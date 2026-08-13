import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { BudgetForecast } from './budget.js';
import type { ReportedUsage } from './domain.js';
import type { LocalUsageForecast, UsageCandidate } from './forecast.js';
import { usageCohortKey } from './forecast.js';
import { orderStatisticCoverageBasisPoints } from './forecast.js';

const RATE_SCALE = 1_000_000n;
const UsageVectorSchema = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    cacheReadTokens: z.number().nonnegative().optional(),
    cacheCreationTokens: z.number().nonnegative().optional(),
  })
  .strict();

export const AllowanceObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    observationId: z.string().regex(/^[a-f0-9]{64}$/u),
    bucketId: z.string().trim().min(1).max(200),
    cohortKey: z.string().min(1).max(2_000),
    previousSnapshotId: z.string().regex(/^[a-f0-9]{64}$/u),
    currentSnapshotId: z.string().regex(/^[a-f0-9]{64}$/u),
    jobId: z.string().uuid(),
    consumedBasisPoints: z.number().int().min(0).max(10_000),
    measurementGranularityBasisPoints: z.number().int().min(1).max(1_000),
    usage: UsageVectorSchema,
    clean: z.boolean(),
    observedAt: z.iso.datetime(),
  })
  .strict();

export type AllowanceObservation = z.infer<typeof AllowanceObservationSchema>;

export function allowanceObservationId(
  value: Omit<AllowanceObservation, 'observationId'>,
): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function q95(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((sorted.length * 9_500) / 10_000));
  return sorted[rank - 1];
}

function ceilRate(numerator: number, denominator: number): number | undefined {
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return undefined;
  }
  return Number(
    (BigInt(Math.ceil(numerator)) * RATE_SCALE + BigInt(Math.ceil(denominator)) - 1n) /
      BigInt(Math.ceil(denominator)),
  );
}

function applyRate(rate: number | undefined, value: number | undefined): number | undefined {
  if (rate === undefined || value === undefined) {
    return undefined;
  }
  return Number(
    (BigInt(rate) * BigInt(Math.ceil(value)) + RATE_SCALE - 1n) / RATE_SCALE,
  );
}

const USAGE_DIMENSIONS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
] as const satisfies ReadonlyArray<keyof ReportedUsage>;

export class AllowanceCalibrator {
  readonly #minimumSamples: number;

  public constructor(options: { readonly minimumSamples: number }) {
    this.#minimumSamples = z.number().int().min(3).max(100).parse(options.minimumSamples);
  }

  public forecast(input: {
    readonly candidate: UsageCandidate;
    readonly localForecast: LocalUsageForecast;
    readonly applicableBucketIds: readonly string[];
    readonly observations: readonly AllowanceObservation[];
  }): BudgetForecast {
    const cohortKey = usageCohortKey(input.candidate);
    if (!input.localForecast.calibrated || input.localForecast.cohortKey !== cohortKey) {
      return {
        calibrated: false,
        cohortKey,
        sampleCount: 0,
        empiricalQuantileBasisPoints: 9_500,
        orderStatisticCoverageBasisPoints: 0,
        buckets: [],
      };
    }
    const parsed = input.observations.map((observation) =>
      AllowanceObservationSchema.parse(observation),
    );
    const bucketForecasts: Array<{
      readonly bucketId: string;
      readonly upperConsumptionBasisPoints: number;
      readonly sampleCount: number;
    }> = [];
    for (const bucketId of input.applicableBucketIds) {
      const samples = parsed.filter(
        (observation) =>
          observation.clean &&
          observation.bucketId === bucketId &&
          observation.cohortKey === cohortKey,
      );
      if (samples.length < this.#minimumSamples) {
        return {
          calibrated: false,
          cohortKey,
          sampleCount: 0,
          empiricalQuantileBasisPoints: 9_500,
          orderStatisticCoverageBasisPoints: 0,
          buckets: [],
        };
      }
      const upperConsumption = (sample: AllowanceObservation): number =>
        Math.max(
          sample.consumedBasisPoints,
          sample.measurementGranularityBasisPoints,
        );
      const candidates = [q95(samples.map(upperConsumption))];
      for (const dimension of USAGE_DIMENSIONS) {
        const upperRate = q95(
          samples.flatMap((sample) => {
            const rate = ceilRate(upperConsumption(sample), sample.usage[dimension] ?? 0);
            return rate === undefined ? [] : [rate];
          }),
        );
        candidates.push(applyRate(upperRate, input.localForecast.predictedUsage[dimension]));
      }
      const upperConsumptionBasisPoints = Math.min(
        10_000,
        Math.max(...candidates.filter((value): value is number => value !== undefined)),
      );
      bucketForecasts.push({ bucketId, upperConsumptionBasisPoints, sampleCount: samples.length });
    }
    const sampleCount =
      bucketForecasts.length === 0
        ? 0
        : Math.min(...bucketForecasts.map(({ sampleCount }) => sampleCount));
    return {
      calibrated: true,
      cohortKey,
      sampleCount,
      empiricalQuantileBasisPoints: 9_500,
      orderStatisticCoverageBasisPoints: Math.min(
        input.localForecast.orderStatisticCoverageBasisPoints,
        orderStatisticCoverageBasisPoints(sampleCount),
      ),
      buckets: bucketForecasts.map(({ bucketId, upperConsumptionBasisPoints }) => ({
        bucketId,
        upperConsumptionBasisPoints,
      })),
    };
  }
}
