import { constants, existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  DEFAULT_CONFIG,
  HydraConfigFileSchema,
  HydraConfigOverridesSchema,
  HydraConfigSchema,
  loadConfig,
  type HydraConfig,
} from './config.js';
import type { HealthSummary } from './contract.js';
import { assertCredentialFree } from './credential-shapes.js';
import {
  HydraError,
  ACCESS_MODES,
  EFFORT_LEVELS,
  JOB_STATUSES,
  OUTCOME_SCOPES,
  OUTCOME_TASK_TYPES,
  StartJobInputSchema,
  USER_VERDICTS,
  assertJobId,
  assertTransition,
  parseStartJobInput,
  type ClaudeCapabilities,
  type Effort,
  type JobId,
  type JobMeta,
  type JobResult,
  type JobStatus,
  type JsonValue,
  type OutcomeRecord,
  type RecordOutcomeInput,
  type ResultRedaction,
  type SafeError,
  type SessionRecord,
  type StartJobInput,
  type TokenFeatureVector,
} from './domain.js';
import { sanitizeClaudeEvent, sanitizeText } from './stream-json.js';
import { usageFeaturesForStart, type UsageObservation } from './forecast.js';
import {
  appendJsonLine,
  atomicCreateJson,
  atomicWriteJson,
  ensurePrivateDirectory,
  resolveManagedPath,
} from './platform/atomic-files.js';
import {
  processIdentityAlive,
  readProcessStartMarker,
} from './platform/process-identity.js';
import {
  DelegationPlanSchema,
  PersistedDelegationPlanInputSchema,
  PersistedDelegationPlanSchema,
  ROUTE_NAMES,
  type DelegationPlan,
  type RouteName,
  type SessionActivation,
} from './policy.js';
import { RouteInputSchema, type RouteInput } from './routing-contract.js';

const UuidSchema = z.string().uuid();
const MAX_DEFAULT_STDERR_BYTES = 1_000_000;
const MAX_DEFAULT_EVENT_BYTES = 20_000_000;
const META_LOCK_STALE_MS = 30_000;
const META_LOCK_WAIT_MS = 60_000;
const DateTimeSchema = z.iso.datetime();
const AbsolutePathSchema = z.string().refine(isAbsolute, 'path must be absolute');
export const SafeErrorSchema = z
  .object({
    code: z.string().min(1).max(200),
    message: z.string().min(1).max(20_000),
    details: z.record(z.string(), z.json()).optional(),
  })
  .strict();
export const CapabilitiesSchema = z
  .object({
    flags: z.record(z.string(), z.boolean()),
    supportsCliMaxTurns: z.boolean(),
    supportsDirectSandboxFlag: z.boolean(),
  })
  .strict();
export const TestExecutionSchema = z
  .object({
    command: z.string().max(20_100),
    toolUseId: z.string().max(1_000).optional(),
    status: z.enum(['attempted', 'completed', 'failed']),
    outputDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  })
  .strict();
export const UsageSchema = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    cacheReadTokens: z.number().nonnegative().optional(),
    cacheCreationTokens: z.number().nonnegative().optional(),
    costUsdEstimate: z.number().nonnegative().optional(),
  })
  .strict();
export const WorktreeEvidenceSchema = z
  .object({
    path: AbsolutePathSchema.optional(),
    changedFiles: z.array(z.string().max(20_000)).max(100_000),
    patch: z.string().max(25_000_000).optional(),
    mainCheckoutChanged: z.boolean(),
    beforeFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    afterFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  })
  .strict();
export const ResultRedactionSchema = z
  .object({
    field: z.enum([
      'warnings',
      'testsRun',
      'finalText',
      'structuredOutput',
      'terminationReason',
      'worktree.patch',
      'error',
    ]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    byteLength: z.number().int().nonnegative(),
  })
  .strict();
export const TokenFeatureVectorSchema = z
  .object({
    promptBytes: z.number().int().nonnegative().max(200_000),
    roleBytes: z.number().int().nonnegative().max(10_000),
    schemaBytes: z.number().int().nonnegative().max(100_000),
    referencedBytes: z.number().int().nonnegative().max(200_000),
    expectedTurns: z.number().int().min(1).max(100),
    toolClass: z.enum(ACCESS_MODES),
  })
  .strict();

export const DelegationActivationRecordSchema = z
  .object({
    sessionIndex: z.number().int().min(0).max(2),
    jobId: UuidSchema,
    activation: z.enum(['immediate', 'if-unresolved', 'if-contradiction', 'manual']),
    activationReason: z.string().min(1).max(2_000),
    evidenceJobId: UuidSchema.optional(),
    activatedAt: DateTimeSchema,
  })
  .strict();

const DelegationGroupRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    groupId: UuidSchema,
    planId: z.string().regex(/^[a-f0-9]{64}$/u),
    legacyPlanId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    routeInput: RouteInputSchema,
    route: z.enum(ROUTE_NAMES),
    plan: PersistedDelegationPlanInputSchema,
    activations: z.array(DelegationActivationRecordSchema).max(3),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    sufficientAt: DateTimeSchema.optional(),
    sufficientJobId: UuidSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.sufficientAt === undefined) !== (value.sufficientJobId === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['sufficientAt'],
        message: 'sufficient delegation evidence needs both timestamp and job identity',
      });
    }
  })
  .transform((value): DelegationGroupRecord => {
    const migratedLegacyPlan = 'replicatedContextBytesLowerBound' in value.plan;
    return {
      ...value,
      plan: PersistedDelegationPlanSchema.parse(value.plan),
      ...(value.legacyPlanId !== undefined
        ? { legacyPlanId: value.legacyPlanId }
        : migratedLegacyPlan
          ? { legacyPlanId: value.planId }
          : {}),
    } as unknown as DelegationGroupRecord;
  });

export interface DelegationActivationRecord {
  readonly sessionIndex: number;
  readonly jobId: JobId;
  readonly activation: SessionActivation;
  readonly activationReason: string;
  readonly evidenceJobId?: JobId;
  readonly activatedAt: string;
}

export interface DelegationGroupRecord {
  readonly schemaVersion: 1;
  readonly groupId: JobId;
  readonly planId: string;
  readonly legacyPlanId?: string;
  readonly routeInput: RouteInput;
  readonly route: RouteName;
  readonly plan: DelegationPlan;
  readonly activations: readonly DelegationActivationRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sufficientAt?: string;
  readonly sufficientJobId?: JobId;
}

export interface DelegationGroupSummary {
  readonly groupId: JobId;
  readonly planId: string;
  readonly legacyPlanId?: string;
  readonly strategy: DelegationPlan['strategy'];
  readonly maxImmediateSessions: number;
  readonly maxTotalSessions: number;
  readonly activatedSessions: number;
  readonly jobCount: number;
  readonly terminalJobCount: number;
  readonly sharedContextBytes: number;
  readonly replicatedContextBytesImmediate: number;
  readonly replicatedContextBytesAllActivated: number;
  readonly replicatedContextBytesActivated: number;
  readonly suppliedContext: Readonly<{
    promptBytes: number;
    roleBytes: number;
    schemaBytes: number;
    referencedBytes: number;
  }>;
  readonly usage: Readonly<{
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }>;
  readonly sufficient: boolean;
  readonly activations: readonly DelegationActivationRecord[];
}

export const DelegationGroupSummarySchema = z
  .object({
    groupId: UuidSchema,
    planId: z.string().regex(/^[a-f0-9]{64}$/u),
    legacyPlanId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    strategy: z.enum([
      'none',
      'single',
      'sequential-escalation',
      'partitioned-parallel',
      'independent-panel',
    ]),
    maxImmediateSessions: z.number().int().min(0).max(3),
    maxTotalSessions: z.number().int().min(0).max(3),
    activatedSessions: z.number().int().min(1).max(3),
    jobCount: z.number().int().min(1),
    terminalJobCount: z.number().int().min(0),
    sharedContextBytes: z.number().int().nonnegative(),
    replicatedContextBytesImmediate: z.number().int().nonnegative(),
    replicatedContextBytesAllActivated: z.number().int().nonnegative(),
    replicatedContextBytesActivated: z.number().int().nonnegative(),
    suppliedContext: z
      .object({
        promptBytes: z.number().int().nonnegative(),
        roleBytes: z.number().int().nonnegative(),
        schemaBytes: z.number().int().nonnegative(),
        referencedBytes: z.number().int().nonnegative(),
      })
      .strict(),
    usage: z
      .object({
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        cacheReadTokens: z.number().nonnegative().optional(),
        cacheCreationTokens: z.number().nonnegative().optional(),
      })
      .strict(),
    sufficient: z.boolean(),
    activations: z.array(DelegationActivationRecordSchema).max(3),
  })
  .strict();

export const JobMetaObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: UuidSchema,
    status: z.enum(JOB_STATUSES),
    input: StartJobInputSchema,
    requestedModel: z.string().min(1).max(128),
    requestedEffort: z.enum(EFFORT_LEVELS),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
    warnings: z.array(z.string().max(20_000)).max(1_000),
    usageFeatures: TokenFeatureVectorSchema,
    runtimeConfig: HydraConfigSchema.optional(),
    startedAt: DateTimeSchema.optional(),
    completedAt: DateTimeSchema.optional(),
    heartbeatAt: DateTimeSchema.optional(),
    workerPid: z.number().int().positive().optional(),
    workerProcessStartMarker: z.string().min(1).max(1_000).optional(),
    claudePgid: z.number().int().positive().optional(),
    claudeProcessStartMarker: z.string().min(1).max(1_000).optional(),
    claudeVersion: z.string().max(100).optional(),
    capabilities: CapabilitiesSchema.optional(),
    resolvedModel: z.string().max(128).optional(),
    canonicalModelId: z.string().max(128).optional(),
    appliedEffort: z.enum(EFFORT_LEVELS).optional(),
    sessionId: UuidSchema.optional(),
    worktreePath: AbsolutePathSchema.optional(),
    cancellationRequestedAt: DateTimeSchema.optional(),
    resumeSessionId: UuidSchema.optional(),
    resumeWorktreePath: AbsolutePathSchema.optional(),
    delegationGroupId: UuidSchema.optional(),
    delegationPlanId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    delegationSessionIndex: z.number().int().min(0).max(2).optional(),
    delegationActivationReason: z.string().min(1).max(2_000).optional(),
    error: SafeErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.requestedModel !== value.input.model || value.requestedEffort !== value.input.effort) {
      context.addIssue({
        code: 'custom',
        message: 'requested model and effort must match the immutable input',
      });
    }
    if (value.status !== 'queued' && value.status !== 'running' && value.completedAt === undefined) {
      context.addIssue({ code: 'custom', path: ['completedAt'], message: 'terminal jobs need completedAt' });
    }
    const active = value.status === 'queued' || value.status === 'running';
    if (
      active &&
      (value.workerPid === undefined) !== (value.workerProcessStartMarker === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['workerPid'],
        message: 'worker PID and process-start marker must be persisted together',
      });
    }
    if (
      active &&
      (value.claudePgid === undefined) !== (value.claudeProcessStartMarker === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['claudePgid'],
        message: 'Claude process group and process-start marker must be persisted together',
      });
    }
    const delegationFields = [
      value.delegationGroupId,
      value.delegationPlanId,
      value.delegationSessionIndex,
      value.delegationActivationReason,
    ];
    if (delegationFields.some((field) => field !== undefined) && delegationFields.some((field) => field === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['delegationGroupId'],
        message: 'delegation metadata must be persisted as one complete identity',
      });
    }
  });

const JobMetaSchema = JobMetaObjectSchema.transform(
  (value) => value as unknown as JobMeta,
);

export const JobResultObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: UuidSchema,
    status: z.enum(['completed', 'failed', 'cancelled', 'timed-out']),
    requestedModel: z.string().min(1).max(128),
    requestedEffort: z.enum(EFFORT_LEVELS),
    warnings: z.array(z.string().max(20_000)).max(1_000),
    testsRun: z.array(TestExecutionSchema).max(100).default([]),
    finalText: z.string().max(1_100_000),
    eventsComplete: z.boolean(),
    createdAt: DateTimeSchema,
    completedAt: DateTimeSchema,
    structuredOutput: z.json().optional(),
    resolvedModel: z.string().max(128).optional(),
    reportedModels: z.array(z.string().min(1).max(128)).max(20).optional(),
    canonicalModelId: z.string().max(128).optional(),
    appliedEffort: z.enum(EFFORT_LEVELS).optional(),
    sessionId: UuidSchema.optional(),
    usage: UsageSchema.optional(),
    turns: z.number().int().nonnegative().optional(),
    reportedSessionTurns: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    terminationReason: z.string().max(1_000).optional(),
    worktree: WorktreeEvidenceSchema.optional(),
    error: SafeErrorSchema.optional(),
    redactions: z.array(ResultRedactionSchema).max(20).optional(),
  })
  .strict();

const JobResultSchema = JobResultObjectSchema.transform(
  (value) => value as unknown as JobResult,
);

const SessionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: UuidSchema,
    latestJobId: UuidSchema,
    model: StartJobInputSchema.shape.model,
    effort: z.enum(EFFORT_LEVELS),
    role: z.string().min(1).max(2_000),
    accessMode: z.enum(ACCESS_MODES),
    strictModel: z.boolean().default(false),
    maxTurns: z.number().int().min(1).max(100).default(12),
    timeoutSec: z.number().int().min(1).max(86_400).default(1_800),
    cwd: AbsolutePathSchema,
    worktreePath: AbsolutePathSchema.optional(),
    delegationGroupId: UuidSchema.optional(),
    delegationPlanId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    delegationSessionIndex: z.number().int().min(0).max(2).optional(),
    updatedAt: DateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const delegationFields = [
      value.delegationGroupId,
      value.delegationPlanId,
      value.delegationSessionIndex,
    ];
    if (delegationFields.some((field) => field !== undefined) && delegationFields.some((field) => field === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['delegationGroupId'],
        message: 'session delegation identity must be persisted together',
      });
    }
  })
  .transform((value) => value as SessionRecord);

export const OutcomeRecordObjectSchema = z
  .object({
    schemaVersion: z.literal(2),
    jobId: UuidSchema,
    taskType: z.enum(OUTCOME_TASK_TYPES),
    scope: z.enum(OUTCOME_SCOPES),
    requestedModel: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
    effort: z.enum(EFFORT_LEVELS),
    status: z.enum(['completed', 'failed', 'cancelled', 'timed-out']),
    durationMs: z.number().nonnegative(),
    completedAt: DateTimeSchema,
    observedTests: z.array(TestExecutionSchema).max(100),
    accepted: z.boolean(),
    recordedAt: DateTimeSchema,
    acceptedClaims: z.array(z.string().max(20_000)).max(1_000),
    rejectedClaims: z.array(z.string().max(20_000)).max(1_000),
    falsePositives: z.array(z.string().max(20_000)).max(1_000),
    testsBefore: z.array(z.string().max(20_000)).max(1_000),
    testsAfter: z.array(z.string().max(20_000)).max(1_000),
    testsPassed: z.boolean().optional(),
    patchAccepted: z.boolean().optional(),
    userVerdict: z.enum(USER_VERDICTS).optional(),
    notes: z.string().max(100_000).optional(),
    delegation: z
      .object({
        groupId: UuidSchema,
        activatedSessions: z.number().int().min(1).max(3),
        jobCount: z.number().int().min(1),
        terminalJobCount: z.number().int().min(0),
        sufficient: z.boolean(),
        usage: z
          .object({
            inputTokens: z.number().nonnegative().optional(),
            outputTokens: z.number().nonnegative().optional(),
            cacheReadTokens: z.number().nonnegative().optional(),
            cacheCreationTokens: z.number().nonnegative().optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

const OutcomeRecordSchema = OutcomeRecordObjectSchema.transform(
  (value) => value as unknown as OutcomeRecord,
);

function serializedForDigest(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value) ?? '';
}

function sanitizeResultForPersistence(result: JobResult): JobResult {
  const redactions: ResultRedaction[] = [...(result.redactions ?? [])];
  const record = (
    field: ResultRedaction['field'],
    original: unknown,
    sanitized: unknown,
  ): void => {
    const originalSerialized = serializedForDigest(original);
    if (originalSerialized === serializedForDigest(sanitized)) {
      return;
    }
    redactions.push({
      field,
      sha256: createHash('sha256').update(originalSerialized).digest('hex'),
      byteLength: Buffer.byteLength(originalSerialized, 'utf8'),
    });
  };

  const warnings = sanitizeClaudeEvent(result.warnings) as unknown as readonly string[];
  const testsRun = sanitizeClaudeEvent(result.testsRun) as unknown as JobResult['testsRun'];
  const finalText = sanitizeText(result.finalText);
  record('warnings', result.warnings, warnings);
  record('testsRun', result.testsRun, testsRun);
  record('finalText', result.finalText, finalText);

  const structuredOutput =
    result.structuredOutput === undefined
      ? undefined
      : sanitizeClaudeEvent(result.structuredOutput);
  if (structuredOutput !== undefined) {
    record('structuredOutput', result.structuredOutput, structuredOutput);
  }

  const terminationReason =
    result.terminationReason === undefined
      ? undefined
      : sanitizeText(result.terminationReason);
  if (terminationReason !== undefined) {
    record('terminationReason', result.terminationReason, terminationReason);
  }

  const patch =
    result.worktree?.patch === undefined ? undefined : sanitizeText(result.worktree.patch);
  if (patch !== undefined) {
    record('worktree.patch', result.worktree?.patch, patch);
  }

  const error =
    result.error === undefined
      ? undefined
      : {
          ...result.error,
          message: sanitizeText(result.error.message),
          ...(result.error.details === undefined
            ? {}
            : { details: sanitizeClaudeEvent(result.error.details) as Record<string, JsonValue> }),
        };
  if (error !== undefined) {
    record('error', result.error, error);
  }

  return {
    ...result,
    warnings,
    testsRun,
    finalText,
    ...(structuredOutput === undefined ? {} : { structuredOutput }),
    ...(terminationReason === undefined ? {} : { terminationReason }),
    ...(result.worktree === undefined
      ? {}
      : {
          worktree: {
            ...result.worktree,
            ...(patch === undefined ? {} : { patch }),
          },
        }),
    ...(error === undefined ? {} : { error }),
    ...(redactions.length === 0 ? {} : { redactions }),
  };
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

async function shortDelay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

interface FileLockOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly processStartMarker: string;
  readonly acquiredAt: string;
  readonly token?: string;
}

async function readFileLockOwner(path: string): Promise<FileLockOwner | undefined> {
  try {
    const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as {
      readonly schemaVersion?: unknown;
      readonly pid?: unknown;
      readonly processStartMarker?: unknown;
      readonly acquiredAt?: unknown;
      readonly token?: unknown;
    };
    if (
      owner.schemaVersion !== 1 ||
      typeof owner.pid !== 'number' ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.processStartMarker !== 'string' ||
      owner.processStartMarker.length === 0 ||
      typeof owner.acquiredAt !== 'string' ||
      Number.isNaN(new Date(owner.acquiredAt).getTime()) ||
      (owner.token !== undefined && typeof owner.token !== 'string')
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      pid: owner.pid,
      processStartMarker: owner.processStartMarker,
      acquiredAt: owner.acquiredAt,
      ...(owner.token === undefined ? {} : { token: owner.token }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function sameFileLockOwner(
  left: FileLockOwner | undefined,
  right: FileLockOwner | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.pid === right.pid &&
    left.processStartMarker === right.processStartMarker &&
    left.acquiredAt === right.acquiredAt &&
    left.token === right.token
  );
}

function withPatch(meta: JobMeta, patch: JobMetaPatch, updatedAt: string): JobMeta {
  return {
    ...meta,
    ...patch,
    updatedAt,
  };
}

function transitionedMeta(
  current: JobMeta,
  status: JobStatus,
  patch: JobMetaPatch,
  timestamp: string,
): JobMeta {
  assertTransition(current.status, status);
  return withPatch(
    {
      ...current,
      status,
      ...(status === 'running' && current.startedAt === undefined
        ? { startedAt: timestamp }
        : {}),
      ...(status !== 'queued' && status !== 'running' ? { completedAt: timestamp } : {}),
    },
    patch,
    timestamp,
  );
}

function resultMetaPatch(result: JobResult): JobMetaPatch {
  return {
    warnings: result.warnings,
    ...(result.resolvedModel === undefined ? {} : { resolvedModel: result.resolvedModel }),
    ...(result.canonicalModelId === undefined
      ? {}
      : { canonicalModelId: result.canonicalModelId }),
    ...(result.appliedEffort === undefined ? {} : { appliedEffort: result.appliedEffort }),
    ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

export interface JobMetaPatch {
  readonly warnings?: readonly string[];
  readonly heartbeatAt?: string;
  readonly workerPid?: number;
  readonly workerProcessStartMarker?: string;
  readonly claudePgid?: number;
  readonly claudeProcessStartMarker?: string;
  readonly claudeVersion?: string;
  readonly capabilities?: ClaudeCapabilities;
  readonly resolvedModel?: string;
  readonly canonicalModelId?: string;
  readonly appliedEffort?: Effort;
  readonly sessionId?: string;
  readonly worktreePath?: string;
  readonly cancellationRequestedAt?: string;
  readonly resumeSessionId?: string;
  readonly resumeWorktreePath?: string;
  readonly delegationGroupId?: string;
  readonly delegationPlanId?: string;
  readonly delegationSessionIndex?: number;
  readonly delegationActivationReason?: string;
  readonly runtimeConfig?: HydraConfig;
  readonly error?: SafeError;
}

type JobCreationPatch = Pick<
  JobMetaPatch,
  | 'resumeSessionId'
  | 'resumeWorktreePath'
  | 'delegationGroupId'
  | 'delegationPlanId'
  | 'delegationSessionIndex'
  | 'delegationActivationReason'
  | 'runtimeConfig'
>;

export interface JobAdmissionHooks {
  readonly beforeCreate: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}

export interface JobStoreDependencies {
  readonly stateRoot: string;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly loggingMode?: 'metadata-only' | 'sanitized-events';
  readonly maxStderrBytes?: number;
  readonly processStartMarker?: () => Promise<string>;
  readonly isProcessAlive?: (pid: number, processStartMarker: string) => Promise<boolean>;
  readonly maxEventBytes?: number;
  readonly metaLockStaleMs?: number;
  readonly metaLockWaitMs?: number;
}

export interface JobResultView {
  readonly meta: JobMeta;
  readonly events: readonly JsonValue[];
  readonly stderr: string;
  readonly result?: JobResult;
  readonly eventCount: number;
  readonly eventsTruncated: boolean;
  readonly eventOffset: number;
  readonly nextEventOffset?: number;
  readonly delegation?: DelegationGroupSummary;
}

export class JobStore {
  readonly #stateRoot: string;
  readonly #jobsRoot: string;
  readonly #idFactory: () => string;
  readonly #now: () => Date;
  readonly #loggingMode: 'metadata-only' | 'sanitized-events';
  readonly #maxStderrBytes: number;
  readonly #processStartMarker: () => Promise<string>;
  readonly #isProcessAlive: (pid: number, marker: string) => Promise<boolean>;
  readonly #maxEventBytes: number;
  readonly #metaLockStaleMs: number;
  readonly #metaLockWaitMs: number;
  readonly #eventLimitRecorded = new Set<string>();
  #cachedProcessStartMarker: Promise<string> | undefined;
  readonly #mutations = new Map<string, Promise<void>>();

  public constructor(dependencies: JobStoreDependencies) {
    this.#stateRoot = dependencies.stateRoot;
    this.#jobsRoot = join(this.#stateRoot, 'jobs');
    this.#idFactory = dependencies.idFactory ?? randomUUID;
    this.#now = dependencies.now ?? ((): Date => new Date());
    this.#loggingMode = dependencies.loggingMode ?? 'sanitized-events';
    this.#maxStderrBytes = dependencies.maxStderrBytes ?? MAX_DEFAULT_STDERR_BYTES;
    this.#processStartMarker =
      dependencies.processStartMarker ?? ((): Promise<string> => readProcessStartMarker(process.pid));
    this.#isProcessAlive = dependencies.isProcessAlive ?? processIdentityAlive;
    this.#maxEventBytes = dependencies.maxEventBytes ?? MAX_DEFAULT_EVENT_BYTES;
    this.#metaLockStaleMs = dependencies.metaLockStaleMs ?? META_LOCK_STALE_MS;
    this.#metaLockWaitMs = dependencies.metaLockWaitMs ?? META_LOCK_WAIT_MS;
    if (
      !Number.isSafeInteger(this.#metaLockStaleMs) ||
      this.#metaLockStaleMs < 1 ||
      !Number.isSafeInteger(this.#metaLockWaitMs) ||
      this.#metaLockWaitMs < 1
    ) {
      throw new HydraError(
        'INVALID_META_LOCK_CONFIG',
        'Metadata lock timing must use positive safe integers',
      );
    }
  }

  public create(
    input: StartJobInput,
    jobIdValue = this.#idFactory(),
    creationPatch: JobCreationPatch = {},
  ): Promise<JobMeta> {
    return this.#createUnlocked(input, jobIdValue, creationPatch);
  }

  public newJobId(): JobId {
    const value = this.#idFactory();
    assertJobId(value);
    return value;
  }

  public async createWithinCapacity(
    input: StartJobInput,
    maxActiveJobs: number,
    creationPatch: JobCreationPatch = {},
    jobIdValue = this.#idFactory(),
    admissionHooks?: JobAdmissionHooks,
  ): Promise<JobMeta> {
    if (!Number.isSafeInteger(maxActiveJobs) || maxActiveJobs < 1) {
      throw new HydraError(
        'INVALID_QUEUE_CAPACITY',
        'Hydra queue capacity must be a positive safe integer',
      );
    }
    return this.withAdmissionLock(async () => {
      if ((await this.activeCount()) >= maxActiveJobs) {
        throw new HydraError(
          'JOB_QUEUE_FULL',
          `Hydra already has ${maxActiveJobs} queued or running jobs`,
        );
      }
      let reserved = false;
      try {
        if (admissionHooks !== undefined) {
          await admissionHooks.beforeCreate();
          reserved = true;
        }
        return await this.#createUnlocked(input, jobIdValue, creationPatch);
      } catch (error) {
        if (reserved) {
          await admissionHooks!.rollback();
        }
        throw error;
      }
    });
  }

  public async withAdmissionLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.#acquireQueueAdmissionLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async #createUnlocked(
    input: StartJobInput,
    jobIdValue: string,
    creationPatch: JobCreationPatch,
  ): Promise<JobMeta> {
    assertJobId(jobIdValue);
    const parsedInput = parseStartJobInput(input);
    const jobDirectory = this.#jobDirectory(jobIdValue);
    await ensurePrivateDirectory(this.#jobsRoot);
    const stagingDirectory = resolveManagedPath(
      this.#jobsRoot,
      `.creating-${jobIdValue}-${randomUUID()}`,
    );
    await mkdir(stagingDirectory, { mode: 0o700 });
    const timestamp = this.#now().toISOString();
    const usageFeatures: TokenFeatureVector = usageFeaturesForStart(parsedInput);
    const meta: JobMeta = {
      schemaVersion: 1,
      jobId: jobIdValue,
      status: 'queued',
      input: parsedInput,
      requestedModel: parsedInput.model,
      requestedEffort: parsedInput.effort,
      createdAt: timestamp,
      updatedAt: timestamp,
      warnings: [],
      usageFeatures,
      ...creationPatch,
    };
    assertCredentialFree(meta);
    try {
      await atomicWriteJson(join(stagingDirectory, 'meta.json'), meta);
      await rename(stagingDirectory, jobDirectory);
      return meta;
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        throw new HydraError('JOB_ALREADY_EXISTS', 'A Hydra job with this ID already exists');
      }
      throw error;
    }
  }

  public async get(jobIdValue: string): Promise<JobMeta> {
    assertJobId(jobIdValue);
    try {
      return await readJson(this.#metaPath(jobIdValue), JobMetaSchema);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HydraError('JOB_NOT_FOUND', 'Hydra job was not found');
      }
      throw error;
    }
  }

  public async list(limit = 20): Promise<readonly JobMeta[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new HydraError('INVALID_LIST_LIMIT', 'Job list limit must be between 1 and 100');
    }
    return (await this.#allRecords())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.jobId.localeCompare(left.jobId))
      .slice(0, limit);
  }

  public async activeCount(): Promise<number> {
    return (await this.#allRecords()).filter(
      ({ status }) => status === 'queued' || status === 'running',
    ).length;
  }

  public async activeRecords(): Promise<readonly JobMeta[]> {
    return (await this.#allRecords()).filter(
      ({ status }) => status === 'queued' || status === 'running',
    );
  }

  public async usageObservations(): Promise<readonly UsageObservation[]> {
    const records = await this.#allRecords();
    const observations = await Promise.all(
      records.map(async (meta): Promise<UsageObservation | undefined> => {
        if (
          meta.status === 'queued' ||
          meta.status === 'running' ||
          meta.claudeVersion === undefined
        ) {
          return undefined;
        }
        const result = await this.#readResultFile(meta.jobId);
        const resolvedModel = result?.resolvedModel ?? meta.resolvedModel;
        if (result?.usage === undefined || resolvedModel === undefined) {
          return undefined;
        }
        return {
          resolvedModel,
          claudeVersion: meta.claudeVersion,
          effort: result.appliedEffort ?? meta.appliedEffort ?? meta.requestedEffort,
          features: meta.usageFeatures,
          usage: result.usage,
          completedAt: result.completedAt,
        };
      }),
    );
    return observations
      .filter((observation): observation is UsageObservation => observation !== undefined)
      .sort((left, right) => left.completedAt.localeCompare(right.completedAt));
  }

  public async activityOverlapping(
    intervalStartedAt: string,
    intervalEndedAt: string,
  ): Promise<readonly JobMeta[]> {
    const started = DateTimeSchema.parse(intervalStartedAt);
    const ended = DateTimeSchema.parse(intervalEndedAt);
    if (Date.parse(started) >= Date.parse(ended)) {
      throw new HydraError(
        'INVALID_ACTIVITY_INTERVAL',
        'Activity interval must end after it starts',
      );
    }
    return (await this.#allRecords())
      .filter(
        (meta) =>
          Date.parse(meta.createdAt) <= Date.parse(ended) &&
          (meta.completedAt === undefined || Date.parse(meta.completedAt) > Date.parse(started)),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId),
      );
  }

  public async delegationRecords(groupId: string): Promise<readonly JobMeta[]> {
    assertJobId(groupId);
    return (await this.#allRecords()).filter(
      ({ delegationGroupId }) => delegationGroupId === groupId,
    );
  }

  public async health(): Promise<HealthSummary> {
    const scan = await this.#scanRecords();
    const issues: HealthSummary['issues'][number][] = [];
    if (scan.invalidRecords > 0) {
      issues.push({
        code: 'JOB_STATE_CORRUPT',
        message: 'One or more durable job records could not be validated',
        count: scan.invalidRecords,
      });
    }
    if (scan.incompleteCreations > 0) {
      issues.push({
        code: 'JOB_CREATION_INCOMPLETE',
        message: 'One or more staged job creations require operator inspection',
        count: scan.incompleteCreations,
      });
    }
    return { state: issues.length === 0 ? 'ok' : 'degraded', issues };
  }

  public transition(
    jobIdValue: string,
    status: JobStatus,
    patch: JobMetaPatch = {},
  ): Promise<JobMeta> {
    return this.#mutate(jobIdValue, (current) => {
      const timestamp = this.#now().toISOString();
      return transitionedMeta(current, status, patch, timestamp);
    });
  }

  public transitionIf(
    jobIdValue: string,
    expectedStatus: JobStatus,
    status: JobStatus,
    patch: JobMetaPatch = {},
  ): Promise<JobMeta> {
    return this.#mutate(jobIdValue, (current) => {
      if (current.status !== expectedStatus) {
        return current;
      }
      return transitionedMeta(current, status, patch, this.#now().toISOString());
    });
  }

  public heartbeat(jobIdValue: string): Promise<JobMeta> {
    const timestamp = this.#now().toISOString();
    return this.#mutate(jobIdValue, (current) =>
      withPatch(current, { heartbeatAt: timestamp }, timestamp),
    );
  }

  public patch(jobIdValue: string, patch: JobMetaPatch): Promise<JobMeta> {
    return this.#mutate(jobIdValue, (current) =>
      withPatch(current, patch, this.#now().toISOString()),
    );
  }

  public requestCancellation(jobIdValue: string): Promise<JobMeta> {
    return this.#mutate(jobIdValue, (current) => {
      if (current.status !== 'queued' && current.status !== 'running') {
        return current;
      }
      const timestamp = this.#now().toISOString();
      if (current.status === 'queued') {
        return withPatch(
          { ...current, status: 'cancelled', completedAt: timestamp },
          { cancellationRequestedAt: timestamp },
          timestamp,
        );
      }
      return withPatch(
        current,
        { cancellationRequestedAt: current.cancellationRequestedAt ?? timestamp },
        timestamp,
      );
    });
  }

  public beginCancellation(jobIdValue: string, queuedError: SafeError): Promise<JobMeta> {
    return this.#exclusive(jobIdValue, async () => {
      const current = await this.get(jobIdValue);
      if (current.status !== 'queued' && current.status !== 'running') {
        return current;
      }
      const timestamp = this.#now().toISOString();
      if (current.status === 'running') {
        const requested = withPatch(
          current,
          { cancellationRequestedAt: current.cancellationRequestedAt ?? timestamp },
          timestamp,
        );
        await atomicWriteJson(this.#metaPath(jobIdValue), requested);
        return requested;
      }
      const result: JobResult = {
        schemaVersion: 1,
        jobId: current.jobId,
        status: 'cancelled',
        requestedModel: current.requestedModel,
        requestedEffort: current.requestedEffort,
        warnings: current.warnings,
        testsRun: [],
        finalText: '',
        eventsComplete: false,
        createdAt: current.createdAt,
        completedAt: timestamp,
        terminationReason: 'cancelled',
        error: queuedError,
      };
      JobResultSchema.parse(result);
      assertCredentialFree(result);
      await atomicCreateJson(this.#resultPath(jobIdValue), result);
      const cancelled = transitionedMeta(
        current,
        'cancelled',
        { cancellationRequestedAt: timestamp, error: queuedError },
        timestamp,
      );
      await atomicWriteJson(this.#metaPath(jobIdValue), cancelled);
      return cancelled;
    });
  }

  public finalizeCancellation(
    jobIdValue: string,
    error: SafeError,
  ): Promise<{ readonly meta: JobMeta; readonly result: JobResult }> {
    return this.#exclusive(jobIdValue, async () => {
      const current = await this.get(jobIdValue);
      const existing = await this.#readResultFile(jobIdValue);
      if (existing !== undefined) {
        if (current.status === 'queued' || current.status === 'running') {
          const reconciled = transitionedMeta(
            current,
            existing.status,
            resultMetaPatch(existing),
            existing.completedAt,
          );
          await atomicWriteJson(this.#metaPath(jobIdValue), reconciled);
          return { meta: reconciled, result: existing };
        }
        return { meta: current, result: existing };
      }
      if (current.status === 'cancelled') {
        const completedAt = current.completedAt ?? this.#now().toISOString();
        const result: JobResult = {
          schemaVersion: 1,
          jobId: current.jobId,
          status: 'cancelled',
          requestedModel: current.requestedModel,
          requestedEffort: current.requestedEffort,
          warnings: current.warnings,
          testsRun: [],
          finalText: '',
          eventsComplete: false,
          createdAt: current.createdAt,
          completedAt,
          terminationReason: 'cancelled',
          error,
        };
        JobResultSchema.parse(result);
        assertCredentialFree(result);
        await atomicCreateJson(this.#resultPath(jobIdValue), result);
        const meta = withPatch(current, { error }, completedAt);
        await atomicWriteJson(this.#metaPath(jobIdValue), meta);
        return { meta, result };
      }
      if (current.status !== 'queued' && current.status !== 'running') {
        throw new HydraError(
          'JOB_STATE_CONFLICT',
          'Hydra cancellation cannot create a result for a conflicting terminal job',
        );
      }
      const completedAt = this.#now().toISOString();
      const result: JobResult = {
        schemaVersion: 1,
        jobId: current.jobId,
        status: 'cancelled',
        requestedModel: current.requestedModel,
        requestedEffort: current.requestedEffort,
        warnings: current.warnings,
        testsRun: [],
        finalText: '',
        eventsComplete: false,
        createdAt: current.createdAt,
        completedAt,
        terminationReason: 'cancelled',
        error,
      };
      JobResultSchema.parse(result);
      assertCredentialFree(result);
      await atomicCreateJson(this.#resultPath(jobIdValue), result);
      const meta = transitionedMeta(
        current,
        'cancelled',
        { cancellationRequestedAt: completedAt, error },
        completedAt,
      );
      await atomicWriteJson(this.#metaPath(jobIdValue), meta);
      return { meta, result };
    });
  }

  public reconcileTerminalResult(jobIdValue: string): Promise<JobMeta> {
    return this.#exclusive(jobIdValue, async () => {
      const current = await this.get(jobIdValue);
      const result = await this.#readResultFile(jobIdValue);
      if (result === undefined) {
        return current;
      }
      if (current.status !== 'queued' && current.status !== 'running') {
        if (current.status !== result.status) {
          throw new HydraError(
            'JOB_STATE_CONFLICT',
            'Hydra job metadata conflicts with its immutable terminal result',
          );
        }
        return current;
      }
      const reconciled = transitionedMeta(
        current,
        result.status,
        resultMetaPatch(result),
        result.completedAt,
      );
      await atomicWriteJson(this.#metaPath(jobIdValue), reconciled);
      return reconciled;
    });
  }

  public finalize(
    jobIdValue: string,
    proposed: JobResult,
    patch: JobMetaPatch = {},
  ): Promise<{ readonly meta: JobMeta; readonly result: JobResult }> {
    return this.#exclusive(jobIdValue, async () => {
      const current = await this.get(jobIdValue);
      this.#assertResultMatchesMeta(current, proposed);
      const existing = await this.#readResultFile(jobIdValue);
      if (existing !== undefined) {
        if (current.status === 'queued' || current.status === 'running') {
          const reconciled = transitionedMeta(
            current,
            existing.status,
            resultMetaPatch(existing),
            existing.completedAt,
          );
          await atomicWriteJson(this.#metaPath(jobIdValue), reconciled);
          return { meta: reconciled, result: existing };
        }
        if (current.status !== existing.status) {
          throw new HydraError(
            'JOB_STATE_CONFLICT',
            'Hydra job metadata conflicts with its immutable terminal result',
          );
        }
        return { meta: current, result: existing };
      }

      const cancellationRequested =
        current.status === 'cancelled' || current.cancellationRequestedAt !== undefined;
      const targetStatus = cancellationRequested ? 'cancelled' : proposed.status;
      const cancellationError: SafeError = {
        code: 'CLAUDE_CANCELLED',
        message: 'Claude execution was cancelled',
      };
      const result = sanitizeResultForPersistence({
        ...proposed,
        status: targetStatus,
        ...(targetStatus === 'cancelled'
          ? { terminationReason: 'cancelled', error: cancellationError }
          : {}),
      });
      if (
        current.status !== 'queued' &&
        current.status !== 'running' &&
        current.status !== targetStatus
      ) {
        throw new HydraError(
          'JOB_STATE_CONFLICT',
          'Hydra job became terminal with a conflicting status during finalization',
        );
      }
      JobResultSchema.parse(result);
      assertCredentialFree(result);
      await atomicCreateJson(this.#resultPath(jobIdValue), result);

      if (current.status !== 'queued' && current.status !== 'running') {
        return { meta: current, result };
      }
      const meta = transitionedMeta(
        current,
        targetStatus,
        {
          ...patch,
          ...resultMetaPatch(result),
        },
        result.completedAt,
      );
      assertCredentialFree(meta);
      JobMetaSchema.parse(meta);
      await atomicWriteJson(this.#metaPath(jobIdValue), meta);
      return { meta, result };
    });
  }

  public setWorker(
    jobIdValue: string,
    workerPid: number,
    workerProcessStartMarker: string,
  ): Promise<JobMeta> {
    this.#assertPositivePid(workerPid);
    if (workerProcessStartMarker.length === 0) {
      throw new HydraError('INVALID_PROCESS_MARKER', 'Worker process marker must not be empty');
    }
    return this.#mutate(jobIdValue, (current) =>
      withPatch(
        current,
        { workerPid, workerProcessStartMarker },
        this.#now().toISOString(),
      ),
    );
  }

  public setClaudeGroup(
    jobIdValue: string,
    claudePgid: number,
    claudeProcessStartMarker: string,
  ): Promise<JobMeta> {
    this.#assertPositivePid(claudePgid);
    if (claudeProcessStartMarker.length === 0) {
      throw new HydraError('INVALID_PROCESS_MARKER', 'Claude process marker must not be empty');
    }
    return this.#mutate(jobIdValue, (current) =>
      withPatch(
        current,
        { claudePgid, claudeProcessStartMarker },
        this.#now().toISOString(),
      ),
    );
  }

  public async appendEvent(jobIdValue: string, event: JsonValue): Promise<void> {
    await this.get(jobIdValue);
    const sanitized = sanitizeClaudeEvent(event);
    assertCredentialFree(sanitized);
    const persisted =
      this.#loggingMode === 'metadata-only'
        ? this.#eventMetadata(sanitized)
        : sanitized;
    const serializedBytes = Buffer.byteLength(JSON.stringify(persisted), 'utf8') + 1;
    let currentBytes = 0;
    try {
      currentBytes = (await lstat(this.#eventsPath(jobIdValue))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (currentBytes + serializedBytes > this.#maxEventBytes) {
      if (!this.#eventLimitRecorded.has(jobIdValue)) {
        const marker: JsonValue = {
          type: 'hydra_event_limit',
          droppedByteLength: serializedBytes,
          sha256: createHash('sha256').update(JSON.stringify(persisted)).digest('hex'),
        };
        const markerBytes = Buffer.byteLength(JSON.stringify(marker), 'utf8') + 1;
        if (currentBytes + markerBytes <= this.#maxEventBytes) {
          await appendJsonLine(this.#eventsPath(jobIdValue), marker);
        }
        this.#eventLimitRecorded.add(jobIdValue);
      }
      return;
    }
    await appendJsonLine(this.#eventsPath(jobIdValue), persisted);
  }

  public async readEvents(jobIdValue: string): Promise<readonly JsonValue[]> {
    await this.get(jobIdValue);
    try {
      const content = await readFile(this.#eventsPath(jobIdValue));
      const events: JsonValue[] = [];
      let lineNumber = 1;
      let offset = 0;
      for (let index = 0; index <= content.byteLength; index += 1) {
        if (index !== content.byteLength && content[index] !== 0x0a) {
          continue;
        }
        let rawLine = content.subarray(offset, index);
        offset = index + 1;
        if (rawLine.at(-1) === 0x0d) {
          rawLine = rawLine.subarray(0, rawLine.byteLength - 1);
        }
        if (rawLine.byteLength > 0) {
          try {
            events.push(JSON.parse(rawLine.toString('utf8')) as JsonValue);
          } catch {
            events.push({
              type: 'hydra_parse_error',
              line: lineNumber,
              sha256: createHash('sha256').update(rawLine).digest('hex'),
              byteLength: rawLine.byteLength,
            });
          }
        }
        lineNumber += 1;
      }
      return events;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  public async appendStderr(
    jobIdValue: string,
    chunk: string,
  ): Promise<{ readonly appendedBytes: number; readonly truncated: boolean }> {
    await this.get(jobIdValue);
    const sanitized = sanitizeText(chunk);
    assertCredentialFree(sanitized);
    const path = this.#stderrPath(jobIdValue);
    let currentBytes = 0;
    try {
      currentBytes = (await lstat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const available = Math.max(0, this.#maxStderrBytes - currentBytes);
    const source = Buffer.from(sanitized, 'utf8');
    const bounded = source.subarray(0, available);
    if (bounded.byteLength > 0) {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.write(bounded);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return {
      appendedBytes: bounded.byteLength,
      truncated: bounded.byteLength < source.byteLength,
    };
  }

  public async readStderr(jobIdValue: string): Promise<string> {
    await this.get(jobIdValue);
    try {
      return await readFile(this.#stderrPath(jobIdValue), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  public async writeResult(jobIdValue: string, result: JobResult): Promise<void> {
    assertJobId(jobIdValue);
    if (result.jobId !== jobIdValue) {
      throw new HydraError('RESULT_JOB_MISMATCH', 'Result job ID does not match its directory');
    }
    this.#assertResultMatchesMeta(await this.get(jobIdValue), result);
    const sanitized = sanitizeResultForPersistence(result);
    JobResultSchema.parse(sanitized);
    assertCredentialFree(sanitized);
    const path = this.#resultPath(jobIdValue);
    try {
      await atomicCreateJson(path, sanitized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new HydraError('RESULT_ALREADY_EXISTS', 'A Hydra terminal result is immutable');
      }
      throw error;
    }
  }

  public async readResult(jobIdValue: string): Promise<JobResult | undefined> {
    await this.get(jobIdValue);
    return this.#readResultFile(jobIdValue);
  }

  async #readResultFile(jobIdValue: string): Promise<JobResult | undefined> {
    try {
      return await readJson(this.#resultPath(jobIdValue), JobResultSchema);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  public async readView(
    jobIdValue: string,
    options: { readonly eventOffset?: number; readonly eventLimit?: number } = {},
  ): Promise<JobResultView> {
    const [meta, allEvents, stderr, result] = await Promise.all([
      this.get(jobIdValue),
      this.readEvents(jobIdValue),
      this.readStderr(jobIdValue),
      this.readResult(jobIdValue),
    ]);
    const eventLimit = options.eventLimit ?? 200;
    if (!Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > 1_000) {
      throw new HydraError('INVALID_EVENT_LIMIT', 'eventLimit must be between 1 and 1000');
    }
    const defaultOffset = Math.max(0, allEvents.length - eventLimit);
    const eventOffset = options.eventOffset ?? defaultOffset;
    if (!Number.isSafeInteger(eventOffset) || eventOffset < 0 || eventOffset > allEvents.length) {
      throw new HydraError('INVALID_EVENT_OFFSET', 'eventOffset is outside the stored event range');
    }
    const events = allEvents.slice(eventOffset, eventOffset + eventLimit);
    const nextEventOffset =
      eventOffset + events.length < allEvents.length ? eventOffset + events.length : undefined;
    return {
      meta,
      events,
      stderr,
      eventCount: allEvents.length,
      eventsTruncated: events.length !== allEvents.length,
      eventOffset,
      ...(nextEventOffset === undefined ? {} : { nextEventOffset }),
      ...(result === undefined ? {} : { result }),
    };
  }

  public async pruneOlderThan(cutoff: Date): Promise<readonly string[]> {
    const removed: string[] = [];
    for (const meta of await this.#allRecords()) {
      if (
        meta.status !== 'queued' &&
        meta.status !== 'running' &&
        new Date(meta.updatedAt).getTime() < cutoff.getTime()
      ) {
        await rm(this.#jobDirectory(meta.jobId), { recursive: true, force: false });
        removed.push(meta.jobId);
      }
    }
    return removed;
  }

  async #allRecords(): Promise<JobMeta[]> {
    return (await this.#scanRecords()).records;
  }

  async #scanRecords(): Promise<{
    readonly records: JobMeta[];
    readonly invalidRecords: number;
    readonly incompleteCreations: number;
  }> {
    if (!existsSync(this.#jobsRoot)) {
      return { records: [], invalidRecords: 0, incompleteCreations: 0 };
    }
    const entries = await readdir(this.#jobsRoot, { withFileTypes: true });
    const jobEntries = entries.filter(
      (entry) => entry.isDirectory() && UuidSchema.safeParse(entry.name).success,
    );
    const settled = await Promise.allSettled(
      jobEntries.map(async (entry) => this.get(entry.name)),
    );
    return {
      records: settled.flatMap((entry) => (entry.status === 'fulfilled' ? [entry.value] : [])),
      invalidRecords: settled.filter((entry) => entry.status === 'rejected').length,
      incompleteCreations: entries.filter(
        (entry) => entry.isDirectory() && entry.name.startsWith('.creating-'),
      ).length,
    };
  }

  async #mutate(jobIdValue: string, change: (current: JobMeta) => JobMeta): Promise<JobMeta> {
    return this.#exclusive(jobIdValue, async () => {
      const current = await this.get(jobIdValue);
      const result = change(current);
      assertCredentialFree(result);
      await atomicWriteJson(this.#metaPath(jobIdValue), result);
      return result;
    });
  }

  async #exclusive<T>(jobIdValue: string, operation: () => Promise<T>): Promise<T> {
    assertJobId(jobIdValue);
    let result: T | undefined;
    const previous = this.#mutations.get(jobIdValue) ?? Promise.resolve();
    const mutation = previous.catch(() => undefined).then(async () => {
      const release = await this.#acquireMetaLock(jobIdValue);
      try {
        result = await operation();
      } finally {
        await release();
      }
    });
    this.#mutations.set(jobIdValue, mutation);
    try {
      await mutation;
    } finally {
      if (this.#mutations.get(jobIdValue) === mutation) {
        this.#mutations.delete(jobIdValue);
      }
    }
    if (result === undefined) {
      throw new HydraError('JOB_MUTATION_FAILED', 'Hydra job mutation did not produce metadata');
    }
    return result;
  }

  async #acquireMetaLock(jobIdValue: string): Promise<() => Promise<void>> {
    const jobDirectory = this.#jobDirectory(jobIdValue);
    return this.#acquireDirectoryLock(
      jobDirectory,
      '.meta-lock',
      '.meta-lock-recovery',
      'Hydra job metadata',
    );
  }

  async #acquireQueueAdmissionLock(): Promise<() => Promise<void>> {
    await ensurePrivateDirectory(this.#stateRoot);
    return this.#acquireDirectoryLock(
      this.#stateRoot,
      '.queue-admission-lock',
      '.queue-admission-lock-recovery',
      'Hydra queue admission',
    );
  }

  async #acquireDirectoryLock(
    parentDirectory: string,
    lockName: string,
    recoveryName: string,
    description: string,
  ): Promise<() => Promise<void>> {
    const lockPath = resolveManagedPath(parentDirectory, lockName);
    const recoveryPath = resolveManagedPath(parentDirectory, recoveryName);
    const timeoutCode = lockName === '.meta-lock' ? 'JOB_META_LOCK_TIMEOUT' : 'STATE_LOCK_TIMEOUT';
    const deadline = Date.now() + this.#metaLockWaitMs;
    for (;;) {
      try {
        await lstat(recoveryPath);
        await this.#recoverRecoveryGuardIfStale(parentDirectory, recoveryPath, recoveryName);
        try {
          await lstat(recoveryPath);
          if (Date.now() >= deadline) {
            throw new HydraError(
              timeoutCode,
              `Timed out waiting for the ${description} recovery lock`,
            );
          }
          await shortDelay(5);
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      try {
        await mkdir(lockPath, { mode: 0o700 });
        const ownerToken = randomUUID();
        try {
          try {
            await lstat(recoveryPath);
            await rm(lockPath, { recursive: true, force: true });
            await shortDelay(5);
            continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error;
            }
          }
          this.#cachedProcessStartMarker ??= this.#processStartMarker();
          await atomicWriteJson(join(lockPath, 'owner.json'), {
            schemaVersion: 1,
            pid: process.pid,
            processStartMarker: await this.#cachedProcessStartMarker,
            acquiredAt: new Date().toISOString(),
            token: ownerToken,
          });
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true });
          throw error;
        }
        return async (): Promise<void> =>
          this.#releaseOwnedDirectoryLock(parentDirectory, lockPath, lockName, ownerToken);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }

      await this.#recoverDirectoryLockIfStale(
        parentDirectory,
        lockPath,
        recoveryPath,
        lockName,
        recoveryName,
      );
      if (Date.now() >= deadline) {
        throw new HydraError(timeoutCode, `Timed out waiting for the ${description} lock`);
      }
      await shortDelay(5);
    }
  }

  async #recoverDirectoryLockIfStale(
    parentDirectory: string,
    lockPath: string,
    recoveryPath: string,
    lockName: string,
    recoveryName: string,
  ): Promise<void> {
    const recoveryToken = randomUUID();
    this.#cachedProcessStartMarker ??= this.#processStartMarker();
    const recoveryOwner: FileLockOwner = {
      schemaVersion: 1,
      pid: process.pid,
      processStartMarker: await this.#cachedProcessStartMarker,
      acquiredAt: new Date().toISOString(),
      token: recoveryToken,
    };
    try {
      await mkdir(recoveryPath, { mode: 0o700 });
      await atomicCreateJson(join(recoveryPath, 'owner.json'), recoveryOwner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return;
      }
      throw error;
    }
    if ((await readFileLockOwner(recoveryPath))?.token !== recoveryToken) {
      return;
    }
    try {
    let modifiedAt: number;
    try {
      modifiedAt = (await lstat(lockPath)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (Date.now() - modifiedAt <= this.#metaLockStaleMs) {
      return;
    }
    let ownerPid: number | undefined;
    let ownerProcessStartMarker: string | undefined;
    try {
      const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as {
        readonly pid?: unknown;
        readonly processStartMarker?: unknown;
      };
      if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        ownerPid = owner.pid;
      }
      if (typeof owner.processStartMarker === 'string' && owner.processStartMarker.length > 0) {
        ownerProcessStartMarker = owner.processStartMarker;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    if (ownerPid !== undefined) {
      if (ownerProcessStartMarker !== undefined) {
        if (await this.#isProcessAlive(ownerPid, ownerProcessStartMarker)) {
          return;
        }
      } else if (pidAlive(ownerPid)) {
        return;
      }
    }
    if ((await readFileLockOwner(recoveryPath))?.token !== recoveryToken) {
      return;
    }
    const quarantine = resolveManagedPath(
      parentDirectory,
      `${lockName}-stale-${randomUUID()}`,
    );
    try {
      await rename(lockPath, quarantine);
      await rm(quarantine, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    } finally {
      await this.#releaseRecoveryGuard(
        parentDirectory,
        recoveryPath,
        recoveryName,
        recoveryToken,
      );
    }
  }

  async #recoverRecoveryGuardIfStale(
    parentDirectory: string,
    recoveryPath: string,
    recoveryName: string,
  ): Promise<void> {
    let details;
    try {
      details = await lstat(recoveryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    const observed = await readFileLockOwner(recoveryPath);
    const acquiredAt = observed?.acquiredAt === undefined
      ? details.mtimeMs
      : new Date(observed.acquiredAt).getTime();
    if (Date.now() - acquiredAt <= this.#metaLockStaleMs) {
      return;
    }
    if (
      observed !== undefined &&
      (await this.#isProcessAlive(observed.pid, observed.processStartMarker))
    ) {
      return;
    }
    const currentDetails = await lstat(recoveryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    const current = await readFileLockOwner(recoveryPath);
    if (
      currentDetails === undefined ||
      currentDetails.dev !== details.dev ||
      currentDetails.ino !== details.ino ||
      !sameFileLockOwner(observed, current)
    ) {
      return;
    }
    const quarantine = resolveManagedPath(
      parentDirectory,
      `${recoveryName}-stale-${randomUUID()}`,
    );
    try {
      await rename(recoveryPath, quarantine);
      const movedDetails = await lstat(quarantine);
      const moved = await readFileLockOwner(quarantine);
      if (
        movedDetails.dev === details.dev &&
        movedDetails.ino === details.ino &&
        sameFileLockOwner(observed, moved)
      ) {
        await rm(quarantine, { recursive: true, force: false });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async #releaseRecoveryGuard(
    parentDirectory: string,
    recoveryPath: string,
    recoveryName: string,
    token: string,
  ): Promise<void> {
    if ((await readFileLockOwner(recoveryPath))?.token !== token) {
      return;
    }
    const quarantine = resolveManagedPath(
      parentDirectory,
      `${recoveryName}-release-${randomUUID()}`,
    );
    try {
      await rename(recoveryPath, quarantine);
      if ((await readFileLockOwner(quarantine))?.token === token) {
        await rm(quarantine, { recursive: true, force: false });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async #releaseOwnedDirectoryLock(
    parentDirectory: string,
    lockPath: string,
    lockName: string,
    token: string,
  ): Promise<void> {
    if ((await readFileLockOwner(lockPath))?.token !== token) {
      return;
    }
    const quarantine = resolveManagedPath(
      parentDirectory,
      `${lockName}-release-${randomUUID()}`,
    );
    try {
      await rename(lockPath, quarantine);
      if ((await readFileLockOwner(quarantine))?.token === token) {
        await rm(quarantine, { recursive: true, force: false });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  #eventMetadata(event: JsonValue): JsonValue {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      return { type: 'unknown' };
    }
    return {
      type: typeof event.type === 'string' ? event.type : 'unknown',
      ...(typeof event.line === 'number' ? { line: event.line } : {}),
      ...(typeof event.subtype === 'string' ? { subtype: event.subtype } : {}),
      ...(typeof event.byteLength === 'number' ? { byteLength: event.byteLength } : {}),
      ...(typeof event.sha256 === 'string' ? { sha256: event.sha256 } : {}),
    };
  }

  #assertPositivePid(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new HydraError('INVALID_PROCESS_ID', 'Process IDs must be positive safe integers');
    }
  }

  #assertResultMatchesMeta(meta: JobMeta, result: JobResult): void {
    if (
      result.jobId !== meta.jobId ||
      result.requestedModel !== meta.requestedModel ||
      result.requestedEffort !== meta.requestedEffort ||
      result.createdAt !== meta.createdAt
    ) {
      throw new HydraError(
        'RESULT_META_MISMATCH',
        'Hydra terminal result does not match immutable job metadata',
      );
    }
  }

  #jobDirectory(jobIdValue: string): string {
    return resolveManagedPath(this.#jobsRoot, jobIdValue);
  }

  #metaPath(jobIdValue: string): string {
    return resolveManagedPath(this.#jobDirectory(jobIdValue), 'meta.json');
  }

  #eventsPath(jobIdValue: string): string {
    return resolveManagedPath(this.#jobDirectory(jobIdValue), 'events.jsonl');
  }

  #stderrPath(jobIdValue: string): string {
    return resolveManagedPath(this.#jobDirectory(jobIdValue), 'stderr.log');
  }

  #resultPath(jobIdValue: string): string {
    return resolveManagedPath(this.#jobDirectory(jobIdValue), 'result.json');
  }
}

interface StoreDependencies {
  readonly stateRoot: string;
  readonly processStartMarker?: () => Promise<string>;
  readonly isProcessAlive?: (pid: number, processStartMarker: string) => Promise<boolean>;
}

export interface ReserveDelegationActivationInput {
  readonly groupId: string;
  readonly jobId: string;
  readonly planId: string;
  readonly suppliedPlanId?: string;
  readonly routeInput: RouteInput;
  readonly route: RouteName;
  readonly plan: DelegationPlan;
  readonly sessionIndex: number;
  readonly activationReason: string;
  readonly evidenceJobId?: string;
}

export class DelegationStore {
  readonly #root: string;
  readonly #now: () => Date;

  public constructor(dependencies: StoreDependencies & { readonly now?: () => Date }) {
    this.#root = join(dependencies.stateRoot, 'delegations');
    this.#now = dependencies.now ?? ((): Date => new Date());
  }

  public async get(groupIdValue: string): Promise<DelegationGroupRecord> {
    assertJobId(groupIdValue);
    try {
      return await readJson(this.#path(groupIdValue), DelegationGroupRecordSchema);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HydraError('DELEGATION_GROUP_NOT_FOUND', 'Hydra delegation group was not found');
      }
      throw error;
    }
  }

  public async reserveActivation(
    input: ReserveDelegationActivationInput,
    jobStore: JobStore,
  ): Promise<DelegationGroupRecord> {
    assertJobId(input.groupId);
    assertJobId(input.jobId);
    if (input.evidenceJobId !== undefined) {
      assertJobId(input.evidenceJobId);
    }
    const plan = DelegationPlanSchema.parse(input.plan) as DelegationPlan;
    const routeInput = RouteInputSchema.parse(input.routeInput);
    const recommendation = plan.sessions[input.sessionIndex];
    if (recommendation === undefined) {
      throw new HydraError(
        'DELEGATION_SESSION_OUT_OF_RANGE',
        'The requested session is not present in the staged delegation plan',
      );
    }

    let current = await this.#readOptional(input.groupId);
    const timestamp = this.#now().toISOString();
    if (current === undefined) {
      if (
        (input.suppliedPlanId ?? input.planId) !== input.planId ||
        input.groupId !== input.jobId ||
        input.sessionIndex !== 0 ||
        recommendation.activation !== 'immediate'
      ) {
        throw new HydraError(
          'DELEGATION_GROUP_NOT_FOUND',
          'A delegation group must be rooted at its first immediate job',
        );
      }
      const created: DelegationGroupRecord = {
        schemaVersion: 1,
        groupId: input.groupId,
        planId: input.planId,
        routeInput,
        route: input.route,
        plan,
        activations: [this.#activation(input, recommendation.activation, timestamp)],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.#write(created);
      return created;
    }

    current = await this.#reconcileDangling(current, jobStore);
    const suppliedPlanId = input.suppliedPlanId ?? input.planId;
    const acceptedPersistedPlanId =
      suppliedPlanId === current.planId || suppliedPlanId === current.legacyPlanId;
    if (
      !acceptedPersistedPlanId ||
      (current.legacyPlanId === undefined && current.planId !== input.planId) ||
      current.route !== input.route ||
      JSON.stringify(current.routeInput) !== JSON.stringify(routeInput) ||
      JSON.stringify(current.plan) !== JSON.stringify(plan)
    ) {
      throw new HydraError(
        'DELEGATION_PLAN_MISMATCH',
        'The activation does not match the immutable delegation plan',
      );
    }
    if (current.planId !== input.planId) {
      current = {
        ...current,
        planId: input.planId,
        legacyPlanId: current.legacyPlanId ?? current.planId,
        updatedAt: timestamp,
      };
    }
    if (current.activations.length === 0) {
      throw new HydraError(
        'DELEGATION_ROOT_MISSING',
        'The delegation root job was not durably created',
      );
    }
    if (current.activations.some(({ sessionIndex }) => sessionIndex === input.sessionIndex)) {
      throw new HydraError(
        'DELEGATION_SESSION_ALREADY_ACTIVATED',
        'The requested delegation session was already activated',
      );
    }
    if (current.activations.length >= current.plan.maxTotalSessions) {
      throw new HydraError(
        'DELEGATION_TOTAL_LIMIT',
        'The delegation already reached its total fresh-session limit',
      );
    }
    if (
      recommendation.activation === 'immediate' &&
      current.activations.filter(({ activation }) => activation === 'immediate').length >=
        current.plan.maxImmediateSessions
    ) {
      throw new HydraError(
        'DELEGATION_IMMEDIATE_LIMIT',
        'The delegation already reached its immediate-session limit',
      );
    }
    if (current.sufficientAt !== undefined && recommendation.activation !== 'immediate') {
      throw new HydraError(
        'DELEGATION_ALREADY_SUFFICIENT',
        'An accepted group result suppresses conditional delegation sessions',
      );
    }

    const jobs = await jobStore.delegationRecords(input.groupId);
    if (
      recommendation.activation !== 'immediate' &&
      jobs.some(({ status }) => status === 'queued' || status === 'running')
    ) {
      throw new HydraError(
        'DELEGATION_SEQUENTIAL_BUSY',
        'Conditional delegation must wait for active group jobs to finish',
      );
    }
    if (
      recommendation.activation === 'if-unresolved' ||
      recommendation.activation === 'if-contradiction'
    ) {
      if (input.evidenceJobId === undefined) {
        throw new HydraError(
          'DELEGATION_EVIDENCE_REQUIRED',
          'Conditional delegation requires a terminal evidence job from the same group',
        );
      }
      const evidence = await jobStore.get(input.evidenceJobId);
      if (
        evidence.delegationGroupId !== input.groupId ||
        evidence.status === 'queued' ||
        evidence.status === 'running'
      ) {
        throw new HydraError(
          'DELEGATION_EVIDENCE_INVALID',
          'Conditional delegation evidence must be terminal and belong to the same group',
        );
      }
    } else if (input.evidenceJobId !== undefined) {
      throw new HydraError(
        'DELEGATION_EVIDENCE_UNEXPECTED',
        'Immediate delegation activation cannot claim conditional evidence',
      );
    }

    const updated: DelegationGroupRecord = {
      ...current,
      activations: [
        ...current.activations,
        this.#activation(input, recommendation.activation, timestamp),
      ],
      updatedAt: timestamp,
    };
    await this.#write(updated);
    return updated;
  }

  public async rollbackActivation(groupIdValue: string, jobIdValue: string): Promise<void> {
    assertJobId(groupIdValue);
    assertJobId(jobIdValue);
    const current = await this.#readOptional(groupIdValue);
    if (current === undefined) {
      return;
    }
    const activations = current.activations.filter(({ jobId }) => jobId !== jobIdValue);
    if (activations.length === current.activations.length) {
      return;
    }
    if (activations.length === 0) {
      await unlink(this.#path(groupIdValue)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      });
      return;
    }
    await this.#write({ ...current, activations, updatedAt: this.#now().toISOString() });
  }

  public async markSufficient(
    groupIdValue: string,
    jobIdValue: string,
    jobStore: JobStore,
  ): Promise<DelegationGroupRecord> {
    const current = await this.get(groupIdValue);
    const job = await jobStore.get(jobIdValue);
    if (
      job.delegationGroupId !== groupIdValue ||
      job.status === 'queued' ||
      job.status === 'running'
    ) {
      throw new HydraError(
        'DELEGATION_SUFFICIENCY_INVALID',
        'Only a terminal job in the delegation group can close conditional activation',
      );
    }
    if (current.sufficientAt !== undefined) {
      return current;
    }
    const timestamp = this.#now().toISOString();
    const updated: DelegationGroupRecord = {
      ...current,
      sufficientAt: timestamp,
      sufficientJobId: job.jobId,
      updatedAt: timestamp,
    };
    await this.#write(updated);
    return updated;
  }

  public async summary(
    groupIdValue: string,
    jobStore: JobStore,
  ): Promise<DelegationGroupSummary> {
    const record = await this.get(groupIdValue);
    const jobs = await jobStore.delegationRecords(groupIdValue);
    const existingJobIds = new Set(jobs.map(({ jobId }) => jobId));
    const activations = record.activations.filter(({ jobId }) => existingJobIds.has(jobId));
    const results = await Promise.all(jobs.map(async ({ jobId }) => jobStore.readResult(jobId)));
    const suppliedContext = jobs.reduce(
      (total, job) => ({
        promptBytes: total.promptBytes + job.usageFeatures.promptBytes,
        roleBytes: total.roleBytes + job.usageFeatures.roleBytes,
        schemaBytes: total.schemaBytes + job.usageFeatures.schemaBytes,
        referencedBytes: total.referencedBytes + job.usageFeatures.referencedBytes,
      }),
      { promptBytes: 0, roleBytes: 0, schemaBytes: 0, referencedBytes: 0 },
    );
    const usage: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    } = {};
    for (const result of results) {
      if (result?.usage === undefined) {
        continue;
      }
      for (const key of [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheCreationTokens',
      ] as const) {
        const value = result.usage[key];
        if (value !== undefined) {
          usage[key] = (usage[key] ?? 0) + value;
        }
      }
    }
    return {
      groupId: record.groupId,
      planId: record.planId,
      ...(record.legacyPlanId === undefined
        ? {}
        : { legacyPlanId: record.legacyPlanId }),
      strategy: record.plan.strategy,
      maxImmediateSessions: record.plan.maxImmediateSessions,
      maxTotalSessions: record.plan.maxTotalSessions,
      activatedSessions: new Set(activations.map(({ sessionIndex }) => sessionIndex)).size,
      jobCount: jobs.length,
      terminalJobCount: jobs.filter(
        ({ status }) => status !== 'queued' && status !== 'running',
      ).length,
      sharedContextBytes: record.plan.sharedContextBytes,
      replicatedContextBytesImmediate:
        record.plan.replicatedContextBytesImmediate,
      replicatedContextBytesAllActivated:
        record.plan.replicatedContextBytesAllActivated,
      replicatedContextBytesActivated:
        record.plan.sharedContextBytes * activations.length,
      suppliedContext,
      usage,
      sufficient: record.sufficientAt !== undefined,
      activations,
    };
  }

  async #reconcileDangling(
    record: DelegationGroupRecord,
    jobStore: JobStore,
  ): Promise<DelegationGroupRecord> {
    const activations: DelegationActivationRecord[] = [];
    for (const activation of record.activations) {
      try {
        await jobStore.get(activation.jobId);
        activations.push(activation);
      } catch (error) {
        if (!(error instanceof HydraError) || error.code !== 'JOB_NOT_FOUND') {
          throw error;
        }
      }
    }
    if (activations.length === record.activations.length) {
      return record;
    }
    const updated = { ...record, activations, updatedAt: this.#now().toISOString() };
    await this.#write(updated);
    return updated;
  }

  #activation(
    input: ReserveDelegationActivationInput,
    activation: SessionActivation,
    activatedAt: string,
  ): DelegationActivationRecord {
    return {
      sessionIndex: input.sessionIndex,
      jobId: input.jobId as JobId,
      activation,
      activationReason: input.activationReason,
      ...(input.evidenceJobId === undefined
        ? {}
        : { evidenceJobId: input.evidenceJobId as JobId }),
      activatedAt,
    };
  }

  async #readOptional(groupIdValue: string): Promise<DelegationGroupRecord | undefined> {
    try {
      return await this.get(groupIdValue);
    } catch (error) {
      if (error instanceof HydraError && error.code === 'DELEGATION_GROUP_NOT_FOUND') {
        return undefined;
      }
      throw error;
    }
  }

  async #write(record: DelegationGroupRecord): Promise<void> {
    const parsed = DelegationGroupRecordSchema.parse(record);
    assertCredentialFree(parsed);
    await atomicWriteJson(this.#path(parsed.groupId), parsed);
  }

  #path(groupIdValue: string): string {
    return resolveManagedPath(this.#root, `${groupIdValue}.json`);
  }
}

export interface ContinuationClaim {
  readonly jobId: string;
  readonly acquiredAt: string;
  readonly state: 'dispatching' | 'active';
  readonly ownerPid?: number;
  readonly ownerProcessStartMarker?: string;
}

export class SessionStore {
  readonly #root: string;
  readonly #processStartMarker: () => Promise<string>;
  readonly #isProcessAlive: (pid: number, marker: string) => Promise<boolean>;
  #cachedProcessStartMarker: Promise<string> | undefined;

  public constructor(dependencies: StoreDependencies) {
    this.#root = join(dependencies.stateRoot, 'sessions');
    this.#processStartMarker =
      dependencies.processStartMarker ?? ((): Promise<string> => readProcessStartMarker(process.pid));
    this.#isProcessAlive = dependencies.isProcessAlive ?? processIdentityAlive;
  }

  public async put(record: SessionRecord): Promise<void> {
    const parsed = SessionRecordSchema.parse(record);
    assertCredentialFree(parsed);
    await atomicWriteJson(this.#path(parsed.sessionId), parsed);
  }

  public async get(sessionId: string): Promise<SessionRecord> {
    if (!UuidSchema.safeParse(sessionId).success) {
      throw new HydraError('INVALID_SESSION_ID', 'Claude session ID must be a UUID');
    }
    try {
      return await readJson(this.#path(sessionId), SessionRecordSchema);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HydraError('SESSION_NOT_FOUND', 'Claude session was not found');
      }
      throw error;
    }
  }

  public async claimContinuation(sessionId: string, jobIdValue: string): Promise<void> {
    await this.get(sessionId);
    assertJobId(jobIdValue);
    this.#cachedProcessStartMarker ??= this.#processStartMarker();
    const claim = {
      schemaVersion: 1,
      sessionId,
      jobId: jobIdValue,
      acquiredAt: new Date().toISOString(),
      state: 'dispatching',
      ownerPid: process.pid,
      ownerProcessStartMarker: await this.#cachedProcessStartMarker,
    } as const;
    try {
      await atomicCreateJson(this.#claimPath(sessionId), claim);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const active = await this.getContinuationClaim(sessionId);
      throw new HydraError('SESSION_BUSY', 'Claude session already has an active continuation', {
        ...(active === undefined ? {} : { activeJobId: active.jobId }),
      });
    }
  }

  public async getContinuationClaim(
    sessionId: string,
  ): Promise<ContinuationClaim | undefined> {
    if (!UuidSchema.safeParse(sessionId).success) {
      throw new HydraError('INVALID_SESSION_ID', 'Claude session ID must be a UUID');
    }
    try {
      const value = JSON.parse(await readFile(this.#claimPath(sessionId), 'utf8')) as {
        readonly schemaVersion?: unknown;
        readonly sessionId?: unknown;
        readonly jobId?: unknown;
        readonly acquiredAt?: unknown;
        readonly state?: unknown;
        readonly ownerPid?: unknown;
        readonly ownerProcessStartMarker?: unknown;
      };
      const state = value.state ?? 'active';
      if (
        value.schemaVersion !== 1 ||
        value.sessionId !== sessionId ||
        typeof value.jobId !== 'string' ||
        !UuidSchema.safeParse(value.jobId).success ||
        typeof value.acquiredAt !== 'string' ||
        (state !== 'dispatching' && state !== 'active') ||
        (state === 'dispatching' &&
          (typeof value.ownerPid !== 'number' ||
            !Number.isSafeInteger(value.ownerPid) ||
            value.ownerPid <= 0 ||
            typeof value.ownerProcessStartMarker !== 'string' ||
            value.ownerProcessStartMarker.length === 0))
      ) {
        throw new HydraError('SESSION_CLAIM_INVALID', 'Claude session claim is invalid');
      }
      return {
        jobId: value.jobId,
        acquiredAt: value.acquiredAt,
        state,
        ...(typeof value.ownerPid === 'number' ? { ownerPid: value.ownerPid } : {}),
        ...(typeof value.ownerProcessStartMarker === 'string'
          ? { ownerProcessStartMarker: value.ownerProcessStartMarker }
          : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  public async continuationDispatchAlive(claim: ContinuationClaim): Promise<boolean> {
    if (
      claim.state !== 'dispatching' ||
      claim.ownerPid === undefined ||
      claim.ownerProcessStartMarker === undefined
    ) {
      return false;
    }
    return this.#isProcessAlive(claim.ownerPid, claim.ownerProcessStartMarker);
  }

  public async activateContinuation(sessionId: string, jobIdValue: string): Promise<void> {
    const claim = await this.getContinuationClaim(sessionId);
    if (claim?.jobId !== jobIdValue || claim.state !== 'dispatching') {
      throw new HydraError(
        'SESSION_CLAIM_INVALID',
        'Hydra continuation dispatch claim is no longer owned by this job',
      );
    }
    await atomicWriteJson(this.#claimPath(sessionId), {
      schemaVersion: 1,
      sessionId,
      jobId: jobIdValue,
      acquiredAt: claim.acquiredAt,
      state: 'active',
    });
  }

  public async releaseContinuation(sessionId: string, jobIdValue: string): Promise<boolean> {
    assertJobId(jobIdValue);
    const claim = await this.getContinuationClaim(sessionId);
    if (claim?.jobId !== jobIdValue) {
      return false;
    }
    const quarantinePath = resolveManagedPath(
      this.#root,
      `${sessionId}.${jobIdValue}.claim-release`,
    );
    try {
      await rename(this.#claimPath(sessionId), quarantinePath);
      try {
        const moved = JSON.parse(await readFile(quarantinePath, 'utf8')) as {
          readonly jobId?: unknown;
        };
        if (moved.jobId !== jobIdValue) {
          await rename(quarantinePath, this.#claimPath(sessionId));
          return false;
        }
      } catch (error) {
        await rename(quarantinePath, this.#claimPath(sessionId)).catch(() => undefined);
        throw error;
      }
      await unlink(quarantinePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  #path(sessionId: string): string {
    return resolveManagedPath(this.#root, `${sessionId}.json`);
  }

  #claimPath(sessionId: string): string {
    return resolveManagedPath(this.#root, `${sessionId}.claim.json`);
  }
}

export class OutcomeStore {
  readonly #root: string;

  public constructor(dependencies: StoreDependencies) {
    this.#root = join(dependencies.stateRoot, 'outcomes');
  }

  public async put(record: OutcomeRecord): Promise<void> {
    const parsed = OutcomeRecordSchema.parse(record);
    assertCredentialFree(parsed);
    await atomicWriteJson(this.#path(parsed.jobId), parsed);
  }

  public async get(jobIdValue: string): Promise<OutcomeRecord> {
    assertJobId(jobIdValue);
    try {
      return await readJson(this.#path(jobIdValue), OutcomeRecordSchema);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HydraError('OUTCOME_NOT_FOUND', 'Hydra outcome was not found');
      }
      throw error;
    }
  }

  #path(jobIdValue: string): string {
    return resolveManagedPath(this.#root, `${jobIdValue}.json`);
  }
}

export interface OutcomeRecorderDependencies {
  readonly jobStore: JobStore;
  readonly outcomeStore: OutcomeStore;
  readonly delegationStore: DelegationStore;
  readonly now?: () => Date;
}

export class OutcomeRecorder {
  readonly #jobStore: JobStore;
  readonly #outcomeStore: OutcomeStore;
  readonly #delegationStore: DelegationStore;
  readonly #now: () => Date;

  public constructor(dependencies: OutcomeRecorderDependencies) {
    this.#jobStore = dependencies.jobStore;
    this.#outcomeStore = dependencies.outcomeStore;
    this.#delegationStore = dependencies.delegationStore;
    this.#now = dependencies.now ?? ((): Date => new Date());
  }

  public async record(input: RecordOutcomeInput): Promise<OutcomeRecord> {
    assertJobId(input.jobId);
    const [meta, result] = await Promise.all([
      this.#jobStore.reconcileTerminalResult(input.jobId),
      this.#jobStore.readResult(input.jobId),
    ]);
    if (
      result === undefined ||
      meta.status === 'queued' ||
      meta.status === 'running'
    ) {
      throw new HydraError(
        'OUTCOME_JOB_NOT_TERMINAL',
        'Hydra outcomes can only be recorded for a durable terminal job result',
      );
    }
    if (result.status !== meta.status) {
      throw new HydraError(
        'JOB_STATE_CONFLICT',
        'Hydra job metadata conflicts with its immutable terminal result',
      );
    }
    const inferredDuration = Math.max(
      0,
      new Date(result.completedAt).getTime() - new Date(result.createdAt).getTime(),
    );
    const baseRecord: OutcomeRecord = {
      schemaVersion: 2,
      jobId: meta.jobId,
      taskType: input.taskType,
      scope: input.scope,
      requestedModel: meta.requestedModel,
      model: result.resolvedModel ?? meta.requestedModel,
      effort: result.appliedEffort ?? meta.requestedEffort,
      status: result.status,
      durationMs: result.durationMs ?? inferredDuration,
      completedAt: result.completedAt,
      observedTests: result.testsRun,
      accepted: input.accepted,
      recordedAt: this.#now().toISOString(),
      acceptedClaims: input.acceptedClaims,
      rejectedClaims: input.rejectedClaims,
      falsePositives: input.falsePositives,
      testsBefore: input.testsBefore,
      testsAfter: input.testsAfter,
      ...(input.testsPassed === undefined ? {} : { testsPassed: input.testsPassed }),
      ...(input.patchAccepted === undefined ? {} : { patchAccepted: input.patchAccepted }),
      ...(input.userVerdict === undefined ? {} : { userVerdict: input.userVerdict }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    };
    assertCredentialFree(baseRecord);
    let delegation: OutcomeRecord['delegation'];
    if (meta.delegationGroupId !== undefined) {
      const summary = input.accepted
        ? await this.#jobStore.withAdmissionLock(async () => {
            await this.#delegationStore.markSufficient(
              meta.delegationGroupId!,
              meta.jobId,
              this.#jobStore,
            );
            return this.#delegationStore.summary(meta.delegationGroupId!, this.#jobStore);
          })
        : await this.#delegationStore.summary(meta.delegationGroupId, this.#jobStore);
      delegation = {
        groupId: summary.groupId,
        activatedSessions: summary.activatedSessions,
        jobCount: summary.jobCount,
        terminalJobCount: summary.terminalJobCount,
        sufficient: summary.sufficient,
        usage: summary.usage,
      };
    }
    const record: OutcomeRecord = {
      ...baseRecord,
      ...(delegation === undefined ? {} : { delegation }),
    };
    await this.#outcomeStore.put(record);
    return record;
  }
}

export class ConfigStore {
  readonly #stateRoot: string;
  readonly #path: string;

  public constructor(dependencies: StoreDependencies) {
    this.#stateRoot = dependencies.stateRoot;
    this.#path = join(dependencies.stateRoot, 'config.json');
  }

  public async put(overrides: unknown): Promise<HydraConfig> {
    const parsedOverrides = HydraConfigOverridesSchema.parse(overrides);
    if (
      parsedOverrides.stateRoot !== undefined &&
      parsedOverrides.stateRoot !== this.#stateRoot
    ) {
      throw new HydraError(
        'CONFIG_STATE_ROOT_MISMATCH',
        'A Hydra configuration store cannot redirect its managed state root',
      );
    }
    const config = loadConfig({ ...parsedOverrides, stateRoot: this.#stateRoot });
    assertCredentialFree(config);
    const persisted = Object.fromEntries(
      Object.entries(config).filter(
        ([key, value]) =>
          key === 'stateRoot' ||
          value !== DEFAULT_CONFIG[key as keyof HydraConfig],
      ),
    );
    const envelope = HydraConfigFileSchema.parse({
      schemaVersion: 1,
      overrides: HydraConfigOverridesSchema.parse(persisted),
    });
    await atomicWriteJson(this.#path, envelope);
    return config;
  }

  public async get(): Promise<HydraConfig> {
    if (!(await pathExists(this.#path))) {
      return loadConfig({ stateRoot: this.#stateRoot });
    }
    const raw = JSON.parse(await readFile(this.#path, 'utf8')) as unknown;
    const envelope = HydraConfigFileSchema.safeParse(raw);
    if (envelope.success) {
      const configuredRoot = envelope.data.overrides.stateRoot;
      if (configuredRoot !== undefined && configuredRoot !== this.#stateRoot) {
        throw new HydraError(
          'CONFIG_STATE_ROOT_MISMATCH',
          'The versioned Hydra configuration belongs to another state root',
        );
      }
      return loadConfig({ ...envelope.data.overrides, stateRoot: this.#stateRoot });
    }
    return HydraConfigSchema.parse(raw);
  }
}

export function asJobId(value: string): JobId {
  assertJobId(value);
  return value;
}
