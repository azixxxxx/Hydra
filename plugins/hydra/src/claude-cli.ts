import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  HydraError,
  type AccessMode,
  type ClaudeCapabilities,
  type Effort,
  type JsonValue,
} from './domain.js';
import { PROHIBITED_SUBSCRIPTION_ENVIRONMENT } from './preflight.js';
import { readProcessStartMarkerWithRetry } from './platform/process-identity.js';
import {
  ClaudeEventAccumulator,
  StreamJsonParser,
  sanitizeClaudeEvent,
  type ClaudeExecutionSummary,
  type ParsedStreamItem,
} from './stream-json.js';

export interface ClaudeRunInput {
  readonly task: string;
  readonly role: string;
  readonly cwd: string;
  readonly model: string;
  readonly effort: Effort;
  readonly accessMode: AccessMode;
  readonly maxTurns: number;
  readonly timeoutSec: number;
  readonly emptyMcpPath: string;
  readonly outputSchema?: Readonly<Record<string, JsonValue>>;
  readonly resumeSessionId?: string;
  readonly newSessionId?: string;
  readonly strictModel?: boolean;
}

export interface ClaudeRunCallbacks {
  readonly settingsPath: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ParsedStreamItem) => Promise<void> | void;
  readonly onStderr?: (chunk: string) => Promise<void> | void;
  readonly onHeartbeat?: () => Promise<void> | void;
  readonly onProcessGroup?: (
    processGroupId: number,
    processStartMarker: string,
  ) => Promise<void> | void;
  readonly onTurnLimit?: (turns: number) => Promise<void> | void;
}

export interface ClaudeRunResult extends ClaudeExecutionSummary {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly turnLimitReached: boolean;
  readonly warnings: readonly string[];
  readonly stderrBytes: number;
  readonly modelMismatch?: boolean;
  readonly unexpectedModelUsage?: boolean;
}

export interface ClaudeCliAdapterDependencies {
  readonly claudePath: string;
  readonly capabilities: ClaudeCapabilities;
  readonly claudeArgsPrefix?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly heartbeatIntervalMs?: number;
  readonly terminationGraceMs?: number;
  readonly processStartMarker?: (pid: number) => Promise<string>;
}

const ACCESS_PROFILES: Readonly<
  Record<AccessMode, { readonly permissionMode: string; readonly tools: string }>
> = Object.freeze({
  analyze: { permissionMode: 'dontAsk', tools: 'Read,Glob,Grep' },
  test: { permissionMode: 'dontAsk', tools: 'Read,Glob,Grep,Bash' },
  execute: { permissionMode: 'dontAsk', tools: 'Read,Glob,Grep,Bash,Edit,Write' },
});

const ALWAYS_REQUIRED_FLAGS = Object.freeze([
  ['print', '--print'],
  ['model', '--model'],
  ['effort', '--effort'],
  ['outputFormat', '--output-format'],
  ['verbose', '--verbose'],
  ['permissionMode', '--permission-mode'],
  ['tools', '--tools'],
  ['settings', '--settings'],
  ['settingSources', '--setting-sources'],
  ['strictMcpConfig', '--strict-mcp-config'],
  ['mcpConfig', '--mcp-config'],
] as const);

const MAX_STREAM_EVENTS = 10_000;

const CLAUDE_MODEL_SELECTOR_ENVIRONMENT = Object.freeze([
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_AUTO_MODE_MODEL',
  'CLAUDE_CODE_BG_CLASSIFIER_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CONTEXT_COLLAPSE_MODEL',
] as const);

const CLAUDE_MODEL_OVERRIDE_ENVIRONMENT = Object.freeze([
  ...CLAUDE_MODEL_SELECTOR_ENVIRONMENT,
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'FALLBACK_FOR_ALL_PRIMARY_MODELS',
] as const);

export function buildClaudePrompt(input: Pick<ClaudeRunInput, 'role' | 'task'>): string {
  return `Work as ${input.role}.\n\nTask:\n${input.task}`;
}

function requireFlag(capabilities: ClaudeCapabilities, name: string, option: string): void {
  if (capabilities.flags[name] !== true) {
    throw new HydraError('CLAUDE_FLAG_MISSING', `Claude Code does not expose required ${option}`, {
      flag: option,
    });
  }
}

export function buildClaudeArgs(
  input: ClaudeRunInput,
  capabilities: ClaudeCapabilities,
  settingsPath: string,
): readonly string[] {
  for (const [name, option] of ALWAYS_REQUIRED_FLAGS) {
    requireFlag(capabilities, name, option);
  }
  if (!isAbsolute(input.cwd) || !isAbsolute(settingsPath) || !isAbsolute(input.emptyMcpPath)) {
    throw new HydraError(
      'CLAUDE_PATH_NOT_ABSOLUTE',
      'Claude cwd, settings, and empty MCP paths must be absolute',
    );
  }
  if (input.resumeSessionId !== undefined && input.newSessionId !== undefined) {
    throw new HydraError(
      'CLAUDE_SESSION_CONFLICT',
      'A Claude invocation cannot resume and create an explicit session at the same time',
    );
  }

  const profile = ACCESS_PROFILES[input.accessMode];
  const args: string[] = [
    '-p',
    buildClaudePrompt(input),
    '--model',
    input.model,
    '--effort',
    input.effort,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    profile.permissionMode,
    '--tools',
    profile.tools,
    '--settings',
    settingsPath,
    '--strict-mcp-config',
    '--mcp-config',
    input.emptyMcpPath,
  ];

  args.push('--setting-sources', '');

  if (input.outputSchema !== undefined) {
    requireFlag(capabilities, 'jsonSchema', '--json-schema');
    args.push('--json-schema', JSON.stringify(input.outputSchema));
  }
  if (input.resumeSessionId !== undefined) {
    requireFlag(capabilities, 'resume', '--resume');
    args.push('--resume', input.resumeSessionId);
  }
  if (input.newSessionId !== undefined) {
    requireFlag(capabilities, 'sessionId', '--session-id');
    args.push('--session-id', input.newSessionId);
  }
  return args;
}

export function sanitizeClaudeEnvironment(
  environment: NodeJS.ProcessEnv,
  requestedModel: string,
): NodeJS.ProcessEnv {
  const prohibited = new Set<string>([
    ...PROHIBITED_SUBSCRIPTION_ENVIRONMENT,
    'CLAUDE_CODE_OAUTH_TOKEN',
    ...CLAUDE_MODEL_OVERRIDE_ENVIRONMENT,
  ]);
  const sanitized: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(environment)) {
    if (
      prohibited.has(name) ||
      /(?:^|_)(?:TOKEN|SECRET|PASSWORD|KEY|AUTH|COOKIE|PAT|DSN|CREDENTIALS?)(?:_|$)/u.test(
        name.toUpperCase(),
      )
    ) {
      continue;
    }
    const value = environment[name];
    if (value !== undefined) {
    sanitized[name] = value;
    }
  }
  sanitized.CLAUDE_CODE_NO_MODEL_FALLBACK = '1';
  for (const name of CLAUDE_MODEL_SELECTOR_ENVIRONMENT) {
    sanitized[name] = requestedModel;
  }
  return sanitized;
}

function modelFamily(model: string): 'fable' | 'opus' | 'sonnet' | undefined {
  const lower = model.toLowerCase();
  if (lower.includes('sonnet')) {
    return 'sonnet';
  }
  if (lower.includes('opus')) {
    return 'opus';
  }
  if (lower.includes('fable')) {
    return 'fable';
  }
  return undefined;
}

function modelsMatch(requested: string, resolved: string): boolean {
  const normalizedRequested = requested.toLowerCase();
  if (
    normalizedRequested === 'sonnet' ||
    normalizedRequested === 'opus' ||
    normalizedRequested === 'fable'
  ) {
    return modelFamily(resolved) === normalizedRequested;
  }
  return normalizedRequested === resolved.toLowerCase();
}

function unexpectedUsageModels(
  requested: string,
  resolved: string | undefined,
  reportedModels: readonly string[],
): readonly string[] {
  if (reportedModels.length === 0) {
    return [];
  }
  if (reportedModels.length === 1) {
    return [];
  }
  const normalizedResolved = resolved?.toLowerCase();
  const additional = reportedModels.filter(
    (model) => normalizedResolved === undefined || model.toLowerCase() !== normalizedResolved,
  );
  return additional.length > 0 ? additional : reportedModels.slice(1);
}

function killProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      child.kill(signal);
    }
  }
}

async function invoke<T extends readonly unknown[]>(
  callback: ((...args: T) => Promise<void> | void) | undefined,
  ...args: T
): Promise<void> {
  await callback?.(...args);
}

export class ClaudeCliAdapter {
  readonly #claudePath: string;
  readonly #capabilities: ClaudeCapabilities;
  readonly #claudeArgsPrefix: readonly string[];
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #heartbeatIntervalMs: number;
  readonly #terminationGraceMs: number;
  readonly #processStartMarker: (pid: number) => Promise<string>;

  public constructor(dependencies: ClaudeCliAdapterDependencies) {
    this.#claudePath = dependencies.claudePath;
    this.#capabilities = dependencies.capabilities;
    this.#claudeArgsPrefix = dependencies.claudeArgsPrefix ?? [];
    this.#environment = dependencies.environment;
    this.#heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? 5_000;
    this.#terminationGraceMs = dependencies.terminationGraceMs ?? 5_000;
    this.#processStartMarker =
      dependencies.processStartMarker ?? readProcessStartMarkerWithRetry;
    if (!Number.isSafeInteger(this.#terminationGraceMs) || this.#terminationGraceMs < 0) {
      throw new HydraError(
        'INVALID_TERMINATION_GRACE',
        'Claude termination grace must be a non-negative integer',
      );
    }
  }

  public async run(
    input: ClaudeRunInput,
    callbacks: ClaudeRunCallbacks,
  ): Promise<ClaudeRunResult> {
    if (callbacks.signal?.aborted === true) {
      throw new HydraError('CLAUDE_ABORTED', 'Claude invocation was aborted before launch');
    }
    const args = buildClaudeArgs(input, this.#capabilities, callbacks.settingsPath);
    const childEnvironment = sanitizeClaudeEnvironment(
      this.#environment ?? process.env,
      input.model,
    );
    const command = this.#claudePath;
    const commandArgs = [...this.#claudeArgsPrefix, ...args];
    const child: ChildProcess = spawn(command, commandArgs, {
      cwd: input.cwd,
      env: childEnvironment,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
      killProcessGroup(child, 'SIGKILL');
      throw new HydraError('CLAUDE_PID_INVALID', 'Claude did not provide a valid process-group ID');
    }
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      killProcessGroup(child, 'SIGKILL');
      throw new HydraError('CLAUDE_STREAM_UNAVAILABLE', 'Claude output streams are unavailable');
    }

    let timedOut = false;
    let aborted = false;
    let turnLimitReached = false;
    let stderrBytes = 0;
    let processingError: unknown;
    let heartbeatInFlight: Promise<void> | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let closed = false;
    let acceptedEvents = 0;
    const parser = new StreamJsonParser();
    const accumulator = new ClaudeEventAccumulator();

    const exit = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise, rejectPromise) => {
        child.once('error', (error) => {
          closed = true;
          rejectPromise(error);
        });
        child.once('close', (exitCode, signal) => {
          closed = true;
          if (forceKill !== undefined) {
            clearTimeout(forceKill);
          }
          resolvePromise({ exitCode, signal });
        });
      },
    );

    const terminate = (signal: NodeJS.Signals = 'SIGTERM'): void => {
      killProcessGroup(child, signal);
      if (signal === 'SIGTERM' && !closed && forceKill === undefined) {
        forceKill = setTimeout(() => {
          if (!closed) {
            killProcessGroup(child, 'SIGKILL');
          }
        }, this.#terminationGraceMs);
        forceKill.unref();
      }
    };
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    callbacks.signal?.addEventListener('abort', onAbort, { once: true });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.max(1, Math.round(input.timeoutSec * 1_000)));
    timeout.unref();

    const heartbeatNow = (): Promise<void> => {
      if (heartbeatInFlight !== undefined) {
        return heartbeatInFlight;
      }
      const current = invoke(callbacks.onHeartbeat).finally(() => {
        if (heartbeatInFlight === current) {
          heartbeatInFlight = undefined;
        }
      });
      heartbeatInFlight = current;
      return current;
    };

    const accept = async (item: ParsedStreamItem): Promise<void> => {
      acceptedEvents += 1;
      if (acceptedEvents > MAX_STREAM_EVENTS) {
        throw new HydraError(
          'CLAUDE_EVENT_LIMIT',
          `Claude emitted more than ${MAX_STREAM_EVENTS} stream events`,
        );
      }
      accumulator.accept(item);
      await invoke(callbacks.onEvent, item);
      await heartbeatNow();
      const turns = accumulator.summary().turns;
      const event: Readonly<Record<string, JsonValue>> | undefined =
        item.type === 'hydra_parse_error' && 'sha256' in item
          ? undefined
          : (item as Readonly<Record<string, JsonValue>>);
      const message =
        event?.message !== null &&
        typeof event?.message === 'object' &&
        !Array.isArray(event.message)
          ? event.message
          : undefined;
      const hasToolUse =
        Array.isArray(message?.content) &&
        message.content.some(
          (block) =>
            block !== null &&
            typeof block === 'object' &&
            !Array.isArray(block) &&
            block.type === 'tool_use',
        );
      if (!turnLimitReached && (turns > input.maxTurns || (turns >= input.maxTurns && hasToolUse))) {
        turnLimitReached = true;
        await invoke(callbacks.onTurnLimit, turns);
        if (item.type !== 'result') {
          terminate();
        }
      }
    };

    const consumeStdout = async (metadataReady: Promise<void>): Promise<void> => {
      for await (const chunk of stdout) {
        await metadataReady;
        for (const item of parser.push(chunk as Buffer)) {
          await accept(item);
        }
      }
      for (const item of parser.finish()) {
        await accept(item);
      }
    };

    const consumeStderr = async (metadataReady: Promise<void>): Promise<void> => {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      const emitLine = async (line: string): Promise<void> => {
        const sanitized = sanitizeClaudeEvent(line);
        await invoke(callbacks.onStderr, typeof sanitized === 'string' ? sanitized : '[REDACTED]');
        await heartbeatNow();
      };
      for await (const chunk of stderr) {
        await metadataReady;
        const buffer = chunk as Buffer;
        stderrBytes += buffer.byteLength;
        pending += decoder.write(buffer);
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          await emitLine(`${pending.slice(0, newline)}\n`);
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      }
      pending += decoder.end();
      if (pending.length > 0) {
        await emitLine(pending);
      }
    };

    try {
      const metadataReady = (async (): Promise<void> => {
        const processStartMarker = await this.#processStartMarker(pid);
        await invoke(callbacks.onProcessGroup, pid, processStartMarker);
        await heartbeatNow();
      })();
      const streamWork = Promise.all([
        consumeStdout(metadataReady),
        consumeStderr(metadataReady),
      ]).catch((error: unknown) => {
          processingError = error;
          terminate();
        });
      await metadataReady;
      heartbeat = setInterval(() => {
        void heartbeatNow().catch((error: unknown) => {
          processingError ??= error;
          terminate();
        });
      }, this.#heartbeatIntervalMs);
      heartbeat.unref();
      const outcome = await exit;
      await streamWork;
      if (processingError !== undefined) {
        if (processingError instanceof Error) {
          throw processingError;
        }
        throw new HydraError('CLAUDE_STREAM_FAILED', 'Claude stream processing failed');
      }

      const summary = accumulator.summary();
      const warnings: string[] = [];
      const unexpectedReportedModels = unexpectedUsageModels(
        input.model,
        summary.resolvedModel,
        summary.reportedModels ?? [],
      );
      if (
        summary.resolvedModel !== undefined &&
        !modelsMatch(input.model, summary.resolvedModel)
      ) {
        warnings.push(
          `Claude resolved ${summary.resolvedModel} while Hydra requested ${input.model}.`,
        );
      } else if (summary.resolvedModel === undefined) {
        warnings.push(`Claude did not report the model requested as ${input.model}.`);
      }
      const soleReportedModel = summary.reportedModels?.length === 1
        ? summary.reportedModels[0]
        : undefined;
      if (
        soleReportedModel !== undefined &&
        !modelsMatch(input.model, soleReportedModel) &&
        soleReportedModel.toLowerCase() !== summary.resolvedModel?.toLowerCase()
      ) {
        warnings.push(
          `Claude reported terminal usage for ${soleReportedModel} while Hydra requested ${input.model}.`,
        );
      }
      if (unexpectedReportedModels.length > 0) {
        warnings.push(
          `Claude reported unexpected model usage while Hydra requested ${input.model}: ${unexpectedReportedModels.join(', ')}.`,
        );
      }
      const unexpectedModelUsage = unexpectedReportedModels.length > 0;
      const modelMismatch = warnings.length > 0;

      return {
        ...summary,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut,
        aborted,
        turnLimitReached,
        warnings,
        stderrBytes,
        modelMismatch,
        unexpectedModelUsage,
      };
    } catch (error) {
      terminate();
      await exit.catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
      }
      if (forceKill !== undefined) {
        clearTimeout(forceKill);
      }
      await heartbeatInFlight?.catch(() => undefined);
      callbacks.signal?.removeEventListener('abort', onAbort);
    }
  }
}
