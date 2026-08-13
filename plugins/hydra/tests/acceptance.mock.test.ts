import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { loadConfig } from '../src/config.js';
import { HYDRA_VERSION } from '../src/contract.js';
import { atomicWriteJson, ensurePrivateDirectory } from '../src/platform/atomic-files.js';
import { NodeProcessRunner } from '../src/platform/process.js';
import { createRepository } from './helpers/repo.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(pluginRoot, '..', '..');
const mockClaude = resolve(pluginRoot, 'tests', 'helpers', 'mock-claude.mjs');
const builtServer = resolve(pluginRoot, 'dist', 'server.js');
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed-out']);

interface StatusView {
  readonly jobId: string;
  readonly status: string;
  readonly worktreePath?: string;
  readonly sessionId?: string;
  readonly resolvedModel?: string;
}

interface ResultView {
  readonly meta: StatusView;
  readonly events: ReadonlyArray<{ readonly type?: string }>;
  readonly stderr: string;
  readonly result?: {
    readonly status: string;
    readonly finalText: string;
    readonly sessionId?: string;
    readonly resolvedModel?: string;
    readonly eventsComplete: boolean;
    readonly worktree?: {
      readonly path?: string;
      readonly changedFiles: readonly string[];
      readonly mainCheckoutChanged: boolean;
    };
  };
}

interface StatusData {
  readonly jobs: readonly StatusView[];
  readonly health: { readonly state: string };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected MCP structured content object');
  }
  return value as Record<string, unknown>;
}

describe('built Hydra server with detached mock CLI workers', () => {
  let root: string;
  let home: string;
  let stateRoot: string;
  let repository: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    const build = await new NodeProcessRunner().run(process.execPath, ['scripts/build.mjs'], {
      cwd: repositoryRoot,
      timeoutMs: 30_000,
      maxOutputBytes: 2_000_000,
    });
    if (build.exitCode !== 0) {
      throw new Error(`Hydra build failed with exit ${String(build.exitCode)}`);
    }

    root = await createTemporaryDirectory('hydra-acceptance-');
    home = join(root, 'home');
    stateRoot = join(home, '.hydra');
    repository = join(root, 'repository');
    await Promise.all([ensurePrivateDirectory(stateRoot), createRepository(repository)]);
    await atomicWriteJson(
      join(stateRoot, 'config.json'),
      loadConfig({
        stateRoot,
        claudePath: mockClaude,
        cancellationGraceMs: 100,
        staleHeartbeatMs: 2_000,
      }),
    );

    const environment: Record<string, string> = {
      HOME: home,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TMPDIR: join(root, 'tmp'),
      LANG: 'C.UTF-8',
    };
    await ensurePrivateDirectory(environment.TMPDIR!);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [builtServer],
      cwd: repositoryRoot,
      env: environment,
      stderr: 'pipe',
    });
    client = new Client({ name: 'hydra-acceptance', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await removeTemporaryDirectory(root);
  });

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError === true) {
      throw new Error(`MCP tool ${name} failed: ${JSON.stringify(result.structuredContent)}`);
    }
    const envelope = record(result.structuredContent);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      hydraVersion: HYDRA_VERSION,
      response: { ok: true, warnings: [] },
    });
    return record(record(envelope.response).data);
  }

  async function waitForTerminal(jobId: string, timeoutMs = 10_000): Promise<StatusView> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const statusData = (await call('hydra_status', { jobId })) as unknown as StatusData;
      const status = statusData.jobs[0];
      if (status === undefined) {
        throw new Error(`Hydra status omitted requested job ${jobId}`);
      }
      if (terminalStatuses.has(status.status)) {
        return status;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Hydra job ${jobId}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }

  async function startJob(
    task: string,
    model: string,
    accessMode = 'analyze',
    timeoutSec = 5,
  ): Promise<string> {
    const started = await call('hydra_start', {
      task,
      cwd: repository,
      model,
      effort: 'low',
      role: 'acceptance verifier',
      accessMode,
      maxTurns: 4,
      timeoutSec,
      strictModel: true,
    });
    expect(started.status).toBe('queued');
    expect(started.jobId).toEqual(expect.any(String));
    return started.jobId as string;
  }

  test('passes preflight and exposes all built tools without a real subscription call', async () => {
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(9);

    const preflight = await call('hydra_preflight', { cwd: repository });
    expect(preflight).toMatchObject({
      ok: true,
      claudeVersion: '2.1.228',
      billingMode: 'subscription-only',
      usageCreditsState: 'unknown',
      manualCheckRequired: true,
    });
    expect(await call('hydra_budget', { action: 'status' })).toEqual({
      snapshotCount: 0,
      observationCount: 0,
      activeReservations: [],
    });
  });

  test('runs explicit models, returns immediately, persists results, and resumes a session', async () => {
    const startedAt = Date.now();
    const sonnetJob = await startJob('mock:success', 'sonnet');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect((await waitForTerminal(sonnetJob)).status).toBe('completed');
    const sonnet = (await call('hydra_result', { jobId: sonnetJob })) as unknown as ResultView;
    expect(sonnet.result).toMatchObject({
      status: 'completed',
      finalText: 'final for mock:success',
      sessionId: '22222222-2222-4222-8222-222222222222',
      resolvedModel: 'claude-sonnet-mock',
    });

    const continued = await call('hydra_continue', {
      sessionId: sonnet.result!.sessionId,
      message: 'mock:success',
      effort: 'low',
    });
    const continuationId = continued.jobId as string;
    expect((await waitForTerminal(continuationId)).status).toBe('completed');
    const continuation = (await call('hydra_result', { jobId: continuationId })) as unknown as ResultView;
    expect(continuation.result?.sessionId).toBe(sonnet.result?.sessionId);

    for (const model of ['opus', 'fable']) {
      const jobId = await startJob('mock:success', model);
      expect((await waitForTerminal(jobId)).status).toBe('completed');
      const result = (await call('hydra_result', { jobId })) as unknown as ResultView;
      expect(result.result?.resolvedModel).toBe(`claude-${model}-mock`);
    }
  }, 20_000);

  test('preserves malformed-stream evidence, timeout partials, and process-group cancellation', async () => {
    const malformedId = await startJob('mock:malformed', 'sonnet');
    expect((await waitForTerminal(malformedId)).status).toBe('failed');
    const malformed = (await call('hydra_result', { jobId: malformedId })) as unknown as ResultView;
    expect(malformed.events.map(({ type }) => type)).toEqual([
      'system',
      'assistant',
      'hydra_parse_error',
      'result',
    ]);
    expect(malformed.result?.finalText).toBe('final for mock:malformed');
    expect(JSON.stringify(malformed)).not.toContain('malformed secret line');

    const timeoutId = await startJob('mock:timeout', 'sonnet', 'analyze', 1);
    expect((await waitForTerminal(timeoutId)).status).toBe('timed-out');
    const timedOut = (await call('hydra_result', { jobId: timeoutId })) as unknown as ResultView;
    expect(timedOut.result).toMatchObject({ status: 'timed-out', eventsComplete: false });
    expect(timedOut.events[0]?.type).toBe('system');

    const cancelId = await startJob('mock:timeout', 'sonnet', 'analyze', 10);
    const runningDeadline = Date.now() + 5_000;
    for (;;) {
      const currentData = (await call('hydra_status', { jobId: cancelId })) as unknown as StatusData;
      const current = currentData.jobs[0];
      if (current === undefined) {
        throw new Error(`Hydra status omitted cancellation job ${cancelId}`);
      }
      if (current.status === 'running') {
        break;
      }
      if (Date.now() >= runningDeadline) {
        throw new Error('Cancellation job did not reach running state');
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    const cancelled = await call('hydra_cancel', { jobId: cancelId });
    expect(cancelled.status).toBe('cancelled');
    expect((await waitForTerminal(cancelId)).status).toBe('cancelled');
  }, 20_000);

  test('isolates write jobs in unique worktrees and records an outcome', async () => {
    const [firstId, secondId] = await Promise.all([
      startJob('mock:write', 'sonnet', 'execute'),
      startJob('mock:write', 'opus', 'execute'),
    ]);
    await Promise.all([waitForTerminal(firstId), waitForTerminal(secondId)]);
    const [first, second] = (await Promise.all([
      call('hydra_result', { jobId: firstId }),
      call('hydra_result', { jobId: secondId }),
    ])) as unknown as [ResultView, ResultView];

    expect(first.result).toMatchObject({
      status: 'completed',
      worktree: { changedFiles: ['mock-change.txt'], mainCheckoutChanged: false },
    });
    expect(second.result).toMatchObject({
      status: 'completed',
      worktree: { changedFiles: ['mock-change.txt'], mainCheckoutChanged: false },
    });
    expect(first.result?.worktree?.path).not.toBe(second.result?.worktree?.path);
    await expect(access(join(repository, 'mock-change.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    const outcome = await call('hydra_record_outcome', {
      jobId: firstId,
      taskType: 'feature',
      scope: 'repo',
      accepted: true,
      acceptedClaims: ['isolated write verified'],
      testsBefore: [],
      testsAfter: ['mock acceptance passed'],
      testsPassed: true,
      patchAccepted: false,
    });
    expect(outcome).toMatchObject({ jobId: firstId, recorded: true });
    const persisted = JSON.parse(
      await readFile(join(stateRoot, 'outcomes', `${firstId}.json`), 'utf8'),
    ) as { accepted: boolean };
    expect(persisted.accepted).toBe(true);
  }, 20_000);
});
