import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { UsageBudgetSnapshot } from '../src/budget.js';
import { BudgetService, type BudgetAdmission } from '../src/budget-service.js';
import { BudgetStore } from '../src/budget-store.js';
import {
  allowanceObservationId,
  type AllowanceObservation,
} from '../src/calibration.js';
import { loadConfig } from '../src/config.js';
import type { StartJobInput } from '../src/domain.js';
import { usageCohortKey } from '../src/forecast.js';
import { PolicyEngine } from '../src/policy.js';
import { JobStore } from '../src/stores.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const ids = Array.from(
  { length: 30 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);

function input(overrides: Partial<StartJobInput> = {}): StartJobInput {
  return {
    task: 'Review the repository for a distinct risk',
    cwd: '/tmp/repository',
    model: 'opus',
    effort: 'xhigh',
    role: 'adversarial reviewer',
    accessMode: 'analyze',
    maxTurns: 10,
    timeoutSec: 1_800,
    strictModel: false,
    ...overrides,
  };
}

function snapshot(
  capturedAt: Date,
  weeklyRemaining: number,
  fiveHourRemaining = 5_000,
): UsageBudgetSnapshot {
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
        cycleStartedAt: '2026-08-06T12:00:00.000Z',
        resetAt: '2026-08-13T12:00:00.000Z',
        remainingBasisPoints: weeklyRemaining,
      },
      {
        bucketId: 'five-hour-all',
        displayLabel: 'Current window',
        window: 'five-hour',
        appliesTo: ['all'],
        capturedAt: capturedAt.toISOString(),
        cycleStartedAt: '2026-08-13T05:00:00.000Z',
        resetAt: '2026-08-13T10:00:00.000Z',
        remainingBasisPoints: fiveHourRemaining,
      },
    ],
  };
}

describe('BudgetService', () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await createTemporaryDirectory('hydra-budget-service-');
  });

  afterEach(async () => {
    await removeTemporaryDirectory(stateRoot);
  });

  test('conservatively attributes a clean multi-job interval to every complete Hydra job', async () => {
    let now = new Date('2026-08-13T08:00:00.000Z');
    const jobIds = [...ids];
    const jobStore = new JobStore({
      stateRoot,
      idFactory: () => jobIds.shift() ?? ids[0]!,
      now: () => now,
    });
    const service = new BudgetService({
      config: loadConfig({ stateRoot, budgetMinimumSamples: 3 }),
      jobStore,
      budgetStore: new BudgetStore({ stateRoot, now: () => now }),
      now: () => now,
    });
    await service.recordSnapshot(snapshot(now, 7_000));

    now = new Date('2026-08-13T08:05:00.000Z');
    const meta = await jobStore.create(input());
    await jobStore.transition(meta.jobId, 'running', {
      claudeVersion: '2.1.228',
      resolvedModel: 'claude-opus-5',
      appliedEffort: 'xhigh',
    });
    await jobStore.finalize(meta.jobId, {
      schemaVersion: 1,
      jobId: meta.jobId,
      status: 'completed',
      requestedModel: meta.requestedModel,
      requestedEffort: meta.requestedEffort,
      resolvedModel: 'claude-opus-5',
      appliedEffort: 'xhigh',
      warnings: [],
      testsRun: [],
      finalText: 'done',
      eventsComplete: true,
      createdAt: meta.createdAt,
      completedAt: '2026-08-13T08:10:00.000Z',
      usage: {
        inputTokens: 4_000,
        outputTokens: 400,
        cacheReadTokens: 1_000,
        cacheCreationTokens: 500,
      },
    });
    now = new Date('2026-08-13T08:20:00.000Z');
    const second = await jobStore.create(input({ task: 'Review a second distinct risk' }));
    await jobStore.transition(second.jobId, 'running', {
      claudeVersion: '2.1.228',
      resolvedModel: 'claude-opus-5',
      appliedEffort: 'xhigh',
    });
    await jobStore.finalize(second.jobId, {
      schemaVersion: 1,
      jobId: second.jobId,
      status: 'completed',
      requestedModel: second.requestedModel,
      requestedEffort: second.requestedEffort,
      resolvedModel: 'claude-opus-5',
      appliedEffort: 'xhigh',
      warnings: [],
      testsRun: [],
      finalText: 'done',
      eventsComplete: true,
      createdAt: second.createdAt,
      completedAt: '2026-08-13T08:25:00.000Z',
      usage: {
        inputTokens: 3_000,
        outputTokens: 300,
        cacheReadTokens: 800,
        cacheCreationTokens: 400,
      },
    });
    now = new Date('2026-08-13T09:00:00.000Z');
    const recorded = await service.recordSnapshot(snapshot(now, 6_800, 4_800));

    expect(recorded.observationsAdded).toHaveLength(4);
    expect(recorded.observationsAdded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bucketId: 'weekly-all',
          jobId: meta.jobId,
          consumedBasisPoints: 200,
          clean: true,
          usage: { inputTokens: 4_000, outputTokens: 400, cacheReadTokens: 1_000, cacheCreationTokens: 500 },
        }),
      ]),
    );
  });

  test('keeps explicit quality-floor work available but defers uncalibrated opportunistic work', async () => {
    const now = new Date('2026-08-13T09:00:00.000Z');
    const jobStore = new JobStore({ stateRoot, now: () => now });
    const budgetStore = new BudgetStore({ stateRoot, now: () => now });
    const service = new BudgetService({
      config: loadConfig({ stateRoot, budgetMinimumSamples: 3 }),
      jobStore,
      budgetStore,
      now: () => now,
    });
    await budgetStore.record(snapshot(now, 6_800, 4_800));

    const quality = await service.admit(ids[0]!, input({
      budgetIntent: {
        priority: 'quality-floor',
        valuableWork: true,
        distinctInformationGain: false,
      },
    }));
    expect(quality.decision).toMatchObject({
      mode: 'uncalibrated',
      admission: 'quality-floor-only',
      fanOutAllowed: false,
    });
    await expect(service.admit(ids[1]!, input({
      budgetIntent: {
        priority: 'opportunistic',
        valuableWork: true,
        distinctInformationGain: true,
      },
    }))).rejects.toMatchObject({ code: 'BUDGET_ADMISSION_DEFERRED' });
    expect(await budgetStore.activeReservations()).toHaveLength(1);
    expect((await budgetStore.activeReservations())[0]?.buckets).toEqual([
      { bucketId: 'weekly-all', basisPoints: 100 },
      { bucketId: 'five-hour-all', basisPoints: 100 },
    ]);
  });

  test('treats route-required immediate panel members as quality-floor, but not conditional fan-out', async () => {
    const now = new Date('2026-08-13T09:00:00.000Z');
    const config = loadConfig({ stateRoot, budgetMinimumSamples: 3 });
    const service = new BudgetService({
      config,
      jobStore: new JobStore({ stateRoot, now: () => now }),
      budgetStore: new BudgetStore({ stateRoot, now: () => now }),
      now: () => now,
    });
    const routeInput = {
      taskProfile: {
        kind: 'review' as const,
        scope: 'repo' as const,
        ambiguity: 'high' as const,
        novelty: 'medium' as const,
        risk: 'critical' as const,
        writeRequired: false,
        testsRequired: true,
        parallelizable: true,
      },
      contextProfile: {
        capsuleBytes: 12_000,
        overlap: 'medium' as const,
        partitionability: 'partial' as const,
        independentJudgmentsRequired: true,
        partitions: [],
      },
      userMode: 'maximum' as const,
    };
    const plan = new PolicyEngine({
      maxPanelMembers: config.maxPanelMembers,
      maxDebateRounds: config.maxDebateRounds,
    }).route(routeInput);
    expect(plan.plan.sessions.map(({ activation }) => activation)).toEqual([
      'immediate',
      'immediate',
      'if-contradiction',
    ]);

    for (const sessionIndex of [0, 1] as const) {
      const session = plan.plan.sessions[sessionIndex]!;
      await expect(service.admit(ids[sessionIndex]!, input({
        model: session.model,
        effort: session.effort,
        role: session.role,
        delegation: {
          routeInput,
          planId: plan.planId,
          sessionIndex,
          activationReason: 'Required independent panel judgment.',
        },
      }))).resolves.toMatchObject({
        decision: { mode: 'unknown', admission: 'quality-floor-only' },
      });
    }

    const conditional = plan.plan.sessions[2]!;
    await expect(service.admit(ids[2]!, input({
      model: conditional.model,
      effort: conditional.effort,
      role: conditional.role,
      budgetIntent: {
        priority: 'quality-floor',
        valuableWork: true,
        distinctInformationGain: false,
      },
      delegation: {
        routeInput,
        planId: plan.planId,
        sessionIndex: 2,
        activationReason: 'Resolve a demonstrated contradiction.',
      },
    }))).rejects.toMatchObject({ code: 'BUDGET_INTENT_CONFLICT' });

    await expect(service.admit(ids[2]!, input({
      model: conditional.model,
      effort: conditional.effort,
      role: conditional.role,
      budgetIntent: {
        priority: 'opportunistic',
        valuableWork: true,
        distinctInformationGain: false,
      },
      delegation: {
        routeInput,
        planId: plan.planId,
        sessionIndex: 2,
        activationReason: 'Resolve a demonstrated contradiction.',
      },
    }))).rejects.toMatchObject({ code: 'BUDGET_ADMISSION_DEFERRED' });
  });

  test('fails open only for explicit quality-floor work when budget evidence is corrupt', async () => {
    const now = new Date('2026-08-13T09:00:00.000Z');
    await mkdir(join(stateRoot, 'budget'), { recursive: true });
    await writeFile(join(stateRoot, 'budget', 'active.json'), '{broken', 'utf8');
    const budgetStore = new BudgetStore({ stateRoot, now: () => now });
    const service = new BudgetService({
      config: loadConfig({ stateRoot, budgetMinimumSamples: 3 }),
      jobStore: new JobStore({ stateRoot, now: () => now }),
      budgetStore,
      now: () => now,
    });

    const admitted = await service.admit(ids[0]!, input({
      budgetIntent: {
        priority: 'quality-floor',
        valuableWork: true,
        distinctInformationGain: false,
      },
    }));
    expect(admitted).toMatchObject({
      decision: {
        mode: 'unknown',
        admission: 'quality-floor-only',
        forecastCalibrated: false,
        forecastOrderStatisticCoverageBasisPoints: 0,
        reasons: ['BUDGET_STATE_UNAVAILABLE_FOR_QUALITY_FLOOR'],
      },
      reservation: { priority: 'quality-floor', buckets: [] },
    });
    await expect(service.admit(ids[1]!, input({
      budgetIntent: {
        priority: 'opportunistic',
        valuableWork: true,
        distinctInformationGain: true,
      },
    }))).rejects.toMatchObject({ code: 'BUDGET_STATE_CORRUPT' });
    await expect(budgetStore.health()).resolves.toMatchObject({
      state: 'degraded',
      issues: [expect.objectContaining({ code: 'BUDGET_STATE_CORRUPT' })],
    });
  });

  test('calibrates exact cohorts, reserves every applicable bucket, and counts in-flight spend', async () => {
    let now = new Date('2026-08-13T08:00:00.000Z');
    const jobIds = [...ids];
    const jobStore = new JobStore({
      stateRoot,
      idFactory: () => jobIds.shift() ?? ids[0]!,
      now: () => now,
    });
    const budgetStore = new BudgetStore({ stateRoot, now: () => now });
    const config = loadConfig({ stateRoot, budgetMinimumSamples: 3 });
    const service = new BudgetService({ config, jobStore, budgetStore, now: () => now });

    for (let index = 0; index < 19; index += 1) {
      const meta = await jobStore.create(input({ task: `historical review ${index}` }));
      await jobStore.transition(meta.jobId, 'running', {
        claudeVersion: '2.1.228',
        resolvedModel: 'claude-opus-5',
        appliedEffort: 'xhigh',
      });
      await jobStore.finalize(meta.jobId, {
        schemaVersion: 1,
        jobId: meta.jobId,
        status: 'completed',
        requestedModel: meta.requestedModel,
        requestedEffort: meta.requestedEffort,
        resolvedModel: 'claude-opus-5',
        appliedEffort: 'xhigh',
        warnings: [],
        testsRun: [],
        finalText: 'done',
        eventsComplete: true,
        createdAt: meta.createdAt,
        completedAt: new Date(now.getTime() + index + 1).toISOString(),
        usage: {
          inputTokens: 4_000 + index * 100,
          outputTokens: 400 + index * 10,
          cacheReadTokens: 1_000 + index * 25,
          cacheCreationTokens: 500 + index * 10,
        },
      });
    }
    const observations = await jobStore.usageObservations();
    const cohortKey = usageCohortKey({
      resolvedModel: 'claude-opus-5',
      claudeVersion: '2.1.228',
      effort: 'xhigh',
      features: observations[0]!.features,
    });
    for (const bucketId of ['weekly-all', 'five-hour-all']) {
      for (let index = 0; index < 19; index += 1) {
        const body: Omit<AllowanceObservation, 'observationId'> = {
          schemaVersion: 1,
          bucketId,
          cohortKey,
          previousSnapshotId: `${bucketId === 'weekly-all' ? 'a' : 'c'}${String(index).padStart(63, '0')}`,
          currentSnapshotId: `${bucketId === 'weekly-all' ? 'b' : 'd'}${String(index).padStart(63, '0')}`,
          jobId: ids[index]!,
          consumedBasisPoints: 100 + index * 10,
          measurementGranularityBasisPoints: 100,
          usage: observations[index]!.usage,
          clean: true,
          observedAt: new Date(now.getTime() + index).toISOString(),
        };
        await budgetStore.recordObservation({ ...body, observationId: allowanceObservationId(body) });
      }
    }
    now = new Date('2026-08-13T09:00:00.000Z');
    await budgetStore.record(snapshot(now, 10_000, 5_000));
    const candidateInput = (index: number): StartJobInput => input({
      task: `historical review ${index}`,
      budgetIntent: {
        priority: 'opportunistic',
        valuableWork: true,
        distinctInformationGain: true,
      },
    });
    const otherJobStore = new JobStore({ stateRoot, now: () => now });
    const otherService = new BudgetService({
      config,
      jobStore: otherJobStore,
      budgetStore: new BudgetStore({ stateRoot, now: () => now }),
      now: () => now,
    });
    const calibrationPreview = await service.evaluate(candidateInput(19));
    expect(calibrationPreview.decision).toMatchObject({
      mode: 'final-burn',
      forecastSampleCount: 19,
      forecastOrderStatisticCoverageBasisPoints: 9_500,
    });
    const fiveHourForecast = calibrationPreview.decision.buckets.find(
      ({ bucketId }) => bucketId === 'five-hour-all',
    )!.forecastBasisPoints;
    now = new Date(now.getTime() + 1);
    await budgetStore.record(
      snapshot(now, 10_000, 300 + 100 + 2 * fiveHourForecast - 1),
    );
    const preview = await service.evaluate(candidateInput(19));
    expect(preview.decision.mode, JSON.stringify(preview)).toBe('final-burn');
    const settled = await Promise.allSettled([
      jobStore.withAdmissionLock(async () => service.admit(ids[19]!, candidateInput(19))),
      otherJobStore.withAdmissionLock(async () => otherService.admit(ids[20]!, candidateInput(20))),
    ]);
    const admitted = settled.filter(
      (result): result is PromiseFulfilledResult<BudgetAdmission> => result.status === 'fulfilled',
    );
    const deferred = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(admitted, JSON.stringify(settled)).toHaveLength(1);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.reason).toMatchObject({ code: 'BUDGET_ADMISSION_DEFERRED' });
    expect(admitted[0]!.value.decision).toMatchObject({
      mode: 'final-burn',
      admission: 'admit',
      fanOutAllowed: true,
      forecastCalibrated: true,
      forecastSampleCount: 19,
      forecastOrderStatisticCoverageBasisPoints: 9_500,
    });
    expect(admitted[0]!.value.reservation.buckets.map(({ bucketId }) => bucketId).sort()).toEqual([
      'five-hour-all',
      'weekly-all',
    ]);
    const reevaluated = await service.evaluate(candidateInput(21));
    expect(reevaluated.decision.buckets.every(({ reservationBasisPoints }) => reservationBasisPoints > 0)).toBe(true);
  });
});
