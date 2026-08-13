import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test, vi } from 'vitest';

import {
  ClaudeCliAdapter,
  buildClaudeArgs,
  buildClaudePrompt,
  sanitizeClaudeEnvironment,
  type ClaudeRunInput,
} from '../src/claude-cli.js';
import type { ClaudeCapabilities } from '../src/domain.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const helper = resolve(dirname(fileURLToPath(import.meta.url)), 'helpers', 'mock-claude.mjs');
const settingsPath = '/private/job/settings.json';
const emptyMcpPath = '/private/job/empty-mcp.json';

const capabilities: ClaudeCapabilities = {
  flags: {
    print: true,
    model: true,
    effort: true,
    outputFormat: true,
    verbose: true,
    permissionMode: true,
    tools: true,
    settings: true,
    settingSources: true,
    jsonSchema: true,
    resume: true,
    sessionId: true,
    mcpConfig: true,
    strictMcpConfig: true,
  },
  supportsCliMaxTurns: false,
  supportsDirectSandboxFlag: false,
};

function input(overrides: Partial<ClaudeRunInput> = {}): ClaudeRunInput {
  return {
    task: 'mock:success',
    role: 'adversarial reviewer',
    cwd: '/tmp',
    model: 'sonnet',
    effort: 'high',
    accessMode: 'analyze',
    maxTurns: 12,
    timeoutSec: 5,
    emptyMcpPath,
    ...overrides,
  };
}

function adapter(): ClaudeCliAdapter {
  return new ClaudeCliAdapter({
    claudePath: process.execPath,
    claudeArgsPrefix: [helper],
    capabilities,
  });
}

describe('buildClaudeArgs', () => {
  test('builds the exact safe analyze invocation and keeps task text in one argument', () => {
    const task = 'review $(touch /tmp/nope); `whoami`; line two';

    expect(buildClaudeArgs(input({ task }), capabilities, settingsPath)).toEqual([
      '-p',
      buildClaudePrompt({ task, role: 'adversarial reviewer' }),
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Glob,Grep',
      '--settings',
      settingsPath,
      '--strict-mcp-config',
      '--mcp-config',
      emptyMcpPath,
      '--setting-sources',
      '',
    ]);
  });

  test.each([
    ['analyze', 'dontAsk', 'Read,Glob,Grep'],
    ['test', 'dontAsk', 'Read,Glob,Grep,Bash'],
    ['execute', 'dontAsk', 'Read,Glob,Grep,Bash,Edit,Write'],
  ] as const)('uses the %s access profile', (accessMode, permissionMode, tools) => {
    const args = buildClaudeArgs(input({ accessMode }), capabilities, settingsPath);
    expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 4)).toEqual([
      '--permission-mode',
      permissionMode,
      '--tools',
      tools,
    ]);
  });

  test('always keeps external setting sources disabled', () => {
    const args = buildClaudeArgs(input(), capabilities, settingsPath);
    expect(args.slice(-2)).toEqual(['--setting-sources', '']);
  });

  test('adds structured output, resume, and explicit new session flags as separate arguments', () => {
    const outputSchema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const args = buildClaudeArgs(
      input({
        outputSchema,
        resumeSessionId: '33333333-3333-4333-8333-333333333333',
      }),
      capabilities,
      settingsPath,
    );

    expect(args).toContain('--json-schema');
    expect(args[args.indexOf('--json-schema') + 1]).toBe(JSON.stringify(outputSchema));
    expect(args.slice(-2)).toEqual(['--resume', '33333333-3333-4333-8333-333333333333']);

    const newSessionArgs = buildClaudeArgs(
      input({ newSessionId: '44444444-4444-4444-8444-444444444444' }),
      capabilities,
      settingsPath,
    );
    expect(newSessionArgs.slice(-2)).toEqual([
      '--session-id',
      '44444444-4444-4444-8444-444444444444',
    ]);
  });

  test('fails closed when a required detected flag is absent', () => {
    expect(() =>
      buildClaudeArgs(
        input(),
        { ...capabilities, flags: { ...capabilities.flags, settings: false } },
        settingsPath,
      ),
    ).toThrow(/--settings/u);
  });

  test('contains no unsafe, fallback, or shell-only arguments', () => {
    const serialized = JSON.stringify(buildClaudeArgs(input(), capabilities, settingsPath));
    expect(serialized).not.toMatch(
      /--bare|--fallback-model|bypassPermissions|dangerously-skip-permissions/u,
    );
  });
});

describe('sanitizeClaudeEnvironment', () => {
  test('removes provider credentials, routing, and explicit OAuth values without reading them', () => {
    const environment: NodeJS.ProcessEnv = { PATH: '/bin', HOME: '/private/home' };
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]) {
      Object.defineProperty(environment, name, {
        enumerable: true,
        get: () => {
          throw new Error(`secret value was read: ${name}`);
        },
      });
    }

    const result = sanitizeClaudeEnvironment(environment, 'sonnet');

    expect(result).toEqual({
      PATH: '/bin',
      HOME: '/private/home',
      CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
      ANTHROPIC_MODEL: 'sonnet',
      ANTHROPIC_SMALL_FAST_MODEL: 'sonnet',
      CLAUDE_CODE_AUTO_MODE_MODEL: 'sonnet',
      CLAUDE_CODE_BG_CLASSIFIER_MODEL: 'sonnet',
      CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet',
      CLAUDE_CONTEXT_COLLAPSE_MODEL: 'sonnet',
    });
  });

  test('pins Claude internal model calls to the explicitly requested model', () => {
    const environment: NodeJS.ProcessEnv = {
      PATH: '/bin',
      ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
      ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5-20251001',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5-20250929',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-old',
      CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-haiku-4-5-20251001',
      CLAUDE_CODE_BG_CLASSIFIER_MODEL: 'claude-haiku-4-5-20251001',
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5-20251001',
      CLAUDE_CONTEXT_COLLAPSE_MODEL: 'claude-haiku-4-5-20251001',
    };

    expect(sanitizeClaudeEnvironment(environment, 'claude-opus-5')).toEqual({
      PATH: '/bin',
      CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
      ANTHROPIC_MODEL: 'claude-opus-5',
      ANTHROPIC_SMALL_FAST_MODEL: 'claude-opus-5',
      CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-opus-5',
      CLAUDE_CODE_BG_CLASSIFIER_MODEL: 'claude-opus-5',
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-opus-5',
      CLAUDE_CONTEXT_COLLAPSE_MODEL: 'claude-opus-5',
    });
  });

  test('drops dynamically named credential variables before reading their values', () => {
    const environment: NodeJS.ProcessEnv = { PATH: '/bin', BUILD_FLAVOR: 'release' };
    for (const name of ['GITHUB_TOKEN', 'DATABASE_PASSWORD', 'SSH_AUTH_SOCK', 'CUSTOM_DSN']) {
      Object.defineProperty(environment, name, {
        enumerable: true,
        get: () => {
          throw new Error(`credential value was read: ${name}`);
        },
      });
    }

    expect(sanitizeClaudeEnvironment(environment, 'sonnet')).toMatchObject({
      PATH: '/bin',
      BUILD_FLAVOR: 'release',
      CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
    });
    expect(Object.keys(sanitizeClaudeEnvironment(environment, 'sonnet'))).not.toEqual(
      expect.arrayContaining(['GITHUB_TOKEN', 'DATABASE_PASSWORD', 'SSH_AUTH_SOCK', 'CUSTOM_DSN']),
    );
  });

  test('sanitizes an injected environment at spawn time as well as construction time', async () => {
    const environment: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: 'never-forward' };
    const guarded = new ClaudeCliAdapter({
      claudePath: process.execPath,
      claudeArgsPrefix: [helper],
      capabilities,
      environment,
    });

    const result = await guarded.run(input(), { settingsPath });

    expect(result.exitCode).toBe(0);
    expect(environment.ANTHROPIC_API_KEY).toBe('never-forward');
  });
});

describe('ClaudeCliAdapter', () => {
  test('streams sanitized events and stderr, captures the process group, and normalizes success', async () => {
    const events: unknown[] = [];
    const stderr: string[] = [];
    const groups: number[] = [];
    const heartbeats = vi.fn();

    const result = await adapter().run(input(), {
      settingsPath,
      onEvent: (event) => {
        events.push(event);
      },
      onStderr: (chunk) => {
        stderr.push(chunk);
      },
      onProcessGroup: (group) => {
        groups.push(group);
      },
      onHeartbeat: heartbeats,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      aborted: false,
      turnLimitReached: false,
      sessionId: '22222222-2222-4222-8222-222222222222',
      resolvedModel: 'claude-sonnet-mock',
      appliedEffort: 'high',
      turns: 1,
      finalText: 'final for mock:success',
      eventsComplete: true,
      warnings: [],
    });
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      'system',
      'assistant',
      'result',
    ]);
    expect(stderr.join('')).toContain('mock diagnostic');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toBeGreaterThan(0);
    expect(heartbeats).toHaveBeenCalled();
  });

  test('supports structured output and resume', async () => {
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const result = await adapter().run(
      input({
        resumeSessionId: sessionId,
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      }),
      { settingsPath },
    );

    expect(result.sessionId).toBe(sessionId);
    expect(result.structuredOutput).toEqual({ ok: true });
  });

  test('returns the complete summary and marks strict-model mismatches for the worker', async () => {
    const permissive = await adapter().run(input({ task: 'mock:mismatch' }), { settingsPath });
    expect(permissive.warnings).toEqual([expect.stringMatching(/requested sonnet/u)]);

    await expect(
      adapter().run(input({ task: 'mock:mismatch', strictModel: true }), { settingsPath }),
    ).resolves.toMatchObject({
      modelMismatch: true,
      resolvedModel: 'claude-opus-4-1',
      finalText: 'final for mock:mismatch',
    });
  });

  test('requires an exact match for a strict full model ID', async () => {
    await expect(
      adapter().run(
        input({
          task: 'mock:same-family-mismatch',
          model: 'claude-sonnet-4-5-20250929',
          strictModel: true,
        }),
        { settingsPath },
      ),
    ).resolves.toMatchObject({ modelMismatch: true, resolvedModel: 'claude-sonnet-5' });
  });

  test('rejects any unexpected model reported in terminal usage evidence', async () => {
    await expect(
      adapter().run(
        input({ task: 'mock:unexpected-model-usage', strictModel: false }),
        { settingsPath },
      ),
    ).resolves.toMatchObject({
      modelMismatch: true,
      reportedModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-mock'],
      warnings: [expect.stringMatching(/claude-haiku-4-5-20251001/u)],
    });
  });

  test('rejects a second terminal model ID from the requested family', async () => {
    await expect(
      adapter().run(
        input({ task: 'mock:same-family-extra-usage', strictModel: false }),
        { settingsPath },
      ),
    ).resolves.toMatchObject({
      modelMismatch: true,
      unexpectedModelUsage: true,
      reportedModels: ['claude-sonnet-4-5-20250929', 'claude-sonnet-mock'],
    });
  });

  test('keeps a single terminal model substitution under strictModel policy', async () => {
    await expect(
      adapter().run(
        input({ task: 'mock:single-model-usage-mismatch', strictModel: false }),
        { settingsPath },
      ),
    ).resolves.toMatchObject({
      modelMismatch: true,
      unexpectedModelUsage: false,
      reportedModels: ['claude-opus-4-1'],
      warnings: [expect.stringMatching(/claude-opus-4-1/u)],
    });
  });

  test('terminates the process group when the Hydra turn limit is exceeded', async () => {
    const onTurnLimit = vi.fn();
    const result = await adapter().run(input({ task: 'mock:turn-limit', maxTurns: 1 }), {
      settingsPath,
      onTurnLimit,
    });

    expect(onTurnLimit).toHaveBeenCalledTimes(1);
    expect(result.turnLimitReached).toBe(true);
    expect(result.turns).toBe(2);
    expect(result.exitCode).not.toBe(0);
  });

  test('stops at the allowed tool boundary without starting a second assistant turn', async () => {
    const result = await adapter().run(
      input({ task: 'mock:tool-turn-limit', maxTurns: 1 }),
      { settingsPath },
    );

    expect(result).toMatchObject({
      turnLimitReached: true,
      turns: 1,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.testsRun).toEqual([
      expect.objectContaining({ command: 'npm test', status: 'attempted' }),
    ]);
  });

  test('does not apply a per-invocation turn limit to a cumulative resumed-session count', async () => {
    const onTurnLimit = vi.fn();
    const result = await adapter().run(
      input({
        task: 'mock:resumed-cumulative-turns',
        maxTurns: 2,
        resumeSessionId: '33333333-3333-4333-8333-333333333333',
      }),
      { settingsPath, onTurnLimit },
    );

    expect(result).toMatchObject({
      turns: 1,
      reportedSessionTurns: 40,
      turnLimitReached: false,
      isError: false,
      exitCode: 0,
    });
    expect(onTurnLimit).not.toHaveBeenCalled();
  });

  test('injects the Claude no-fallback tripwire into every invocation', async () => {
    await expect(
      adapter().run(input({ task: 'mock:require-no-fallback' }), { settingsPath }),
    ).resolves.toMatchObject({ isError: false, exitCode: 0 });
  });

  test('terminates and reaps Claude when process metadata persistence fails', async () => {
    let pid = 0;
    const forcefulAdapter = new ClaudeCliAdapter({
      claudePath: process.execPath,
      claudeArgsPrefix: [helper],
      capabilities,
      terminationGraceMs: 20,
    });
    await expect(
      forcefulAdapter.run(input({ task: 'mock:ignore-term' }), {
        settingsPath,
        onProcessGroup: (group) => {
          pid = group;
          throw new Error('metadata unavailable');
        },
      }),
    ).rejects.toThrow('metadata unavailable');
    expect(pid).toBeGreaterThan(0);
    await expectProcessGone(pid);
  });

  test('kills descendants in the detached process group after TERM grace expires', async () => {
    const root = await createTemporaryDirectory('hydra-process-tree-');
    const pidFile = resolve(root, 'pids.txt');
    try {
      const forcefulAdapter = new ClaudeCliAdapter({
        claudePath: process.execPath,
        claudeArgsPrefix: [helper],
        capabilities,
        environment: { ...process.env, HYDRA_MOCK_PID_FILE: pidFile },
        terminationGraceMs: 20,
      });
      const result = await forcefulAdapter.run(
        input({ task: 'mock:process-tree', timeoutSec: 0.2 }),
        { settingsPath },
      );
      expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
      const pids = [...new Set((await readFile(pidFile, 'utf8')).trim().split(/\s+/u).map(Number))];
      expect(pids.length).toBeGreaterThanOrEqual(3);
      await Promise.all(pids.map(async (pid) => expectProcessGone(pid)));
    } finally {
      await removeTemporaryDirectory(root);
    }
  });

  test('terminates on timeout and preserves partial output', async () => {
    const result = await adapter().run(input({ task: 'mock:timeout', timeoutSec: 0.08 }), {
      settingsPath,
    });

    expect(result.timedOut).toBe(true);
    expect(result.sessionId).toBe('22222222-2222-4222-8222-222222222222');
    expect(result.eventsComplete).toBe(false);
  });

  test('escalates timeout termination when the process group ignores SIGTERM', async () => {
    const forcefulAdapter = new ClaudeCliAdapter({
      claudePath: process.execPath,
      claudeArgsPrefix: [helper],
      capabilities,
      terminationGraceMs: 20,
    });
    const startedAt = Date.now();

    const result = await forcefulAdapter.run(
      input({ task: 'mock:ignore-term', timeoutSec: 0.05 }),
      { settingsPath },
    );

    expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test('honors AbortSignal without conflating it with timeout', async () => {
    const controller = new AbortController();
    const run = adapter().run(input({ task: 'mock:timeout' }), {
      settingsPath,
      signal: controller.signal,
      onEvent: () => controller.abort(),
    });

    await expect(run).resolves.toMatchObject({ aborted: true, timedOut: false });
  });

  test('converts malformed output into a bounded event and keeps the final result', async () => {
    const result = await adapter().run(input({ task: 'mock:malformed' }), { settingsPath });

    expect(result.parseErrors).toEqual([expect.objectContaining({ line: 3 })]);
    expect(result.finalText).toBe('final for mock:malformed');
    expect(JSON.stringify(result.parseErrors)).not.toContain('secret line');
  });
});

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return;
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`process ${pid} survived group termination`);
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
