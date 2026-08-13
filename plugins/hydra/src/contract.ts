import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { BudgetDecisionSchema, BudgetForecastSchema } from './budget.js';
import {
  BudgetReservationSchema,
  BudgetSnapshotRecordSchema,
} from './budget-store.js';
import { AllowanceObservationSchema } from './calibration.js';
import { EFFORT_LEVELS, ACCESS_MODES } from './domain.js';
import { RouteRecommendationSchema } from './policy.js';
import { PreflightResultSchema } from './preflight.js';
import {
  DelegationGroupSummarySchema,
  JobMetaObjectSchema,
  JobResultObjectSchema,
  OutcomeRecordObjectSchema,
} from './stores.js';

const SemverSchema = z.string().regex(
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
);
const PluginManifestSchema = z.object({ version: SemverSchema }).passthrough();

export interface HydraRuntimeIdentity {
  readonly version: string;
  readonly issue?: {
    readonly code: 'HYDRA_MANIFEST_UNREADABLE';
    readonly message: string;
  };
}

export function loadHydraRuntimeIdentity(
  reader: (url: URL) => string = (url) => readFileSync(url, 'utf8'),
  manifestUrl: URL = new URL('../.codex-plugin/plugin.json', import.meta.url),
): HydraRuntimeIdentity {
  try {
    const manifest = PluginManifestSchema.parse(
      JSON.parse(reader(manifestUrl)) as unknown,
    );
    return { version: manifest.version };
  } catch {
    return {
      version: '0.0.0-unknown',
      issue: {
        code: 'HYDRA_MANIFEST_UNREADABLE',
        message: 'Hydra could not validate its plugin manifest and started read-only',
      },
    };
  }
}

export const HYDRA_RUNTIME_IDENTITY = loadHydraRuntimeIdentity();
export const HYDRA_VERSION = HYDRA_RUNTIME_IDENTITY.version;

const JsonObjectSchema = z.record(z.string(), z.json());

export const SafeWarningSchema = z
  .object({
    code: z.string().min(1).max(200),
    message: z.string().min(1).max(20_000),
    details: JsonObjectSchema.optional(),
  })
  .strict();

export const HydraFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.string().min(1).max(200),
        message: z.string().min(1).max(20_000),
        details: JsonObjectSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const HealthSummarySchema = z
  .object({
    state: z.enum(['ok', 'degraded']),
    issues: z.array(
      z
        .object({
          code: z.string().min(1).max(200),
          message: z.string().min(1).max(20_000),
          count: z.number().int().positive().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type HealthSummary = z.infer<typeof HealthSummarySchema>;

export function successSchema<T extends z.ZodType>(data: T): z.ZodObject<{
  ok: z.ZodLiteral<true>;
  data: T;
  warnings: z.ZodArray<typeof SafeWarningSchema>;
}> {
  return z
    .object({
      ok: z.literal(true),
      data,
      warnings: z.array(SafeWarningSchema),
    })
    .strict();
}

export function outputSchema<T extends z.ZodType>(data: T): z.ZodType {
  return z
    .object({
      schemaVersion: z.literal(1),
      hydraVersion: z.string(),
      response: z.discriminatedUnion('ok', [successSchema(data), HydraFailureSchema]),
    })
    .strict();
}

export const PreflightDataSchema = PreflightResultSchema;
export const RouteDataSchema = RouteRecommendationSchema;
export const StartDataSchema = z
  .object({
    jobId: z.string().uuid(),
    status: z.literal('queued'),
    delegationGroupId: z.string().uuid().optional(),
    budget: BudgetDecisionSchema.optional(),
  })
  .strict();
const JobStatusRecordSchema = JobMetaObjectSchema.safeExtend({
  delegation: DelegationGroupSummarySchema.optional(),
});
export const StatusDataSchema = z
  .object({
    jobs: z.array(JobStatusRecordSchema),
    health: HealthSummarySchema,
  })
  .strict();
export const ResultDataSchema = z
  .object({
    meta: JobMetaObjectSchema,
    events: z.array(z.json()),
    stderr: z.string(),
    result: JobResultObjectSchema.optional(),
    eventCount: z.number().int().nonnegative().optional(),
    eventsTruncated: z.boolean().optional(),
    eventOffset: z.number().int().nonnegative().optional(),
    nextEventOffset: z.number().int().nonnegative().optional(),
    delegation: DelegationGroupSummarySchema.optional(),
  })
  .strict();
export const CancelDataSchema = JobMetaObjectSchema;
export const OutcomeDataSchema = z
  .object({
    jobId: z.string().uuid(),
    recorded: z.literal(true),
    record: OutcomeRecordObjectSchema,
  })
  .strict();

const TokenFeatureVectorSchema = z
  .object({
    promptBytes: z.number().int().nonnegative(),
    roleBytes: z.number().int().nonnegative(),
    schemaBytes: z.number().int().nonnegative(),
    referencedBytes: z.number().int().nonnegative(),
    expectedTurns: z.number().int().min(1).max(100),
    toolClass: z.enum(ACCESS_MODES),
  })
  .strict();
const UsageCandidateSchema = z
  .object({
    resolvedModel: z.string().min(1).max(128),
    claudeVersion: z.string().min(1).max(100),
    effort: z.enum(EFFORT_LEVELS),
    features: TokenFeatureVectorSchema,
  })
  .strict();
const UsageVectorSchema = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    cacheReadTokens: z.number().nonnegative().optional(),
    cacheCreationTokens: z.number().nonnegative().optional(),
  })
  .strict();
const LocalUsageForecastSchema = z
  .object({
    calibrated: z.boolean(),
    cohortKey: z.string().min(1).max(2_000),
    sampleCount: z.number().int().nonnegative(),
    empiricalQuantileBasisPoints: z.literal(9_500),
    orderStatisticCoverageBasisPoints: z.number().int().min(0).max(10_000),
    predictedUsage: UsageVectorSchema,
    upperRatesPerMillion: z
      .object({
        inputTokensPerContextByte: z.number().nonnegative().optional(),
        outputTokensPerTurn: z.number().nonnegative().optional(),
        cacheReadTokensPerContextByte: z.number().nonnegative().optional(),
        cacheCreationTokensPerContextByte: z.number().nonnegative().optional(),
      })
      .strict(),
    invalidationReason: z.literal('INSUFFICIENT_COHORT_SAMPLES').optional(),
  })
  .strict();
const BudgetEvaluationSchema = z
  .object({
    decision: BudgetDecisionSchema,
    candidate: UsageCandidateSchema,
    localForecast: LocalUsageForecastSchema,
    allowanceForecast: BudgetForecastSchema,
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    measurementGranularityBasisPoints: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();
const BudgetStatusSchema = z
  .object({
    active: BudgetSnapshotRecordSchema.optional(),
    snapshotCount: z.number().int().nonnegative(),
    observationCount: z.number().int().nonnegative(),
    activeReservations: z.array(BudgetReservationSchema),
  })
  .strict();
export const BudgetDataSchema = z.union([
  BudgetStatusSchema,
  z
    .object({
      status: BudgetStatusSchema,
      evaluation: BudgetEvaluationSchema,
    })
    .strict(),
  z
    .object({
      record: BudgetSnapshotRecordSchema,
      observationsAdded: z.array(AllowanceObservationSchema),
    })
    .strict(),
]);

export const TOOL_OUTPUT_SCHEMAS = Object.freeze({
  preflight: outputSchema(PreflightDataSchema),
  route: outputSchema(RouteDataSchema),
  start: outputSchema(StartDataSchema),
  status: outputSchema(StatusDataSchema),
  result: outputSchema(ResultDataSchema),
  continue: outputSchema(StartDataSchema),
  cancel: outputSchema(CancelDataSchema),
  outcome: outputSchema(OutcomeDataSchema),
  budget: outputSchema(BudgetDataSchema),
});
