import { fileURLToPath, pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { loadConfig, type HydraConfig } from './config.js';
import { UsageBudgetSnapshotSchema, type UsageBudgetSnapshot } from './budget.js';
import { BudgetService } from './budget-service.js';
import { BudgetStore } from './budget-store.js';
import {
  HYDRA_RUNTIME_IDENTITY,
  HYDRA_VERSION,
  TOOL_OUTPUT_SCHEMAS,
  type HydraRuntimeIdentity,
  type HealthSummary,
} from './contract.js';
import {
  ContinueJobInputSchema,
  HydraError,
  StartJobInputSchema,
  type ContinueJobInput,
  type RecordOutcomeInput,
  type SafeError,
  type StartJobInput,
} from './domain.js';
import {
  DetachedWorkerLauncher,
  JobService,
  NodeProcessGroupController,
} from './job-service.js';
import { NodeProcessRunner } from './platform/process.js';
import { HydraTransport } from './mcp-transport.js';
import { PolicyEngine, RouteInputSchema, type RouteInput } from './policy.js';
import { PreflightService } from './preflight.js';
import {
  ConfigStore,
  DelegationStore,
  JobStore,
  OutcomeRecorder,
  OutcomeStore,
  SessionStore,
} from './stores.js';

export interface HydraServices {
  readonly preflight: {
    check: (input: { readonly cwd?: string }) => Promise<unknown>;
  };
  readonly policy: {
    route: (input: RouteInput) => unknown;
  };
  readonly jobs: {
    start: (input: StartJobInput) => Promise<unknown>;
    status: (jobId?: string) => Promise<unknown>;
    health: () => Promise<HealthSummary>;
    result: (
      jobId: string,
      options?: { readonly eventOffset?: number; readonly eventLimit?: number },
    ) => Promise<unknown>;
    continue: (input: ContinueJobInput) => Promise<unknown>;
    cancel: (jobId: string) => Promise<unknown>;
  };
  readonly outcomes: {
    record: (input: RecordOutcomeInput) => Promise<unknown>;
  };
  readonly budget: {
    status: () => Promise<unknown>;
    evaluate: (input: StartJobInput) => Promise<unknown>;
    recordSnapshot: (snapshot: UsageBudgetSnapshot) => Promise<unknown>;
  };
  readonly now?: () => Date;
}

const JobIdSchema = z.string().uuid();
const PreflightInputSchema = z
  .object({
    cwd: z.string().min(1).optional(),
  })
  .strict();
const StatusInputSchema = z.object({ jobId: JobIdSchema.optional() }).strict();
const JobInputSchema = z.object({ jobId: JobIdSchema }).strict();
const ResultInputSchema = z
  .object({
    jobId: JobIdSchema,
    eventOffset: z.number().int().nonnegative().optional(),
    eventLimit: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();
const OutcomeInputSchema = z
  .object({
    jobId: JobIdSchema,
    taskType: z.enum(['routine', 'feature', 'debug', 'architecture', 'review', 'migration', 'research']),
    scope: z.enum(['local', 'module', 'repo']),
    accepted: z.boolean(),
    acceptedClaims: z.array(z.string().max(20_000)).max(1_000).default([]),
    rejectedClaims: z.array(z.string().max(20_000)).max(1_000).default([]),
    falsePositives: z.array(z.string().max(20_000)).max(1_000).default([]),
    testsBefore: z.array(z.string().max(20_000)).max(1_000).default([]),
    testsAfter: z.array(z.string().max(20_000)).max(1_000).default([]),
    testsPassed: z.boolean().optional(),
    patchAccepted: z.boolean().optional(),
    userVerdict: z.enum(['accepted', 'rejected', 'mixed']).optional(),
    notes: z.string().max(100_000).optional(),
  })
  .strict();
const BudgetInputSchema = z
  .object({
    action: z.enum(['status', 'record']),
    snapshot: UsageBudgetSnapshotSchema.optional(),
    job: StartJobInputSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'record' && value.snapshot === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['snapshot'],
        message: 'record action requires a manual usage snapshot',
      });
    }
    if (value.action === 'record' && value.job !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['job'],
        message: 'record action does not evaluate a job candidate',
      });
    }
    if (value.action === 'status' && value.snapshot !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['snapshot'],
        message: 'status action does not accept a snapshot',
      });
    }
  });

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const MUTATING = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = JSON.parse(JSON.stringify(value)) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: parsed };
  }
  return parsed as Record<string, unknown>;
}

function safeToolError(error: unknown): SafeError {
  if (error instanceof HydraError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { code: 'HYDRA_TOOL_FAILED', message: 'Hydra tool execution failed' };
}

async function toolResult(
  operation: () => unknown,
): Promise<CallToolResult> {
  try {
    const structuredContent = {
      schemaVersion: 1 as const,
      hydraVersion: HYDRA_VERSION,
      response: {
        ok: true as const,
        data: jsonObject(await operation()),
        warnings: [],
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    const structuredContent = {
      schemaVersion: 1 as const,
      hydraVersion: HYDRA_VERSION,
      response: {
        ok: false as const,
        error: safeToolError(error),
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: true,
    };
  }
}

export function createHydraServer(services: HydraServices): McpServer {
  const server = new (class extends McpServer {
    public override connect(transport: Transport): Promise<void> {
      return super.connect(new HydraTransport(transport));
    }
  })(
    { name: 'hydra', version: HYDRA_VERSION },
    { capabilities: { tools: {} }, instructions: 'Use Hydra for bounded local Claude Code delegation.' },
  );

  server.registerTool(
    'hydra_preflight',
    {
      title: 'Hydra preflight',
      description: 'Check local Claude Code version, subscription authentication, provider routing, and capabilities.',
      inputSchema: PreflightInputSchema,
      outputSchema: TOOL_OUTPUT_SCHEMAS.preflight,
      annotations: READ_ONLY,
    },
    async (input) =>
      toolResult(() =>
        services.preflight.check(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ),
  );

  server.registerTool(
    'hydra_route',
    {
      title: 'Hydra route recommendation',
      description: 'Return a deterministic delegation recommendation without launching an external model.',
      inputSchema: RouteInputSchema,
      outputSchema: TOOL_OUTPUT_SCHEMAS.route,
      annotations: READ_ONLY,
    },
    async (input) => toolResult(() => services.policy.route(input)),
  );

  server.registerTool(
    'hydra_start',
    {
      title: 'Start Hydra job',
      description: 'Persist and start a background Claude Code job. The external invocation consumes Claude subscription allowance.',
      inputSchema: StartJobInputSchema,
      outputSchema: TOOL_OUTPUT_SCHEMAS.start,
      annotations: MUTATING,
    },
    async (input) => toolResult(() => services.jobs.start(input)),
  );

  server.registerTool(
    'hydra_status',
    {
      title: 'Hydra job status',
      description: 'Read one Hydra job or a bounded list of recent jobs.',
      inputSchema: StatusInputSchema,
      outputSchema: TOOL_OUTPUT_SCHEMAS.status,
      annotations: READ_ONLY,
    },
    async ({ jobId }) =>
      toolResult(async () => {
        const raw = await services.jobs.status(jobId);
        return {
          jobs: Array.isArray(raw) ? raw : [raw],
          health: await services.jobs.health(),
        };
      }),
  );

  server.registerTool(
    'hydra_result',
    {
      title: 'Hydra job result',
      description: 'Read durable terminal or partial output for a Hydra job.',
      inputSchema: ResultInputSchema,
      outputSchema: TOOL_OUTPUT_SCHEMAS.result,
      annotations: READ_ONLY,
    },
    async ({ jobId, eventOffset, eventLimit }) =>
      toolResult(() =>
        services.jobs.result(jobId, {
          ...(eventOffset === undefined ? {} : { eventOffset }),
          ...(eventLimit === undefined ? {} : { eventLimit }),
        }),
      ),
  );

  server.registerTool(
    'hydra_continue',
    {
      title: 'Continue Claude session',
      description: 'Resume a saved Claude Code session in a new background process. The external invocation consumes Claude subscription allowance.',
      inputSchema: ContinueJobInputSchema,
      outputSchema: TOOL_OUTPUT_SCHEMAS.continue,
      annotations: MUTATING,
    },
    async (input) => toolResult(() => services.jobs.continue(input)),
  );

  server.registerTool(
    'hydra_cancel',
    {
      title: 'Cancel Hydra job',
      description: 'Request process-group termination for a queued or running Hydra job.',
      inputSchema: JobInputSchema,
      outputSchema: TOOL_OUTPUT_SCHEMAS.cancel,
      annotations: { ...MUTATING, destructiveHint: true },
    },
    async ({ jobId }) => toolResult(() => services.jobs.cancel(jobId)),
  );

  server.registerTool(
    'hydra_record_outcome',
    {
      title: 'Record Hydra outcome',
      description: 'Persist a local evidence verdict without changing routing policy automatically.',
      inputSchema: OutcomeInputSchema,
      outputSchema: TOOL_OUTPUT_SCHEMAS.outcome,
      annotations: { ...MUTATING, openWorldHint: false },
    },
    async (input) =>
      toolResult(async () => {
        const record = await services.outcomes.record({
          jobId: input.jobId,
          taskType: input.taskType,
          scope: input.scope,
          accepted: input.accepted,
          acceptedClaims: input.acceptedClaims,
          rejectedClaims: input.rejectedClaims,
          falsePositives: input.falsePositives,
          testsBefore: input.testsBefore,
          testsAfter: input.testsAfter,
          ...(input.testsPassed === undefined ? {} : { testsPassed: input.testsPassed }),
          ...(input.patchAccepted === undefined ? {} : { patchAccepted: input.patchAccepted }),
          ...(input.userVerdict === undefined ? {} : { userVerdict: input.userVerdict }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
        });
        return { jobId: input.jobId, recorded: true, record };
      }),
  );

  server.registerTool(
    'hydra_budget',
    {
      title: 'Hydra allowance budget',
      description:
        'Record an attested manual Claude usage snapshot or inspect the local calibrated pacing decision. This tool never retrieves account quota itself.',
      inputSchema: BudgetInputSchema,
      outputSchema: TOOL_OUTPUT_SCHEMAS.budget,
      annotations: { ...MUTATING, openWorldHint: false },
    },
    async (input) =>
      toolResult(async () => {
        if (input.action === 'record') {
          return services.budget.recordSnapshot(input.snapshot!);
        }
        const status = await services.budget.status();
        return input.job === undefined
          ? status
          : { status, evaluation: await services.budget.evaluate(input.job) };
      }),
  );

  return server;
}

export async function pruneExpiredJobs(
  jobStore: Pick<JobStore, 'pruneOlderThan'>,
  retentionDays: number,
  now: Date = new Date(),
): Promise<readonly string[]> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  return jobStore.pruneOlderThan(cutoff);
}

export interface ProductionServiceOptions {
  readonly defaultConfig?: HydraConfig;
  readonly runtimeIdentity?: HydraRuntimeIdentity;
  readonly prune?: (
    jobStore: Pick<JobStore, 'pruneOlderThan'>,
    retentionDays: number,
    now?: Date,
  ) => Promise<readonly string[]>;
}

export async function createProductionServices(
  options: ProductionServiceOptions = {},
): Promise<HydraServices> {
  const defaultConfig = options.defaultConfig ?? loadConfig();
  const runtimeIdentity = options.runtimeIdentity ?? HYDRA_RUNTIME_IDENTITY;
  const startupIssues: HealthSummary['issues'][number][] = runtimeIdentity.issue === undefined
    ? []
    : [runtimeIdentity.issue];
  let config = defaultConfig;
  try {
    config = await new ConfigStore({ stateRoot: defaultConfig.stateRoot }).get();
  } catch {
    startupIssues.push({
      code: 'HYDRA_CONFIG_INVALID',
      message: 'Hydra started with validated defaults because config.json is invalid',
    });
  }
  const jobStore = new JobStore({
    stateRoot: config.stateRoot,
    loggingMode: config.loggingMode,
  });
  if (startupIssues.length === 0) {
    try {
      await (options.prune ?? pruneExpiredJobs)(jobStore, config.logRetentionDays);
    } catch {
      startupIssues.push({
        code: 'HYDRA_RETENTION_FAILED',
        message: 'Hydra could not complete startup retention and is read-only until restart',
      });
    }
  }
  const sessionStore = new SessionStore({ stateRoot: config.stateRoot });
  const delegationStore = new DelegationStore({ stateRoot: config.stateRoot });
  const outcomeStore = new OutcomeStore({ stateRoot: config.stateRoot });
  const budgetStore = new BudgetStore({ stateRoot: config.stateRoot });
  const budget = new BudgetService({ config, jobStore, budgetStore });
  const workerBundlePath = fileURLToPath(new URL('./worker.js', import.meta.url));
  const jobService = new JobService({
    config,
    jobStore,
    sessionStore,
    delegationStore,
    launcher: new DetachedWorkerLauncher(workerBundlePath),
    processGroups: new NodeProcessGroupController(),
    budget,
  });
  const assertMutable = (): void => {
    if (startupIssues.length > 0) {
      throw new HydraError(
        'HYDRA_DEGRADED_READ_ONLY',
        'Hydra startup health is degraded; repair local state and restart before mutating it',
        { issueCodes: startupIssues.map(({ code }) => code) },
      );
    }
  };
  const degradedReadOnly = startupIssues.length > 0;
  const health = async (): Promise<HealthSummary> => {
    const [durable, allowance] = await Promise.all([
      jobService.health(),
      budgetStore.health(),
    ]);
    const issues = [...startupIssues, ...durable.issues, ...allowance.issues];
    return { state: issues.length === 0 ? 'ok' : 'degraded', issues };
  };
  const outcomeRecorder = new OutcomeRecorder({ jobStore, outcomeStore, delegationStore });
  return {
    preflight: new PreflightService({ config, runner: new NodeProcessRunner() }),
    policy: new PolicyEngine({
      maxPanelMembers: config.maxPanelMembers,
      maxDebateRounds: config.maxDebateRounds,
    }),
    jobs: {
      start: async (input): Promise<unknown> => {
        assertMutable();
        return jobService.start(input);
      },
      status: (jobId) => jobService.status(jobId, { recover: !degradedReadOnly }),
      health,
      result: (jobId, resultOptions) => jobService.result(jobId, {
        ...resultOptions,
        reconcile: !degradedReadOnly,
      }),
      continue: async (input): Promise<unknown> => {
        assertMutable();
        return jobService.continue(input);
      },
      cancel: async (jobId): Promise<unknown> => {
        assertMutable();
        return jobService.cancel(jobId);
      },
    },
    outcomes: {
      record: async (input): Promise<unknown> => {
        assertMutable();
        return outcomeRecorder.record(input);
      },
    },
    budget: {
      status: () => budget.status({ reconcile: !degradedReadOnly }),
      evaluate: (input) => budget.evaluate(input, { reconcile: !degradedReadOnly }),
      recordSnapshot: async (snapshot): Promise<unknown> => {
        assertMutable();
        return budget.recordSnapshot(snapshot);
      },
    },
  };
}

export async function startStdioServer(): Promise<McpServer> {
  const server = createHydraServer(await createProductionServices());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const close = (): void => {
    void server.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  return server;
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(executedPath).href
) {
  startStdioServer().catch((error: unknown) => {
    console.error(error instanceof HydraError ? error.code : 'HYDRA_SERVER_FAILED');
    process.exitCode = 1;
  });
}
