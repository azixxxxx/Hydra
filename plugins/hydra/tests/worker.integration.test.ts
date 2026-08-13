import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ClaudeCliAdapter, type ClaudeRunResult } from '../src/claude-cli.js';
import { ConcurrencyManager } from '../src/concurrency.js';
import { HydraError, type StartJobInput } from '../src/domain.js';
import { JobStore, SessionStore } from '../src/stores.js';
import { WorktreeManager } from '../src/worktrees.js';
import { runWorker, type WorkerDependencies } from '../src/worker.js';
import { TEST_CAPABILITIES } from './helpers/capabilities.js';
import { createRepository } from './helpers/repo.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const mockClaude = resolve(dirname(fileURLToPath(import.meta.url)), 'helpers', 'mock-claude.mjs');
const jobIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

function input(cwd: string, overrides: Partial<StartJobInput> = {}): StartJobInput {
  return {
    task: 'mock:success',
    cwd,
    model: 'sonnet',
    effort: 'high',
    role: 'reviewer',
    accessMode: 'analyze',
    maxTurns: 12,
    timeoutSec: 5,
    strictModel: false,
    ...overrides,
  };
}

describe('runWorker integration', () => {
  let root: string;
  let repository: string;
  let stateRoot: string;
  let ids: string[];
  let jobStore: JobStore;
  let sessionStore: SessionStore;

  beforeEach(async () => {
    root = await createTemporaryDirectory('hydra-worker-');
    repository = join(root, 'repository');
    stateRoot = join(root, 'state');
    await createRepository(repository);
    ids = [...jobIds];
    jobStore = new JobStore({ stateRoot, idFactory: () => ids.shift() ?? jobIds[0]! });
    sessionStore = new SessionStore({ stateRoot });
  });

  afterEach(async () => {
    await removeTemporaryDirectory(root);
  });

  function dependencies(adapter: WorkerDependencies['adapter'] = new ClaudeCliAdapter({
    claudePath: process.execPath,
    claudeArgsPrefix: [mockClaude],
    capabilities: TEST_CAPABILITIES,
    heartbeatIntervalMs: 10,
  })): WorkerDependencies {
    return {
      jobStore,
      sessionStore,
      concurrency: new ConcurrencyManager({
        stateRoot,
        maxConcurrentClaudeJobs: 2,
        maxConcurrentFableJobs: 1,
        staleHeartbeatMs: 500,
        pollIntervalMs: 5,
        processStartMarker: () => Promise.resolve('worker-test-process'),
      }),
      worktrees: new WorktreeManager({ stateRoot }),
      adapter,
      preflight: () =>
        Promise.resolve({ claudeVersion: '2.1.228', capabilities: TEST_CAPABILITIES }),
      now: () => new Date(),
    };
  }

  test('runs a queued job through completion and persists events, result, and session', async () => {
    const meta = await jobStore.create(input(repository));
    await runWorker(meta.jobId, dependencies());

    const finished = await jobStore.get(meta.jobId);
    const result = await jobStore.readResult(meta.jobId);
    expect(finished.status).toBe('completed');
    expect(finished.claudeVersion).toBe('2.1.228');
    expect(finished.claudePgid).toEqual(expect.any(Number));
    expect(finished.resolvedModel, JSON.stringify({ finished, result })).toBe('claude-sonnet-mock');
    expect(finished.sessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(result).toMatchObject({
      status: 'completed',
      finalText: 'final for mock:success',
      eventsComplete: true,
      turns: 1,
    });
    expect((await jobStore.readEvents(meta.jobId)).map((event) => (event as { type: string }).type)).toEqual([
      'system',
      'assistant',
      'result',
    ]);
    expect(await sessionStore.get('22222222-2222-4222-8222-222222222222')).toMatchObject({
      latestJobId: meta.jobId,
      model: 'sonnet',
      accessMode: 'analyze',
    });
  });

  test('persists invocation turns separately from terminal session turns', async () => {
    const adapter: WorkerDependencies['adapter'] = {
      run: () => Promise.resolve({
        finalText: 'continued result',
        eventsComplete: true,
        turns: 1,
        reportedSessionTurns: 40,
        isError: false,
        parseErrors: [],
        resolvedModel: 'claude-sonnet-mock',
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        turnLimitReached: false,
        warnings: [],
        stderrBytes: 0,
      }),
    };
    const meta = await jobStore.create(input(repository));

    await runWorker(meta.jobId, dependencies(adapter));

    expect(await jobStore.readResult(meta.jobId)).toMatchObject({
      status: 'completed',
      turns: 1,
      reportedSessionTurns: 40,
    });
  });

  test('keeps a completed terminal result when Claude output requires redaction', async () => {
    const rawBearer = ['Bearer', 'worker-secret-value'].join(' ');
    const adapter: WorkerDependencies['adapter'] = {
      run: () => Promise.resolve({
        finalText: `Security prose kept Bearer [REDACTED]; raw ${rawBearer}`,
        structuredOutput: { authorization: rawBearer, verdict: 'accepted' },
        eventsComplete: true,
        turns: 1,
        isError: false,
        parseErrors: [],
        resolvedModel: 'claude-sonnet-mock',
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        turnLimitReached: false,
        warnings: [],
        stderrBytes: 0,
      }),
    };
    const meta = await jobStore.create(input(repository));

    await runWorker(meta.jobId, dependencies(adapter));

    expect(await jobStore.get(meta.jobId)).toMatchObject({ status: 'completed' });
    expect(await jobStore.readResult(meta.jobId)).toMatchObject({
      status: 'completed',
      finalText: 'Security prose kept Bearer [REDACTED]; raw Bearer [REDACTED]',
      structuredOutput: { authorization: '[REDACTED]', verdict: 'accepted' },
      redactions: expect.arrayContaining([
        expect.objectContaining({ field: 'finalText' }),
        expect.objectContaining({ field: 'structuredOutput' }),
      ]),
    });
  });

  test('does not discard safe prose containing a short credential prefix', async () => {
    const adapter: WorkerDependencies['adapter'] = {
      run: () => Promise.resolve({
        finalText: 'The documented prefix is sk-ant-x.',
        eventsComplete: true,
        turns: 1,
        isError: false,
        parseErrors: [],
        resolvedModel: 'claude-sonnet-mock',
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        turnLimitReached: false,
        warnings: [],
        stderrBytes: 0,
      }),
    };
    const meta = await jobStore.create(input(repository));

    await runWorker(meta.jobId, dependencies(adapter));

    expect(await jobStore.get(meta.jobId)).toMatchObject({ status: 'completed' });
    expect(await jobStore.readResult(meta.jobId)).toMatchObject({
      status: 'completed',
      finalText: 'The documented prefix is sk-ant-x.',
    });
  });

  test('uses an isolated worktree for execute and records changed-file evidence', async () => {
    const fakeResult: ClaudeRunResult = {
      finalText: 'implemented',
      eventsComplete: true,
      turns: 1,
      isError: false,
      parseErrors: [],
      resolvedModel: 'claude-sonnet-mock',
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      turnLimitReached: false,
      warnings: [],
      testsRun: [{ command: 'npm test', status: 'completed' }],
      stderrBytes: 0,
    };
    const adapter: WorkerDependencies['adapter'] = {
      run: async (runInput, callbacks) => {
        await callbacks.onProcessGroup?.(4567, 'claude-start');
        await writeFile(join(runInput.cwd, 'worker-change.txt'), 'created\n', 'utf8');
        return fakeResult;
      },
    };
    const meta = await jobStore.create(input(repository, { accessMode: 'execute' }));
    await runWorker(meta.jobId, dependencies(adapter));

    const result = await jobStore.readResult(meta.jobId);
    expect(result).toMatchObject({
      status: 'completed',
      worktree: {
        changedFiles: ['worker-change.txt'],
        mainCheckoutChanged: false,
        path: expect.stringContaining(meta.jobId),
      },
      testsRun: [{ command: 'npm test', status: 'completed' }],
    });
    expect((await jobStore.get(meta.jobId)).worktreePath).toContain(meta.jobId);
  });

  test('fails analyze mode if the adapter changes the main checkout and never resets it', async () => {
    const adapter: WorkerDependencies['adapter'] = {
      run: async (runInput) => {
        await writeFile(join(runInput.cwd, 'unexpected.txt'), 'kept for inspection\n', 'utf8');
        return {
          finalText: 'changed it', eventsComplete: true, turns: 1, isError: false, parseErrors: [],
          exitCode: 0, signal: null, timedOut: false, aborted: false,
          turnLimitReached: false, warnings: [], stderrBytes: 0,
        };
      },
    };
    const meta = await jobStore.create(input(repository));
    await runWorker(meta.jobId, dependencies(adapter));

    expect(await jobStore.get(meta.jobId)).toMatchObject({
      status: 'failed',
      error: { code: 'ANALYZE_REPOSITORY_CHANGED' },
    });
    const analyzeResult = await jobStore.readResult(meta.jobId);
    expect(analyzeResult).toMatchObject({
      worktree: {
        beforeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        afterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(analyzeResult?.worktree).not.toHaveProperty('patch');
    expect(await readFile(join(repository, 'unexpected.txt'), 'utf8')).toBe('kept for inspection\n');
  });

  test('preserves model identity and partial output when strict model validation fails', async () => {
    const adapter: WorkerDependencies['adapter'] = {
      run: () => Promise.resolve({
        finalText: 'useful partial review',
        eventsComplete: true,
        turns: 1,
        isError: false,
        parseErrors: [],
        resolvedModel: 'claude-opus-4-1',
        canonicalModelId: 'claude-opus-4-1-20250805',
        appliedEffort: 'xhigh',
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        turnLimitReached: false,
        warnings: ['model mismatch'],
        stderrBytes: 0,
        modelMismatch: true,
      }),
    };
    const meta = await jobStore.create(input(repository, { strictModel: true }));
    await runWorker(meta.jobId, dependencies(adapter));

    expect(await jobStore.readResult(meta.jobId)).toMatchObject({
      status: 'failed',
      finalText: 'useful partial review',
      requestedModel: 'sonnet',
      resolvedModel: 'claude-opus-4-1',
      canonicalModelId: 'claude-opus-4-1-20250805',
      appliedEffort: 'xhigh',
      error: { code: 'MODEL_MISMATCH' },
    });
  });

  test('fails on unexpected terminal model usage even when strictModel is false', async () => {
    const meta = await jobStore.create(
      input(repository, { task: 'mock:unexpected-model-usage', strictModel: false }),
    );
    await runWorker(meta.jobId, dependencies());

    expect(await jobStore.readResult(meta.jobId)).toMatchObject({
      status: 'failed',
      requestedModel: 'sonnet',
      resolvedModel: 'claude-sonnet-mock',
      reportedModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-mock'],
      error: { code: 'MODEL_MISMATCH' },
      warnings: [expect.stringMatching(/claude-haiku-4-5-20251001/u)],
    });
  });

  test('fails closed when Claude reports that usage credits are required', async () => {
    const meta = await jobStore.create(input(repository, { task: 'mock:credits-required' }));
    await runWorker(meta.jobId, dependencies());

    expect(await jobStore.readResult(meta.jobId)).toMatchObject({
      status: 'failed',
      error: { code: 'USAGE_CREDITS_REQUIRED' },
    });
  });

  test.each([
    ['timed-out', { timedOut: true, aborted: false, isError: false, exitCode: null }],
    ['cancelled', { timedOut: false, aborted: true, isError: false, exitCode: null }],
    ['failed', { timedOut: false, aborted: false, isError: true, exitCode: 1 }],
  ] as const)('maps adapter termination to %s and preserves partial output', async (status, termination) => {
    const adapter: WorkerDependencies['adapter'] = {
      run: () => Promise.resolve({
        finalText: 'partial output', eventsComplete: false, turns: 1, parseErrors: [],
        signal: null, turnLimitReached: false, warnings: [], stderrBytes: 0,
        ...termination,
      }),
    };
    const meta = await jobStore.create(input(repository));
    await runWorker(meta.jobId, dependencies(adapter));

    expect(await jobStore.get(meta.jobId)).toMatchObject({ status });
    expect(await jobStore.readResult(meta.jobId)).toMatchObject({ status, finalText: 'partial output' });
  });

  test('reports cancellation as the termination reason when a cancellation races a terminal event', async () => {
    const expectedJobId = jobIds[0]!;
    const adapter: WorkerDependencies['adapter'] = {
      run: async () => {
        await jobStore.patch(expectedJobId, {
          cancellationRequestedAt: new Date().toISOString(),
        });
        return {
          finalText: 'partial output',
          eventsComplete: true,
          turns: 1,
          isError: false,
          parseErrors: [],
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          turnLimitReached: false,
          warnings: [],
          stderrBytes: 0,
          terminationReason: 'completed',
        };
      },
    };
    const meta = await jobStore.create(input(repository));
    expect(meta.jobId).toBe(expectedJobId);
    await runWorker(meta.jobId, dependencies(adapter));

    expect(await jobStore.readResult(meta.jobId)).toMatchObject({
      status: 'cancelled',
      terminationReason: 'cancelled',
      error: { code: 'CLAUDE_CANCELLED' },
    });
  });

  test('keeps cancellation authoritative when it arrives during repository evidence collection', async () => {
    const adapter: WorkerDependencies['adapter'] = {
      run: () => Promise.resolve({
        finalText: 'safe partial output',
        eventsComplete: true,
        turns: 1,
        isError: false,
        parseErrors: [],
        sessionId: '99999999-9999-4999-8999-999999999999',
        resolvedModel: 'claude-sonnet-mock',
        canonicalModelId: 'claude-sonnet-mock-20260801',
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        turnLimitReached: false,
        warnings: [],
        stderrBytes: 0,
      }),
    };
    const meta = await jobStore.create(input(repository));
    const workerDependencies = {
      ...dependencies(adapter),
      collectEvidence: async () => {
        await jobStore.requestCancellation(meta.jobId);
        return {
          evidence: {
            path: repository,
            changedFiles: [],
            mainCheckoutChanged: false,
          },
          analyzeChanged: false,
        };
      },
    };

    await runWorker(meta.jobId, workerDependencies);

    expect(await jobStore.get(meta.jobId)).toMatchObject({
      status: 'cancelled',
      resolvedModel: 'claude-sonnet-mock',
      canonicalModelId: 'claude-sonnet-mock-20260801',
      sessionId: '99999999-9999-4999-8999-999999999999',
    });
    expect(await jobStore.readResult(meta.jobId)).toMatchObject({
      status: 'cancelled',
      finalText: 'safe partial output',
      resolvedModel: 'claude-sonnet-mock',
      canonicalModelId: 'claude-sonnet-mock-20260801',
      sessionId: '99999999-9999-4999-8999-999999999999',
      terminationReason: 'cancelled',
      error: { code: 'CLAUDE_CANCELLED' },
    });
  });

  test('keeps an early cancellation authoritative when the adapter fails before model discovery', async () => {
    const expectedJobId = jobIds[0]!;
    const adapter: WorkerDependencies['adapter'] = {
      run: async () => {
        await jobStore.patch(expectedJobId, {
          cancellationRequestedAt: new Date().toISOString(),
        });
        throw new HydraError(
          'MODEL_MISMATCH',
          'Claude did not report the model requested as sonnet.',
        );
      },
    };
    const meta = await jobStore.create(input(repository));
    expect(meta.jobId).toBe(expectedJobId);
    await runWorker(meta.jobId, dependencies(adapter));

    expect(await jobStore.get(meta.jobId)).toMatchObject({
      status: 'cancelled',
      error: { code: 'CLAUDE_CANCELLED' },
    });
    expect(await jobStore.readResult(meta.jobId)).toMatchObject({
      status: 'cancelled',
      terminationReason: 'cancelled',
      error: { code: 'CLAUDE_CANCELLED' },
    });
  });

  test('resumes the exact stored Claude session ID', async () => {
    const resumeSessionId = '99999999-9999-4999-8999-999999999999';
    let observedResume: string | undefined;
    const adapter: WorkerDependencies['adapter'] = {
      run: (runInput) => {
        observedResume = runInput.resumeSessionId;
        return Promise.resolve({
          finalText: 'continued', eventsComplete: true, turns: 1, isError: false, parseErrors: [],
          sessionId: resumeSessionId, resolvedModel: 'claude-opus-mock', exitCode: 0,
          signal: null, timedOut: false, aborted: false, turnLimitReached: false,
          warnings: [], stderrBytes: 0,
        });
      },
    };
    const meta = await jobStore.create(
      input(repository, { model: 'opus' }),
      undefined,
      { resumeSessionId },
    );
    await runWorker(meta.jobId, dependencies(adapter));

    expect(observedResume).toBe(resumeSessionId);
    expect(await jobStore.get(meta.jobId)).toMatchObject({ status: 'completed', sessionId: resumeSessionId });
  });
});
