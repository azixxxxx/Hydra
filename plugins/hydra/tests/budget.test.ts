import { describe, expect, test } from 'vitest';

import {
  BudgetController,
  UsageBudgetSnapshotSchema,
  targetRemainingBasisPoints,
  type BudgetForecast,
  type BudgetPolicy,
  type UsageBudgetSnapshot,
} from '../src/budget.js';

const HOUR_MS = 60 * 60 * 1_000;
const now = new Date('2026-08-13T12:00:00.000Z');

const policy: BudgetPolicy = {
  burnWindowHours: 24,
  finishBufferHours: 2,
  burnStartTargetBasisPoints: 2_000,
  hardReserveBasisPoints: 300,
  normalFreshnessMinutes: 720,
  burnFreshnessMinutes: 60,
  roundingMarginBasisPoints: 100,
};

function snapshot(overrides: Partial<UsageBudgetSnapshot> = {}): UsageBudgetSnapshot {
  return {
    schemaVersion: 1,
    source: 'manual-settings',
    measurementGranularityBasisPoints: 100,
    capturedAt: now.toISOString(),
    usageCreditsDisabledAttestedAt: now.toISOString(),
    exclusiveHydraActivitySincePreviousSnapshot: true,
    buckets: [
      {
        bucketId: 'weekly-all',
        displayLabel: 'Weekly all models',
        window: 'weekly',
        appliesTo: ['all'],
        capturedAt: now.toISOString(),
        cycleStartedAt: new Date(now.getTime() - 156 * HOUR_MS).toISOString(),
        resetAt: new Date(now.getTime() + 12 * HOUR_MS).toISOString(),
        remainingBasisPoints: 5_000,
      },
      {
        bucketId: 'five-hour-all',
        displayLabel: 'Current five-hour window',
        window: 'five-hour',
        appliesTo: ['all'],
        capturedAt: now.toISOString(),
        cycleStartedAt: new Date(now.getTime() - HOUR_MS).toISOString(),
        resetAt: new Date(now.getTime() + 4 * HOUR_MS).toISOString(),
        remainingBasisPoints: 4_000,
      },
    ],
    ...overrides,
  };
}

function forecast(overrides: Partial<BudgetForecast> = {}): BudgetForecast {
  return {
    calibrated: true,
    cohortKey: 'claude-opus-5\0xhigh\0analyze\0medium',
    sampleCount: 20,
    empiricalQuantileBasisPoints: 9_500,
    orderStatisticCoverageBasisPoints: 9_523,
    buckets: [
      { bucketId: 'weekly-all', upperConsumptionBasisPoints: 300 },
      { bucketId: 'five-hour-all', upperConsumptionBasisPoints: 500 },
    ],
    ...overrides,
  };
}

describe('fixed-point weekly pacing', () => {
  test('hits the documented weekly boundary targets exactly', () => {
    const at = (hoursUntilReset: number): number => {
      const resetAt = new Date(now.getTime() + hoursUntilReset * HOUR_MS);
      return targetRemainingBasisPoints({
        now,
        cycleStartedAt: new Date(resetAt.getTime() - 168 * HOUR_MS).toISOString(),
        resetAt: resetAt.toISOString(),
        policy,
      });
    };

    expect(at(168)).toBe(10_000);
    expect(at(24)).toBe(2_000);
    expect(at(2)).toBe(300);
    expect(at(0)).toBe(300);
  });

  test('is monotonic and bounded without floating-point admission comparisons', () => {
    const cycleStartedAt = new Date(now.getTime() - 168 * HOUR_MS).toISOString();
    const values = Array.from({ length: 169 }, (_, hoursUntilReset) =>
      targetRemainingBasisPoints({
        now,
        cycleStartedAt,
        resetAt: new Date(now.getTime() + hoursUntilReset * HOUR_MS).toISOString(),
        policy,
      }),
    );

    expect(values.every((value) => Number.isInteger(value) && value >= 300 && value <= 10_000)).toBe(
      true,
    );
    expect(values.every((value, index) => index === 0 || value >= values[index - 1]!)).toBe(true);
  });
});

describe('manual usage snapshots', () => {
  test('accepts opaque unique bucket labels and integer basis points', () => {
    expect(UsageBudgetSnapshotSchema.parse(snapshot())).toEqual(snapshot());
  });

  test('rejects duplicate bucket IDs, invalid ordering, and non-integer percentages', () => {
    const valid = snapshot();
    expect(() =>
      UsageBudgetSnapshotSchema.parse({
        ...valid,
        buckets: [valid.buckets[0], { ...valid.buckets[0] }],
      }),
    ).toThrow(/bucket/i);
    expect(() =>
      UsageBudgetSnapshotSchema.parse({
        ...valid,
        buckets: [
          {
            ...valid.buckets[0],
            cycleStartedAt: valid.buckets[0]!.resetAt,
          },
        ],
      }),
    ).toThrow(/cycle|reset/i);
    expect(() =>
      UsageBudgetSnapshotSchema.parse({
        ...valid,
        buckets: [{ ...valid.buckets[0], remainingBasisPoints: 99.5 }],
      }),
    ).toThrow(/integer|basis/i);
  });
});

describe('BudgetController', () => {
  test('enters final burn only with fresh calibrated surplus in every applicable bucket', () => {
    const decision = new BudgetController(policy).decide({
      now,
      snapshot: snapshot(),
      model: 'opus',
      forecast: forecast(),
      inFlightReservations: [],
      urgent: false,
      valuableWork: true,
      distinctInformationGain: true,
      qualityFloor: { model: 'opus', effort: 'xhigh' },
    });

    expect(decision).toMatchObject({
      mode: 'final-burn',
      admission: 'admit',
      fanOutAllowed: true,
      qualityFloor: { model: 'opus', effort: 'xhigh' },
      tightestBucketId: 'five-hour-all',
    });
    expect(decision.buckets).toHaveLength(2);
    expect(decision.buckets.every(({ surplusBasisPoints }) => surplusBasisPoints > 0)).toBe(true);
  });

  test('uses the tightest bucket and conserves when any applicable bucket cannot fit', () => {
    const decision = new BudgetController(policy).decide({
      now,
      snapshot: snapshot({
        buckets: snapshot().buckets.map((bucket) =>
          bucket.bucketId === 'five-hour-all'
            ? { ...bucket, remainingBasisPoints: 700 }
            : bucket,
        ),
      }),
      model: 'opus',
      forecast: forecast(),
      inFlightReservations: [],
      urgent: false,
      valuableWork: true,
      distinctInformationGain: true,
      qualityFloor: { model: 'opus', effort: 'xhigh' },
    });

    expect(decision).toMatchObject({
      mode: 'conserve',
      admission: 'defer',
      fanOutAllowed: false,
      tightestBucketId: 'five-hour-all',
    });
  });

  test('disables aggressive routing for stale or uncalibrated evidence', () => {
    const stale = new BudgetController(policy).decide({
      now,
      snapshot: snapshot({
        capturedAt: new Date(now.getTime() - 61 * 60 * 1_000).toISOString(),
        usageCreditsDisabledAttestedAt: new Date(
          now.getTime() - 61 * 60 * 1_000,
        ).toISOString(),
        buckets: snapshot().buckets.map((bucket) => ({
          ...bucket,
          capturedAt: new Date(now.getTime() - 61 * 60 * 1_000).toISOString(),
          ...(bucket.window === 'five-hour'
            ? { cycleStartedAt: new Date(now.getTime() - 2 * HOUR_MS).toISOString() }
            : {}),
        })),
      }),
      model: 'opus',
      forecast: forecast(),
      inFlightReservations: [],
      urgent: false,
      valuableWork: true,
      distinctInformationGain: true,
      qualityFloor: { model: 'opus', effort: 'xhigh' },
    });
    expect(stale).toMatchObject({ mode: 'paused', admission: 'defer', fanOutAllowed: false });
    expect(stale.reasons).toContain('BUDGET_SNAPSHOT_STALE');

    const uncalibrated = new BudgetController(policy).decide({
      now,
      snapshot: snapshot(),
      model: 'opus',
      forecast: forecast({ calibrated: false, sampleCount: 0, buckets: [] }),
      inFlightReservations: [],
      urgent: true,
      valuableWork: true,
      distinctInformationGain: true,
      qualityFloor: { model: 'opus', effort: 'xhigh' },
    });
    expect(uncalibrated).toMatchObject({
      mode: 'uncalibrated',
      admission: 'quality-floor-only',
      fanOutAllowed: false,
      qualityFloor: { model: 'opus', effort: 'xhigh' },
    });
  });

  test('refuses final burn until the empirical upper bound reaches 95 percent coverage', () => {
    const decision = new BudgetController(policy).decide({
      now,
      snapshot: snapshot(),
      model: 'opus',
      forecast: forecast({
        sampleCount: 5,
        orderStatisticCoverageBasisPoints: 8_333,
      }),
      inFlightReservations: [],
      urgent: false,
      valuableWork: true,
      distinctInformationGain: true,
      qualityFloor: { model: 'opus', effort: 'xhigh' },
    });

    expect(decision).toMatchObject({
      mode: 'uncalibrated',
      admission: 'defer',
      fanOutAllowed: false,
      forecastSampleCount: 5,
      forecastOrderStatisticCoverageBasisPoints: 8_333,
    });
    expect(decision.reasons).toContain('BUDGET_FORECAST_COVERAGE_INSUFFICIENT');
  });

  test('stops non-urgent admission in the two-hour finish buffer and never invents burn work', () => {
    const finishSnapshot = snapshot({
      buckets: snapshot().buckets.map((bucket) =>
        bucket.window === 'weekly'
          ? { ...bucket, resetAt: new Date(now.getTime() + 2 * HOUR_MS).toISOString() }
          : bucket,
      ),
    });
    const stopped = new BudgetController(policy).decide({
      now,
      snapshot: finishSnapshot,
      model: 'opus',
      forecast: forecast(),
      inFlightReservations: [],
      urgent: false,
      valuableWork: true,
      distinctInformationGain: true,
      qualityFloor: { model: 'opus', effort: 'xhigh' },
    });
    expect(stopped).toMatchObject({ mode: 'paused', admission: 'defer', fanOutAllowed: false });
    expect(stopped.reasons).toContain('BUDGET_FINISH_BUFFER');

    const noWork = new BudgetController(policy).decide({
      now,
      snapshot: snapshot(),
      model: 'opus',
      forecast: forecast(),
      inFlightReservations: [],
      urgent: false,
      valuableWork: false,
      distinctInformationGain: false,
      qualityFloor: { model: 'opus', effort: 'xhigh' },
    });
    expect(noWork).toMatchObject({
      mode: 'final-burn',
      admission: 'no-valuable-work',
      fanOutAllowed: false,
    });
  });
});
