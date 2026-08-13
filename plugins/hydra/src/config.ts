import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

const ConfigShape = {
  claudePath: z.string().trim().min(1).max(4_096),
  stateRoot: z
    .string()
    .min(1)
    .refine((value) => isAbsolute(value), 'stateRoot must be an absolute path'),
  minClaudeVersion: z.string().regex(/^\d+\.\d+\.\d+$/u, 'minClaudeVersion must be semver'),
  maxConcurrentClaudeJobs: z.number().int().min(1).max(64),
  maxConcurrentFableJobs: z.number().int().min(1).max(64),
  maxQueuedJobs: z.number().int().min(1).max(10_000),
  maxPanelMembers: z.number().int().min(1).max(3),
  maxDebateRounds: z.number().int().min(1).max(2),
  defaultMaxTurns: z.number().int().min(1).max(100),
  defaultTimeoutSec: z.number().int().min(1).max(86_400),
  cancellationGraceMs: z.number().int().min(100).max(60_000),
  staleHeartbeatMs: z.number().int().min(1_000).max(3_600_000),
  logRetentionDays: z.number().int().min(1).max(3_650),
  loggingMode: z.enum(['sanitized-events', 'metadata-only']),
  budgetBurnWindowHours: z.number().int().min(4).max(72),
  budgetFinishBufferHours: z.number().int().min(1).max(12),
  budgetBurnStartTargetBasisPoints: z.number().int().min(500).max(5_000),
  budgetHardReserveBasisPoints: z.number().int().min(0).max(2_000),
  budgetNormalFreshnessMinutes: z.number().int().min(60).max(24 * 60),
  budgetBurnFreshnessMinutes: z.number().int().min(15).max(6 * 60),
  budgetRoundingMarginBasisPoints: z.number().int().min(0).max(1_000),
  budgetMinimumSamples: z.number().int().min(3).max(100),
} as const;

export const HydraConfigSchema = z
  .object(ConfigShape)
  .strict()
  .superRefine((value, context) => {
    if (value.maxConcurrentFableJobs > value.maxConcurrentClaudeJobs) {
      context.addIssue({
        code: 'custom',
        path: ['maxConcurrentFableJobs'],
        message: 'Fable concurrency cannot exceed total Claude concurrency',
      });
    }
    if (value.budgetFinishBufferHours >= value.budgetBurnWindowHours) {
      context.addIssue({
        code: 'custom',
        path: ['budgetFinishBufferHours'],
        message: 'Budget finish buffer must be shorter than the burn window',
      });
    }
    if (value.budgetHardReserveBasisPoints >= value.budgetBurnStartTargetBasisPoints) {
      context.addIssue({
        code: 'custom',
        path: ['budgetHardReserveBasisPoints'],
        message: 'Budget hard reserve must be below the burn-start target',
      });
    }
    if (value.budgetBurnFreshnessMinutes > value.budgetNormalFreshnessMinutes) {
      context.addIssue({
        code: 'custom',
        path: ['budgetBurnFreshnessMinutes'],
        message: 'Final-burn snapshots must be at least as fresh as normal snapshots',
      });
    }
  });

export const HydraConfigOverridesSchema = z.object(ConfigShape).partial().strict();

export const HydraConfigFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    overrides: HydraConfigOverridesSchema,
  })
  .strict();

export type HydraConfig = z.infer<typeof HydraConfigSchema>;
export type HydraConfigOverrides = z.infer<typeof HydraConfigOverridesSchema>;

export const DEFAULT_CONFIG: HydraConfig = Object.freeze({
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

export function loadConfig(overrides: unknown = {}): HydraConfig {
  const parsedOverrides = HydraConfigOverridesSchema.parse(overrides);
  return HydraConfigSchema.parse({ ...DEFAULT_CONFIG, ...parsedOverrides });
}
