import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { RouteInputSchema, type RouteInput } from './routing-contract.js';
import type { HydraConfig } from './config.js';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JOB_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const ACCESS_MODES = ['analyze', 'test', 'execute'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export type JobId = string & { readonly __jobId: unique symbol };

export const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  queued: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled', 'timed-out'],
  completed: [],
  failed: [],
  cancelled: [],
  'timed-out': [],
});

const MODEL_PATTERN = /^(?:sonnet|opus|fable|claude-(?:sonnet|opus|fable)-[0-9]+(?:-[0-9]+)*)$/u;
const MAX_TASK_BYTES = 200_000;
const MAX_SCHEMA_BYTES = 100_000;

const TaskSchema = z
  .string()
  .refine((value) => value.trim().length > 0, 'task must contain non-whitespace text')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_TASK_BYTES,
    `task must not exceed ${MAX_TASK_BYTES} bytes`,
  );

const MessageSchema = z
  .string()
  .refine((value) => value.trim().length > 0, 'message must contain non-whitespace text')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_TASK_BYTES,
    `message must not exceed ${MAX_TASK_BYTES} bytes`,
  );

const ModelSchema = z
  .string()
  .max(128)
  .regex(
    MODEL_PATTERN,
    'model must be sonnet, opus, fable, or a full Claude Sonnet/Opus/Fable identifier',
  );

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), 'cwd must be an absolute path');

export const DelegationStartSchema = z
  .object({
    routeInput: RouteInputSchema,
    planId: z.string().regex(/^[a-f0-9]{64}$/u),
    groupId: z.string().uuid().optional(),
    sessionIndex: z.number().int().min(0).max(2),
    activationReason: z.string().trim().min(1).max(2_000),
    evidenceJobId: z.string().uuid().optional(),
  })
  .strict();

export interface DelegationStart {
  readonly routeInput: RouteInput;
  readonly planId: string;
  readonly groupId?: string;
  readonly sessionIndex: number;
  readonly activationReason: string;
  readonly evidenceJobId?: string;
}

export const BudgetIntentSchema = z
  .object({
    priority: z.enum(['quality-floor', 'opportunistic']),
    valuableWork: z.boolean(),
    distinctInformationGain: z.boolean(),
  })
  .strict();

export type BudgetIntent = z.infer<typeof BudgetIntentSchema>;

function isJsonValue(value: unknown, seen: WeakSet<object>): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, seen));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  return Object.values(value).every((item) => isJsonValue(item, seen));
}

const OutputSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => isJsonValue(value, new WeakSet<object>()), {
    message: 'outputSchema must contain only JSON values',
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_SCHEMA_BYTES, {
    message: `outputSchema must not exceed ${MAX_SCHEMA_BYTES} bytes`,
  });

export const StartJobInputSchema = z
  .object({
    task: TaskSchema,
    cwd: AbsolutePathSchema,
    model: ModelSchema,
    effort: z.enum(EFFORT_LEVELS),
    role: z.string().trim().min(1).max(2_000),
    accessMode: z.enum(ACCESS_MODES),
    maxTurns: z.number().int().min(1).max(100).default(12),
    timeoutSec: z.number().int().min(1).max(86_400).default(1_800),
    outputSchema: OutputSchema.optional(),
    strictModel: z.boolean().default(false),
    delegation: DelegationStartSchema.optional(),
    budgetIntent: BudgetIntentSchema.optional(),
  })
  .strict();

export type StartJobInput = z.infer<typeof StartJobInputSchema>;

export const ContinueJobInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    message: MessageSchema,
    effort: z.enum(EFFORT_LEVELS).optional(),
    maxTurns: z.number().int().min(1).max(100).optional(),
    timeoutSec: z.number().int().min(1).max(86_400).optional(),
    outputSchema: OutputSchema.optional(),
  })
  .strict();

export type ContinueJobInput = z.infer<typeof ContinueJobInputSchema>;

export interface SafeError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export interface ClaudeCapabilities {
  readonly flags: Readonly<Record<string, boolean>>;
  readonly supportsCliMaxTurns: boolean;
  readonly supportsDirectSandboxFlag: boolean;
}

export interface TokenFeatureVector {
  readonly promptBytes: number;
  readonly roleBytes: number;
  readonly schemaBytes: number;
  readonly referencedBytes: number;
  readonly expectedTurns: number;
  readonly toolClass: AccessMode;
}

export interface JobMeta {
  readonly schemaVersion: 1;
  readonly jobId: JobId;
  readonly status: JobStatus;
  readonly input: StartJobInput;
  readonly requestedModel: string;
  readonly requestedEffort: Effort;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly warnings: readonly string[];
  readonly usageFeatures: TokenFeatureVector;
  readonly runtimeConfig?: HydraConfig;
  readonly startedAt?: string;
  readonly completedAt?: string;
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
  readonly error?: SafeError;
}

export interface ReportedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly costUsdEstimate?: number;
}

export interface TestExecution {
  readonly command: string;
  readonly toolUseId?: string;
  readonly status: 'attempted' | 'completed' | 'failed';
  readonly outputDigest?: string;
}

export interface WorktreeEvidence {
  readonly path?: string;
  readonly changedFiles: readonly string[];
  readonly patch?: string;
  readonly mainCheckoutChanged: boolean;
  readonly beforeFingerprint?: string;
  readonly afterFingerprint?: string;
}

export type ResultRedactionField =
  | 'warnings'
  | 'testsRun'
  | 'finalText'
  | 'structuredOutput'
  | 'terminationReason'
  | 'worktree.patch'
  | 'error';

export interface ResultRedaction {
  readonly field: ResultRedactionField;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface JobResult {
  readonly schemaVersion: 1;
  readonly jobId: JobId;
  readonly status: JobStatus;
  readonly requestedModel: string;
  readonly requestedEffort: Effort;
  readonly warnings: readonly string[];
  readonly testsRun: readonly TestExecution[];
  readonly finalText: string;
  readonly eventsComplete: boolean;
  readonly createdAt: string;
  readonly completedAt: string;
  readonly structuredOutput?: JsonValue;
  readonly resolvedModel?: string;
  readonly reportedModels?: readonly string[];
  readonly canonicalModelId?: string;
  readonly appliedEffort?: Effort;
  readonly sessionId?: string;
  readonly usage?: ReportedUsage;
  readonly turns?: number;
  readonly reportedSessionTurns?: number;
  readonly durationMs?: number;
  readonly terminationReason?: string;
  readonly worktree?: WorktreeEvidence;
  readonly error?: SafeError;
  readonly redactions?: readonly ResultRedaction[];
}

export interface SessionRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly latestJobId: JobId;
  readonly model: string;
  readonly effort: Effort;
  readonly role: string;
  readonly accessMode: AccessMode;
  readonly strictModel: boolean;
  readonly maxTurns: number;
  readonly timeoutSec: number;
  readonly cwd: string;
  readonly worktreePath?: string;
  readonly delegationGroupId?: string;
  readonly delegationPlanId?: string;
  readonly delegationSessionIndex?: number;
  readonly updatedAt: string;
}

export const OUTCOME_TASK_TYPES = [
  'routine',
  'feature',
  'debug',
  'architecture',
  'review',
  'migration',
  'research',
] as const;
export type OutcomeTaskType = (typeof OUTCOME_TASK_TYPES)[number];

export const OUTCOME_SCOPES = ['local', 'module', 'repo'] as const;
export type OutcomeScope = (typeof OUTCOME_SCOPES)[number];

export const USER_VERDICTS = ['accepted', 'rejected', 'mixed'] as const;
export type UserVerdict = (typeof USER_VERDICTS)[number];

export interface RecordOutcomeInput {
  readonly jobId: string;
  readonly taskType: OutcomeTaskType;
  readonly scope: OutcomeScope;
  readonly accepted: boolean;
  readonly acceptedClaims: readonly string[];
  readonly rejectedClaims: readonly string[];
  readonly falsePositives: readonly string[];
  readonly testsBefore: readonly string[];
  readonly testsAfter: readonly string[];
  readonly testsPassed?: boolean;
  readonly patchAccepted?: boolean;
  readonly userVerdict?: UserVerdict;
  readonly notes?: string;
}

export interface OutcomeRecord {
  readonly schemaVersion: 2;
  readonly jobId: JobId;
  readonly taskType: OutcomeTaskType;
  readonly scope: OutcomeScope;
  readonly requestedModel: string;
  readonly model: string;
  readonly effort: Effort;
  readonly status: Exclude<JobStatus, 'queued' | 'running'>;
  readonly durationMs: number;
  readonly completedAt: string;
  readonly observedTests: readonly TestExecution[];
  readonly accepted: boolean;
  readonly recordedAt: string;
  readonly acceptedClaims: readonly string[];
  readonly rejectedClaims: readonly string[];
  readonly falsePositives: readonly string[];
  readonly testsBefore: readonly string[];
  readonly testsAfter: readonly string[];
  readonly testsPassed?: boolean;
  readonly patchAccepted?: boolean;
  readonly userVerdict?: UserVerdict;
  readonly notes?: string;
  readonly delegation?: DelegationOutcomeEvidence;
}

export interface DelegationOutcomeEvidence {
  readonly groupId: JobId;
  readonly activatedSessions: number;
  readonly jobCount: number;
  readonly terminalJobCount: number;
  readonly sufficient: boolean;
  readonly usage: Readonly<{
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }>;
}

export class HydraError extends Error {
  public readonly code: string;
  public readonly details?: Readonly<Record<string, JsonValue>>;

  public constructor(
    code: string,
    message: string,
    details?: Readonly<Record<string, JsonValue>>,
  ) {
    super(message);
    this.name = 'HydraError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }

  public toSafeError(): SafeError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function parseStartJobInput(value: unknown): StartJobInput {
  return StartJobInputSchema.parse(value);
}

export function parseContinueJobInput(value: unknown): ContinueJobInput {
  return ContinueJobInputSchema.parse(value);
}

export function assertJobId(value: string): asserts value is JobId {
  if (!z.string().uuid().safeParse(value).success) {
    throw new HydraError('INVALID_JOB_ID', 'jobId must be a UUID');
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new HydraError(
      'INVALID_JOB_TRANSITION',
      `Cannot transition a Hydra job from ${from} to ${to}`,
    );
  }
}
