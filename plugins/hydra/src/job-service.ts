import { spawn } from 'node:child_process';

import type { HydraConfig } from './config.js';
import type { HealthSummary } from './contract.js';
import type { BudgetAdmission } from './budget-service.js';
import {
  HydraError,
  parseContinueJobInput,
  parseStartJobInput,
  type ContinueJobInput,
  type JobMeta,
  type JobResult,
  type SessionRecord,
  type StartJobInput,
} from './domain.js';
import { PolicyEngine } from './policy.js';
import {
  DelegationStore,
  type DelegationGroupSummary,
  type JobAdmissionHooks,
  type JobResultView,
  type JobStore,
  type SessionStore,
} from './stores.js';

export type JobStatusRecord = JobMeta & {
  readonly delegation?: DelegationGroupSummary;
};
import {
  processIdentityAlive,
  readProcessStartMarkerWithRetry,
} from './platform/process-identity.js';

export interface WorkerIdentity {
  readonly pid: number;
  readonly processStartMarker: string;
}

export interface WorkerLauncher {
  launch(jobId: string, stateRoot: string): Promise<WorkerIdentity>;
}

export interface ProcessGroupController {
  terminate(pgid: number, processStartMarker: string, graceMs: number): Promise<boolean>;
}

export interface JobServiceDependencies {
  readonly config: HydraConfig;
  readonly jobStore: JobStore;
  readonly sessionStore: SessionStore;
  readonly launcher: WorkerLauncher;
  readonly processGroups: ProcessGroupController;
  readonly delegationStore?: DelegationStore;
  readonly budget?: {
    readonly admit: (jobId: string, input: StartJobInput) => Promise<BudgetAdmission>;
    readonly release: (
      jobId: string,
      reason: 'creation-failed' | 'terminal',
    ) => Promise<unknown>;
  };
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number, processStartMarker: string) => Promise<boolean>;
  readonly cancellationObservationMs?: number;
  readonly cancellationPollMs?: number;
}

export class DetachedWorkerLauncher implements WorkerLauncher {
  readonly #workerBundlePath: string;

  public constructor(workerBundlePath: string) {
    this.#workerBundlePath = workerBundlePath;
  }

  public launch(jobId: string, stateRoot: string): Promise<WorkerIdentity> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(
        process.execPath,
        [this.#workerBundlePath, '--job-id', jobId, '--state-root', stateRoot],
        {
          detached: true,
          shell: false,
          stdio: 'ignore',
        },
      );
      child.once('error', rejectPromise);
      child.once('spawn', () => {
        void (async (): Promise<void> => {
          const pid = child.pid;
          if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
            child.kill('SIGKILL');
            rejectPromise(new HydraError('WORKER_PID_INVALID', 'Worker returned an invalid PID'));
            return;
          }
          try {
            const processStartMarker = await readProcessStartMarkerWithRetry(pid);
            child.unref();
            resolvePromise({ pid, processStartMarker });
          } catch {
            child.kill('SIGKILL');
            rejectPromise(
              new HydraError('WORKER_IDENTITY_INVALID', 'Worker process identity was unavailable'),
            );
          }
        })().catch(rejectPromise);
      });
    });
  }
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    throw error;
  }
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

export class NodeProcessGroupController implements ProcessGroupController {
  readonly #isProcessAlive: (pid: number, marker: string) => Promise<boolean>;

  public constructor(
    isProcessAlive: (pid: number, marker: string) => Promise<boolean> = processIdentityAlive,
  ) {
    this.#isProcessAlive = isProcessAlive;
  }

  public async terminate(
    pgid: number,
    processStartMarker: string,
    graceMs: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(pgid) || pgid <= 0) {
      throw new HydraError('INVALID_PROCESS_GROUP', 'Claude process group must be a positive PID');
    }
    if (!(await this.#isProcessAlive(pgid, processStartMarker))) {
      return false;
    }
    signalProcessGroup(pgid, 'SIGTERM');
    if (!processGroupAlive(pgid)) {
      return true;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, graceMs);
    });
    if (processGroupAlive(pgid)) {
      const leaderStillExists = await this.#isProcessAlive(pgid, processStartMarker);
      if (!leaderStillExists) {
        try {
          const currentMarker = await readProcessStartMarkerWithRetry(pgid, 1);
          if (currentMarker !== processStartMarker) {
            return false;
          }
        } catch {
          // The validated leader may exit while descendants remain in its original group.
        }
      }
      signalProcessGroup(pgid, 'SIGKILL');
    }
    return true;
  }
}

export class JobService {
  readonly #config: HydraConfig;
  readonly #jobStore: JobStore;
  readonly #sessionStore: SessionStore;
  readonly #launcher: WorkerLauncher;
  readonly #processGroups: ProcessGroupController;
  readonly #delegationStore: DelegationStore;
  readonly #policy: PolicyEngine;
  readonly #budget: JobServiceDependencies['budget'];
  readonly #now: () => Date;
  readonly #isProcessAlive: (pid: number, marker: string) => Promise<boolean>;
  readonly #cancellationObservationMs: number;
  readonly #cancellationPollMs: number;

  public constructor(dependencies: JobServiceDependencies) {
    this.#config = dependencies.config;
    this.#jobStore = dependencies.jobStore;
    this.#sessionStore = dependencies.sessionStore;
    this.#launcher = dependencies.launcher;
    this.#processGroups = dependencies.processGroups;
    this.#delegationStore =
      dependencies.delegationStore ?? new DelegationStore({ stateRoot: dependencies.config.stateRoot });
    this.#policy = new PolicyEngine({
      maxPanelMembers: dependencies.config.maxPanelMembers,
      maxDebateRounds: dependencies.config.maxDebateRounds,
    });
    this.#budget = dependencies.budget;
    this.#now = dependencies.now ?? ((): Date => new Date());
    this.#isProcessAlive = dependencies.isProcessAlive ?? processIdentityAlive;
    this.#cancellationObservationMs = dependencies.cancellationObservationMs ?? 5_000;
    this.#cancellationPollMs = dependencies.cancellationPollMs ?? 25;
  }

  public async start(
    value: StartJobInput,
  ): Promise<{
    jobId: string;
    status: 'queued';
    delegationGroupId?: string;
    budget?: BudgetAdmission['decision'];
  }> {
    const input = parseStartJobInput(value);
    await this.#recoverActiveJobs();
    const jobId = this.#jobStore.newJobId();
    const delegation = this.#delegationAdmission(input, jobId);
    let budgetAdmission: BudgetAdmission | undefined;
    const meta = await this.#jobStore.createWithinCapacity(
      input,
      this.#config.maxQueuedJobs,
      {
        runtimeConfig: this.#config,
        ...delegation?.creationPatch,
      },
      jobId,
      this.#admissionHooks(input, jobId, delegation?.hooks, (admission) => {
        budgetAdmission = admission;
      }),
    );
    try {
      const worker = await this.#launcher.launch(meta.jobId, this.#config.stateRoot);
      await this.#jobStore.setWorker(meta.jobId, worker.pid, worker.processStartMarker);
      return {
        jobId: meta.jobId,
        status: 'queued',
        ...(meta.delegationGroupId === undefined
          ? {}
          : { delegationGroupId: meta.delegationGroupId }),
        ...(budgetAdmission === undefined ? {} : { budget: budgetAdmission.decision }),
      };
    } catch {
      await this.#failBeforeWorker(
        meta,
        'WORKER_LAUNCH_FAILED',
        'Hydra could not launch the background worker',
      );
      await this.#budget?.release(meta.jobId, 'terminal');
      throw new HydraError('WORKER_LAUNCH_FAILED', 'Hydra could not launch the background worker');
    }
  }

  #admissionHooks(
    input: StartJobInput,
    jobId: string,
    delegationHooks: JobAdmissionHooks | undefined,
    onBudgetAdmission: (admission: BudgetAdmission) => void,
  ): JobAdmissionHooks | undefined {
    if (this.#budget === undefined && delegationHooks === undefined) {
      return undefined;
    }
    let budgetReserved = false;
    let delegationReserved = false;
    return {
      beforeCreate: async (): Promise<void> => {
        try {
          if (this.#budget !== undefined) {
            const admission = await this.#budget.admit(jobId, input);
            budgetReserved = true;
            onBudgetAdmission(admission);
          }
          if (delegationHooks !== undefined) {
            await delegationHooks.beforeCreate();
            delegationReserved = true;
          }
        } catch (error) {
          if (budgetReserved) {
            await this.#budget!.release(jobId, 'creation-failed');
            budgetReserved = false;
          }
          throw error;
        }
      },
      rollback: async (): Promise<void> => {
        if (delegationReserved) {
          await delegationHooks!.rollback();
          delegationReserved = false;
        }
        if (budgetReserved) {
          await this.#budget!.release(jobId, 'creation-failed');
          budgetReserved = false;
        }
      },
    };
  }

  #delegationAdmission(
    input: StartJobInput,
    jobId: string,
  ):
    | {
        readonly creationPatch: {
          readonly delegationGroupId: string;
          readonly delegationPlanId: string;
          readonly delegationSessionIndex: number;
          readonly delegationActivationReason: string;
        };
        readonly hooks: JobAdmissionHooks;
      }
    | undefined {
    const activation = input.delegation;
    if (activation === undefined) {
      return undefined;
    }
    const recommendation = this.#policy.route(activation.routeInput);
    if (activation.groupId === undefined && recommendation.planId !== activation.planId) {
      throw new HydraError(
        'DELEGATION_PLAN_MISMATCH',
        'The supplied plan digest does not match Hydra routing policy',
      );
    }
    const session = recommendation.plan.sessions[activation.sessionIndex];
    if (session === undefined) {
      throw new HydraError(
        'DELEGATION_SESSION_OUT_OF_RANGE',
        'The requested session is not present in the staged delegation plan',
      );
    }
    if (
      input.model !== session.model ||
      input.effort !== session.effort ||
      input.role !== session.role
    ) {
      throw new HydraError(
        'DELEGATION_SESSION_MISMATCH',
        'Model, effort, and role must match the selected staged session',
        {
          expectedModel: session.model,
          expectedEffort: session.effort,
          expectedRole: session.role,
        },
      );
    }
    const groupId = activation.groupId ?? jobId;
    const creationPatch = {
      delegationGroupId: groupId,
      delegationPlanId: recommendation.planId,
      delegationSessionIndex: activation.sessionIndex,
      delegationActivationReason: activation.activationReason,
    } as const;
    return {
      creationPatch,
      hooks: {
        beforeCreate: async (): Promise<void> => {
          await this.#delegationStore.reserveActivation(
            {
              groupId,
              jobId,
              planId: recommendation.planId,
              suppliedPlanId: activation.planId,
              routeInput: activation.routeInput,
              route: recommendation.route,
              plan: recommendation.plan,
              sessionIndex: activation.sessionIndex,
              activationReason: activation.activationReason,
              ...(activation.evidenceJobId === undefined
                ? {}
                : { evidenceJobId: activation.evidenceJobId }),
            },
            this.#jobStore,
          );
        },
        rollback: async (): Promise<void> =>
          this.#delegationStore.rollbackActivation(groupId, jobId),
      },
    };
  }

  public async status(
    jobId?: string,
    options: { readonly recover?: boolean } = {},
  ): Promise<JobStatusRecord | readonly JobStatusRecord[]> {
    const inspect = async (meta: JobMeta): Promise<JobStatusRecord> => {
      const current = options.recover === false
        ? meta
        : await this.#recoverIfStale(
            await this.#jobStore.reconcileTerminalResult(meta.jobId),
          );
      return this.#withDelegationSummary(current);
    };
    if (jobId === undefined) {
      const records = await this.#jobStore.list(20);
      return Promise.all(records.map(inspect));
    }
    return inspect(await this.#jobStore.get(jobId));
  }

  public health(): Promise<HealthSummary> {
    return this.#jobStore.health();
  }

  public async result(
    jobId: string,
    options: {
      readonly eventOffset?: number;
      readonly eventLimit?: number;
      readonly reconcile?: boolean;
    } = {},
  ): Promise<JobResultView> {
    if (options.reconcile !== false) {
      await this.#jobStore.reconcileTerminalResult(jobId);
    }
    const view = await this.#jobStore.readView(jobId, {
      ...(options.eventOffset === undefined ? {} : { eventOffset: options.eventOffset }),
      ...(options.eventLimit === undefined ? {} : { eventLimit: options.eventLimit }),
    });
    if (view.meta.delegationGroupId === undefined) {
      return view;
    }
    return {
      ...view,
      delegation: await this.#delegationStore.summary(
        view.meta.delegationGroupId,
        this.#jobStore,
      ),
    };
  }

  public async continue(
    value: ContinueJobInput,
  ): Promise<{
    jobId: string;
    status: 'queued';
    delegationGroupId?: string;
    budget?: BudgetAdmission['decision'];
  }> {
    const input = parseContinueJobInput(value);
    await this.#recoverActiveJobs();
    const activeClaim = await this.#sessionStore.getContinuationClaim(input.sessionId);
    if (activeClaim !== undefined) {
      if (activeClaim.state === 'dispatching') {
        if (await this.#sessionStore.continuationDispatchAlive(activeClaim)) {
          throw new HydraError('SESSION_BUSY', 'Claude session continuation is being dispatched', {
            activeJobId: activeClaim.jobId,
          });
        }
        await this.#sessionStore.releaseContinuation(input.sessionId, activeClaim.jobId);
      } else {
        try {
          const active = await this.status(activeClaim.jobId);
          if ('status' in active && (active.status === 'queued' || active.status === 'running')) {
            throw new HydraError('SESSION_BUSY', 'Claude session already has an active continuation', {
              activeJobId: activeClaim.jobId,
            });
          }
        } catch (error) {
          if (!(error instanceof HydraError) || error.code !== 'JOB_NOT_FOUND') {
            throw error;
          }
        }
        await this.#sessionStore.releaseContinuation(input.sessionId, activeClaim.jobId);
      }
    }
    const reservedJobId = this.#jobStore.newJobId();
    await this.#sessionStore.claimContinuation(input.sessionId, reservedJobId);
    let session: SessionRecord;
    let meta: JobMeta | undefined;
    let budgetAdmission: BudgetAdmission | undefined;
    try {
      session = await this.#sessionStore.get(input.sessionId);
      const startInput: StartJobInput = {
        task: input.message,
        cwd: session.cwd,
        model: session.model,
        effort: input.effort ?? session.effort,
        role: session.role,
        accessMode: session.accessMode,
        maxTurns: input.maxTurns ?? session.maxTurns,
        timeoutSec: input.timeoutSec ?? session.timeoutSec,
        strictModel: session.strictModel,
        ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
      };
      meta = await this.#jobStore.createWithinCapacity(
        startInput,
        this.#config.maxQueuedJobs,
        {
          runtimeConfig: this.#config,
          resumeSessionId: input.sessionId,
          ...(session.worktreePath === undefined
            ? {}
            : { resumeWorktreePath: session.worktreePath }),
          ...(session.delegationGroupId === undefined
            ? {}
            : { delegationGroupId: session.delegationGroupId }),
          ...(session.delegationPlanId === undefined
            ? {}
            : { delegationPlanId: session.delegationPlanId }),
          ...(session.delegationSessionIndex === undefined
            ? {}
            : { delegationSessionIndex: session.delegationSessionIndex }),
          ...(session.delegationGroupId === undefined
            ? {}
            : { delegationActivationReason: 'Continuation of the same delegated Claude session.' }),
        },
        reservedJobId,
        this.#admissionHooks(startInput, reservedJobId, undefined, (admission) => {
          budgetAdmission = admission;
        }),
      );
      await this.#sessionStore.activateContinuation(input.sessionId, meta.jobId);
    } catch (error) {
      await this.#sessionStore.releaseContinuation(input.sessionId, reservedJobId);
      if (meta !== undefined) {
        await this.#failBeforeWorker(
          meta,
          error instanceof HydraError ? error.code : 'SESSION_CLAIM_FAILED',
          'Hydra could not establish exclusive continuation access to the session',
        );
        await this.#budget?.release(meta.jobId, 'terminal');
      }
      throw error;
    }
    if (meta === undefined) {
      throw new HydraError('SESSION_CLAIM_FAILED', 'Hydra continuation job was not created');
    }
    try {
      const worker = await this.#launcher.launch(meta.jobId, this.#config.stateRoot);
      await this.#jobStore.setWorker(meta.jobId, worker.pid, worker.processStartMarker);
      return {
        jobId: meta.jobId,
        status: 'queued',
        ...(meta.delegationGroupId === undefined
          ? {}
          : { delegationGroupId: meta.delegationGroupId }),
        ...(budgetAdmission === undefined ? {} : { budget: budgetAdmission.decision }),
      };
    } catch {
      await this.#sessionStore.releaseContinuation(input.sessionId, meta.jobId);
      await this.#failBeforeWorker(
        meta,
        'WORKER_LAUNCH_FAILED',
        'Hydra could not launch the continuation worker',
      );
      await this.#budget?.release(meta.jobId, 'terminal');
      throw new HydraError(
        'WORKER_LAUNCH_FAILED',
        'Hydra could not launch the continuation worker',
      );
    }
  }

  public async cancel(jobId: string): Promise<JobMeta> {
    let meta = await this.#jobStore.reconcileTerminalResult(jobId);
    if (meta.status !== 'queued' && meta.status !== 'running') {
      return meta;
    }
    meta = await this.#jobStore.beginCancellation(jobId, {
      code: 'CLAUDE_CANCELLED',
      message: 'Queued Hydra job was cancelled before Claude started',
    });
    if (meta.status === 'cancelled') {
      return meta;
    }
    if (meta.status !== 'running') {
      return meta;
    }
    let terminatedIdentity: string | undefined;
    if (meta.claudePgid !== undefined && meta.claudeProcessStartMarker !== undefined) {
      await this.#processGroups.terminate(
        meta.claudePgid,
        meta.claudeProcessStartMarker,
        this.#config.cancellationGraceMs,
      );
      terminatedIdentity = `${meta.claudePgid}\0${meta.claudeProcessStartMarker}`;
    }
    const deadline = Date.now() + this.#cancellationObservationMs;
    for (;;) {
      const current = await this.#jobStore.get(jobId);
      if (current.status !== 'running') {
        return current;
      }
      const currentIdentity =
        current.claudePgid === undefined || current.claudeProcessStartMarker === undefined
          ? undefined
          : `${current.claudePgid}\0${current.claudeProcessStartMarker}`;
      if (currentIdentity !== undefined && currentIdentity !== terminatedIdentity) {
        await this.#processGroups.terminate(
          current.claudePgid!,
          current.claudeProcessStartMarker!,
          this.#config.cancellationGraceMs,
        );
        terminatedIdentity = currentIdentity;
      }
      if (Date.now() >= deadline) {
        return (
          await this.#jobStore.finalizeCancellation(jobId, {
            code: 'CANCELLATION_WORKER_UNCONFIRMED',
            message: 'Claude was terminated but the worker did not confirm cleanup in time',
          })
        ).meta;
      }
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, this.#cancellationPollMs);
      });
    }
  }

  async #withDelegationSummary(meta: JobMeta): Promise<JobStatusRecord> {
    if (meta.delegationGroupId === undefined) {
      return meta;
    }
    return {
      ...meta,
      delegation: await this.#delegationStore.summary(
        meta.delegationGroupId,
        this.#jobStore,
      ),
    };
  }

  async #recoverIfStale(meta: JobMeta): Promise<JobMeta> {
    if (meta.status !== 'queued' && meta.status !== 'running') {
      return meta;
    }
    const reference = meta.heartbeatAt ?? meta.updatedAt;
    const age = this.#now().getTime() - new Date(reference).getTime();
    if (age <= this.#config.staleHeartbeatMs) {
      return meta;
    }
    if (
      meta.workerPid !== undefined &&
      meta.workerProcessStartMarker !== undefined &&
      (await this.#isProcessAlive(meta.workerPid, meta.workerProcessStartMarker))
    ) {
      return meta;
    }
    if (meta.claudePgid !== undefined && meta.claudeProcessStartMarker !== undefined) {
      await this.#processGroups.terminate(
        meta.claudePgid,
        meta.claudeProcessStartMarker,
        this.#config.cancellationGraceMs,
      );
    }
    const error = {
      code: 'STALE_WORKER',
      message: 'The Hydra worker heartbeat is stale and its process is absent',
    } as const;
    const completedAt = this.#now().toISOString();
    const recovered = (
      await this.#jobStore.finalize(
        meta.jobId,
        {
          schemaVersion: 1,
          jobId: meta.jobId,
          status: 'failed',
          requestedModel: meta.requestedModel,
          requestedEffort: meta.requestedEffort,
          warnings: meta.warnings,
          testsRun: [],
          finalText: '',
          eventsComplete: false,
          createdAt: meta.createdAt,
          completedAt,
          error,
        },
        { error },
      )
    ).meta;
    if (recovered.resumeSessionId !== undefined) {
      await this.#sessionStore.releaseContinuation(recovered.resumeSessionId, recovered.jobId);
    }
    return recovered;
  }

  async #recoverActiveJobs(): Promise<void> {
    await Promise.all(
      (await this.#jobStore.activeRecords()).map(async (meta) => this.#recoverIfStale(meta)),
    );
  }

  async #failBeforeWorker(meta: JobMeta, code: string, message: string): Promise<void> {
    const completedAt = this.#now().toISOString();
    const error = { code, message } as const;
    const result: JobResult = {
      schemaVersion: 1,
      jobId: meta.jobId,
      status: 'failed',
      requestedModel: meta.requestedModel,
      requestedEffort: meta.requestedEffort,
      warnings: meta.warnings,
      testsRun: [],
      finalText: '',
      eventsComplete: false,
      createdAt: meta.createdAt,
      completedAt,
      error,
    };
    await this.#jobStore.finalize(meta.jobId, result, { error });
  }
}
