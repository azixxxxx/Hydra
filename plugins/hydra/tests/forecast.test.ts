import { describe, expect, test } from 'vitest';

import {
  LocalUsageForecaster,
  usageCohortKey,
  type UsageCandidate,
  type UsageObservation,
} from '../src/forecast.js';

const candidate: UsageCandidate = {
  resolvedModel: 'claude-opus-5',
  claudeVersion: '2.1.228',
  effort: 'xhigh',
  features: {
    promptBytes: 8_000,
    roleBytes: 1_000,
    schemaBytes: 1_000,
    referencedBytes: 10_000,
    expectedTurns: 10,
    toolClass: 'analyze',
  },
};

function observation(
  multiplier: number,
  overrides: Partial<UsageObservation> = {},
): UsageObservation {
  return {
    ...candidate,
    usage: {
      inputTokens: 2_000 * multiplier,
      outputTokens: 100 * multiplier,
      cacheReadTokens: 500 * multiplier,
      cacheCreationTokens: 250 * multiplier,
    },
    completedAt: `2026-08-13T0${String(multiplier)}:00:00.000Z`,
    ...overrides,
  };
}

describe('LocalUsageForecaster', () => {
  test('keeps all reported dimensions separate and uses an empirical q95 upper ratio', () => {
    const observations = [1, 2, 3, 4, 5].map((value) => observation(value));
    const forecast = new LocalUsageForecaster({ minimumSamples: 5 }).forecast(
      candidate,
      observations,
    );

    expect(forecast).toMatchObject({
      calibrated: true,
      cohortKey: usageCohortKey(candidate),
      sampleCount: 5,
      empiricalQuantileBasisPoints: 9_500,
      orderStatisticCoverageBasisPoints: 8_333,
      predictedUsage: {
        inputTokens: 10_000,
        outputTokens: 500,
        cacheReadTokens: 2_500,
        cacheCreationTokens: 1_250,
      },
    });
    expect(forecast.upperRatesPerMillion).toEqual({
      inputTokensPerContextByte: 500_000,
      outputTokensPerTurn: 50_000_000,
      cacheReadTokensPerContextByte: 125_000,
      cacheCreationTokensPerContextByte: 62_500,
    });
  });

  test('reports the honest order-statistic coverage implied by the cohort size', () => {
    const observations = Array.from({ length: 19 }, (_, index) => observation(index + 1));
    const forecast = new LocalUsageForecaster({ minimumSamples: 5 }).forecast(
      candidate,
      observations,
    );

    expect(forecast).toMatchObject({
      calibrated: true,
      sampleCount: 19,
      empiricalQuantileBasisPoints: 9_500,
      orderStatisticCoverageBasisPoints: 9_500,
    });
  });

  test('is uncalibrated below the sample floor and never borrows another model or CLI version', () => {
    const forecaster = new LocalUsageForecaster({ minimumSamples: 5 });
    expect(forecaster.forecast(candidate, [1, 2, 3, 4].map((value) => observation(value)))).toMatchObject({
      calibrated: false,
      invalidationReason: 'INSUFFICIENT_COHORT_SAMPLES',
      sampleCount: 4,
    });
    expect(
      forecaster.forecast(
        { ...candidate, resolvedModel: 'claude-fable-5' },
        [1, 2, 3, 4, 5].map((value) => observation(value)),
      ),
    ).toMatchObject({ calibrated: false, sampleCount: 0 });
    expect(
      forecaster.forecast(
        { ...candidate, claudeVersion: '2.1.229' },
        [1, 2, 3, 4, 5].map((value) => observation(value)),
      ),
    ).toMatchObject({ calibrated: false, sampleCount: 0 });
  });

  test('starts a new cohort when context or expected-turn class changes', () => {
    const observations = [1, 2, 3, 4, 5].map((value) => observation(value));
    expect(
      new LocalUsageForecaster({ minimumSamples: 5 }).forecast(
        {
          ...candidate,
          features: { ...candidate.features, referencedBytes: 40_000 },
        },
        observations,
      ),
    ).toMatchObject({ calibrated: false, sampleCount: 0 });
    expect(
      new LocalUsageForecaster({ minimumSamples: 5 }).forecast(
        {
          ...candidate,
          features: { ...candidate.features, expectedTurns: 20 },
        },
        observations,
      ),
    ).toMatchObject({ calibrated: false, sampleCount: 0 });
  });
});
