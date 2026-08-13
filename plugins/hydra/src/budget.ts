import { z } from 'zod';

import { EFFORT_LEVELS, type Effort } from './domain.js';

const HOUR_MS = 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;
const BASIS_POINTS = 10_000;

const DateTimeSchema = z.iso.datetime();
const BucketModelSchema = z.enum(['sonnet', 'opus', 'fable', 'all']);

export const UsageBucketSnapshotSchema = z
  .object({
    bucketId: z.string().trim().min(1).max(200),
    displayLabel: z.string().trim().min(1).max(500),
    window: z.enum(['five-hour', 'weekly']),
    appliesTo: z.array(BucketModelSchema).min(1).max(4),
    capturedAt: DateTimeSchema,
    cycleStartedAt: DateTimeSchema,
    resetAt: DateTimeSchema,
    remainingBasisPoints: z.number().int().min(0).max(BASIS_POINTS),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.appliesTo).size !== value.appliesTo.length) {
      context.addIssue({
        code: 'custom',
        path: ['appliesTo'],
        message: 'bucket model applicability must not contain duplicates',
      });
    }
    const started = Date.parse(value.cycleStartedAt);
    const captured = Date.parse(value.capturedAt);
    const reset = Date.parse(value.resetAt);
    if (!(started <= captured && captured < reset)) {
      context.addIssue({
        code: 'custom',
        path: ['cycleStartedAt'],
        message: 'bucket cycle must start no later than capture and reset after capture',
      });
      return;
    }
    const duration = reset - started;
    const withinWindowBounds =
      value.window === 'weekly'
        ? duration >= 24 * HOUR_MS && duration <= 14 * 24 * HOUR_MS
        : duration >= HOUR_MS && duration <= 24 * HOUR_MS;
    if (!withinWindowBounds) {
      context.addIssue({
        code: 'custom',
        path: ['resetAt'],
        message: 'bucket cycle duration is outside the supported window bounds',
      });
    }
  });

export const UsageBudgetSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal('manual-settings'),
    measurementGranularityBasisPoints: z.number().int().min(1).max(1_000),
    capturedAt: DateTimeSchema,
    buckets: z.array(UsageBucketSnapshotSchema).min(1).max(20),
    usageCreditsDisabledAttestedAt: DateTimeSchema,
    exclusiveHydraActivitySincePreviousSnapshot: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const identifiers = value.buckets.map(({ bucketId }) => bucketId);
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: 'custom',
        path: ['buckets'],
        message: 'snapshot bucket IDs must be unique',
      });
    }
    for (const [index, bucket] of value.buckets.entries()) {
      if (bucket.capturedAt !== value.capturedAt) {
        context.addIssue({
          code: 'custom',
          path: ['buckets', index, 'capturedAt'],
          message: 'every bucket capture time must equal the snapshot capture time',
        });
      }
    }
    if (Date.parse(value.usageCreditsDisabledAttestedAt) > Date.parse(value.capturedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['usageCreditsDisabledAttestedAt'],
        message: 'usage-credit attestation cannot be later than the manual snapshot',
      });
    }
  });

export type UsageBucketSnapshot = z.infer<typeof UsageBucketSnapshotSchema>;
export type UsageBudgetSnapshot = z.infer<typeof UsageBudgetSnapshotSchema>;

export interface BudgetPolicy {
  readonly burnWindowHours: number;
  readonly finishBufferHours: number;
  readonly burnStartTargetBasisPoints: number;
  readonly hardReserveBasisPoints: number;
  readonly normalFreshnessMinutes: number;
  readonly burnFreshnessMinutes: number;
  readonly roundingMarginBasisPoints: number;
}

export const BudgetPolicySchema = z
  .object({
    burnWindowHours: z.number().int().min(4).max(72),
    finishBufferHours: z.number().int().min(1).max(12),
    burnStartTargetBasisPoints: z.number().int().min(500).max(5_000),
    hardReserveBasisPoints: z.number().int().min(0).max(2_000),
    normalFreshnessMinutes: z.number().int().min(60).max(24 * 60),
    burnFreshnessMinutes: z.number().int().min(15).max(6 * 60),
    roundingMarginBasisPoints: z.number().int().min(0).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.finishBufferHours >= value.burnWindowHours) {
      context.addIssue({
        code: 'custom',
        path: ['finishBufferHours'],
        message: 'finish buffer must be shorter than the burn window',
      });
    }
    if (value.hardReserveBasisPoints >= value.burnStartTargetBasisPoints) {
      context.addIssue({
        code: 'custom',
        path: ['hardReserveBasisPoints'],
        message: 'hard reserve must be below the burn-start target',
      });
    }
    if (value.burnFreshnessMinutes > value.normalFreshnessMinutes) {
      context.addIssue({
        code: 'custom',
        path: ['burnFreshnessMinutes'],
        message: 'final-burn evidence must be at least as fresh as normal evidence',
      });
    }
  });

export interface BudgetForecastBucket {
  readonly bucketId: string;
  readonly upperConsumptionBasisPoints: number;
}

export interface BudgetForecast {
  readonly calibrated: boolean;
  readonly cohortKey?: string;
  readonly sampleCount: number;
  readonly empiricalQuantileBasisPoints: number;
  readonly orderStatisticCoverageBasisPoints: number;
  readonly buckets: readonly BudgetForecastBucket[];
}

export const BudgetForecastSchema = z
  .object({
    calibrated: z.boolean(),
    cohortKey: z.string().min(1).max(2_000).optional(),
    sampleCount: z.number().int().nonnegative(),
    empiricalQuantileBasisPoints: z.number().int().min(0).max(10_000),
    orderStatisticCoverageBasisPoints: z.number().int().min(0).max(10_000),
    buckets: z.array(
      z
        .object({
          bucketId: z.string().min(1).max(200),
          upperConsumptionBasisPoints: z.number().int().min(0).max(10_000),
        })
        .strict(),
    ),
  })
  .strict();

export interface InFlightBudgetReservation {
  readonly bucketId: string;
  readonly basisPoints: number;
}

export type BudgetMode =
  | 'unknown'
  | 'uncalibrated'
  | 'conserve'
  | 'on-track'
  | 'catch-up'
  | 'final-burn'
  | 'paused';

export const BUDGET_MODES = [
  'unknown',
  'uncalibrated',
  'conserve',
  'on-track',
  'catch-up',
  'final-burn',
  'paused',
] as const satisfies readonly BudgetMode[];

export interface BucketBudgetDecision {
  readonly bucketId: string;
  readonly window: UsageBucketSnapshot['window'];
  readonly remainingBasisPoints: number;
  readonly targetRemainingBasisPoints: number;
  readonly forecastBasisPoints: number;
  readonly reservationBasisPoints: number;
  readonly marginBasisPoints: number;
  readonly lowerBoundRemainingBasisPoints: number;
  readonly surplusBasisPoints: number;
  readonly resetAt: string;
}

export interface BudgetDecision {
  readonly mode: BudgetMode;
  readonly admission: 'admit' | 'defer' | 'quality-floor-only' | 'no-valuable-work';
  readonly fanOutAllowed: boolean;
  readonly qualityFloor: Readonly<{ model: string; effort: Effort }>;
  readonly snapshotAgeMinutes?: number;
  readonly forecastCalibrated: boolean;
  readonly forecastSampleCount: number;
  readonly forecastEmpiricalQuantileBasisPoints: number;
  readonly forecastOrderStatisticCoverageBasisPoints: number;
  readonly tightestBucketId?: string;
  readonly buckets: readonly BucketBudgetDecision[];
  readonly reasons: readonly string[];
}

export const BudgetDecisionSchema = z
  .object({
    mode: z.enum(BUDGET_MODES),
    admission: z.enum(['admit', 'defer', 'quality-floor-only', 'no-valuable-work']),
    fanOutAllowed: z.boolean(),
    qualityFloor: z
      .object({
        model: z.string().min(1).max(128),
        effort: z.enum(EFFORT_LEVELS),
      })
      .strict(),
    snapshotAgeMinutes: z.number().int().nonnegative().optional(),
    forecastCalibrated: z.boolean(),
    forecastSampleCount: z.number().int().nonnegative(),
    forecastEmpiricalQuantileBasisPoints: z.number().int().min(0).max(10_000),
    forecastOrderStatisticCoverageBasisPoints: z.number().int().min(0).max(10_000),
    tightestBucketId: z.string().min(1).max(200).optional(),
    buckets: z.array(
      z
        .object({
          bucketId: z.string().min(1).max(200),
          window: z.enum(['five-hour', 'weekly']),
          remainingBasisPoints: z.number().int().min(0).max(10_000),
          targetRemainingBasisPoints: z.number().int().min(0).max(10_000),
          forecastBasisPoints: z.number().int().min(0).max(10_000),
          reservationBasisPoints: z.number().int().nonnegative(),
          marginBasisPoints: z.number().int().min(0).max(10_000),
          lowerBoundRemainingBasisPoints: z.number().int().min(0).max(10_000),
          surplusBasisPoints: z.number().int().min(-10_000).max(10_000),
          resetAt: z.iso.datetime(),
        })
        .strict(),
    ),
    reasons: z.array(z.string().min(1).max(500)).max(20),
  })
  .strict();

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function integerSquareRootFloor(value: bigint): bigint {
  if (value < 0n) {
    throw new RangeError('square root requires a non-negative integer');
  }
  if (value < 2n) {
    return value;
  }
  let left = 1n;
  let right = value;
  while (left <= right) {
    const middle = (left + right) / 2n;
    const square = middle * middle;
    if (square === value) {
      return middle;
    }
    if (square < value) {
      left = middle + 1n;
    } else {
      right = middle - 1n;
    }
  }
  return right;
}

function integerSquareRootCeil(value: bigint): bigint {
  const floor = integerSquareRootFloor(value);
  return floor * floor === value ? floor : floor + 1n;
}

export function targetRemainingBasisPoints(input: {
  readonly now: Date;
  readonly cycleStartedAt: string;
  readonly resetAt: string;
  readonly policy: BudgetPolicy;
}): number {
  const policyValue = BudgetPolicySchema.parse(input.policy);
  const started = BigInt(Date.parse(input.cycleStartedAt));
  const reset = BigInt(Date.parse(input.resetAt));
  const current = BigInt(input.now.getTime());
  if (reset <= started) {
    throw new RangeError('budget cycle reset must be after its start');
  }
  const window = reset - started;
  const remaining = current >= reset ? 0n : current <= started ? window : reset - current;
  const burn = BigInt(policyValue.burnWindowHours * HOUR_MS);
  const finish = BigInt(policyValue.finishBufferHours * HOUR_MS);
  const burnTarget = BigInt(policyValue.burnStartTargetBasisPoints);
  const reserve = BigInt(policyValue.hardReserveBasisPoints);

  if (remaining <= finish) {
    return Number(reserve);
  }
  if (remaining <= burn) {
    const zBasisPoints = ceilDiv(
      BigInt(BASIS_POINTS) * (remaining - finish),
      burn - finish,
    );
    const sqrtScaled = integerSquareRootCeil(zBasisPoints * BigInt(BASIS_POINTS));
    const zPower = ceilDiv(zBasisPoints * sqrtScaled, BigInt(BASIS_POINTS));
    const target = reserve + ceilDiv(
      (burnTarget - reserve) * zPower,
      BigInt(BASIS_POINTS),
    );
    return Number(target > burnTarget ? burnTarget : target);
  }
  if (window <= burn) {
    return policyValue.burnStartTargetBasisPoints;
  }
  const normalRemaining = remaining > window ? window : remaining;
  const target = burnTarget + ceilDiv(
    BigInt(BASIS_POINTS - policyValue.burnStartTargetBasisPoints) *
      (normalRemaining - burn),
    window - burn,
  );
  return Number(target > BigInt(BASIS_POINTS) ? BigInt(BASIS_POINTS) : target);
}

export function modelFamily(model: string): Exclude<z.infer<typeof BucketModelSchema>, 'all'> | undefined {
  for (const family of ['sonnet', 'opus', 'fable'] as const) {
    if (model === family || model.startsWith(`claude-${family}-`)) {
      return family;
    }
  }
  return undefined;
}

export function budgetBucketApplies(bucket: UsageBucketSnapshot, model: string): boolean {
  const family = modelFamily(model);
  return bucket.appliesTo.includes('all') || (family !== undefined && bucket.appliesTo.includes(family));
}

function reservationFor(
  reservations: readonly InFlightBudgetReservation[],
  bucketId: string,
): number {
  return reservations
    .filter((reservation) => reservation.bucketId === bucketId)
    .reduce((total, reservation) => total + reservation.basisPoints, 0);
}

export class BudgetController {
  readonly #policy: BudgetPolicy;

  public constructor(policy: BudgetPolicy) {
    this.#policy = BudgetPolicySchema.parse(policy);
  }

  public decide(input: {
    readonly now: Date;
    readonly snapshot?: UsageBudgetSnapshot;
    readonly model: string;
    readonly forecast: BudgetForecast;
    readonly inFlightReservations: readonly InFlightBudgetReservation[];
    readonly urgent: boolean;
    readonly valuableWork: boolean;
    readonly distinctInformationGain: boolean;
    readonly qualityFloor: Readonly<{ model: string; effort: Effort }>;
  }): BudgetDecision {
    const base = {
      qualityFloor: input.qualityFloor,
      forecastCalibrated: input.forecast.calibrated,
      forecastSampleCount: input.forecast.sampleCount,
      forecastEmpiricalQuantileBasisPoints:
        input.forecast.empiricalQuantileBasisPoints,
      forecastOrderStatisticCoverageBasisPoints:
        input.forecast.orderStatisticCoverageBasisPoints,
    } as const;
    if (input.snapshot === undefined) {
      return {
        ...base,
        mode: 'unknown',
        admission: input.urgent ? 'quality-floor-only' : 'defer',
        fanOutAllowed: false,
        buckets: [],
        reasons: ['BUDGET_SNAPSHOT_MISSING'],
      };
    }

    const snapshotValue = UsageBudgetSnapshotSchema.parse(input.snapshot);
    const applicable = snapshotValue.buckets.filter((bucket) =>
      budgetBucketApplies(bucket, input.model),
    );
    if (applicable.length === 0) {
      return {
        ...base,
        mode: 'paused',
        admission: input.urgent ? 'quality-floor-only' : 'defer',
        fanOutAllowed: false,
        buckets: [],
        reasons: ['BUDGET_BUCKET_MISSING'],
      };
    }

    const weeklyHours = applicable
      .filter(({ window }) => window === 'weekly')
      .map(({ resetAt }) => (Date.parse(resetAt) - input.now.getTime()) / HOUR_MS);
    const insideBurnWindow = weeklyHours.some(
      (hours) => hours >= 0 && hours <= this.#policy.burnWindowHours,
    );
    const snapshotAgeMs = input.now.getTime() - Date.parse(snapshotValue.capturedAt);
    const snapshotAgeMinutes = Math.max(0, Math.floor(snapshotAgeMs / MINUTE_MS));
    const freshnessMinutes = insideBurnWindow
      ? this.#policy.burnFreshnessMinutes
      : this.#policy.normalFreshnessMinutes;
    const attestationAgeMs =
      input.now.getTime() - Date.parse(snapshotValue.usageCreditsDisabledAttestedAt);
    const stale =
      snapshotAgeMs < 0 ||
      snapshotAgeMs > freshnessMinutes * MINUTE_MS ||
      attestationAgeMs < 0 ||
      attestationAgeMs > freshnessMinutes * MINUTE_MS;

    const forecastByBucket = new Map(
      input.forecast.buckets.map((item) => [item.bucketId, item.upperConsumptionBasisPoints]),
    );
    const missingForecast = applicable.some(
      ({ bucketId }) => !forecastByBucket.has(bucketId),
    );
    const buckets = applicable.map((bucket): BucketBudgetDecision => {
      const forecastBasisPoints = forecastByBucket.get(bucket.bucketId) ?? 0;
      const reservationBasisPoints = reservationFor(
        input.inFlightReservations,
        bucket.bucketId,
      );
      const target =
        bucket.window === 'weekly'
          ? targetRemainingBasisPoints({
              now: input.now,
              cycleStartedAt: bucket.cycleStartedAt,
              resetAt: bucket.resetAt,
              policy: this.#policy,
            })
          : this.#policy.hardReserveBasisPoints;
      const lowerBound = Math.max(
        0,
        bucket.remainingBasisPoints -
          forecastBasisPoints -
          reservationBasisPoints -
          this.#policy.roundingMarginBasisPoints,
      );
      return {
        bucketId: bucket.bucketId,
        window: bucket.window,
        remainingBasisPoints: bucket.remainingBasisPoints,
        targetRemainingBasisPoints: target,
        forecastBasisPoints,
        reservationBasisPoints,
        marginBasisPoints: this.#policy.roundingMarginBasisPoints,
        lowerBoundRemainingBasisPoints: lowerBound,
        surplusBasisPoints: lowerBound - target,
        resetAt: bucket.resetAt,
      };
    });
    const tightest = [...buckets].sort(
      (left, right) =>
        left.surplusBasisPoints - right.surplusBasisPoints ||
        left.bucketId.localeCompare(right.bucketId),
    )[0]!;
    const resultBase = {
      ...base,
      snapshotAgeMinutes,
      tightestBucketId: tightest.bucketId,
      buckets,
    } as const;

    if (stale) {
      return {
        ...resultBase,
        mode: 'paused',
        admission: input.urgent ? 'quality-floor-only' : 'defer',
        fanOutAllowed: false,
        reasons: ['BUDGET_SNAPSHOT_STALE'],
      };
    }
    if (!input.forecast.calibrated || missingForecast) {
      return {
        ...resultBase,
        mode: 'uncalibrated',
        admission: input.urgent ? 'quality-floor-only' : 'defer',
        fanOutAllowed: false,
        reasons: ['BUDGET_FORECAST_UNCALIBRATED'],
      };
    }

    const insideFinishBuffer = weeklyHours.some(
      (hours) => hours >= 0 && hours <= this.#policy.finishBufferHours,
    );
    if (insideFinishBuffer) {
      return {
        ...resultBase,
        mode: 'paused',
        admission: input.urgent ? 'quality-floor-only' : 'defer',
        fanOutAllowed: false,
        reasons: ['BUDGET_FINISH_BUFFER'],
      };
    }
    if (
      insideBurnWindow &&
      input.forecast.orderStatisticCoverageBasisPoints < 9_500
    ) {
      return {
        ...resultBase,
        mode: 'uncalibrated',
        admission: input.urgent ? 'quality-floor-only' : 'defer',
        fanOutAllowed: false,
        reasons: ['BUDGET_FORECAST_COVERAGE_INSUFFICIENT'],
      };
    }
    if (tightest.surplusBasisPoints < 0) {
      return {
        ...resultBase,
        mode: 'conserve',
        admission: input.urgent ? 'quality-floor-only' : 'defer',
        fanOutAllowed: false,
        reasons: ['BUDGET_NO_CONSERVATIVE_SURPLUS'],
      };
    }
    if (insideBurnWindow) {
      if (!input.valuableWork) {
        return {
          ...resultBase,
          mode: 'final-burn',
          admission: 'no-valuable-work',
          fanOutAllowed: false,
          reasons: ['BUDGET_NO_VALUABLE_WORK'],
        };
      }
      return {
        ...resultBase,
        mode: 'final-burn',
        admission: 'admit',
        fanOutAllowed: input.distinctInformationGain,
        reasons: input.distinctInformationGain
          ? ['BUDGET_VERIFIED_FINAL_BURN_SURPLUS']
          : ['BUDGET_DISTINCT_INFORMATION_GAIN_REQUIRED'],
      };
    }
    const catchUp = tightest.surplusBasisPoints > this.#policy.roundingMarginBasisPoints;
    return {
      ...resultBase,
      mode: catchUp ? 'catch-up' : 'on-track',
      admission: 'admit',
      fanOutAllowed: false,
      reasons: [catchUp ? 'BUDGET_AHEAD_OF_TARGET' : 'BUDGET_ON_TARGET'],
    };
  }
}
