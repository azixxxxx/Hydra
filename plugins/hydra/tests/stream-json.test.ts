import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, test } from 'vitest';

import {
  ClaudeEventAccumulator,
  MAX_STREAM_LINE_BYTES,
  StreamJsonParser,
  containsCredentialShape,
  sanitizeClaudeEvent,
  sanitizeText,
} from '../src/stream-json.js';

const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
let validFixture: Buffer;
let malformedFixture: Buffer;
let incompleteFixture: Buffer;
let realAuthFailureFixture: Buffer;
let realSuccessFixture: Buffer;

beforeAll(async () => {
  [validFixture, malformedFixture, incompleteFixture, realAuthFailureFixture, realSuccessFixture] =
    await Promise.all([
      readFile(resolve(fixtureDirectory, 'mock-valid.jsonl')),
      readFile(resolve(fixtureDirectory, 'mock-malformed.jsonl')),
      readFile(resolve(fixtureDirectory, 'mock-incomplete.jsonl')),
      readFile(resolve(fixtureDirectory, 'claude-sonnet-2.1.228-auth-failure.sanitized.jsonl')),
      readFile(resolve(fixtureDirectory, 'claude-sonnet-2.1.228-success.sanitized.jsonl')),
    ]);
});

function parseChunks(chunks: readonly Uint8Array[]): ReturnType<StreamJsonParser['finish']> {
  const parser = new StreamJsonParser();
  const items = chunks.flatMap((chunk) => parser.push(chunk));
  return [...items, ...parser.finish()];
}

describe('StreamJsonParser', () => {
  test('parses a JSONL stream split at every byte boundary', () => {
    const expected = parseChunks([validFixture]);

    for (let boundary = 0; boundary <= validFixture.byteLength; boundary += 1) {
      expect(parseChunks([validFixture.subarray(0, boundary), validFixture.subarray(boundary)])).toEqual(
        expected,
      );
    }

    expect(expected).toHaveLength(3);
    expect(expected[0]).toMatchObject({ type: 'system', line: 1 });
    expect(expected[2]).toMatchObject({ type: 'result', line: 3 });
  });

  test('supports CRLF, blank lines, and multiple events in one chunk', () => {
    const parser = new StreamJsonParser();
    const items = parser.push('{"type":"one"}\r\n\r\n{"type":"two"}\r\n');

    expect(items).toEqual([
      { type: 'one', line: 1 },
      { type: 'two', line: 3 },
    ]);
    expect(parser.finish()).toEqual([]);
  });

  test('decodes split UTF-8 and replaces invalid UTF-8 without losing events', () => {
    const text = Buffer.from('{"type":"assistant","text":"Привет"}\n');
    const splitInsideCharacter = text.indexOf(Buffer.from('П')) + 1;
    const parsed = parseChunks([
      text.subarray(0, splitInsideCharacter),
      text.subarray(splitInsideCharacter),
      Buffer.from([0xff]),
      Buffer.from('\n'),
    ]);

    expect(parsed[0]).toMatchObject({ type: 'assistant', text: 'Привет' });
    expect(parsed[1]).toMatchObject({ type: 'hydra_parse_error', line: 2, byteLength: 3 });
  });

  test('keeps valid events around a malformed line and stores only its digest', () => {
    const rawMalformed = '{this is not json and must never be persisted}';
    const items = parseChunks([malformedFixture]);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ type: 'system' });
    expect(items[1]).toEqual({
      type: 'hydra_parse_error',
      line: 2,
      sha256: createHash('sha256').update(rawMalformed).digest('hex'),
      byteLength: Buffer.byteLength(rawMalformed),
    });
    expect(JSON.stringify(items[1])).not.toContain('must never be persisted');
    expect(items[2]).toMatchObject({ type: 'result' });
  });

  test('reports a final incomplete object while preserving prior events', () => {
    const items = parseChunks([incompleteFixture]);

    expect(items[0]).toMatchObject({ type: 'assistant' });
    expect(items[1]).toMatchObject({ type: 'hydra_parse_error', line: 2 });
  });

  test('finish is idempotent and push after finish is rejected', () => {
    const parser = new StreamJsonParser();
    parser.push('{"type":"one"}');
    expect(parser.finish()).toHaveLength(1);
    expect(parser.finish()).toEqual([]);
    expect(() => parser.push('\n')).toThrow(/finished/u);
  });

  test('bounds a newline-free oversized event and resumes parsing at the next line', () => {
    const parser = new StreamJsonParser();
    const oversized = `{"type":"assistant","text":"${'x'.repeat(MAX_STREAM_LINE_BYTES + 50)}"}`;
    const first = parser.push(oversized);
    const second = parser.push('\n{"type":"result","result":"kept"}\n');

    expect(first).toEqual([]);
    expect(second).toEqual([
      expect.objectContaining({
        type: 'hydra_parse_error',
        line: 1,
        byteLength: Buffer.byteLength(oversized),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      { type: 'result', result: 'kept', line: 2 },
    ]);
    expect(parser.finish()).toEqual([]);
  });
});

describe('sanitizeClaudeEvent', () => {
  test('redacts secret-shaped keys and sensitive substrings while preserving unknown fields', () => {
    const event = {
      type: 'future_event',
      authorization: 'Bearer bearer-value',
      api_key: 'api-value',
      nested: {
        oauthToken: 'oauth-value',
        email: 'owner@example.com',
        note: 'Contact owner@example.com from /Users/private/project with Bearer abc.def.ghi',
        future: 42,
      },
    };

    expect(sanitizeClaudeEvent(event, { homeDirectory: '/Users/private' })).toEqual({
      type: 'future_event',
      authorization: '[REDACTED]',
      api_key: '[REDACTED]',
      nested: {
        oauthToken: '[REDACTED]',
        email: '[REDACTED]',
        note: 'Contact [REDACTED] from ~/project with Bearer [REDACTED]',
        future: 42,
      },
    });
  });

  test('normalizes home paths in keys and array values without mutating input', () => {
    const input = { cwd: '/Users/private/repo', values: ['/Users/private', 'safe'] };
    const sanitized = sanitizeClaudeEvent(input, { homeDirectory: '/Users/private' });

    expect(sanitized).toEqual({ cwd: '~/repo', values: ['~', 'safe'] });
    expect(input.cwd).toBe('/Users/private/repo');
  });

  test('is idempotent for canonical redaction placeholders', () => {
    const once = sanitizeClaudeEvent({
      note: 'Authorization analysis uses Bearer [REDACTED]; safely',
      authorization: '[REDACTED]',
    });

    expect(sanitizeClaudeEvent(once)).toEqual(once);
  });

  test('uses one credential classifier for every redacted provider shape', () => {
    const shapes = [
      ['Bearer', 'credential-value'].join(' '),
      ['sk-ant-', 'A'.repeat(8)].join(''),
      ['ghp_', 'A'.repeat(24)].join(''),
      ['AKIA', 'A'.repeat(16)].join(''),
      ['eyJ', 'A'.repeat(10), '.', 'B'.repeat(10), '.', 'C'.repeat(10)].join(''),
      ['GITHUB_TOKEN', '=', 'A'.repeat(16)].join(''),
      ['-----BEGIN PRIVATE KEY-----', 'body', '-----END PRIVATE KEY-----'].join('\n'),
    ];

    for (const shape of shapes) {
      expect(containsCredentialShape(shape), shape).toBe(true);
      expect(containsCredentialShape(sanitizeText(shape)), shape).toBe(false);
    }
    expect(containsCredentialShape('The documented prefix is sk-ant-x.')).toBe(false);
    expect(sanitizeText('The documented prefix is sk-ant-x.')).toBe(
      'The documented prefix is sk-ant-x.',
    );
  });
});

describe('ClaudeEventAccumulator', () => {
  test('extracts normalized execution fields from valid Claude events', () => {
    const accumulator = new ClaudeEventAccumulator();
    for (const item of parseChunks([validFixture])) {
      accumulator.accept(item);
    }

    expect(accumulator.summary()).toEqual({
      sessionId: '11111111-1111-4111-8111-111111111111',
      resolvedModel: 'claude-sonnet-5',
      finalText: 'final answer',
      structuredOutput: { ok: true },
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        costUsdEstimate: 0,
      },
      durationMs: 1234,
      turns: 1,
      reportedSessionTurns: 1,
      terminationReason: 'end_turn',
      isError: false,
      eventsComplete: true,
      parseErrors: [],
    });
    expect(accumulator.summary()).not.toHaveProperty('canonicalModelId');
  });

  test('records a canonical model ID only when Claude reports one explicitly', () => {
    const accumulator = new ClaudeEventAccumulator();
    accumulator.accept({
      type: 'system',
      line: 1,
      model: 'sonnet',
      canonical_model_id: 'claude-sonnet-5-20260801',
    });

    expect(accumulator.summary()).toMatchObject({
      resolvedModel: 'sonnet',
      canonicalModelId: 'claude-sonnet-5-20260801',
    });
  });

  test('records every model reported in terminal usage evidence', () => {
    const accumulator = new ClaudeEventAccumulator();
    accumulator.accept({
      type: 'result',
      line: 1,
      modelUsage: {
        'claude-haiku-4-5-20251001': { inputTokens: 543 },
        'claude-sonnet-5': { inputTokens: 2 },
      },
    });

    expect(accumulator.summary()).toMatchObject({
      reportedModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'],
    });
  });

  test('counts only top-level assistant events as turns and retains partial text', () => {
    const accumulator = new ClaudeEventAccumulator();
    accumulator.accept({
      type: 'system',
      line: 1,
      nested: { type: 'assistant', message: { content: [{ type: 'text', text: 'ignored' }] } },
    });
    accumulator.accept({
      type: 'assistant',
      line: 2,
      message: { content: [{ type: 'text', text: 'partial one' }] },
    });
    accumulator.accept({
      type: 'assistant',
      line: 3,
      message: { content: [{ type: 'text', text: 'partial two' }] },
    });

    expect(accumulator.summary()).toMatchObject({
      turns: 2,
      finalText: 'partial one\npartial two',
      eventsComplete: false,
    });
  });

  test('keeps per-invocation turns separate from cumulative terminal session turns', () => {
    const accumulator = new ClaudeEventAccumulator();
    accumulator.accept({
      type: 'assistant',
      line: 1,
      message: { id: 'msg_real_shape', content: [{ type: 'thinking' }] },
    });
    accumulator.accept({
      type: 'assistant',
      line: 2,
      message: { id: 'msg_real_shape', content: [{ type: 'tool_use' }] },
    });

    expect(accumulator.summary().turns).toBe(1);

    accumulator.accept({
      type: 'result',
      line: 3,
      subtype: 'success',
      num_turns: 40,
      result: 'done',
    });
    expect(accumulator.summary()).toMatchObject({
      turns: 1,
      reportedSessionTurns: 40,
    });
  });

  test('does not double-count split assistant events with malformed content', () => {
    const accumulator = new ClaudeEventAccumulator();
    accumulator.accept({
      type: 'assistant',
      line: 1,
      message: { id: 'msg_split_malformed', content: 'unexpected' },
    });
    accumulator.accept({
      type: 'assistant',
      line: 2,
      message: { id: 'msg_split_malformed', content: null },
    });

    expect(accumulator.summary()).toMatchObject({ turns: 1, eventsComplete: false });
  });

  test('distinguishes completed, failed, and incomplete test tool executions', () => {
    const accumulator = new ClaudeEventAccumulator();
    for (const [line, command] of [
      'npm test',
      'cd packages/core && python3 -m pytest -q',
      'cargo test',
      'git status --short',
    ].entries()) {
      accumulator.accept({
        type: 'assistant',
        line: line + 1,
        message: {
          id: `msg-${line}`,
          content: [{ type: 'tool_use', id: `tool-${line}`, name: 'Bash', input: { command } }],
        },
      });
    }
    accumulator.accept({
      type: 'user',
      line: 5,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-0', is_error: false, content: 'passed' },
          { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: 'failed' },
        ],
      },
    });

    expect(accumulator.summary().testsRun).toEqual([
      {
        command: 'npm test',
        toolUseId: 'tool-0',
        status: 'completed',
        outputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      {
        command: 'cd packages/core && python3 -m pytest -q',
        toolUseId: 'tool-1',
        status: 'failed',
        outputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      { command: 'cargo test', toolUseId: 'tool-2', status: 'attempted' },
    ]);
  });

  test('tracks parse errors and error termination without throwing', () => {
    const accumulator = new ClaudeEventAccumulator();
    const items = parseChunks([malformedFixture]);
    items.forEach((item) => accumulator.accept(item));

    expect(accumulator.summary()).toMatchObject({
      finalText: 'partial',
      isError: true,
      terminationReason: 'api_error',
      eventsComplete: false,
      parseErrors: [expect.objectContaining({ line: 2 })],
    });
  });

  test('normalizes the sanitized real 2.1.228 authentication-failure event shape', () => {
    const accumulator = new ClaudeEventAccumulator();
    parseChunks([realAuthFailureFixture]).forEach((item) => accumulator.accept(item));

    expect(accumulator.summary()).toMatchObject({
      sessionId: '77777777-7777-4777-8777-777777777777',
      resolvedModel: 'claude-sonnet-5',
      finalText: 'Authentication failed',
      turns: 1,
      isError: true,
      terminationReason: 'api_error',
      eventsComplete: true,
      usage: { costUsdEstimate: 0 },
    });
  });

  test('normalizes the sanitized real 2.1.228 structured-output success shape', () => {
    const accumulator = new ClaudeEventAccumulator();
    parseChunks([realSuccessFixture]).forEach((item) => accumulator.accept(item));

    expect(accumulator.summary()).toMatchObject({
      sessionId: '88888888-8888-4888-8888-888888888888',
      resolvedModel: 'claude-sonnet-5',
      structuredOutput: { ok: true, label: 'hydra-smoke' },
      turns: 1,
      reportedSessionTurns: 2,
      isError: false,
      terminationReason: 'completed',
      eventsComplete: true,
      usage: { costUsdEstimate: 0.048 },
    });
  });

  test('detects structured usage-credit requirements without relying on prose', () => {
    const accumulator = new ClaudeEventAccumulator();
    accumulator.accept({
      type: 'result',
      line: 1,
      subtype: 'usage_credits_required',
      usage_credits_required: true,
      is_error: true,
    });
    expect(accumulator.summary()).toMatchObject({
      usageCreditsRequired: true,
      isError: true,
    });
  });
});
