import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';

describe('Hydra configuration', () => {
  test('loads the production defaults', () => {
    expect(loadConfig()).toEqual({
      claudePath: 'claude',
      stateRoot: join(homedir(), '.hydra'),
      minClaudeVersion: '2.1.228',
      maxConcurrentClaudeJobs: 2,
      maxConcurrentFableJobs: 1,
      maxQueuedJobs: 8,
      maxPanelMembers: 3,
      maxDebateRounds: 2,
      defaultMaxTurns: 12,
      defaultTimeoutSec: 1_800,
      cancellationGraceMs: 5_000,
      staleHeartbeatMs: 30_000,
      logRetentionDays: 30,
      loggingMode: 'sanitized-events',
      budgetBurnWindowHours: 24,
      budgetFinishBufferHours: 2,
      budgetBurnStartTargetBasisPoints: 2_000,
      budgetHardReserveBasisPoints: 300,
      budgetNormalFreshnessMinutes: 720,
      budgetBurnFreshnessMinutes: 60,
      budgetRoundingMarginBasisPoints: 100,
      budgetMinimumSamples: 5,
    });
  });

  test('keeps exported defaults immutable', () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  });

  test('accepts bounded overrides', () => {
    expect(
      loadConfig({
        stateRoot: '/tmp/hydra-state',
        maxConcurrentClaudeJobs: 3,
        maxConcurrentFableJobs: 2,
        loggingMode: 'metadata-only',
      }),
    ).toMatchObject({
      stateRoot: '/tmp/hydra-state',
      maxConcurrentClaudeJobs: 3,
      maxConcurrentFableJobs: 2,
      loggingMode: 'metadata-only',
    });
  });

  test('rejects a relative state root', () => {
    expect(() => loadConfig({ stateRoot: '../state' })).toThrowError(/stateRoot|absolute/i);
  });

  test('rejects more Fable slots than total Claude slots', () => {
    expect(() =>
      loadConfig({ maxConcurrentClaudeJobs: 1, maxConcurrentFableJobs: 2 }),
    ).toThrowError(/Fable/i);
  });

  test('rejects incoherent weekly pacing boundaries', () => {
    expect(() =>
      loadConfig({ budgetBurnWindowHours: 2, budgetFinishBufferHours: 2 }),
    ).toThrowError(/finish|burn/i);
    expect(() =>
      loadConfig({
        budgetBurnStartTargetBasisPoints: 300,
        budgetHardReserveBasisPoints: 300,
      }),
    ).toThrowError(/reserve|target/i);
  });

  test('rejects unknown configuration keys', () => {
    expect(() => loadConfig({ remainingQuota: 100 })).toThrowError(/unrecognized|unknown/i);
    expect(() => loadConfig({ billingMode: 'subscription-only' })).toThrowError(
      /unrecognized|unknown/i,
    );
  });
});
