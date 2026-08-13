import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import type { BudgetAdmission } from '../src/budget-service.js';
import type { JobId, SessionRecord, StartJobInput } from '../src/domain.js';
import {
  JobService,
  type ProcessGroupController,
  type WorkerLauncher,
} from '../src/job-service.js';
import { PolicyEngine, type RouteInput } from '../src/policy.js';
import { DelegationStore, JobStore, SessionStore } from '../src/stores.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const jobIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
];
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
    capsuleBytes: 12_000,
    overlap: 'high',
    partitionability: 'none',
    independentJudgmentsRequired: false,
    partitions: [],
  },
  userMode: 'auto',
};

function input(overrides: Partial<StartJobInput> = {}): StartJobInput {
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

class FakeLauncher implements WorkerLauncher {
  public readonly launches: Array<{ jobId: string; stateRoot: string }> = [];

  public launch(jobId: string, stateRoot: string): Promise<{ pid: number; processStartMarker: string }> {
    this.launches.push({ jobId, stateRoot });
    return Promise.resolve({ pid: 4321, processStartMarker: 'worker-start' });
  }
}

class FakeProcessGroups implements ProcessGroupController {
  public readonly terminated: Array<{ pgid: number; marker: string; graceMs: number }> = [];

  public terminate(pgid: number, marker: string, graceMs: number): Promise<boolean> {
    this.terminated.push({ pgid, marker, graceMs });
    return Promise.resolve(true);
  }
}

describe('JobService', () => {
  let stateRoot: string;
  let ids: string[];
  let jobStore: JobStore;
  let sessionStore: SessionStore;
  let launcher: FakeLauncher;
  let processGroups: FakeProcessGroups;

  beforeEach(async () => {
    stateRoot = await createTemporaryDirectory('hydra-job-service-');
    ids = [...jobIds];
    jobStore = new JobStore({ stateRoot, idFactory: () => ids.shift() ?? jobIds[0]! });
    sessionStore = new SessionStore({ stateRoot });
    launcher = new FakeLauncher();
    processGroups = new FakeProcessGroups();
  });

  afterEach(async () => {
    await removeTemporaryDirectory(stateRoot);
  });

  function service(overrides: {
    now?: () => Date;
    isProcessAlive?: (pid: number, marker: string) => Promise<boolean>;
    maxQueuedJobs?: number;
    defaultMaxTurns?: number;
    defaultTimeoutSec?: number;
  } = {}): JobService {
    const {
      maxQueuedJobs,
      defaultMaxTurns,
      defaultTimeoutSec,
      ...dependencyOverrides
    } = overrides;
    return new JobService({
      config: loadConfig({
        stateRoot,
        cancellationGraceMs: 250,
        ...(maxQueuedJobs === undefined ? {} : { maxQueuedJobs }),
        ...(defaultMaxTurns === undefined ? {} : { defaultMaxTurns }),
        ...(defaultTimeoutSec === undefined ? {} : { defaultTimeoutSec }),
      }),
      jobStore,
      sessionStore,
      launcher,
      processGroups,
      cancellationObservationMs: 0,
      ...dependencyOverrides,
    });
  }

  test('persists and launches a detached job before returning its ID', async () => {
    const result = await service().start(input());

    expect(result).toEqual({ jobId: jobIds[0], status: 'queued' });
    expect(launcher.launches).toEqual([{ jobId: jobIds[0], stateRoot }]);
    expect(await jobStore.get(jobIds[0]!)).toMatchObject({
      status: 'queued',
      workerPid: 4321,
      runtimeConfig: {
        stateRoot,
        claudePath: 'claude',
        maxConcurrentClaudeJobs: 2,
        loggingMode: 'sanitized-events',
      },
    });
  });

  test('marks launch failure without losing the durable job', async () => {
    const failing: WorkerLauncher = {
      launch: () => Promise.reject(new Error('worker unavailable')),
    };
    const instance = new JobService({
      config: loadConfig({ stateRoot }),
      jobStore,
      sessionStore,
      launcher: failing,
      processGroups,
    });

    await expect(instance.start(input())).rejects.toMatchObject({ code: 'WORKER_LAUNCH_FAILED' });
    expect(await jobStore.get(jobIds[0]!)).toMatchObject({
      status: 'failed',
      error: { code: 'WORKER_LAUNCH_FAILED' },
    });
    expect(await jobStore.readResult(jobIds[0]!)).toMatchObject({
      status: 'failed',
      error: { code: 'WORKER_LAUNCH_FAILED' },
    });
  });

  test('returns a single status or a bounded recent list', async () => {
    const instance = service();
    await instance.start(input({ task: 'first' }));
    await instance.start(input({ task: 'second' }));

    expect(await instance.status(jobIds[0])).toMatchObject({ jobId: jobIds[0] });
    expect(await instance.status()).toHaveLength(2);
  });

  test('applies durable queue backpressure before launching another detached worker', async () => {
    const instance = service({ maxQueuedJobs: 1 });
    await instance.start(input({ task: 'first' }));

    await expect(instance.start(input({ task: 'second' }))).rejects.toMatchObject({
      code: 'JOB_QUEUE_FULL',
    });
    expect(launcher.launches).toHaveLength(1);
  });

  test('reserves budget inside admission, returns the decision, and releases failed creation', async () => {
    const admission: BudgetAdmission = {
      decision: {
        mode: 'final-burn',
        admission: 'admit',
        fanOutAllowed: true,
        qualityFloor: { model: 'sonnet', effort: 'high' },
        forecastCalibrated: true,
        forecastSampleCount: 5,
        forecastEmpiricalQuantileBasisPoints: 9_500,
        forecastOrderStatisticCoverageBasisPoints: 8_333,
        buckets: [],
        reasons: ['BUDGET_VERIFIED_FINAL_BURN_SURPLUS'],
      },
      reservation: {
        schemaVersion: 1,
        jobId: jobIds[0]!,
        cohortKey: 'cohort',
        mode: 'final-burn',
        admission: 'admit',
        priority: 'quality-floor',
        forecastCalibrated: true,
        forecastSampleCount: 5,
        forecastEmpiricalQuantileBasisPoints: 9_500,
        forecastOrderStatisticCoverageBasisPoints: 8_333,
        reasons: ['BUDGET_VERIFIED_FINAL_BURN_SURPLUS'],
        buckets: [],
        createdAt: '2026-08-13T10:00:00.000Z',
      },
    };
    const budget = {
      admit: vi.fn(async (jobId: string) => {
        await expect(jobStore.get(jobId)).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
        return admission;
      }),
      release: vi.fn(() => Promise.resolve(undefined)),
    };
    const instance = new JobService({
      config: loadConfig({ stateRoot }),
      jobStore,
      sessionStore,
      launcher,
      processGroups,
      budget,
    });

    await expect(instance.start(input())).resolves.toEqual({
      jobId: jobIds[0],
      status: 'queued',
      budget: admission.decision,
    });
    expect(budget.admit).toHaveBeenCalledWith(jobIds[0], expect.objectContaining({ model: 'sonnet' }));

    const failing = new JobService({
      config: loadConfig({ stateRoot }),
      jobStore: new JobStore({ stateRoot, idFactory: () => jobIds[1]! }),
      sessionStore,
      launcher: { launch: () => Promise.reject(new Error('failed')) },
      processGroups,
      budget,
    });
    await expect(failing.start(input({ task: 'second' }))).rejects.toMatchObject({
      code: 'WORKER_LAUNCH_FAILED',
    });
    expect(budget.release).toHaveBeenCalledWith(jobIds[1], 'terminal');
  });

  test('keeps queue admission bounded when independent service calls start concurrently', async () => {
    const firstService = service({ maxQueuedJobs: 1 });
    const secondService = service({ maxQueuedJobs: 1 });

    const settled = await Promise.allSettled([
      firstService.start(input({ task: 'first concurrent job' })),
      secondService.start(input({ task: 'second concurrent job' })),
    ]);

    const fulfilled = settled.filter((result) => result.status === 'fulfilled');
    const rejected = settled.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'JOB_QUEUE_FULL' });
    expect(await jobStore.activeCount()).toBe(1);
    expect(launcher.launches).toHaveLength(1);
  });

  test('enforces staged activation and records why each fresh session was added', async () => {
    const recommendation = new PolicyEngine().route(architectureRouteInput);
    const delegatedInput = (
      sessionIndex: number,
      options: { readonly groupId?: string; readonly evidenceJobId?: string } = {},
    ): StartJobInput => {
      const session = recommendation.plan.sessions[sessionIndex]!;
      return input({
        model: session.model,
        effort: session.effort,
        role: session.role,
        delegation: {
          routeInput: architectureRouteInput,
          planId: recommendation.planId,
          sessionIndex,
          activationReason:
            sessionIndex === 0
              ? 'Start one architecture lead.'
              : 'The lead left the storage recovery invariant unresolved.',
          ...options,
        },
      });
    };
    const instance = service();
    const lead = await instance.start(delegatedInput(0));

    expect(lead).toEqual({
      jobId: jobIds[0],
      status: 'queued',
      delegationGroupId: jobIds[0],
    });
    await expect(
      instance.start(
        delegatedInput(1, { groupId: jobIds[0]!, evidenceJobId: jobIds[0]! }),
      ),
    ).rejects.toMatchObject({ code: 'DELEGATION_SEQUENTIAL_BUSY' });

    const running = await jobStore.transition(jobIds[0]!, 'running');
    await jobStore.finalize(jobIds[0]!, {
      schemaVersion: 1,
      jobId: running.jobId,
      status: 'completed',
      requestedModel: running.requestedModel,
      requestedEffort: running.requestedEffort,
      warnings: [],
      testsRun: [],
      finalText: 'Storage recovery remains unresolved.',
      eventsComplete: true,
      createdAt: running.createdAt,
      completedAt: new Date().toISOString(),
      usage: { inputTokens: 13, outputTokens: 5 },
    });

    const followup = await instance.start(
      delegatedInput(1, { groupId: jobIds[0]!, evidenceJobId: jobIds[0]! }),
    );
    expect(followup).toEqual({
      jobId: jobIds[2],
      status: 'queued',
      delegationGroupId: jobIds[0],
    });
    expect(await new DelegationStore({ stateRoot }).summary(jobIds[0]!, jobStore)).toMatchObject({
      activatedSessions: 2,
      jobCount: 2,
      usage: { inputTokens: 13, outputTokens: 5 },
      activations: [
        expect.objectContaining({ activationReason: 'Start one architecture lead.' }),
        expect.objectContaining({
          activationReason: 'The lead left the storage recovery invariant unresolved.',
          evidenceJobId: jobIds[0],
        }),
      ],
    });
    expect(await instance.status(jobIds[0])).toMatchObject({
      delegation: {
        groupId: jobIds[0],
        activatedSessions: 2,
        usage: { inputTokens: 13, outputTokens: 5 },
      },
    });
    expect(await instance.result(jobIds[0]!)).toMatchObject({
      delegation: {
        groupId: jobIds[0],
        activatedSessions: 2,
        usage: { inputTokens: 13, outputTokens: 5 },
      },
    });
  });

  test('rejects a tampered plan digest and a job that does not match its staged session', async () => {
    const recommendation = new PolicyEngine().route(architectureRouteInput);
    const session = recommendation.plan.sessions[0]!;
    const activation = {
      routeInput: architectureRouteInput,
      planId: recommendation.planId,
      sessionIndex: 0,
      activationReason: 'Start one architecture lead.',
    } as const;

    await expect(
      service().start(input({
        model: session.model,
        effort: session.effort,
        role: session.role,
        delegation: { ...activation, planId: '0'.repeat(64) },
      })),
    ).rejects.toMatchObject({ code: 'DELEGATION_PLAN_MISMATCH' });
    await expect(
      service().start(input({
        model: 'sonnet',
        effort: session.effort,
        role: session.role,
        delegation: activation,
      })),
    ).rejects.toMatchObject({ code: 'DELEGATION_SESSION_MISMATCH' });
    expect(await jobStore.list()).toEqual([]);
    expect(launcher.launches).toEqual([]);
  });

  test('migrates a legacy delegation digest while activating a remaining session', async () => {
    const recommendation = new PolicyEngine().route(architectureRouteInput);
    const leadSession = recommendation.plan.sessions[0]!;
    const followupSession = recommendation.plan.sessions[1]!;
    const instance = service();
    const lead = await instance.start(input({
      model: leadSession.model,
      effort: leadSession.effort,
      role: leadSession.role,
      delegation: {
        routeInput: architectureRouteInput,
        planId: recommendation.planId,
        sessionIndex: 0,
        activationReason: 'Start the legacy architecture lead.',
      },
    }));
    const running = await jobStore.transition(lead.jobId, 'running');
    await jobStore.finalize(lead.jobId, {
      schemaVersion: 1,
      jobId: running.jobId,
      status: 'completed',
      requestedModel: running.requestedModel,
      requestedEffort: running.requestedEffort,
      warnings: [],
      testsRun: [],
      finalText: 'The legacy lead left one invariant unresolved.',
      eventsComplete: true,
      createdAt: running.createdAt,
      completedAt: new Date().toISOString(),
    });

    const legacyPlan = {
      strategy: recommendation.plan.strategy,
      maxImmediateSessions: recommendation.plan.maxImmediateSessions,
      maxTotalSessions: recommendation.plan.maxTotalSessions,
      sharedContextBytes: recommendation.plan.sharedContextBytes,
      replicatedContextBytesLowerBound:
        recommendation.plan.replicatedContextBytesAllActivated,
      contextEstimateCaveat: recommendation.plan.contextEstimateCaveat,
      sessions: recommendation.plan.sessions,
    };
    const legacyPlanId = createHash('sha256')
      .update(JSON.stringify({
        routeInput: architectureRouteInput,
        route: recommendation.route,
        plan: legacyPlan,
        limits: recommendation.limits,
      }), 'utf8')
      .digest('hex');
    const delegationPath = join(stateRoot, 'delegations', `${lead.jobId}.json`);
    const persisted = JSON.parse(await readFile(delegationPath, 'utf8')) as Record<string, unknown>;
    await mkdir(join(stateRoot, 'delegations'), { recursive: true });
    await writeFile(delegationPath, JSON.stringify({
      ...persisted,
      planId: legacyPlanId,
      plan: legacyPlan,
    }), 'utf8');

    await expect(instance.start(input({
      model: followupSession.model,
      effort: followupSession.effort,
      role: followupSession.role,
      delegation: {
        routeInput: architectureRouteInput,
        planId: legacyPlanId,
        groupId: lead.jobId,
        sessionIndex: 1,
        activationReason: 'Resolve the legacy lead finding.',
        evidenceJobId: lead.jobId,
      },
    }))).resolves.toMatchObject({
      status: 'queued',
      delegationGroupId: lead.jobId,
    });

    await expect(new DelegationStore({ stateRoot }).get(lead.jobId)).resolves.toMatchObject({
      planId: recommendation.planId,
      legacyPlanId,
      plan: recommendation.plan,
      activations: [
        expect.objectContaining({ sessionIndex: 0 }),
        expect.objectContaining({ sessionIndex: 1 }),
      ],
    });
  });

  test('suppresses a conditional fresh session after the group is marked sufficient', async () => {
    const recommendation = new PolicyEngine().route(architectureRouteInput);
    const leadSession = recommendation.plan.sessions[0]!;
    const followupSession = recommendation.plan.sessions[1]!;
    const instance = service();
    const lead = await instance.start(input({
      model: leadSession.model,
      effort: leadSession.effort,
      role: leadSession.role,
      delegation: {
        routeInput: architectureRouteInput,
        planId: recommendation.planId,
        sessionIndex: 0,
        activationReason: 'Start one architecture lead.',
      },
    }));
    const running = await jobStore.transition(lead.jobId, 'running');
    await jobStore.finalize(lead.jobId, {
      schemaVersion: 1,
      jobId: running.jobId,
      status: 'completed',
      requestedModel: running.requestedModel,
      requestedEffort: running.requestedEffort,
      warnings: [],
      testsRun: [],
      finalText: 'The architecture answer is sufficient.',
      eventsComplete: true,
      createdAt: running.createdAt,
      completedAt: new Date().toISOString(),
    });
    await new DelegationStore({ stateRoot }).markSufficient(lead.jobId, lead.jobId, jobStore);

    await expect(instance.start(input({
      model: followupSession.model,
      effort: followupSession.effort,
      role: followupSession.role,
      delegation: {
        routeInput: architectureRouteInput,
        planId: recommendation.planId,
        groupId: lead.jobId,
        sessionIndex: 1,
        activationReason: 'Try to launch an unnecessary follow-up.',
        evidenceJobId: lead.jobId,
      },
    }))).rejects.toMatchObject({ code: 'DELEGATION_ALREADY_SUFFICIENT' });
    expect(launcher.launches).toHaveLength(1);
  });

  test('continues a saved Claude session with immutable context and allowed overrides', async () => {
    const session: SessionRecord = {
      schemaVersion: 1,
      sessionId,
      latestJobId: jobIds[0] as JobId,
      model: 'opus',
      effort: 'high',
      role: 'architect',
      accessMode: 'test',
      strictModel: true,
      maxTurns: 7,
      timeoutSec: 600,
      cwd: '/tmp/repository',
      updatedAt: '2026-08-12T12:00:00.000Z',
    };
    await sessionStore.put(session);

    const result = await service().continue({
      sessionId,
      message: 'Check the remaining hypothesis',
      effort: 'xhigh',
      maxTurns: 9,
      timeoutSec: 900,
      outputSchema: { type: 'object' },
    });
    const created = await jobStore.get(result.jobId);

    expect(created).toMatchObject({
      resumeSessionId: sessionId,
      input: {
        task: 'Check the remaining hypothesis',
        model: 'opus',
        effort: 'xhigh',
        role: 'architect',
        accessMode: 'test',
        maxTurns: 9,
        timeoutSec: 900,
        cwd: '/tmp/repository',
        outputSchema: { type: 'object' },
      },
    });
  });

  test('inherits durable continuation limits instead of mutable config defaults', async () => {
    const session: SessionRecord = {
      schemaVersion: 1,
      sessionId,
      latestJobId: jobIds[0] as JobId,
      model: 'sonnet',
      effort: 'high',
      role: 'reviewer',
      accessMode: 'analyze',
      strictModel: false,
      maxTurns: 7,
      timeoutSec: 600,
      cwd: '/tmp/repository',
      updatedAt: '2026-08-12T12:00:00.000Z',
    };
    await sessionStore.put(session);

    const result = await service({ defaultMaxTurns: 99, defaultTimeoutSec: 3_600 }).continue({
      sessionId,
      message: 'Continue within the original limits',
    });

    expect(await jobStore.get(result.jobId)).toMatchObject({
      input: { maxTurns: 7, timeoutSec: 600 },
    });
  });

  test('claims the session before reading the effective continuation snapshot', async () => {
    const original: SessionRecord = {
      schemaVersion: 1,
      sessionId,
      latestJobId: jobIds[0] as JobId,
      model: 'sonnet',
      effort: 'high',
      role: 'reviewer',
      accessMode: 'analyze',
      strictModel: false,
      maxTurns: 7,
      timeoutSec: 600,
      cwd: '/tmp/repository',
      updatedAt: '2026-08-12T12:00:00.000Z',
    };
    const current: SessionRecord = {
      ...original,
      latestJobId: jobIds[1] as JobId,
      maxTurns: 9,
      timeoutSec: 900,
      updatedAt: '2026-08-12T12:00:01.000Z',
    };
    await sessionStore.put(original);
    const read = sessionStore.get.bind(sessionStore);
    let reads = 0;
    vi.spyOn(sessionStore, 'get').mockImplementation(async (id) => {
      const snapshot = await read(id);
      reads += 1;
      if (reads === 1) {
        await sessionStore.put(current);
      }
      return snapshot;
    });

    const result = await service().continue({
      sessionId,
      message: 'Use the latest durable policy',
    });

    expect(await jobStore.get(result.jobId)).toMatchObject({
      input: { maxTurns: 9, timeoutSec: 900 },
    });
  });

  test('preserves worktree lineage and serializes concurrent continuations of one session', async () => {
    const worktreePath = '/tmp/hydra-preserved-worktree';
    const session: SessionRecord = {
      schemaVersion: 1,
      sessionId,
      latestJobId: jobIds[0] as JobId,
      model: 'sonnet',
      effort: 'high',
      role: 'reviewer',
      accessMode: 'execute',
      strictModel: false,
      maxTurns: 12,
      timeoutSec: 1_800,
      cwd: '/tmp/repository/packages/pkg',
      worktreePath,
      updatedAt: '2026-08-12T12:00:00.000Z',
    };
    await sessionStore.put(session);

    const [first, second] = await Promise.allSettled([
      service().continue({ sessionId, message: 'first continuation' }),
      service().continue({ sessionId, message: 'second continuation' }),
    ]);
    const fulfilled = [first, second].filter(
      (result): result is PromiseFulfilledResult<{ jobId: string; status: 'queued' }> =>
        result.status === 'fulfilled',
    );
    const rejected = [first, second].filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'SESSION_BUSY' });
    expect(await jobStore.get(fulfilled[0]!.value.jobId)).toMatchObject({
      resumeSessionId: sessionId,
      resumeWorktreePath: worktreePath,
      input: { cwd: '/tmp/repository/packages/pkg' },
    });
  });

  test('cancels queued jobs without signaling an unrelated process', async () => {
    const instance = service();
    await instance.start(input());
    const cancelled = await instance.cancel(jobIds[0]!);

    expect(cancelled.status).toBe('cancelled');
    expect(processGroups.terminated).toEqual([]);
    expect(await jobStore.readResult(jobIds[0]!)).toMatchObject({
      status: 'cancelled',
      terminationReason: 'cancelled',
      error: { code: 'CLAUDE_CANCELLED' },
    });
  });

  test('signals a job that became running after cancellation read a queued status', async () => {
    const instance = service();
    await instance.start(input());
    await jobStore.transition(jobIds[0]!, 'running');
    await jobStore.setClaudeGroup(jobIds[0]!, 7654, 'claude-start');
    const readActual = jobStore.get.bind(jobStore);
    let firstRead = true;
    vi.spyOn(jobStore, 'get').mockImplementation(async (jobId) => {
      const actual = await readActual(jobId);
      if (firstRead) {
        firstRead = false;
        return { ...actual, status: 'queued' };
      }
      return actual;
    });

    const cancelled = await instance.cancel(jobIds[0]!);

    expect(processGroups.terminated).toEqual([
      { pgid: 7654, marker: 'claude-start', graceMs: 250 },
    ]);
    expect(cancelled.status).toBe('cancelled');
  });

  test('does not signal a job that completed after cancellation read a running status', async () => {
    const instance = service();
    await instance.start(input());
    await jobStore.transition(jobIds[0]!, 'running');
    await jobStore.setClaudeGroup(jobIds[0]!, 6543, 'claude-start');
    await jobStore.transition(jobIds[0]!, 'completed');
    const readActual = jobStore.get.bind(jobStore);
    let firstRead = true;
    vi.spyOn(jobStore, 'get').mockImplementation(async (jobId) => {
      const actual = await readActual(jobId);
      if (firstRead) {
        firstRead = false;
        return { ...actual, status: 'running' };
      }
      return actual;
    });

    const completed = await instance.cancel(jobIds[0]!);

    expect(completed.status).toBe('completed');
    expect(processGroups.terminated).toEqual([]);
  });

  test('keeps an immutable completed result authoritative if completion races cancellation', async () => {
    const instance = service();
    await instance.start(input());
    const running = await jobStore.transition(jobIds[0]!, 'running');
    await jobStore.setClaudeGroup(jobIds[0]!, 6544, 'claude-start');
    const beginActual = jobStore.beginCancellation.bind(jobStore);
    vi.spyOn(jobStore, 'beginCancellation').mockImplementation(async (jobId, error) => {
      await jobStore.finalize(jobId, {
        schemaVersion: 1,
        jobId: running.jobId,
        status: 'completed',
        requestedModel: running.requestedModel,
        requestedEffort: running.requestedEffort,
        warnings: running.warnings,
        testsRun: [],
        finalText: 'won the race',
        eventsComplete: true,
        createdAt: running.createdAt,
        completedAt: new Date().toISOString(),
      });
      return beginActual(jobId, error);
    });

    const completed = await instance.cancel(jobIds[0]!);
    expect(completed.status).toBe('completed');
    expect(processGroups.terminated).toEqual([]);
    expect(await jobStore.readResult(jobIds[0]!)).toMatchObject({
      status: 'completed',
      finalText: 'won the race',
    });
  });

  test('terminates a validated Claude group before marking a running job cancelled', async () => {
    const instance = service();
    await instance.start(input());
    await jobStore.transition(jobIds[0]!, 'running');
    await jobStore.setClaudeGroup(jobIds[0]!, 9876, 'claude-start');

    const cancelled = await instance.cancel(jobIds[0]!);
    expect(processGroups.terminated).toEqual([
      { pgid: 9876, marker: 'claude-start', graceMs: 250 },
    ]);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancellationRequestedAt: expect.any(String) });
  });

  test('terminates the Claude group when it appears after cancellation was requested', async () => {
    const instance = new JobService({
      config: loadConfig({ stateRoot, cancellationGraceMs: 250 }),
      jobStore,
      sessionStore,
      launcher,
      processGroups,
      cancellationObservationMs: 100,
      cancellationPollMs: 2,
    });
    await instance.start(input());
    await jobStore.transition(jobIds[0]!, 'running');

    const cancellation = instance.cancel(jobIds[0]!);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    await jobStore.setClaudeGroup(jobIds[0]!, 8765, 'claude-start');

    const cancelled = await cancellation;
    expect(processGroups.terminated).toEqual([
      { pgid: 8765, marker: 'claude-start', graceMs: 250 },
    ]);
    expect(cancelled.status).toBe('cancelled');
  });

  test('recovers only stale running jobs whose worker is absent', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    jobStore = new JobStore({
      stateRoot,
      idFactory: () => ids.shift() ?? jobIds[0]!,
      now: () => now,
    });
    const isProcessAlive = vi.fn(() => Promise.resolve(false));
    const instance = service({
      now: () => new Date('2026-01-01T00:01:00.000Z'),
      isProcessAlive,
    });
    await instance.start(input());
    await jobStore.transition(jobIds[0]!, 'running');
    await jobStore.heartbeat(jobIds[0]!);
    now = new Date('2026-01-01T00:02:00.000Z');

    const recovered = await instance.status(jobIds[0]);
    expect(recovered).toMatchObject({
      status: 'failed',
      error: { code: 'STALE_WORKER' },
    });
    expect(isProcessAlive).toHaveBeenCalledWith(4321, 'worker-start');
    expect(await jobStore.readResult(jobIds[0]!)).toMatchObject({
      status: 'failed',
      error: { code: 'STALE_WORKER' },
    });
  });

  test('recovers a stale queued job when its detached worker died before startup', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    jobStore = new JobStore({
      stateRoot,
      idFactory: () => ids.shift() ?? jobIds[0]!,
      now: () => now,
    });
    const instance = service({
      now: () => new Date('2026-01-01T00:01:00.000Z'),
      isProcessAlive: () => Promise.resolve(false),
    });
    await instance.start(input());
    now = new Date('2026-01-01T00:02:00.000Z');

    expect(await instance.status(jobIds[0])).toMatchObject({
      status: 'failed',
      error: { code: 'STALE_WORKER' },
    });
    expect(await jobStore.readResult(jobIds[0]!)).toMatchObject({
      status: 'failed',
      error: { code: 'STALE_WORKER' },
    });
  });

  test('returns partial and terminal result views from the store', async () => {
    const instance = service();
    await instance.start(input());
    await jobStore.appendEvent(jobIds[0]!, { type: 'assistant', line: 1, text: 'partial' });

    expect(await instance.result(jobIds[0]!)).toMatchObject({
      meta: { status: 'queued' },
      events: [{ type: 'assistant', line: 1, text: 'partial' }],
    });
  });
});
