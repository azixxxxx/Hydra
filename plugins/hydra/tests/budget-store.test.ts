import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { UsageBudgetSnapshot } from '../src/budget.js';
import { BudgetStore } from '../src/budget-store.js';
import {
  allowanceObservationId,
  type AllowanceObservation,
} from '../src/calibration.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const HOUR_MS = 60 * 60 * 1_000;
const firstTime = new Date('2026-08-13T10:00:00.000Z');
const secondTime = new Date('2026-08-13T11:00:00.000Z');

function snapshot(capturedAt: Date, remainingBasisPoints: number): UsageBudgetSnapshot {
  return {
    schemaVersion: 1,
    source: 'manual-settings',
    measurementGranularityBasisPoints: 100,
    capturedAt: capturedAt.toISOString(),
    usageCreditsDisabledAttestedAt: capturedAt.toISOString(),
    exclusiveHydraActivitySincePreviousSnapshot: true,
    buckets: [
      {
        bucketId: 'weekly-all',
        displayLabel: 'Weekly all models',
        window: 'weekly',
        appliesTo: ['all'],
        capturedAt: capturedAt.toISOString(),
        cycleStartedAt: new Date(capturedAt.getTime() - 6 * 24 * HOUR_MS).toISOString(),
        resetAt: new Date(capturedAt.getTime() + 24 * HOUR_MS).toISOString(),
        remainingBasisPoints,
      },
    ],
  };
}

describe('BudgetStore', () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await createTemporaryDirectory('hydra-budget-store-');
  });

  afterEach(async () => {
    await removeTemporaryDirectory(stateRoot);
  });

  test('keeps immutable append-only history and points at the newest capture', async () => {
    const store = new BudgetStore({
      stateRoot,
      now: () => new Date('2026-08-13T12:00:00.000Z'),
    });
    const second = await store.record(snapshot(secondTime, 6_000));
    const first = await store.record(snapshot(firstTime, 7_000));
    const duplicate = await store.record(snapshot(secondTime, 6_000));

    expect(duplicate.snapshotId).toBe(second.snapshotId);
    expect(first.snapshotId).not.toBe(second.snapshotId);
    expect(await new BudgetStore({ stateRoot }).active()).toEqual(second);
    expect((await store.history()).map(({ snapshotId }) => snapshotId)).toEqual([
      first.snapshotId,
      second.snapshotId,
    ]);
    expect(await readdir(join(stateRoot, 'budget', 'snapshots'))).toHaveLength(2);
  });

  test('rejects future captures and credential-shaped labels before persistence', async () => {
    const store = new BudgetStore({ stateRoot, now: () => firstTime });
    await expect(store.record(snapshot(secondTime, 6_000))).rejects.toMatchObject({
      code: 'BUDGET_SNAPSHOT_FUTURE',
    });
    const unsafe = snapshot(firstTime, 6_000);
    await expect(
      store.record({
        ...unsafe,
        buckets: [{ ...unsafe.buckets[0]!, displayLabel: 'Bearer test-secret-value' }],
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_SHAPED_STATE' });
    await expect(readdir(join(stateRoot, 'budget', 'snapshots'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('fails visibly when immutable history is corrupt', async () => {
    const store = new BudgetStore({ stateRoot, now: () => secondTime });
    await store.record(snapshot(firstTime, 7_000));
    const files = await readdir(join(stateRoot, 'budget', 'snapshots'));
    await writeFile(join(stateRoot, 'budget', 'snapshots', files[0]!), '{bad json', 'utf8');

    await expect(store.history()).rejects.toMatchObject({ code: 'BUDGET_STATE_CORRUPT' });
    await expect(store.active()).rejects.toMatchObject({ code: 'BUDGET_STATE_CORRUPT' });
  });

  test('persists immutable calibration evidence and verifies its content digest', async () => {
    const store = new BudgetStore({ stateRoot, now: () => secondTime });
    const body: Omit<AllowanceObservation, 'observationId'> = {
      schemaVersion: 1,
      bucketId: 'weekly-all',
      cohortKey: '["claude-opus-5","2.1.228","xhigh","analyze","small","medium"]',
      previousSnapshotId: 'a'.repeat(64),
      currentSnapshotId: 'b'.repeat(64),
      jobId: '11111111-1111-4111-8111-111111111111',
      consumedBasisPoints: 120,
      measurementGranularityBasisPoints: 100,
      usage: {
        inputTokens: 4_000,
        outputTokens: 400,
        cacheReadTokens: 1_000,
        cacheCreationTokens: 500,
      },
      clean: true,
      observedAt: secondTime.toISOString(),
    };
    const observation: AllowanceObservation = {
      ...body,
      observationId: allowanceObservationId(body),
    };

    await expect(store.recordObservation(observation)).resolves.toEqual(observation);
    await expect(store.recordObservation(observation)).resolves.toEqual(observation);
    expect(await new BudgetStore({ stateRoot }).observations()).toEqual([observation]);

    const files = await readdir(join(stateRoot, 'budget', 'calibration'));
    await writeFile(
      join(stateRoot, 'budget', 'calibration', files[0]!),
      `${JSON.stringify({ ...observation, consumedBasisPoints: 999 })}\n`,
      'utf8',
    );
    await expect(store.observations()).rejects.toMatchObject({ code: 'BUDGET_STATE_CORRUPT' });
  });

  test('tracks append-only quota reservations and releases across restarts', async () => {
    const store = new BudgetStore({ stateRoot, now: () => secondTime });
    const reservation = await store.reserve({
      jobId: '11111111-1111-4111-8111-111111111111',
      snapshotId: 'a'.repeat(64),
      cohortKey: '["claude-opus-5","2.1.228","xhigh","analyze","small","medium"]',
      mode: 'final-burn',
      admission: 'admit',
      priority: 'opportunistic',
      forecastCalibrated: true,
      forecastSampleCount: 5,
      forecastEmpiricalQuantileBasisPoints: 9_500,
      forecastOrderStatisticCoverageBasisPoints: 8_333,
      reasons: ['BUDGET_VERIFIED_FINAL_BURN_SURPLUS'],
      buckets: [
        { bucketId: 'weekly-all', basisPoints: 120 },
        { bucketId: 'five-hour-all', basisPoints: 240 },
      ],
    });

    expect(await new BudgetStore({ stateRoot }).activeReservations()).toEqual([reservation]);
    await store.releaseReservation(reservation.jobId, 'terminal');
    await store.releaseReservation(reservation.jobId, 'terminal');
    expect(await new BudgetStore({ stateRoot }).activeReservations()).toEqual([]);
    expect(await store.reservationHistory()).toEqual([
      expect.objectContaining({ jobId: reservation.jobId }),
    ]);
  });
});
