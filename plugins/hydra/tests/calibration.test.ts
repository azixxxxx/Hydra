import { describe, expect, test } from 'vitest';

import type { BudgetForecast } from '../src/budget.js';
import {
  AllowanceCalibrator,
  type AllowanceObservation,
} from '../src/calibration.js';
import type { LocalUsageForecast, UsageCandidate } from '../src/forecast.js';
import { usageCohortKey } from '../src/forecast.js';

const candidate: UsageCandidate = {
  resolvedModel: 'claude-opus-5',
  claudeVersion: '2.1.228',
  effort: 'xhigh',
  features: {
    promptBytes: 20_000,
    roleBytes: 1_000,
    schemaBytes: 0,
    referencedBytes: 10_000,
    expectedTurns: 10,
    toolClass: 'analyze',
  },
};

const localForecast: LocalUsageForecast = {
  calibrated: true,
  cohortKey: usageCohortKey(candidate),
  sampleCount: 8,
  empiricalQuantileBasisPoints: 9_500,
  orderStatisticCoverageBasisPoints: 8_888,
  predictedUsage: {
    inputTokens: 4_000,
    outputTokens: 400,
    cacheReadTokens: 1_000,
    cacheCreationTokens: 500,
  },
  upperRatesPerMillion: {},
};

function observation(
  index: number,
  overrides: Partial<AllowanceObservation> = {},
): AllowanceObservation {
  return {
    schemaVersion: 1,
    observationId: String(index).padStart(64, 'a'),
    bucketId: 'weekly-all',
    cohortKey: usageCohortKey(candidate),
    previousSnapshotId: `${String(index).padStart(63, 'b')}0`,
    currentSnapshotId: `${String(index).padStart(63, 'c')}0`,
    jobId: `11111111-1111-4111-8111-11111111111${String(index)}`,
    consumedBasisPoints: 100 + index * 20,
    measurementGranularityBasisPoints: 100,
    usage: {
      inputTokens: 2_000 + index * 400,
      outputTokens: 200 + index * 40,
      cacheReadTokens: 500 + index * 100,
      cacheCreationTokens: 250 + index * 50,
    },
    clean: true,
    observedAt: `2026-08-13T0${String(index)}:00:00.000Z`,
    ...overrides,
  };
}

describe('AllowanceCalibrator', () => {
  test('derives a conservative per-bucket q95 without collapsing token dimensions', () => {
    const forecast: BudgetForecast = new AllowanceCalibrator({ minimumSamples: 3 }).forecast({
      candidate,
      localForecast,
      applicableBucketIds: ['weekly-all'],
      observations: [observation(1), observation(2), observation(3)],
    });

    expect(forecast).toMatchObject({
      calibrated: true,
      cohortKey: usageCohortKey(candidate),
      sampleCount: 3,
      empiricalQuantileBasisPoints: 9_500,
      buckets: [{ bucketId: 'weekly-all', upperConsumptionBasisPoints: 200 }],
    });
  });

  test('excludes contaminated and mismatched cohorts and requires every applicable bucket', () => {
    const calibrator = new AllowanceCalibrator({ minimumSamples: 3 });
    const result = calibrator.forecast({
      candidate,
      localForecast,
      applicableBucketIds: ['weekly-all', 'five-hour-all'],
      observations: [
        observation(1),
        observation(2, { clean: false }),
        observation(3, { cohortKey: 'different-cohort' }),
      ],
    });

    expect(result).toMatchObject({ calibrated: false, sampleCount: 0, buckets: [] });
  });

  test('does not claim quota calibration when the local usage forecast is uncalibrated', () => {
    const result = new AllowanceCalibrator({ minimumSamples: 3 }).forecast({
      candidate,
      localForecast: {
        ...localForecast,
        calibrated: false,
        sampleCount: 0,
        predictedUsage: {},
        invalidationReason: 'INSUFFICIENT_COHORT_SAMPLES',
      },
      applicableBucketIds: ['weekly-all'],
      observations: [observation(1), observation(2), observation(3)],
    });

    expect(result).toMatchObject({ calibrated: false, sampleCount: 0, buckets: [] });
  });

  test('treats a zero UI delta as censored by the declared measurement granularity', () => {
    const result = new AllowanceCalibrator({ minimumSamples: 3 }).forecast({
      candidate,
      localForecast,
      applicableBucketIds: ['weekly-all'],
      observations: [1, 2, 3].map((index) =>
        observation(index, { consumedBasisPoints: 0, measurementGranularityBasisPoints: 100 }),
      ),
    });

    expect(result).toMatchObject({
      calibrated: true,
      buckets: [{ bucketId: 'weekly-all', upperConsumptionBasisPoints: 167 }],
    });
  });
});
