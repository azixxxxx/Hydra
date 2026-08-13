import { createHash, type Hash } from 'node:crypto';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

import {
  HydraError,
  type Effort,
  type JsonValue,
  type ReportedUsage,
  type TestExecution,
} from './domain.js';
import {
  isSensitiveCredentialKey,
  sanitizeCredentialText,
} from './credential-shapes.js';

export { containsCredentialShape } from './credential-shapes.js';

export interface HydraParseError {
  readonly type: 'hydra_parse_error';
  readonly line: number;
  readonly sha256: string;
  readonly byteLength: number;
}

export type ClaudeStreamEvent = {
  readonly type: string;
  readonly line: number;
  readonly [key: string]: JsonValue;
};

export type ParsedStreamItem = ClaudeStreamEvent | HydraParseError;

export interface SanitizeOptions {
  readonly homeDirectory?: string;
}

export interface ClaudeExecutionSummary {
  readonly finalText: string;
  readonly eventsComplete: boolean;
  readonly turns: number;
  readonly reportedSessionTurns?: number;
  readonly isError: boolean;
  readonly parseErrors: readonly HydraParseError[];
  readonly testsRun?: readonly TestExecution[];
  readonly usageCreditsRequired?: boolean;
  readonly sessionId?: string;
  readonly resolvedModel?: string;
  readonly reportedModels?: readonly string[];
  readonly canonicalModelId?: string;
  readonly appliedEffort?: Effort;
  readonly structuredOutput?: JsonValue;
  readonly usage?: ReportedUsage;
  readonly durationMs?: number;
  readonly terminationReason?: string;
}

const SENSITIVE_KEY_PARTS = new Set([
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'access_token',
  'refresh_token',
  'oauth',
  'oauth_token',
  'secret',
  'password',
  'cookie',
  'credential',
  'credentials',
  'email',
  'org_id',
  'organization_id',
]);

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
export const MAX_STREAM_LINE_BYTES = 2_000_000;
const MAX_FINAL_TEXT_BYTES = 1_000_000;
const MAX_PARSE_ERRORS = 100;

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[-.\s]+/gu, '_')
    .toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  if (isSensitiveCredentialKey(key)) {
    return true;
  }
  const normalized = normalizedKey(key);
  return SENSITIVE_KEY_PARTS.has(normalized);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function sanitizeText(value: string, homeDirectory = homedir()): string {
  let result = sanitizeCredentialText(value).replace(EMAIL_PATTERN, '[REDACTED]');
  if (homeDirectory.length > 1) {
    result = result.replace(new RegExp(escapeRegExp(homeDirectory), 'gu'), '~');
  }
  return result;
}

function sanitizeValue(value: unknown, homeDirectory: string, seen: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return '[NON_FINITE_NUMBER]';
    }
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeText(value, homeDirectory);
  }
  if (typeof value !== 'object') {
    return `[UNSUPPORTED_${typeof value}]`;
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => sanitizeValue(item, homeDirectory, seen));
    seen.delete(value);
    return output;
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : sanitizeValue(child, homeDirectory, seen);
  }
  seen.delete(value);
  return output;
}

export function sanitizeClaudeEvent(
  value: unknown,
  options: SanitizeOptions = {},
): JsonValue {
  return sanitizeValue(value, options.homeDirectory ?? homedir(), new WeakSet<object>());
}

function parseError(rawLine: string, line: number): HydraParseError {
  return {
    type: 'hydra_parse_error',
    line,
    sha256: createHash('sha256').update(rawLine).digest('hex'),
    byteLength: Buffer.byteLength(rawLine),
  };
}

function digestParseError(hash: Hash, byteLength: number, line: number): HydraParseError {
  return {
    type: 'hydra_parse_error',
    line,
    sha256: hash.digest('hex'),
    byteLength,
  };
}

function parseLine(rawLine: string, line: number): ParsedStreamItem | undefined {
  const withoutCarriageReturn = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (withoutCarriageReturn.trim().length === 0) {
    return undefined;
  }
  if (Buffer.byteLength(withoutCarriageReturn, 'utf8') > MAX_STREAM_LINE_BYTES) {
    return parseError(withoutCarriageReturn, line);
  }
  try {
    const value = JSON.parse(withoutCarriageReturn) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return parseError(withoutCarriageReturn, line);
    }
    const sanitized = sanitizeClaudeEvent(value);
    if (sanitized === null || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
      return parseError(withoutCarriageReturn, line);
    }
    const type = typeof sanitized.type === 'string' ? sanitized.type : 'unknown';
    return { ...sanitized, type, line };
  } catch {
    return parseError(withoutCarriageReturn, line);
  }
}

export class StreamJsonParser {
  readonly #decoder = new StringDecoder('utf8');
  #buffer = '';
  #line = 1;
  #finished = false;
  #oversizeHash: Hash | undefined;
  #oversizeBytes = 0;

  public push(chunk: Uint8Array | string): ParsedStreamItem[] {
    if (this.#finished) {
      throw new HydraError('STREAM_ALREADY_FINISHED', 'Cannot push after the stream parser has finished');
    }
    const decoded =
      typeof chunk === 'string'
        ? chunk
        : this.#decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    return this.#consume(decoded);
  }

  public finish(): ParsedStreamItem[] {
    if (this.#finished) {
      return [];
    }
    this.#finished = true;
    const items = this.#consume(this.#decoder.end());
    if (this.#oversizeHash !== undefined) {
      items.push(digestParseError(this.#oversizeHash, this.#oversizeBytes, this.#line));
      this.#oversizeHash = undefined;
      this.#oversizeBytes = 0;
      this.#line += 1;
    }
    if (this.#buffer.length > 0) {
      const item = parseLine(this.#buffer, this.#line);
      this.#buffer = '';
      if (item !== undefined) {
        items.push(item);
      }
    }
    return items;
  }

  #consume(decodedValue: string): ParsedStreamItem[] {
    const items: ParsedStreamItem[] = [];
    let decoded = decodedValue;
    while (decoded.length > 0) {
      if (this.#oversizeHash !== undefined) {
        const newline = decoded.indexOf('\n');
        const part = newline < 0 ? decoded : decoded.slice(0, newline);
        this.#oversizeHash.update(part);
        this.#oversizeBytes += Buffer.byteLength(part, 'utf8');
        if (newline < 0) {
          return items;
        }
        items.push(digestParseError(this.#oversizeHash, this.#oversizeBytes, this.#line));
        this.#oversizeHash = undefined;
        this.#oversizeBytes = 0;
        this.#line += 1;
        decoded = decoded.slice(newline + 1);
        continue;
      }
      this.#buffer += decoded;
      decoded = '';
      items.push(...this.#drainCompleteLines());
      const bufferedBytes = Buffer.byteLength(this.#buffer, 'utf8');
      if (bufferedBytes > MAX_STREAM_LINE_BYTES) {
        this.#oversizeHash = createHash('sha256').update(this.#buffer);
        this.#oversizeBytes = bufferedBytes;
        this.#buffer = '';
      }
    }
    return items;
  }

  #drainCompleteLines(): ParsedStreamItem[] {
    const items: ParsedStreamItem[] = [];
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const rawLine = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const item = parseLine(rawLine, this.#line);
      this.#line += 1;
      if (item !== undefined) {
        items.push(item);
      }
      newline = this.#buffer.indexOf('\n');
    }
    return items;
  }
}

function asObject(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asFiniteNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstString(...values: readonly (JsonValue | undefined)[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function extractText(message: Readonly<Record<string, JsonValue>> | undefined): string[] {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((item) => {
    const block = asObject(item);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  });
}

const TEST_COMMAND_PATTERN =
  /(?:^|[\s;&|])(?:(?:npm|pnpm|yarn|bun)\s+(?:(?:run|exec)\s+)?(?:test(?:[:\w-]*)?|check)\b|(?:python(?:3)?\s+-m\s+)?pytest\b|(?:vitest|jest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|rspec)\b)/iu;

function extractTestCommands(
  message: Readonly<Record<string, JsonValue>> | undefined,
): Array<{ readonly command: string; readonly toolUseId?: string }> {
  const content = message?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((item) => {
    const block = asObject(item);
    if (block?.type !== 'tool_use' || block.name !== 'Bash') {
      return [];
    }
    const command = asString(asObject(block.input)?.command);
    if (command === undefined || !TEST_COMMAND_PATTERN.test(command)) {
      return [];
    }
    const toolUseId = asString(block.id);
    return [{ command, ...(toolUseId === undefined ? {} : { toolUseId }) }];
  });
}

function truncateUtf8(value: string, maxBytes: number): string {
  const source = Buffer.from(value, 'utf8');
  if (source.byteLength <= maxBytes) {
    return value;
  }
  return `${source.subarray(0, maxBytes).toString('utf8')}\n[HYDRA_TEXT_TRUNCATED]`;
}

function toolResultDigest(block: Readonly<Record<string, JsonValue>>): string | undefined {
  const content = block.content;
  if (content === undefined) {
    return undefined;
  }
  const serialized = typeof content === 'string' ? content : JSON.stringify(content);
  return createHash('sha256').update(serialized).digest('hex');
}

function creditsRequired(value: JsonValue, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => creditsRequired(item, depth + 1));
  }
  return Object.entries(value).some(([key, child]) => {
    const normalized = normalizedKey(key);
    if (
      (normalized === 'fable_credits_required' || normalized === 'usage_credits_required') &&
      child === true
    ) {
      return true;
    }
    if (
      (normalized === 'subtype' || normalized === 'error_type' || normalized === 'code') &&
      typeof child === 'string' &&
      /(?:fable|usage)[_-]?credits?[_-]?required/iu.test(child)
    ) {
      return true;
    }
    return creditsRequired(child, depth + 1);
  });
}

export class ClaudeEventAccumulator {
  #sessionId: string | undefined;
  #resolvedModel: string | undefined;
  #reportedModels = new Set<string>();
  #canonicalModelId: string | undefined;
  #appliedEffort: Effort | undefined;
  #resultText: string | undefined;
  #assistantText = '';
  #structuredOutput: JsonValue | undefined;
  #usage: ReportedUsage = {};
  #hasUsage = false;
  #durationMs: number | undefined;
  #turns = 0;
  #reportedSessionTurns: number | undefined;
  #assistantMessageIds = new Set<string>();
  #terminationReason: string | undefined;
  #isError = false;
  #sawResult = false;
  #parseErrors: HydraParseError[] = [];
  #testsRun: TestExecution[] = [];
  #pendingTests = new Map<string, number>();
  #usageCreditsRequired = false;

  public accept(item: ParsedStreamItem): void {
    if (
      item.type === 'hydra_parse_error' &&
      'sha256' in item &&
      typeof item.sha256 === 'string' &&
      'byteLength' in item &&
      typeof item.byteLength === 'number'
    ) {
      if (this.#parseErrors.length < MAX_PARSE_ERRORS) {
        this.#parseErrors.push(item as HydraParseError);
      }
      return;
    }
    const event = item as ClaudeStreamEvent;
    const message = asObject(event.message);
    const resultObject = asObject(event.result);
    this.#usageCreditsRequired ||= creditsRequired(event);

    this.#sessionId = firstString(event.session_id, event.sessionId) ?? this.#sessionId;
    const reportedModel = firstString(event.model, message?.model, resultObject?.model);
    if (
      reportedModel !== undefined &&
      (this.#resolvedModel === undefined || !reportedModel.toLowerCase().includes('synthetic'))
    ) {
      this.#resolvedModel = reportedModel;
    }
    this.#canonicalModelId =
      firstString(
        event.canonical_model_id,
        event.canonicalModelId,
        message?.canonical_model_id,
        message?.canonicalModelId,
      ) ?? this.#canonicalModelId;
    const effort = firstString(event.effort, message?.effort);
    if (effort !== undefined && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      this.#appliedEffort = effort as Effort;
    }

    if (event.type === 'assistant') {
      const messageId = asString(message?.id);
      if (messageId === undefined || !this.#assistantMessageIds.has(messageId)) {
        this.#turns += 1;
        if (messageId !== undefined) {
          this.#assistantMessageIds.add(messageId);
        }
      }
      const text = extractText(message).join('\n');
      if (text.length > 0) {
        this.#assistantText = truncateUtf8(
          this.#assistantText.length === 0 ? text : `${this.#assistantText}\n${text}`,
          MAX_FINAL_TEXT_BYTES,
        );
      }
      for (const test of extractTestCommands(message)) {
        if (this.#testsRun.length < 100) {
          const index = this.#testsRun.push({
            command: truncateUtf8(test.command, 20_000),
            ...(test.toolUseId === undefined ? {} : { toolUseId: test.toolUseId }),
            status: 'attempted',
          }) - 1;
          if (test.toolUseId !== undefined) {
            this.#pendingTests.set(test.toolUseId, index);
          }
        }
      }
      this.#mergeUsage(asObject(message?.usage));
    }

    if (event.type === 'user' && Array.isArray(message?.content)) {
      for (const item of message.content) {
        const block = asObject(item);
        const toolUseId = asString(block?.tool_use_id);
        if (block?.type !== 'tool_result' || toolUseId === undefined) {
          continue;
        }
        const index = this.#pendingTests.get(toolUseId);
        const existing = index === undefined ? undefined : this.#testsRun[index];
        if (index !== undefined && existing !== undefined) {
          const outputDigest = toolResultDigest(block);
          this.#testsRun[index] = {
            ...existing,
            status: block.is_error === true ? 'failed' : 'completed',
            ...(outputDigest === undefined ? {} : { outputDigest }),
          };
          this.#pendingTests.delete(toolUseId);
        }
      }
    }

    if (event.type === 'result') {
      this.#sawResult = true;
      const resultText = asString(event.result);
      if (resultText !== undefined) {
        this.#resultText = truncateUtf8(resultText, MAX_FINAL_TEXT_BYTES);
      }
      if (event.structured_output !== undefined) {
        this.#structuredOutput = event.structured_output;
      } else if (event.structuredOutput !== undefined) {
        this.#structuredOutput = event.structuredOutput;
      }
      this.#durationMs =
        asFiniteNumber(event.duration_ms) ?? asFiniteNumber(event.durationMs) ?? this.#durationMs;
      this.#terminationReason =
        firstString(event.terminal_reason, event.termination_reason, event.stop_reason) ??
        this.#terminationReason;
      const reportedTurns =
        asFiniteNumber(event.num_turns) ?? asFiniteNumber(event.numTurns);
      if (
        reportedTurns !== undefined &&
        Number.isInteger(reportedTurns) &&
        reportedTurns >= 0
      ) {
        this.#reportedSessionTurns = reportedTurns;
      }
      this.#isError = event.is_error === true || event.subtype === 'error';
      const modelUsage = asObject(event.modelUsage);
      if (modelUsage !== undefined) {
        for (const model of Object.keys(modelUsage)) {
          this.#reportedModels.add(model);
        }
      }
      this.#mergeUsage(asObject(event.usage));
      const cost = asFiniteNumber(event.total_cost_usd);
      if (cost !== undefined) {
        this.#usage = { ...this.#usage, costUsdEstimate: cost };
        this.#hasUsage = true;
      }
    }
  }

  public summary(): ClaudeExecutionSummary {
    const finalText = this.#resultText ?? this.#assistantText;
    return {
      finalText,
      eventsComplete: this.#sawResult && this.#parseErrors.length === 0,
      turns: this.#turns,
      ...(this.#reportedSessionTurns === undefined
        ? {}
        : { reportedSessionTurns: this.#reportedSessionTurns }),
      isError: this.#isError,
      parseErrors: [...this.#parseErrors],
      ...(this.#testsRun.length === 0 ? {} : { testsRun: [...this.#testsRun] }),
      ...(this.#usageCreditsRequired ? { usageCreditsRequired: true } : {}),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.#resolvedModel === undefined ? {} : { resolvedModel: this.#resolvedModel }),
      ...(this.#reportedModels.size === 0
        ? {}
        : { reportedModels: [...this.#reportedModels].sort() }),
      ...(this.#canonicalModelId === undefined ? {} : { canonicalModelId: this.#canonicalModelId }),
      ...(this.#appliedEffort === undefined ? {} : { appliedEffort: this.#appliedEffort }),
      ...(this.#structuredOutput === undefined ? {} : { structuredOutput: this.#structuredOutput }),
      ...(this.#hasUsage ? { usage: this.#usage } : {}),
      ...(this.#durationMs === undefined ? {} : { durationMs: this.#durationMs }),
      ...(this.#terminationReason === undefined
        ? {}
        : { terminationReason: this.#terminationReason }),
    };
  }

  #mergeUsage(usage: Readonly<Record<string, JsonValue>> | undefined): void {
    if (usage === undefined) {
      return;
    }
    const inputTokens =
      asFiniteNumber(usage.input_tokens) ?? asFiniteNumber(usage.inputTokens);
    const outputTokens =
      asFiniteNumber(usage.output_tokens) ?? asFiniteNumber(usage.outputTokens);
    const cacheReadTokens =
      asFiniteNumber(usage.cache_read_input_tokens) ??
      asFiniteNumber(usage.cache_read_tokens) ??
      asFiniteNumber(usage.cacheReadTokens);
    const cacheCreationTokens =
      asFiniteNumber(usage.cache_creation_input_tokens) ??
      asFiniteNumber(usage.cache_creation_tokens) ??
      asFiniteNumber(usage.cacheCreationTokens);

    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      cacheReadTokens === undefined &&
      cacheCreationTokens === undefined
    ) {
      return;
    }
    this.#usage = {
      ...this.#usage,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
    };
    this.#hasUsage = true;
  }
}
