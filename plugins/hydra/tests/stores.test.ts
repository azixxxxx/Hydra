import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { JobResult, OutcomeRecord, SessionRecord, StartJobInput } from '../src/domain.js';
import {
  ConfigStore,
  DelegationStore,
  JobStore,
  OutcomeRecorder,
  OutcomeStore,
  SessionStore,
} from '../src/stores.js';
import { PolicyEngine, type RouteInput } from '../src/policy.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';

const architectureRouteInput: RouteInput = {
  taskProfile: {
    kind: 'architecture',
    scope: 'repo',
    ambiguity: 'high',
    novelty: 'high',
    risk: 'critical',
    writeRequired: false,
    testsRequired: true,
    parallelizable: false,
  },
  contextProfile: {
    capsuleBytes: 10_000,
    overlap: 'high',
    partitionability: 'none',
    independentJudgmentsRequired: false,
    partitions: [],
  },
  userMode: 'auto',
};

function jobInput(overrides: Partial<StartJobInput> = {}): StartJobInput {
  return {
    task: 'Review this repository',
    cwd: '/tmp/repository',
    model: 'sonnet',
    effort: 'high',
    role: 'reviewer',
    accessMode: 'analyze',
    maxTurns: 12,
    timeoutSec: 1800,
    strictModel: false,
    ...overrides,
  };
}

describe('durable stores', () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await createTemporaryDirectory('hydra-stores-');
  });

  afterEach(async () => {
    await removeTemporaryDirectory(stateRoot);
  });

  test('creates the documented private job layout and refuses duplicate creation', async () => {
    const store = new JobStore({ stateRoot, idFactory: () => firstId });
    const meta = await store.create(jobInput());

    expect(meta).toMatchObject({
      schemaVersion: 1,
      jobId: firstId,
      status: 'queued',
      requestedModel: 'sonnet',
      requestedEffort: 'high',
      usageFeatures: {
        promptBytes: 22,
        roleBytes: 8,
        schemaBytes: 0,
        referencedBytes: 0,
        expectedTurns: 12,
        toolClass: 'analyze',
      },
    });
    expect((await stat(join(stateRoot, 'jobs'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateRoot, 'jobs', firstId))).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateRoot, 'jobs', firstId, 'meta.json'))).mode & 0o777).toBe(0o600);
    await expect(store.create(jobInput())).rejects.toMatchObject({ code: 'JOB_ALREADY_EXISTS' });
  });

  test('does not persist removed billing or context selectors', async () => {
    const store = new JobStore({ stateRoot, idFactory: () => firstId });
    const meta = await store.create(jobInput());

    expect(meta.warnings).toEqual([]);
    expect(meta).not.toHaveProperty('billingMode');
    expect(meta.input).not.toHaveProperty('contextMode');
  });

  test('persists staged delegation activations and aggregates raw group usage', async () => {
    const ids = [firstId, secondId];
    const jobStore = new JobStore({ stateRoot, idFactory: () => ids.shift() ?? firstId });
    const delegationStore = new DelegationStore({ stateRoot });
    const recommendation = new PolicyEngine().route(architectureRouteInput);

    const admit = async (sessionIndex: number, jobId: string, evidenceJobId?: string) => {
      const session = recommendation.plan.sessions[sessionIndex]!;
      const delegation = {
        routeInput: architectureRouteInput,
        planId: recommendation.planId,
        ...(sessionIndex === 0 ? {} : { groupId: firstId }),
        sessionIndex,
        activationReason:
          sessionIndex === 0
            ? 'Start the architecture lead.'
            : 'The lead left the persistence invariant unresolved.',
        ...(evidenceJobId === undefined ? {} : { evidenceJobId }),
      };
      return jobStore.createWithinCapacity(
        jobInput({
          model: session.model,
          effort: session.effort,
          role: session.role,
          delegation,
        }),
        8,
        {
          delegationGroupId: firstId,
          delegationPlanId: recommendation.planId,
          delegationSessionIndex: sessionIndex,
          delegationActivationReason: delegation.activationReason,
        },
        jobId,
        {
          beforeCreate: async () => {
            await delegationStore.reserveActivation(
              {
                groupId: firstId,
                jobId,
                planId: recommendation.planId,
                routeInput: architectureRouteInput,
                route: recommendation.route,
                plan: recommendation.plan,
                sessionIndex,
                activationReason: delegation.activationReason,
                ...(evidenceJobId === undefined ? {} : { evidenceJobId }),
              },
              jobStore,
            );
          },
          rollback: async () => delegationStore.rollbackActivation(firstId, jobId),
        },
      );
    };

    const lead = await admit(0, firstId);
    await jobStore.transition(firstId, 'running');
    await jobStore.finalize(firstId, {
      schemaVersion: 1,
      jobId: lead.jobId,
      status: 'completed',
      requestedModel: lead.requestedModel,
      requestedEffort: lead.requestedEffort,
      warnings: [],
      testsRun: [],
      finalText: 'One persistence invariant remains unresolved.',
      eventsComplete: true,
      createdAt: lead.createdAt,
      completedAt: '2026-08-12T12:00:01.000Z',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
    });
    const followup = await admit(1, secondId, firstId);
    await jobStore.transition(secondId, 'running');
    await jobStore.finalize(secondId, {
      schemaVersion: 1,
      jobId: followup.jobId,
      status: 'completed',
      requestedModel: followup.requestedModel,
      requestedEffort: followup.requestedEffort,
      warnings: [],
      testsRun: [],
      finalText: 'Invariant resolved.',
      eventsComplete: true,
      createdAt: followup.createdAt,
      completedAt: '2026-08-12T12:00:02.000Z',
      usage: { inputTokens: 7, outputTokens: 2, cacheCreationTokens: 4 },
    });

    expect(await delegationStore.summary(firstId, jobStore)).toMatchObject({
      groupId: firstId,
      strategy: 'sequential-escalation',
      maxImmediateSessions: 1,
      maxTotalSessions: 2,
      activatedSessions: 2,
      jobCount: 2,
      terminalJobCount: 2,
      replicatedContextBytesImmediate: 10_000,
      replicatedContextBytesAllActivated: 20_000,
      replicatedContextBytesActivated: 20_000,
      suppliedContext: {
        promptBytes: expect.any(Number),
        roleBytes: expect.any(Number),
        schemaBytes: 0,
        referencedBytes: 20_000,
      },
      usage: {
        inputTokens: 17,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
      },
    });

    const outcome = await new OutcomeRecorder({
      jobStore,
      outcomeStore: new OutcomeStore({ stateRoot }),
      delegationStore,
    }).record({
      jobId: secondId,
      taskType: 'architecture',
      scope: 'repo',
      accepted: true,
      acceptedClaims: ['The recovery invariant is now explicit.'],
      rejectedClaims: [],
      falsePositives: [],
      testsBefore: [],
      testsAfter: [],
      userVerdict: 'accepted',
    });
    expect(outcome.delegation).toMatchObject({
      groupId: firstId,
      activatedSessions: 2,
      jobCount: 2,
      terminalJobCount: 2,
      sufficient: true,
      usage: {
        inputTokens: 17,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
      },
    });
    expect(await delegationStore.summary(firstId, jobStore)).toMatchObject({ sufficient: true });
  });

  test('checks transitions and preserves the prior record after an illegal transition', async () => {
    let now = new Date('2026-08-12T12:00:00.000Z');
    const store = new JobStore({
      stateRoot,
      idFactory: () => firstId,
      now: () => now,
    });
    await store.create(jobInput());
    now = new Date('2026-08-12T12:00:01.000Z');
    await store.setWorker(firstId, 1234, 'worker-start');
    const running = await store.transition(firstId, 'running', {
      claudeVersion: '2.1.228',
      resolvedModel: 'claude-sonnet-5',
    });

    expect(running).toMatchObject({
      status: 'running',
      workerPid: 1234,
      startedAt: '2026-08-12T12:00:01.000Z',
      claudeVersion: '2.1.228',
    });
    await expect(store.transition(firstId, 'queued')).rejects.toMatchObject({
      code: 'INVALID_JOB_TRANSITION',
    });
    expect((await store.get(firstId)).status).toBe('running');
  });

  test('conditionally transitions only the expected current status', async () => {
    const store = new JobStore({ stateRoot, idFactory: () => firstId });
    await store.create(jobInput());
    await store.transition(firstId, 'running');
    await store.transition(firstId, 'completed');

    const unchanged = await store.transitionIf(firstId, 'running', 'failed', {
      error: { code: 'STALE_WORKER', message: 'stale' },
    });

    expect(unchanged.status).toBe('completed');
    expect(unchanged.error).toBeUndefined();
  });

  test('persists heartbeat, worker and Claude process-group metadata across store restarts', async () => {
    const store = new JobStore({ stateRoot, idFactory: () => firstId });
    await store.create(jobInput());
    await store.setWorker(firstId, 4321, 'worker-start');
    await store.transition(firstId, 'running');
    await store.setClaudeGroup(firstId, 5432, 'claude-start');
    await store.heartbeat(firstId);

    const restarted = new JobStore({ stateRoot });
    expect(await restarted.get(firstId)).toMatchObject({
      workerPid: 4321,
      workerProcessStartMarker: 'worker-start',
      claudePgid: 5432,
      claudeProcessStartMarker: 'claude-start',
      status: 'running',
      heartbeatAt: expect.any(String),
    });
  });

  test('recovers a stale metadata recovery guard left by a crashed process', async () => {
    const store = new JobStore({ stateRoot, idFactory: () => firstId });
    await store.create(jobInput());
    const recoveryPath = join(stateRoot, 'jobs', firstId, '.meta-lock-recovery');
    await mkdir(recoveryPath, { mode: 0o700 });
    await writeFile(
      join(recoveryPath, 'owner.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 999_999_999,
        processStartMarker: 'dead-process',
        acquiredAt: '2020-01-01T00:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );

    await expect(store.setWorker(firstId, 4321, 'worker-start')).resolves.toMatchObject({
      workerPid: 4321,
      workerProcessStartMarker: 'worker-start',
    });
  }, 2_000);

  test('does not steal a stale-looking metadata recovery guard from a live owner', async () => {
    const store = new JobStore({
      stateRoot,
      idFactory: () => firstId,
      isProcessAlive: (_pid, marker) => Promise.resolve(marker === 'live-recovery-owner'),
      metaLockStaleMs: 10,
      metaLockWaitMs: 50,
    });
    await store.create(jobInput());
    const recoveryPath = join(stateRoot, 'jobs', firstId, '.meta-lock-recovery');
    await mkdir(recoveryPath, { mode: 0o700 });
    await writeFile(
      join(recoveryPath, 'owner.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 4242,
        processStartMarker: 'live-recovery-owner',
        acquiredAt: '2020-01-01T00:00:00.000Z',
        token: '44444444-4444-4444-8444-444444444444',
      })}\n`,
      { mode: 0o600 },
    );

    await expect(store.setWorker(firstId, 4321, 'worker-start')).rejects.toMatchObject({
      code: 'JOB_META_LOCK_TIMEOUT',
    });
  }, 2_000);

  test('lists recent jobs in descending creation order with a bound', async () => {
    const ids = [firstId, secondId];
    let instant = Date.parse('2026-08-12T12:00:00.000Z');
    const store = new JobStore({
      stateRoot,
      idFactory: () => ids.shift() ?? firstId,
      now: () => new Date(instant++),
    });
    await store.create(jobInput({ task: 'first' }));
    await store.create(jobInput({ task: 'second' }));

    expect((await store.list(1)).map(({ jobId }) => jobId)).toEqual([secondId]);
  });

  test('exposes exact terminal usage cohorts and conservatively detects interval activity', async () => {
    let now = new Date('2026-08-13T10:05:00.000Z');
    const ids = [firstId, secondId];
    const store = new JobStore({
      stateRoot,
      idFactory: () => ids.shift() ?? firstId,
      now: () => now,
    });
    const first = await store.create(jobInput({ model: 'opus', effort: 'xhigh' }));
    now = new Date('2026-08-13T10:06:00.000Z');
    await store.transition(firstId, 'running', {
      claudeVersion: '2.1.228',
      resolvedModel: 'claude-opus-5',
      appliedEffort: 'xhigh',
    });
    await store.finalize(firstId, {
      schemaVersion: 1,
      jobId: first.jobId,
      status: 'completed',
      requestedModel: first.requestedModel,
      requestedEffort: first.requestedEffort,
      resolvedModel: 'claude-opus-5',
      appliedEffort: 'xhigh',
      warnings: [],
      testsRun: [],
      finalText: 'done',
      eventsComplete: true,
      createdAt: first.createdAt,
      completedAt: '2026-08-13T10:10:00.000Z',
      usage: {
        inputTokens: 4_000,
        outputTokens: 400,
        cacheReadTokens: 1_000,
        cacheCreationTokens: 500,
      },
    });
    now = new Date('2026-08-13T10:15:00.000Z');
    await store.create(jobInput({ task: 'still active' }));

    expect(await store.usageObservations()).toEqual([
      {
        resolvedModel: 'claude-opus-5',
        claudeVersion: '2.1.228',
        effort: 'xhigh',
        features: first.usageFeatures,
        usage: {
          inputTokens: 4_000,
          outputTokens: 400,
          cacheReadTokens: 1_000,
          cacheCreationTokens: 500,
        },
        completedAt: '2026-08-13T10:10:00.000Z',
      },
    ]);
    expect(
      (await store.activityOverlapping(
        '2026-08-13T10:00:00.000Z',
        '2026-08-13T10:20:00.000Z',
      )).map(({ jobId }) => jobId),
    ).toEqual([firstId, secondId]);
    expect(
      await store.activityOverlapping(
        '2026-08-13T10:10:00.000Z',
        '2026-08-13T10:14:00.000Z',
      ),
    ).toEqual([]);
  });

  test('prunes terminal jobs older than the cutoff even when more than 100 newer jobs exist', async () => {
    const ids = Array.from(
      { length: 101 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    let now = new Date('2020-01-01T00:00:00.000Z');
    const store = new JobStore({
      stateRoot,
      idFactory: () => ids.shift() ?? firstId,
      now: () => now,
    });
    const oldest = await store.create(jobInput({ task: 'old terminal job' }));
    await store.transition(oldest.jobId, 'running');
    await store.transition(oldest.jobId, 'completed');
    now = new Date('2030-01-01T00:00:00.000Z');
    for (let index = 0; index < 100; index += 1) {
      await store.create(jobInput({ task: `new queued job ${index}` }));
    }

    expect(await store.pruneOlderThan(new Date('2025-01-01T00:00:00.000Z'))).toEqual([
      oldest.jobId,
    ]);
    await expect(store.get(oldest.jobId)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });

  test('sanitizes Claude events and accepts canonical redaction placeholders', async () => {
    const store = new JobStore({ stateRoot, idFactory: () => firstId });
    await store.create(jobInput());
    const rawBearer = ['Bearer', 'raw-secret-value'].join(' ');
    await store.appendEvent(firstId, {
      type: 'assistant',
      line: 1,
      message: { content: [{ type: 'text', text: 'safe' }] },
      authorization: '[REDACTED]',
    });

    await store.appendEvent(firstId, {
      type: 'assistant',
      line: 2,
      authorization: rawBearer,
      note: 'Authorization analysis uses Bearer [REDACTED] safely',
    });

    expect(await store.readEvents(firstId)).toEqual([
      expect.objectContaining({ type: 'assistant', authorization: '[REDACTED]' }),
      expect.objectContaining({
        type: 'assistant',
        authorization: '[REDACTED]',
        note: 'Authorization analysis uses Bearer [REDACTED] safely',
      }),
    ]);
  });

  test('rejects credential-shaped caller input before creating durable state', async () => {
    const store = new JobStore({ stateRoot, idFactory: () => firstId });
    const shapes = [
      ['Bearer', 'caller-secret-value'].join(' '),
      ['sk-ant-', 'A'.repeat(8)].join(''),
      ['ghp_', 'A'.repeat(24)].join(''),
      ['AKIA', 'A'.repeat(16)].join(''),
      ['eyJ', 'A'.repeat(10), '.', 'B'.repeat(10), '.', 'C'.repeat(10)].join(''),
      ['GITHUB_TOKEN', '=', 'A'.repeat(16)].join(''),
      ['-----BEGIN PRIVATE KEY-----', 'body', '-----END PRIVATE KEY-----'].join('\n'),
    ];

    for (const shape of shapes) {
      await expect(
        store.create(jobInput({ task: `Inspect request with ${shape}` })),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_SHAPED_STATE' });
    }
    await expect(store.get(firstId)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });

    await expect(
      store.create(jobInput({ task: 'The documented prefix is sk-ant-x.' })),
    ).resolves.toMatchObject({ status: 'queued' });
  });

  test('supports metadata-only logging without retaining message bodies', async () => {
    const store = new JobStore({
      stateRoot,
      idFactory: () => firstId,
      loggingMode: 'metadata-only',
    });
    await store.create(jobInput());
    await store.appendEvent(firstId, {
      type: 'assistant',
      line: 7,
      message: { content: [{ type: 'text', text: 'must disappear' }] },
    });

    expect(await store.readEvents(firstId)).toEqual([{ type: 'assistant', line: 7 }]);
  });

  test('preserves valid events and replaces a crash-truncated JSONL tail with safe metadata', async () => {
    const store = new JobStore({ stateRoot, idFactory: () => firstId });
    await store.create(jobInput());
    await store.appendEvent(firstId, { type: 'assistant', line: 1, text: 'kept' });
    const truncated = Buffer.from('{"type":"result","secret":"never returned"', 'utf8');
    await appendFile(join(stateRoot, 'jobs', firstId, 'events.jsonl'), truncated);

    const events = await store.readEvents(firstId);

    expect(events[0]).toEqual({ type: 'assistant', line: 1, text: 'kept' });
    expect(events[1]).toEqual({
      type: 'hydra_parse_error',
      line: 2,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      byteLength: truncated.byteLength,
    });
    expect(JSON.stringify(events)).not.toContain('never returned');
  });

  test('bounds stderr by bytes and reports truncation', async () => {
    const store = new JobStore({
      stateRoot,
      idFactory: () => firstId,
      maxStderrBytes: 12,
    });
    await store.create(jobInput());

    expect(await store.appendStderr(firstId, '12345678')).toEqual({
      appendedBytes: 8,
      truncated: false,
    });
    expect(await store.appendStderr(firstId, '90abcdef')).toEqual({
      appendedBytes: 4,
      truncated: true,
    });
    expect(await store.readStderr(firstId)).toBe('1234567890ab');
  });

  test('sanitizes credential-shaped stderr before persistence', async () => {
    const store = new JobStore({
      stateRoot,
      idFactory: () => firstId,
      maxStderrBytes: 100,
    });
    await store.create(jobInput());
    const rawBearer = ['Bearer', 'stderr-secret-value'].join(' ');

    await expect(store.appendStderr(firstId, rawBearer)).resolves.toEqual({
      appendedBytes: Buffer.byteLength('Bearer [REDACTED]'),
      truncated: false,
    });
    expect(await store.readStderr(firstId)).toBe('Bearer [REDACTED]');
  });

  test('sanitizes terminal output with auditable digests instead of losing the result', async () => {
    const store = new JobStore({ stateRoot, idFactory: () => firstId });
    const meta = await store.create(jobInput());
    await store.transition(firstId, 'running');
    const rawBearer = ['Bearer', 'result-secret-value'].join(' ');

    const finalized = await store.finalize(firstId, {
      schemaVersion: 1,
      jobId: meta.jobId,
      status: 'completed',
      requestedModel: meta.requestedModel,
      requestedEffort: meta.requestedEffort,
      warnings: [`Detected ${rawBearer}`],
      testsRun: [{ command: `curl -H '${rawBearer}' localhost`, status: 'attempted' }],
      finalText: `Canonical Bearer [REDACTED]; observed ${rawBearer}`,
      structuredOutput: {
        nested: { authorization: rawBearer, note: 'Bearer [REDACTED]' },
      },
      eventsComplete: true,
      createdAt: meta.createdAt,
      completedAt: '2026-08-12T12:00:01.000Z',
      worktree: {
        changedFiles: [],
        patch: `+AUTH=${rawBearer}`,
        mainCheckoutChanged: false,
      },
    });

    expect(finalized.meta.status).toBe('completed');
    expect(finalized.result).toMatchObject({
      status: 'completed',
      warnings: ['Detected Bearer [REDACTED]'],
      testsRun: [{ command: "curl -H 'Bearer [REDACTED]' localhost", status: 'attempted' }],
      finalText: 'Canonical Bearer [REDACTED]; observed Bearer [REDACTED]',
      structuredOutput: {
        nested: { authorization: '[REDACTED]', note: 'Bearer [REDACTED]' },
      },
      worktree: {
        changedFiles: [],
        patch: '+AUTH=Bearer [REDACTED]',
        mainCheckoutChanged: false,
      },
      redactions: expect.arrayContaining([
        expect.objectContaining({ field: 'warnings', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
        expect.objectContaining({ field: 'testsRun', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
        expect.objectContaining({ field: 'finalText', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
        expect.objectContaining({ field: 'structuredOutput', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
        expect.objectContaining({ field: 'worktree.patch', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
      ]),
    });
    expect(JSON.stringify(await store.readResult(firstId))).not.toContain('result-secret-value');
  });

  test('writes one immutable terminal result and exposes durable partial views', async () => {
    const store = new JobStore({ stateRoot, idFactory: () => firstId });
    const meta = await store.create(jobInput());
    await store.appendEvent(firstId, { type: 'assistant', line: 1, text: 'partial' });
    const result: JobResult = {
      schemaVersion: 1,
      jobId: meta.jobId,
      status: 'completed',
      requestedModel: 'sonnet',
      requestedEffort: 'high',
      warnings: [],
      testsRun: [],
      finalText: 'done',
      eventsComplete: true,
      createdAt: meta.createdAt,
      completedAt: meta.createdAt,
    };

    await store.writeResult(firstId, result);
    expect((await store.readView(firstId)).result).toEqual(result);
    expect((await store.readView(firstId)).events).toHaveLength(1);
    await expect(store.writeResult(firstId, { ...result, finalText: 'overwrite' })).rejects.toMatchObject({
      code: 'RESULT_ALREADY_EXISTS',
    });
  });

  test('reconciles a crash after immutable result creation and keeps cancellation authoritative', async () => {
    const ids = [firstId, secondId];
    const store = new JobStore({ stateRoot, idFactory: () => ids.shift() ?? firstId });
    const first = await store.create(jobInput());
    await store.transition(firstId, 'running');
    const completed: JobResult = {
      schemaVersion: 1,
      jobId: first.jobId,
      status: 'completed',
      requestedModel: first.requestedModel,
      requestedEffort: first.requestedEffort,
      resolvedModel: 'claude-sonnet-5-20260801',
      canonicalModelId: 'claude-sonnet-5-20260801',
      sessionId,
      warnings: [],
      testsRun: [],
      finalText: 'persisted before the crash',
      eventsComplete: true,
      createdAt: first.createdAt,
      completedAt: '2026-08-12T12:00:01.000Z',
    };
    await store.writeResult(firstId, completed);

    expect((await store.get(firstId)).status).toBe('running');
    await expect(store.reconcileTerminalResult(firstId)).resolves.toMatchObject({
      status: 'completed',
      resolvedModel: 'claude-sonnet-5-20260801',
      canonicalModelId: 'claude-sonnet-5-20260801',
      sessionId,
    });
    expect(await store.readResult(firstId)).toMatchObject({
      status: 'completed',
      finalText: 'persisted before the crash',
      resolvedModel: 'claude-sonnet-5-20260801',
      canonicalModelId: 'claude-sonnet-5-20260801',
      sessionId,
    });

    const second = await store.create(jobInput());
    await store.transition(secondId, 'running');
    await store.requestCancellation(secondId);
    const finalized = await store.finalize(secondId, {
      ...completed,
      jobId: second.jobId,
      createdAt: second.createdAt,
      finalText: 'late completed output',
    });
    expect(finalized.meta.status).toBe('cancelled');
    expect(finalized.result).toMatchObject({
      status: 'cancelled',
      terminationReason: 'cancelled',
      error: { code: 'CLAUDE_CANCELLED' },
    });
    expect((await store.readResult(secondId))?.status).toBe('cancelled');
  });

  test('projects all immutable identity evidence during cancellation crash recovery', async () => {
    const store = new JobStore({ stateRoot, idFactory: () => firstId });
    const meta = await store.create(jobInput());
    await store.transition(firstId, 'running');
    await store.requestCancellation(firstId);
    const cancelled: JobResult = {
      schemaVersion: 1,
      jobId: meta.jobId,
      status: 'cancelled',
      requestedModel: meta.requestedModel,
      requestedEffort: meta.requestedEffort,
      resolvedModel: 'claude-sonnet-5',
      canonicalModelId: 'claude-sonnet-5-20260801',
      appliedEffort: 'xhigh',
      sessionId,
      warnings: ['safe partial result'],
      testsRun: [],
      finalText: 'safe partial output',
      eventsComplete: false,
      createdAt: meta.createdAt,
      completedAt: '2026-08-12T12:00:01.000Z',
      terminationReason: 'cancelled',
      error: { code: 'CLAUDE_CANCELLED', message: 'cancelled' },
    };
    await store.writeResult(firstId, cancelled);

    const recovered = await store.finalizeCancellation(firstId, cancelled.error!);

    expect(recovered.meta).toMatchObject({
      status: 'cancelled',
      resolvedModel: 'claude-sonnet-5',
      canonicalModelId: 'claude-sonnet-5-20260801',
      appliedEffort: 'xhigh',
      sessionId,
      warnings: ['safe partial result'],
      error: { code: 'CLAUDE_CANCELLED' },
    });
    expect(recovered.result).toEqual(cancelled);
  });

  test('rejects result metadata drift and skips corrupt or incomplete job directories in lists', async () => {
    const ids = [firstId, secondId];
    const store = new JobStore({ stateRoot, idFactory: () => ids.shift() ?? firstId });
    const first = await store.create(jobInput());
    await expect(
      store.writeResult(firstId, {
        schemaVersion: 1,
        jobId: first.jobId,
        status: 'completed',
        requestedModel: 'opus',
        requestedEffort: first.requestedEffort,
        warnings: [],
        testsRun: [],
        finalText: 'invalid',
        eventsComplete: true,
        createdAt: first.createdAt,
        completedAt: first.createdAt,
      }),
    ).rejects.toMatchObject({ code: 'RESULT_META_MISMATCH' });

    const second = await store.create(jobInput({ task: 'valid' }));
    await writeFile(
      join(stateRoot, 'jobs', firstId, 'meta.json'),
      JSON.stringify({ schemaVersion: 1, jobId: firstId, status: 'queued' }),
      'utf8',
    );
    const orphanId = '44444444-4444-4444-8444-444444444444';
    await mkdir(join(stateRoot, 'jobs', orphanId), { mode: 0o700 });

    await expect(store.get(firstId)).rejects.toThrow();
    expect((await store.list()).map(({ jobId }) => jobId)).toEqual([second.jobId]);
    expect(await store.health()).toEqual({
      state: 'degraded',
      issues: [
        {
          code: 'JOB_STATE_CORRUPT',
          message: 'One or more durable job records could not be validated',
          count: 2,
        },
      ],
    });
  });

  test('bounds event storage and paginates the durable result view', async () => {
    const store = new JobStore({
      stateRoot,
      idFactory: () => firstId,
      maxEventBytes: 500,
    });
    await store.create(jobInput());
    await store.appendEvent(firstId, { type: 'assistant', text: 'x'.repeat(300) });
    await store.appendEvent(firstId, { type: 'assistant', text: 'y'.repeat(300) });
    const bounded = await readFile(join(stateRoot, 'jobs', firstId, 'events.jsonl'));
    expect(bounded.byteLength).toBeLessThanOrEqual(500);
    expect(await store.readEvents(firstId)).toEqual([
      { type: 'assistant', text: 'x'.repeat(300) },
      expect.objectContaining({ type: 'hydra_event_limit', droppedByteLength: expect.any(Number) }),
    ]);

    const pageStore = new JobStore({ stateRoot, idFactory: () => secondId });
    await pageStore.create(jobInput({ task: 'paged' }));
    const lines = Array.from(
      { length: 205 },
      (_, index) => `${JSON.stringify({ type: 'assistant', line: index + 1 })}\n`,
    ).join('');
    await appendFile(join(stateRoot, 'jobs', secondId, 'events.jsonl'), lines);
    const tail = await pageStore.readView(secondId);
    expect(tail).toMatchObject({
      eventCount: 205,
      eventsTruncated: true,
      eventOffset: 5,
    });
    expect(tail.events).toHaveLength(200);
    const firstPage = await pageStore.readView(secondId, { eventOffset: 0, eventLimit: 100 });
    expect(firstPage).toMatchObject({ eventOffset: 0, nextEventOffset: 100 });
    expect(firstPage.events).toHaveLength(100);
  });

  test('persists validated session and outcome records under opaque IDs', async () => {
    const sessionStore = new SessionStore({ stateRoot });
    const outcomeStore = new OutcomeStore({ stateRoot });
    const session: SessionRecord = {
      schemaVersion: 1,
      sessionId,
      latestJobId: firstId as SessionRecord['latestJobId'],
      model: 'sonnet',
      effort: 'high',
      role: 'reviewer',
      accessMode: 'analyze',
      strictModel: false,
      maxTurns: 12,
      timeoutSec: 1_800,
      cwd: '/tmp/repository',
      updatedAt: '2026-08-12T12:00:00.000Z',
    };
    const outcome: OutcomeRecord = {
      schemaVersion: 2,
      jobId: firstId as OutcomeRecord['jobId'],
      taskType: 'review',
      scope: 'repo',
      requestedModel: 'sonnet',
      model: 'claude-sonnet-5-20260801',
      effort: 'high',
      status: 'completed',
      durationMs: 1_000,
      completedAt: '2026-08-12T12:00:01.000Z',
      observedTests: [],
      accepted: true,
      recordedAt: '2026-08-12T12:00:01.000Z',
      acceptedClaims: ['finding 1'],
      rejectedClaims: [],
      falsePositives: [],
      testsBefore: ['npm test: failed'],
      testsAfter: ['npm test: passed'],
      testsPassed: true,
      patchAccepted: false,
      notes: 'Verified output contains Bearer [REDACTED].',
    };

    await sessionStore.put(session);
    await outcomeStore.put(outcome);
    expect(await new SessionStore({ stateRoot }).get(sessionId)).toEqual(session);
    expect(await new OutcomeStore({ stateRoot }).get(firstId)).toEqual(outcome);
    const rawBearer = ['Bearer', 'outcome-secret-value'].join(' ');
    await expect(
      outcomeStore.put({ ...outcome, notes: `Unsafe note: ${rawBearer}` }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_SHAPED_STATE' });
    expect(await outcomeStore.get(firstId)).toEqual(outcome);
    await expect(sessionStore.get('../escape')).rejects.toMatchObject({ code: 'INVALID_SESSION_ID' });
  });

  test('records outcomes only for terminal jobs and snapshots immutable job evidence', async () => {
    const jobStore = new JobStore({ stateRoot, idFactory: () => firstId });
    const outcomeStore = new OutcomeStore({ stateRoot });
    const recorder = new OutcomeRecorder({
      jobStore,
      outcomeStore,
      delegationStore: new DelegationStore({ stateRoot }),
      now: () => new Date('2026-08-12T12:00:02.000Z'),
    });
    const meta = await jobStore.create(jobInput());

    await expect(
      recorder.record({
        jobId: firstId,
        taskType: 'review',
        scope: 'repo',
        accepted: true,
        acceptedClaims: [],
        rejectedClaims: [],
        falsePositives: [],
        testsBefore: [],
        testsAfter: [],
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_JOB_NOT_TERMINAL' });

    await jobStore.transition(firstId, 'running');
    await jobStore.finalize(firstId, {
      schemaVersion: 1,
      jobId: meta.jobId,
      status: 'completed',
      requestedModel: 'sonnet',
      requestedEffort: 'high',
      resolvedModel: 'claude-sonnet-5-20260801',
      appliedEffort: 'xhigh',
      warnings: [],
      testsRun: [{ command: 'npm test', status: 'completed' }],
      finalText: 'done',
      eventsComplete: true,
      createdAt: meta.createdAt,
      completedAt: '2026-08-12T12:00:01.000Z',
      durationMs: 900,
    });
    const outcome = await recorder.record({
      jobId: firstId,
      taskType: 'review',
      scope: 'repo',
      accepted: true,
      acceptedClaims: ['finding'],
      rejectedClaims: [],
      falsePositives: [],
      testsBefore: ['npm test: failed'],
      testsAfter: ['npm test: passed'],
      testsPassed: true,
      patchAccepted: false,
      userVerdict: 'accepted',
    });

    expect(outcome).toMatchObject({
      schemaVersion: 2,
      jobId: firstId,
      taskType: 'review',
      scope: 'repo',
      requestedModel: 'sonnet',
      model: 'claude-sonnet-5-20260801',
      effort: 'xhigh',
      status: 'completed',
      durationMs: 900,
      observedTests: [{ command: 'npm test', status: 'completed' }],
      testsBefore: ['npm test: failed'],
      testsAfter: ['npm test: passed'],
      userVerdict: 'accepted',
    });
    expect(await outcomeStore.get(firstId)).toEqual(outcome);
    await expect(
      recorder.record({
        jobId: secondId,
        taskType: 'review',
        scope: 'repo',
        accepted: false,
        acceptedClaims: [],
        rejectedClaims: [],
        falsePositives: [],
        testsBefore: [],
        testsAfter: [],
      }),
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });

  test('loads validated local configuration without permitting secret fields', async () => {
    const store = new ConfigStore({ stateRoot });
    await store.put({ maxConcurrentClaudeJobs: 3, defaultTimeoutSec: 900 });

    expect(JSON.parse(await readFile(join(stateRoot, 'config.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      overrides: {
        stateRoot,
        maxConcurrentClaudeJobs: 3,
        defaultTimeoutSec: 900,
      },
    });

    expect(await store.get()).toMatchObject({
      maxConcurrentClaudeJobs: 3,
      defaultTimeoutSec: 900,
    });
    await expect(store.put({ remainingQuota: 10 })).rejects.toThrow();
  });

  test('loads a legacy resolved configuration while writing only a versioned override envelope', async () => {
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, 'config.json'),
      JSON.stringify({
        claudePath: 'claude',
        stateRoot,
        minClaudeVersion: '2.1.228',
        maxConcurrentClaudeJobs: 4,
        maxConcurrentFableJobs: 1,
        maxQueuedJobs: 8,
        maxPanelMembers: 3,
        maxDebateRounds: 2,
        defaultMaxTurns: 12,
        defaultTimeoutSec: 1800,
        cancellationGraceMs: 5000,
        staleHeartbeatMs: 30000,
        logRetentionDays: 30,
        loggingMode: 'sanitized-events',
        budgetBurnWindowHours: 24,
        budgetFinishBufferHours: 2,
        budgetBurnStartTargetBasisPoints: 2000,
        budgetHardReserveBasisPoints: 300,
        budgetNormalFreshnessMinutes: 720,
        budgetBurnFreshnessMinutes: 60,
        budgetRoundingMarginBasisPoints: 100,
        budgetMinimumSamples: 5,
      }),
      'utf8',
    );
    const store = new ConfigStore({ stateRoot });

    expect(await store.get()).toMatchObject({ stateRoot, maxConcurrentClaudeJobs: 4 });
    await store.put(await store.get());
    expect(JSON.parse(await readFile(join(stateRoot, 'config.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      overrides: { stateRoot, maxConcurrentClaudeJobs: 4 },
    });
  });

  test('preserves its managed state root when no configuration file exists yet', async () => {
    const nestedStateRoot = join(stateRoot, 'fresh-state');

    expect(await new ConfigStore({ stateRoot: nestedStateRoot }).get()).toMatchObject({
      stateRoot: nestedStateRoot,
    });
  });

  test('prunes only exact terminal job directories older than the cutoff', async () => {
    const ids = [firstId, secondId];
    let now = new Date('2026-01-01T00:00:00.000Z');
    const store = new JobStore({
      stateRoot,
      idFactory: () => ids.shift() ?? firstId,
      now: () => now,
    });
    await store.create(jobInput({ task: 'old' }));
    await store.transition(firstId, 'cancelled');
    now = new Date('2026-08-12T00:00:00.000Z');
    await store.create(jobInput({ task: 'new' }));
    await store.transition(secondId, 'cancelled');

    expect(await store.pruneOlderThan(new Date('2026-06-01T00:00:00.000Z'))).toEqual([firstId]);
    await expect(store.get(firstId)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    expect((await store.get(secondId)).status).toBe('cancelled');
    expect(join(tmpdir(), 'unrelated')).not.toContain(stateRoot);
  });
});
