import { fileURLToPath, pathToFileURL } from 'node:url';

import { ClaudeCliAdapter, type ClaudeRunInput, type ClaudeRunResult } from './claude-cli.js';
import { ConcurrencyManager } from './concurrency.js';
import {
  HydraError,
  type ClaudeCapabilities,
  type JobId,
  type JobMeta,
  type JobResult,
  type JobStatus,
  type SafeError,
  type SessionRecord,
} from './domain.js';
import { NodeProcessRunner } from './platform/process.js';
import { PreflightService } from './preflight.js';
import { ConfigStore, JobStore, SessionStore } from './stores.js';
import { sanitizeClaudeEvent } from './stream-json.js';
import {
  WorktreeManager,
  collectWorktreeResult,
  compareSnapshots,
  snapshotRepository,
  type PreparedAccessContext,
  type RepositorySnapshot,
} from './worktrees.js';

export interface ClaudeRunner {
  run(input: ClaudeRunInput, callbacks: Parameters<ClaudeCliAdapter['run']>[1]): Promise<ClaudeRunResult>;
}

export interface WorkerPreflight {
  readonly claudeVersion: string;
  readonly capabilities: ClaudeCapabilities;
}

export interface WorkerDependencies {
  readonly jobStore: JobStore;
  readonly sessionStore: SessionStore;
  readonly concurrency: ConcurrencyManager;
  readonly worktrees: WorktreeManager;
  readonly adapter: ClaudeRunner;
  readonly preflight: (cwd: string) => Promise<WorkerPreflight>;
  readonly collectEvidence?: (
    prepared: PreparedAccessContext,
  ) => Promise<{ readonly evidence: JobResult['worktree']; readonly analyzeChanged: boolean }>;
  readonly now?: () => Date;
}

function safeError(error: unknown): SafeError {
  if (error instanceof HydraError) {
    return error.toSafeError();
  }
  return {
    code: 'WORKER_FAILED',
    message: error instanceof Error ? error.message : 'Hydra worker failed',
  };
}

function terminalStatus(summary: ClaudeRunResult, current: JobMeta): JobStatus {
  if (current.status === 'cancelled' || current.cancellationRequestedAt !== undefined) {
    return 'cancelled';
  }
  if (summary.timedOut) {
    return 'timed-out';
  }
  if (summary.aborted) {
    return 'cancelled';
  }
  if (
    summary.unexpectedModelUsage === true ||
    (summary.modelMismatch && current.input.strictModel) ||
    summary.usageCreditsRequired === true ||
    summary.isError ||
    summary.turnLimitReached ||
    summary.exitCode !== 0 ||
    summary.parseErrors.length > 0
  ) {
    return 'failed';
  }
  return 'completed';
}

function statusError(status: JobStatus, summary: ClaudeRunResult): SafeError | undefined {
  if (status === 'timed-out') {
    return { code: 'CLAUDE_TIMED_OUT', message: 'Claude exceeded the Hydra timeout' };
  }
  if (status === 'cancelled') {
    return { code: 'CLAUDE_CANCELLED', message: 'Claude execution was cancelled' };
  }
  if (status === 'failed') {
    if (summary.usageCreditsRequired === true) {
      return {
        code: 'USAGE_CREDITS_REQUIRED',
        message: 'Claude reported that this invocation requires usage credits',
      };
    }
    if (summary.modelMismatch) {
      return {
        code: 'MODEL_MISMATCH',
        message: 'Claude reported a model different from the explicit Hydra request',
      };
    }
    if (summary.turnLimitReached) {
      return { code: 'CLAUDE_TURN_LIMIT', message: 'Claude exceeded the Hydra turn limit' };
    }
    if (summary.parseErrors.length > 0) {
      return { code: 'CLAUDE_STREAM_INVALID', message: 'Claude emitted malformed stream events' };
    }
    return { code: 'CLAUDE_EXECUTION_FAILED', message: 'Claude execution failed' };
  }
  return undefined;
}

async function repositoryEvidence(
  prepared: PreparedAccessContext,
): Promise<{ evidence: JobResult['worktree']; analyzeChanged: boolean }> {
  if (prepared.accessMode === 'analyze') {
    const after = await snapshotRepository(prepared.repositoryRoot);
    const difference = compareSnapshots(prepared.beforeSnapshot!, after);
    const evidence: JobResult['worktree'] = {
      path: prepared.repositoryRoot,
      changedFiles: difference.changed ? pathsChangedBetween(prepared.beforeSnapshot!, after) : [],
      mainCheckoutChanged: difference.changed,
      beforeFingerprint: prepared.beforeSnapshot!.fingerprint,
      afterFingerprint: after.fingerprint,
    };
    return { evidence, analyzeChanged: difference.changed };
  }
  const evidence = await collectWorktreeResult(prepared.cwd, prepared.beforeSnapshot);
  return { evidence, analyzeChanged: false };
}

function pathsChangedBetween(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
): string[] {
  const entryMap = (snapshot: RepositorySnapshot): Map<string, string> =>
    new Map(
      [...snapshot.untrackedEntries, ...snapshot.ignoredEntries].map((entry) => [
        entry.path,
        `${entry.mode}:${entry.size}:${entry.contentId}`,
      ]),
    );
  const beforeEntries = entryMap(before);
  const afterEntries = entryMap(after);
  const changed = new Set<string>();
  for (const path of new Set([...beforeEntries.keys(), ...afterEntries.keys()])) {
    if (beforeEntries.get(path) !== afterEntries.get(path)) {
      changed.add(path);
    }
  }
  if (
    before.statusPorcelain !== after.statusPorcelain ||
    before.stagedPatch !== after.stagedPatch ||
    before.unstagedPatch !== after.unstagedPatch ||
    JSON.stringify(before.trackedEntries) !== JSON.stringify(after.trackedEntries)
  ) {
    changed.add('[tracked-repository-state]');
  }
  return [...changed].sort();
}

function resultFromSummary(
  meta: JobMeta,
  summary: ClaudeRunResult,
  status: JobStatus,
  completedAt: string,
  evidence: JobResult['worktree'],
  error?: SafeError,
): JobResult {
  const terminationReason =
    status === 'cancelled'
      ? 'cancelled'
      : status === 'timed-out'
        ? 'timed-out'
        : summary.terminationReason;
  return {
    schemaVersion: 1,
    jobId: meta.jobId,
    status,
    requestedModel: meta.requestedModel,
    requestedEffort: meta.requestedEffort,
    warnings: [...meta.warnings, ...summary.warnings],
    testsRun: summary.testsRun ?? [],
    finalText: summary.finalText,
    eventsComplete: summary.eventsComplete,
    createdAt: meta.createdAt,
    completedAt,
    ...(summary.structuredOutput === undefined ? {} : { structuredOutput: summary.structuredOutput }),
    ...(summary.resolvedModel === undefined ? {} : { resolvedModel: summary.resolvedModel }),
    ...(summary.reportedModels === undefined ? {} : { reportedModels: summary.reportedModels }),
    ...(summary.canonicalModelId === undefined ? {} : { canonicalModelId: summary.canonicalModelId }),
    ...(summary.appliedEffort === undefined ? {} : { appliedEffort: summary.appliedEffort }),
    ...(summary.sessionId === undefined ? {} : { sessionId: summary.sessionId }),
    ...(summary.usage === undefined ? {} : { usage: summary.usage }),
    turns: summary.turns,
    ...(summary.reportedSessionTurns === undefined
      ? {}
      : { reportedSessionTurns: summary.reportedSessionTurns }),
    ...(summary.durationMs === undefined ? {} : { durationMs: summary.durationMs }),
    ...(terminationReason === undefined ? {} : { terminationReason }),
    ...(evidence === undefined ? {} : { worktree: evidence }),
    ...(error === undefined ? {} : { error }),
  };
}

async function writeFailure(
  jobId: JobId,
  dependencies: WorkerDependencies,
  error: unknown,
): Promise<void> {
  const meta = await dependencies.jobStore.get(jobId);
  if (meta.status === 'completed' || meta.status === 'failed' || meta.status === 'timed-out') {
    return;
  }
  const cancellationRequested =
    meta.status === 'cancelled' || meta.cancellationRequestedAt !== undefined;
  const failure = cancellationRequested
    ? { code: 'CLAUDE_CANCELLED', message: 'Claude execution was cancelled' }
    : safeError(error);
  const terminalStatus: JobStatus = cancellationRequested ? 'cancelled' : 'failed';
  const completedAt = (dependencies.now ?? ((): Date => new Date()))().toISOString();
  const result: JobResult = {
    schemaVersion: 1,
    jobId,
    status: terminalStatus,
    requestedModel: meta.requestedModel,
    requestedEffort: meta.requestedEffort,
    warnings: meta.warnings,
    testsRun: [],
    finalText: '',
    eventsComplete: false,
    createdAt: meta.createdAt,
    completedAt,
    ...(cancellationRequested ? { terminationReason: 'cancelled' } : {}),
    error: failure,
  };
  await dependencies.jobStore.finalize(jobId, result, { error: failure });
}

export async function runWorker(jobId: JobId, dependencies: WorkerDependencies): Promise<void> {
  const now = dependencies.now ?? ((): Date => new Date());
  let lease: Awaited<ReturnType<ConcurrencyManager['acquire']>> | undefined;
  try {
    let meta = await dependencies.jobStore.get(jobId);
    if (meta.status === 'cancelled') {
      return;
    }
    if (meta.status !== 'queued') {
      throw new HydraError('WORKER_JOB_NOT_QUEUED', 'Hydra worker requires a queued job');
    }
    lease = await dependencies.concurrency.acquire({
      jobId,
      model: meta.requestedModel,
      isCancelled: async () => (await dependencies.jobStore.get(jobId)).status === 'cancelled',
    });
    meta = await dependencies.jobStore.get(jobId);
    if (meta.status === 'cancelled') {
      return;
    }
    const preflight = await dependencies.preflight(meta.input.cwd);
    const prepared = await dependencies.worktrees.prepare(meta);
    meta = await dependencies.jobStore.transition(jobId, 'running', {
      claudeVersion: preflight.claudeVersion,
      capabilities: preflight.capabilities,
      heartbeatAt: now().toISOString(),
      ...(prepared.worktreePath === undefined ? {} : { worktreePath: prepared.worktreePath }),
    });
    const summary = await dependencies.adapter.run(
      {
        task: meta.input.task,
        role: meta.input.role,
        cwd: prepared.cwd,
        model: meta.input.model,
        effort: meta.input.effort,
        accessMode: meta.input.accessMode,
        maxTurns: meta.input.maxTurns,
        timeoutSec: meta.input.timeoutSec,
        emptyMcpPath: prepared.emptyMcpPath,
        ...(meta.input.outputSchema === undefined ? {} : { outputSchema: meta.input.outputSchema }),
        ...(meta.resumeSessionId === undefined ? {} : { resumeSessionId: meta.resumeSessionId }),
        strictModel: meta.input.strictModel,
      },
      {
        settingsPath: prepared.settingsPath,
        onEvent: async (event) => {
          await dependencies.jobStore.appendEvent(jobId, sanitizeClaudeEvent(event));
        },
        onStderr: async (chunk) => {
          await dependencies.jobStore.appendStderr(jobId, chunk);
        },
        onHeartbeat: async () => {
          await Promise.all([dependencies.jobStore.heartbeat(jobId), lease?.heartbeat()]);
        },
        onProcessGroup: async (pgid, processStartMarker) => {
          await dependencies.jobStore.setClaudeGroup(jobId, pgid, processStartMarker);
        },
      },
    );
    const current = await dependencies.jobStore.get(jobId);
    let status = terminalStatus(summary, current);
    let error = statusError(status, summary);
    const { evidence, analyzeChanged } = await (
      dependencies.collectEvidence ?? repositoryEvidence
    )(prepared);
    if (analyzeChanged) {
      status = 'failed';
      error = {
        code: 'ANALYZE_REPOSITORY_CHANGED',
        message: 'Analyze mode observed a repository change and preserved it for inspection',
      };
    }
    const completedAt = now().toISOString();
    const result = resultFromSummary(current, summary, status, completedAt, evidence, error);

    if (summary.sessionId !== undefined) {
      const session: SessionRecord = {
        schemaVersion: 1,
        sessionId: summary.sessionId,
        latestJobId: jobId,
        model: current.input.model,
        effort: current.input.effort,
        role: current.input.role,
        accessMode: current.input.accessMode,
        strictModel: current.input.strictModel,
        maxTurns: current.input.maxTurns,
        timeoutSec: current.input.timeoutSec,
        cwd: current.input.cwd,
        ...(prepared.worktreePath === undefined
          ? {}
          : { worktreePath: prepared.worktreePath }),
        ...(current.delegationGroupId === undefined
          ? {}
          : { delegationGroupId: current.delegationGroupId }),
        ...(current.delegationPlanId === undefined
          ? {}
          : { delegationPlanId: current.delegationPlanId }),
        ...(current.delegationSessionIndex === undefined
          ? {}
          : { delegationSessionIndex: current.delegationSessionIndex }),
        updatedAt: completedAt,
      };
      await dependencies.sessionStore.put(session);
    }
    await dependencies.jobStore.finalize(jobId, result, {
      warnings: result.warnings,
      ...(summary.resolvedModel === undefined ? {} : { resolvedModel: summary.resolvedModel }),
      ...(summary.canonicalModelId === undefined
        ? {}
        : { canonicalModelId: summary.canonicalModelId }),
      ...(summary.appliedEffort === undefined ? {} : { appliedEffort: summary.appliedEffort }),
      ...(summary.sessionId === undefined ? {} : { sessionId: summary.sessionId }),
      ...(error === undefined ? {} : { error }),
    });
  } catch (error) {
    await writeFailure(jobId, dependencies, error);
  } finally {
    const finalMeta = await dependencies.jobStore.get(jobId).catch(() => undefined);
    if (finalMeta?.resumeSessionId !== undefined) {
      await dependencies.sessionStore.releaseContinuation(finalMeta.resumeSessionId, jobId);
    }
    await lease?.release();
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function productionMain(): Promise<void> {
  const jobIdValue = argument('--job-id');
  const stateRoot = argument('--state-root');
  if (jobIdValue === undefined || stateRoot === undefined) {
    throw new HydraError('WORKER_ARGUMENTS_INVALID', 'Worker requires --job-id and --state-root');
  }
  const jobId = jobIdValue as JobId;
  const currentConfig = await new ConfigStore({ stateRoot }).get();
  const bootstrapStore = new JobStore({
    stateRoot,
    loggingMode: currentConfig.loggingMode,
  });
  const queuedMeta = await bootstrapStore.get(jobId);
  const config = queuedMeta.runtimeConfig ?? currentConfig;
  if (config.stateRoot !== stateRoot) {
    throw new HydraError(
      'JOB_RUNTIME_CONFIG_INVALID',
      'The immutable job runtime config targets a different state root',
    );
  }
  const jobStore =
    config.loggingMode === currentConfig.loggingMode
      ? bootstrapStore
      : new JobStore({ stateRoot, loggingMode: config.loggingMode });
  const sessionStore = new SessionStore({ stateRoot });
  const preflightService = new PreflightService({
    config,
    runner: new NodeProcessRunner(),
  });
  let invocationCapabilities: ClaudeCapabilities | undefined;
  const preflight = async (cwd: string): Promise<WorkerPreflight> => {
    if (queuedMeta.runtimeConfig === undefined) {
      throw new HydraError(
        'JOB_RUNTIME_CONFIG_MISSING',
        'The queued job predates the immutable Hydra runtime-config contract',
      );
    }
    const preflightResult = await preflightService.check({ cwd });
    if (!preflightResult.ok || preflightResult.claudeVersion === null) {
      throw new HydraError('PREFLIGHT_FAILED', 'Hydra preflight rejected the Claude invocation', {
        codes: preflightResult.errors.map(({ code }) => code),
      });
    }
    invocationCapabilities = preflightResult.capabilities;
    return {
      claudeVersion: preflightResult.claudeVersion,
      capabilities: preflightResult.capabilities,
    };
  };
  const adapter: ClaudeRunner = {
    run: (input, callbacks) => {
      if (invocationCapabilities === undefined) {
        throw new HydraError(
          'PREFLIGHT_REQUIRED',
          'Claude cannot start before the worker completes preflight',
        );
      }
      return new ClaudeCliAdapter({
        claudePath: config.claudePath,
        capabilities: invocationCapabilities,
        terminationGraceMs: config.cancellationGraceMs,
      }).run(input, callbacks);
    },
  };
  await runWorker(jobId, {
    jobStore,
    sessionStore,
    concurrency: new ConcurrencyManager({
      stateRoot,
      maxConcurrentClaudeJobs: config.maxConcurrentClaudeJobs,
      maxConcurrentFableJobs: config.maxConcurrentFableJobs,
      staleHeartbeatMs: config.staleHeartbeatMs,
    }),
    worktrees: new WorktreeManager({ stateRoot }),
    adapter,
    preflight,
  });
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(executedPath).href
) {
  productionMain().catch((error: unknown) => {
    console.error(error instanceof HydraError ? error.code : 'WORKER_FAILED');
    process.exitCode = 1;
  });
}
