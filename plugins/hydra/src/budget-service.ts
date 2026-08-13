import type { HydraConfig } from './config.js';
import {
  BudgetController,
  budgetBucketApplies,
  modelFamily,
  type BudgetDecision,
  type BudgetForecast,
  type InFlightBudgetReservation,
  type UsageBudgetSnapshot,
} from './budget.js';
import type {
  BudgetStore,
  BudgetReservation,
  BudgetSnapshotRecord,
} from './budget-store.js';
import {
  AllowanceCalibrator,
  allowanceObservationId,
  type AllowanceObservation,
} from './calibration.js';
import {
  HydraError,
  parseStartJobInput,
  type ReportedUsage,
  type StartJobInput,
} from './domain.js';
import {
  LocalUsageForecaster,
  usageCohortKey,
  usageFeaturesForStart,
  type LocalUsageForecast,
  type UsageCandidate,
  type UsageObservation,
} from './forecast.js';
import type { JobStore } from './stores.js';
import { PolicyEngine } from './policy.js';

const RESERVATION_STALE_MS = 30_000;

export interface BudgetEvaluation {
  readonly decision: BudgetDecision;
  readonly candidate: UsageCandidate;
  readonly localForecast: LocalUsageForecast;
  readonly allowanceForecast: BudgetForecast;
  readonly snapshotId?: string;
  readonly measurementGranularityBasisPoints?: number;
}

export interface BudgetAdmission {
  readonly decision: BudgetDecision;
  readonly reservation: BudgetReservation;
}

export interface BudgetSnapshotResult {
  readonly record: BudgetSnapshotRecord;
  readonly observationsAdded: readonly AllowanceObservation[];
}

export interface BudgetServiceDependencies {
  readonly config: HydraConfig;
  readonly jobStore: JobStore;
  readonly budgetStore: BudgetStore;
  readonly now?: () => Date;
}

function exactUsage(usage: ReportedUsage): AllowanceObservation['usage'] {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheCreationTokens === undefined
      ? {}
      : { cacheCreationTokens: usage.cacheCreationTokens }),
  };
}

function requestedModelMatches(requested: string, resolved: string): boolean {
  if (requested.startsWith('claude-')) {
    return requested === resolved;
  }
  return modelFamily(requested) === modelFamily(resolved);
}

function effectiveIntent(input: StartJobInput, policy: PolicyEngine): {
  readonly priority: 'quality-floor' | 'opportunistic';
  readonly valuableWork: boolean;
  readonly distinctInformationGain: boolean;
} {
  if (input.delegation !== undefined) {
    const delegatedSession = policy.route(input.delegation.routeInput).plan.sessions[
      input.delegation.sessionIndex
    ];
    if (delegatedSession === undefined) {
      throw new HydraError(
        'DELEGATION_SESSION_OUT_OF_RANGE',
        'The requested session is not present in the staged delegation plan',
      );
    }
    const priority = delegatedSession.activation === 'immediate'
      ? 'quality-floor' as const
      : 'opportunistic' as const;
    if (
      input.budgetIntent !== undefined &&
      input.budgetIntent.priority !== priority
    ) {
      throw new HydraError(
        'BUDGET_INTENT_CONFLICT',
        'Delegated job priority is fixed by its immutable activation plan',
        {
          plannedActivation: delegatedSession.activation,
          plannedPriority: priority,
        },
      );
    }
    return {
      priority,
      valuableWork: input.budgetIntent?.valuableWork ?? true,
      distinctInformationGain:
        input.budgetIntent?.distinctInformationGain ?? false,
    };
  }
  if (input.budgetIntent !== undefined) {
    return input.budgetIntent;
  }
  return {
    priority: 'quality-floor',
    valuableWork: true,
    distinctInformationGain: false,
  };
}

export class BudgetService {
  readonly #jobStore: JobStore;
  readonly #budgetStore: BudgetStore;
  readonly #now: () => Date;
  readonly #forecaster: LocalUsageForecaster;
  readonly #calibrator: AllowanceCalibrator;
  readonly #controller: BudgetController;
  readonly #policy: PolicyEngine;

  public constructor(dependencies: BudgetServiceDependencies) {
    this.#jobStore = dependencies.jobStore;
    this.#budgetStore = dependencies.budgetStore;
    this.#now = dependencies.now ?? ((): Date => new Date());
    this.#forecaster = new LocalUsageForecaster({
      minimumSamples: dependencies.config.budgetMinimumSamples,
    });
    this.#calibrator = new AllowanceCalibrator({
      minimumSamples: dependencies.config.budgetMinimumSamples,
    });
    this.#controller = new BudgetController({
      burnWindowHours: dependencies.config.budgetBurnWindowHours,
      finishBufferHours: dependencies.config.budgetFinishBufferHours,
      burnStartTargetBasisPoints: dependencies.config.budgetBurnStartTargetBasisPoints,
      hardReserveBasisPoints: dependencies.config.budgetHardReserveBasisPoints,
      normalFreshnessMinutes: dependencies.config.budgetNormalFreshnessMinutes,
      burnFreshnessMinutes: dependencies.config.budgetBurnFreshnessMinutes,
      roundingMarginBasisPoints: dependencies.config.budgetRoundingMarginBasisPoints,
    });
    this.#policy = new PolicyEngine({
      maxPanelMembers: dependencies.config.maxPanelMembers,
      maxDebateRounds: dependencies.config.maxDebateRounds,
    });
  }

  public async recordSnapshot(snapshot: UsageBudgetSnapshot): Promise<BudgetSnapshotResult> {
    return this.#jobStore.withAdmissionLock(async () => {
      const record = await this.#budgetStore.record(snapshot);
      const history = await this.#budgetStore.history();
      const index = history.findIndex(({ snapshotId }) => snapshotId === record.snapshotId);
      const active = await this.#budgetStore.active();
      if (index <= 0 || active?.snapshotId !== record.snapshotId) {
        return { record, observationsAdded: [] };
      }
      const previous = history[index - 1]!;
      const observationsAdded = await this.#deriveObservations(previous, record);
      return { record, observationsAdded };
    });
  }

  public async evaluate(
    value: StartJobInput,
    options: { readonly reconcile?: boolean } = {},
  ): Promise<BudgetEvaluation> {
    const input = parseStartJobInput(value);
    if (options.reconcile !== false) {
      await this.#reconcileReservations();
    }
    const [active, usageObservations, allowanceObservations, activeReservations] =
      await Promise.all([
        this.#budgetStore.active(),
        this.#jobStore.usageObservations(),
        this.#budgetStore.observations(),
        this.#budgetStore.activeReservations(),
      ]);
    const candidate = this.#candidate(input, usageObservations);
    const localForecast = this.#forecaster.forecast(candidate, usageObservations);
    const applicableBucketIds =
      active?.snapshot.buckets
        .filter((bucket) => budgetBucketApplies(bucket, candidate.resolvedModel))
        .map(({ bucketId }) => bucketId) ?? [];
    const allowanceForecast = this.#calibrator.forecast({
      candidate,
      localForecast,
      applicableBucketIds,
      observations: allowanceObservations,
    });
    const intent = effectiveIntent(input, this.#policy);
    const decision = this.#controller.decide({
      now: this.#now(),
      ...(active === undefined ? {} : { snapshot: active.snapshot }),
      model: candidate.resolvedModel,
      forecast: allowanceForecast,
      inFlightReservations: activeReservations.flatMap(({ buckets }) =>
        buckets.map(
          ({ bucketId, basisPoints }): InFlightBudgetReservation => ({
            bucketId,
            basisPoints,
          }),
        ),
      ),
      urgent: intent.priority === 'quality-floor',
      valuableWork: intent.valuableWork,
      distinctInformationGain: intent.distinctInformationGain,
      qualityFloor: { model: input.model, effort: input.effort },
    });
    return {
      decision,
      candidate,
      localForecast,
      allowanceForecast,
      ...(active === undefined ? {} : { snapshotId: active.snapshotId }),
      ...(active === undefined
        ? {}
        : {
            measurementGranularityBasisPoints:
              active.snapshot.measurementGranularityBasisPoints,
          }),
    };
  }

  public async admit(jobId: string, value: StartJobInput): Promise<BudgetAdmission> {
    const input = parseStartJobInput(value);
    const intent = effectiveIntent(input, this.#policy);
    let evaluation: BudgetEvaluation;
    try {
      evaluation = await this.evaluate(input);
    } catch (error) {
      if (
        intent.priority !== 'quality-floor' ||
        !(error instanceof HydraError) ||
        error.code !== 'BUDGET_STATE_CORRUPT'
      ) {
        throw error;
      }
      const decision: BudgetDecision = {
        mode: 'unknown',
        admission: 'quality-floor-only',
        fanOutAllowed: false,
        qualityFloor: { model: input.model, effort: input.effort },
        forecastCalibrated: false,
        forecastSampleCount: 0,
        forecastEmpiricalQuantileBasisPoints: 9_500,
        forecastOrderStatisticCoverageBasisPoints: 0,
        buckets: [],
        reasons: ['BUDGET_STATE_UNAVAILABLE_FOR_QUALITY_FLOOR'],
      };
      const reservation = await this.#budgetStore.reserve({
        jobId,
        cohortKey: usageCohortKey({
          resolvedModel: input.model,
          claudeVersion: 'unknown',
          effort: input.effort,
          features: usageFeaturesForStart(input),
        }),
        mode: decision.mode,
        admission: decision.admission,
        priority: intent.priority,
        forecastCalibrated: false,
        forecastSampleCount: 0,
        forecastEmpiricalQuantileBasisPoints: 9_500,
        forecastOrderStatisticCoverageBasisPoints: 0,
        reasons: [...decision.reasons],
        buckets: [],
      });
      return { decision, reservation };
    }
    if (evaluation.decision.admission === 'no-valuable-work' || !intent.valuableWork) {
      throw new HydraError(
        'BUDGET_NO_VALUABLE_WORK',
        'Hydra will not consume allowance without declared useful work',
      );
    }
    if (
      intent.priority === 'opportunistic' &&
      evaluation.decision.admission !== 'admit'
    ) {
      throw new HydraError(
        'BUDGET_ADMISSION_DEFERRED',
        'The calibrated allowance controller deferred opportunistic work',
        { mode: evaluation.decision.mode, reasons: [...evaluation.decision.reasons] },
      );
    }
    if (
      input.delegation !== undefined &&
      input.delegation.sessionIndex > 0 &&
      intent.priority === 'opportunistic' &&
      !evaluation.decision.fanOutAllowed
    ) {
      throw new HydraError(
        'BUDGET_FANOUT_REQUIRES_GAIN',
        'An additional Claude session requires distinct expected information gain',
        { mode: evaluation.decision.mode, reasons: [...evaluation.decision.reasons] },
      );
    }
    const reservation = await this.#budgetStore.reserve({
      jobId,
      ...(evaluation.snapshotId === undefined
        ? {}
        : { snapshotId: evaluation.snapshotId }),
      cohortKey: usageCohortKey(evaluation.candidate),
      mode: evaluation.decision.mode,
      admission: evaluation.decision.admission,
      priority: intent.priority,
      forecastCalibrated: evaluation.decision.forecastCalibrated,
      forecastSampleCount: evaluation.decision.forecastSampleCount,
      forecastEmpiricalQuantileBasisPoints:
        evaluation.decision.forecastEmpiricalQuantileBasisPoints,
      forecastOrderStatisticCoverageBasisPoints:
        evaluation.decision.forecastOrderStatisticCoverageBasisPoints,
      reasons: [...evaluation.decision.reasons],
      buckets: evaluation.decision.buckets.map(({ bucketId, forecastBasisPoints }) => ({
          bucketId,
          basisPoints: Math.max(
            forecastBasisPoints,
            evaluation.measurementGranularityBasisPoints ?? 1,
          ),
        })),
    });
    return { decision: evaluation.decision, reservation };
  }

  public release(
    jobId: string,
    reason: 'creation-failed' | 'terminal',
  ): Promise<unknown> {
    return this.#budgetStore.releaseReservation(jobId, reason);
  }

  public async status(options: { readonly reconcile?: boolean } = {}): Promise<{
    readonly active?: BudgetSnapshotRecord;
    readonly snapshotCount: number;
    readonly observationCount: number;
    readonly activeReservations: readonly BudgetReservation[];
  }> {
    if (options.reconcile !== false) {
      await this.#reconcileReservations();
    }
    const [active, history, observations, activeReservations] = await Promise.all([
      this.#budgetStore.active(),
      this.#budgetStore.history(),
      this.#budgetStore.observations(),
      this.#budgetStore.activeReservations(),
    ]);
    return {
      ...(active === undefined ? {} : { active }),
      snapshotCount: history.length,
      observationCount: observations.length,
      activeReservations,
    };
  }

  #candidate(
    input: StartJobInput,
    observations: readonly UsageObservation[],
  ): UsageCandidate {
    const identity = [...observations]
      .reverse()
      .find(({ resolvedModel }) => requestedModelMatches(input.model, resolvedModel));
    return {
      resolvedModel: identity?.resolvedModel ?? input.model,
      claudeVersion: identity?.claudeVersion ?? 'unknown',
      effort: input.effort,
      features: usageFeaturesForStart(input),
    };
  }

  async #deriveObservations(
    previous: BudgetSnapshotRecord,
    current: BudgetSnapshotRecord,
  ): Promise<readonly AllowanceObservation[]> {
    if (!current.snapshot.exclusiveHydraActivitySincePreviousSnapshot) {
      return [];
    }
    const activity = await this.#jobStore.activityOverlapping(
      previous.snapshot.capturedAt,
      current.snapshot.capturedAt,
    );
    if (activity.length === 0) {
      return [];
    }
    const completed = await Promise.all(
      activity.map(async (meta) => ({
        meta,
        result: await this.#jobStore.readResult(meta.jobId),
      })),
    );
    if (completed.some(({ meta, result }) =>
      meta.status !== 'completed' ||
      meta.claudeVersion === undefined ||
      result?.status !== 'completed' ||
      result.resolvedModel === undefined ||
      result.usage === undefined ||
      Date.parse(meta.createdAt) <= Date.parse(previous.snapshot.capturedAt) ||
      Date.parse(result.completedAt) > Date.parse(current.snapshot.capturedAt)
    )) {
      return [];
    }
    const priorBuckets = new Map(
      previous.snapshot.buckets.map((bucket) => [bucket.bucketId, bucket]),
    );
    const observations: AllowanceObservation[] = [];
    for (const { meta, result } of completed) {
      const terminal = result!;
      const candidate: UsageCandidate = {
        resolvedModel: terminal.resolvedModel!,
        claudeVersion: meta.claudeVersion!,
        effort: terminal.appliedEffort ?? meta.appliedEffort ?? meta.requestedEffort,
        features: meta.usageFeatures,
      };
      for (const bucket of current.snapshot.buckets) {
        const prior = priorBuckets.get(bucket.bucketId);
        if (
          prior === undefined ||
          prior.window !== bucket.window ||
          prior.cycleStartedAt !== bucket.cycleStartedAt ||
          prior.resetAt !== bucket.resetAt ||
          JSON.stringify(prior.appliesTo) !== JSON.stringify(bucket.appliesTo) ||
          bucket.remainingBasisPoints > prior.remainingBasisPoints ||
          !budgetBucketApplies(bucket, terminal.resolvedModel!)
        ) {
          continue;
        }
        const body: Omit<AllowanceObservation, 'observationId'> = {
          schemaVersion: 1,
          bucketId: bucket.bucketId,
          cohortKey: usageCohortKey(candidate),
          previousSnapshotId: previous.snapshotId,
          currentSnapshotId: current.snapshotId,
          jobId: meta.jobId,
          consumedBasisPoints: prior.remainingBasisPoints - bucket.remainingBasisPoints,
          measurementGranularityBasisPoints:
            current.snapshot.measurementGranularityBasisPoints,
          usage: exactUsage(terminal.usage!),
          clean: true,
          observedAt: current.snapshot.capturedAt,
        };
        const observation = { ...body, observationId: allowanceObservationId(body) };
        observations.push(await this.#budgetStore.recordObservation(observation));
      }
    }
    return observations;
  }

  async #reconcileReservations(): Promise<void> {
    for (const reservation of await this.#budgetStore.activeReservations()) {
      try {
        const meta = await this.#jobStore.get(reservation.jobId);
        if (meta.status !== 'queued' && meta.status !== 'running') {
          await this.#budgetStore.releaseReservation(reservation.jobId, 'terminal');
        }
      } catch (error) {
        if (!(error instanceof HydraError) || error.code !== 'JOB_NOT_FOUND') {
          throw error;
        }
        if (
          this.#now().getTime() - Date.parse(reservation.createdAt) >=
          RESERVATION_STALE_MS
        ) {
          await this.#budgetStore.releaseReservation(
            reservation.jobId,
            'creation-failed',
          );
        }
      }
    }
  }
}
