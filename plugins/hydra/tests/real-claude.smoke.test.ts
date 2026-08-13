import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { ClaudeCliAdapter } from '../src/claude-cli.js';
import { loadConfig } from '../src/config.js';
import { atomicWriteJson } from '../src/platform/atomic-files.js';
import { NodeProcessRunner } from '../src/platform/process.js';
import { PreflightService } from '../src/preflight.js';

const enabled = process.env.HYDRA_REAL_CLAUDE_SMOKE === '1';

describe.skipIf(!enabled)('opt-in real Claude smoke', () => {
  test('runs one low-effort structured Sonnet turn through the production adapter', async () => {
    const config = loadConfig();
    const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const preflight = await new PreflightService({
      config,
      runner: new NodeProcessRunner(),
    }).check({ cwd });
    expect(preflight.ok, JSON.stringify(preflight.errors)).toBe(true);
    expect(preflight.claudeVersion).not.toBeNull();
    expect(preflight.auth).toMatchObject({
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      subscriptionType: 'max',
      compatible: true,
    });

    const smokeRoot = await mkdtemp(join(tmpdir(), 'hydra-real-smoke-'));
    const settingsPath = resolve(smokeRoot, 'settings.json');
    const emptyMcpPath = resolve(smokeRoot, 'empty-mcp.json');
    const eventShapes: unknown[] = [];
    await Promise.all([
      atomicWriteJson(settingsPath, {
        autoMemoryEnabled: false,
        disableAllHooks: true,
        permissions: {
          allow: [`Read(${cwd}/**)`, `Glob(${cwd}/**)`, `Grep(${cwd}/**)`],
          deny: ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'],
        },
        enableAllProjectMcpServers: false,
      }),
      atomicWriteJson(emptyMcpPath, { mcpServers: {} }),
    ]);

    try {
      const result = await new ClaudeCliAdapter({
        claudePath: config.claudePath,
        capabilities: preflight.capabilities,
      }).run(
        {
          task: 'Return JSON with ok=true and label="hydra-smoke". Do not read or modify files.',
          role: 'subscription smoke verifier',
          cwd,
          model: 'sonnet',
          effort: 'low',
          accessMode: 'analyze',
          maxTurns: 2,
          timeoutSec: 60,
          emptyMcpPath,
          outputSchema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              label: { type: 'string' },
            },
            required: ['ok', 'label'],
            additionalProperties: false,
          },
          strictModel: true,
        },
        {
          settingsPath,
          onEvent: (event) => {
            const record = event as Record<string, unknown>;
            const message =
              record.message !== null && typeof record.message === 'object'
                ? (record.message as Record<string, unknown>)
                : undefined;
            eventShapes.push({
              type: record.type,
              subtype: record.subtype,
              numTurns: record.num_turns,
              sessionIdPresent: typeof record.session_id === 'string',
              messageIdPresent: typeof message?.id === 'string',
              messageModel: message?.model,
              contentTypes: Array.isArray(message?.content)
                ? message.content.map((item) =>
                    item !== null && typeof item === 'object'
                      ? (item as Record<string, unknown>).type
                      : typeof item,
                  )
                : [],
            });
          },
        },
      );

      expect({
        exitCode: result.exitCode,
        isError: result.isError,
        timedOut: result.timedOut,
        aborted: result.aborted,
        structuredOutput: result.structuredOutput,
        turns: result.turns,
        reportedSessionTurns: result.reportedSessionTurns,
        resolvedModel: result.resolvedModel,
        reportedModels: result.reportedModels,
      }, JSON.stringify({ eventShapes, finalText: result.finalText })).toMatchObject({
        exitCode: 0,
        isError: false,
        timedOut: false,
        aborted: false,
        structuredOutput: { ok: true, label: 'hydra-smoke' },
        turns: 1,
        reportedSessionTurns: 2,
        resolvedModel: expect.stringContaining('sonnet'),
        reportedModels: [expect.stringContaining('sonnet')],
      });
      expect(eventShapes).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ subtype: 'hook_started' })]),
      );
    } finally {
      await rm(smokeRoot, { recursive: true, force: true });
    }
  }, 90_000);
});
