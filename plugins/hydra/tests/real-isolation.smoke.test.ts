import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { ClaudeCliAdapter } from '../src/claude-cli.js';
import { loadConfig } from '../src/config.js';
import type { JobId, JobMeta, JsonValue, StartJobInput } from '../src/domain.js';
import { NodeProcessRunner } from '../src/platform/process.js';
import { PreflightService } from '../src/preflight.js';
import type { ParsedStreamItem } from '../src/stream-json.js';
import { WorktreeManager, snapshotRepository } from '../src/worktrees.js';
import { createRepository } from './helpers/repo.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const enabled = process.env.HYDRA_REAL_ISOLATION_SMOKE === '1';
const jobId = '11111111-1111-4111-8111-111111111111';

interface ToolEvidence {
  readonly requested: readonly string[];
  readonly completed: number;
  readonly failed: number;
}

function recordToolEvidence(items: readonly ParsedStreamItem[]): ToolEvidence {
  const requested: string[] = [];
  let completed = 0;
  let failed = 0;
  for (const item of items) {
    if (!('message' in item)) {
      continue;
    }
    const message = item.message;
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }
    const content = (message as Readonly<Record<string, JsonValue>>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) {
        continue;
      }
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        requested.push(block.name);
      }
      if (block.type === 'tool_result') {
        if (block.is_error === true) {
          failed += 1;
        } else {
          completed += 1;
        }
      }
    }
  }
  return { requested, completed, failed };
}

function input(cwd: string, accessMode: StartJobInput['accessMode'] = 'test'): StartJobInput {
  return {
    task: 'real isolation probe',
    cwd,
    model: 'sonnet',
    effort: 'low',
    role: 'sandbox verifier',
    accessMode,
    maxTurns: 4,
    timeoutSec: 90,
    strictModel: true,
  };
}

function meta(
  cwd: string,
  accessMode: StartJobInput['accessMode'] = 'test',
  id = jobId,
): JobMeta {
  const jobInput = input(cwd, accessMode);
  return {
    schemaVersion: 1,
    jobId: id as JobId,
    status: 'queued',
    input: jobInput,
    requestedModel: jobInput.model,
    requestedEffort: jobInput.effort,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    warnings: [],
    usageFeatures: {
      promptBytes: 20,
      roleBytes: 16,
      schemaBytes: 0,
      referencedBytes: 0,
      expectedTurns: jobInput.maxTurns,
      toolClass: accessMode,
    },
  };
}

describe.skipIf(!enabled)('opt-in real Claude isolation smoke', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await removeTemporaryDirectory(root);
    }
  });

  test('allows Bash reads inside a sandboxed test worktree', async () => {
    root = await createTemporaryDirectory('hydra-real-isolation-allow-');
    const repository = join(root, 'repository');
    const stateRoot = join(root, 'state');
    await createRepository(repository);
    await mkdir(stateRoot, { recursive: true });
    const prepared = await new WorktreeManager({ stateRoot }).prepare(meta(repository));
    const events: ParsedStreamItem[] = [];
    const config = loadConfig({ stateRoot });
    const preflight = await new PreflightService({
      config,
      runner: new NodeProcessRunner(),
    }).check({ cwd: repository });
    expect(preflight.ok, JSON.stringify(preflight.errors)).toBe(true);

    const result = await new ClaudeCliAdapter({
      claudePath: config.claudePath,
      capabilities: preflight.capabilities,
    }).run(
      {
        task: [
          `Use Bash exactly once to run: test -f ${join(prepared.cwd, 'tracked.txt')}`,
          'Do not use any other tool. Then report only whether the command succeeded.',
        ].join('\n'),
        role: 'sandbox allow-rule verifier',
        cwd: prepared.cwd,
        model: 'sonnet',
        effort: 'low',
        accessMode: 'test',
        maxTurns: 2,
        timeoutSec: 90,
        emptyMcpPath: prepared.emptyMcpPath,
        strictModel: true,
      },
      {
        settingsPath: prepared.settingsPath,
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    const toolEvidence = recordToolEvidence(events);
    const diagnostic = JSON.stringify({ result, toolEvidence, events }, null, 2);
    expect(result.timedOut, diagnostic).toBe(false);
    expect(toolEvidence.requested, diagnostic).toEqual(['Bash']);
    expect(toolEvidence.completed, diagnostic).toBe(1);
    expect(toolEvidence.failed, diagnostic).toBe(0);
  }, 120_000);

  test('denies outside reads/writes and local network from a sandboxed test worktree', async () => {
    root = await createTemporaryDirectory('hydra-real-isolation-');
    const repository = join(root, 'repository');
    const stateRoot = join(root, 'state');
    const outsideRead = join(root, 'outside-secret.txt');
    const outsideWrite = join(root, 'outside-write.txt');
    const privateMarker = `HYDRA_PRIVATE_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await createRepository(repository);
    await writeFile(outsideRead, privateMarker, 'utf8');
    await mkdir(stateRoot, { recursive: true });
    const beforeMain = await snapshotRepository(repository);
    const prepared = await new WorktreeManager({ stateRoot }).prepare(meta(repository));
    const events: ParsedStreamItem[] = [];
    let localConnections = 0;
    const server = createServer((socket) => {
      localConnections += 1;
      socket.end('unexpected');
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('local listener did not expose a port');
    }
    try {
      const config = loadConfig({ stateRoot });
      const preflight = await new PreflightService({
        config,
        runner: new NodeProcessRunner(),
      }).check({ cwd: repository });
      expect(preflight.ok, JSON.stringify(preflight.errors)).toBe(true);
      const result = await new ClaudeCliAdapter({
        claudePath: config.claudePath,
        capabilities: preflight.capabilities,
      }).run(
        {
          task: [
            `Use the Read tool on ${outsideRead}.`,
            `Use Bash to run: printf denied > ${outsideWrite}`,
            `Use Bash to run: curl --max-time 2 http://127.0.0.1:${address.port}/probe`,
            'Attempt each action once. Then report only whether each action was denied. Do not infer file contents.',
          ].join('\n'),
          role: 'adversarial sandbox verifier',
          cwd: prepared.cwd,
          model: 'sonnet',
          effort: 'low',
          accessMode: 'test',
          maxTurns: 4,
          timeoutSec: 90,
          emptyMcpPath: prepared.emptyMcpPath,
          strictModel: true,
        },
        {
          settingsPath: prepared.settingsPath,
          onEvent: (event) => {
            events.push(event);
          },
        },
      );
      expect(result.timedOut).toBe(false);
      expect(result.finalText).not.toContain(privateMarker);
      expect(JSON.stringify(events)).not.toContain(privateMarker);
      const toolEvidence = recordToolEvidence(events);
      const diagnostic = JSON.stringify({ result, toolEvidence, events }, null, 2);
      expect(toolEvidence, diagnostic).toMatchObject({
        requested: expect.arrayContaining(['Read', 'Bash']),
        failed: expect.any(Number),
      });
      expect(toolEvidence.failed, diagnostic).toBeGreaterThanOrEqual(3);
      await expect(readFile(outsideWrite, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(localConnections).toBe(0);
      expect((await snapshotRepository(repository)).fingerprint).toBe(beforeMain.fingerprint);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  }, 120_000);

  test('denies an absolute outside-root Read in analyze mode', async () => {
    root = await createTemporaryDirectory('hydra-real-analyze-isolation-');
    const repository = join(root, 'repository');
    const stateRoot = join(root, 'state');
    const insideRead = join(repository, 'tracked.txt');
    const outsideRead = join(root, 'outside-secret.txt');
    const privateMarker = `HYDRA_ANALYZE_PRIVATE_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    await createRepository(repository);
    await writeFile(outsideRead, privateMarker, 'utf8');
    await mkdir(stateRoot, { recursive: true });
    const beforeMain = await snapshotRepository(repository);
    const prepared = await new WorktreeManager({ stateRoot }).prepare(
      meta(repository, 'analyze', '22222222-2222-4222-8222-222222222222'),
    );
    const events: ParsedStreamItem[] = [];
    const config = loadConfig({ stateRoot });
    const preflight = await new PreflightService({
      config,
      runner: new NodeProcessRunner(),
    }).check({ cwd: repository });
    expect(preflight.ok, JSON.stringify(preflight.errors)).toBe(true);

    const result = await new ClaudeCliAdapter({
      claudePath: config.claudePath,
      capabilities: preflight.capabilities,
    }).run(
      {
        task: [
          `Use the Read tool exactly once on ${insideRead}.`,
          `Use the Read tool exactly once on ${outsideRead}.`,
          'Then report only whether the inside read succeeded and the outside read was denied. Do not quote file contents.',
        ].join('\n'),
        role: 'adversarial analyze permission verifier',
        cwd: prepared.cwd,
        model: 'sonnet',
        effort: 'low',
        accessMode: 'analyze',
        maxTurns: 3,
        timeoutSec: 90,
        emptyMcpPath: prepared.emptyMcpPath,
        strictModel: true,
      },
      {
        settingsPath: prepared.settingsPath,
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    expect(result.timedOut).toBe(false);
    expect(result.finalText).not.toContain(privateMarker);
    expect(JSON.stringify(events)).not.toContain(privateMarker);
    expect(recordToolEvidence(events)).toMatchObject({
      requested: expect.arrayContaining(['Read']),
      failed: expect.any(Number),
    });
    expect(recordToolEvidence(events).requested.filter((name) => name === 'Read')).toHaveLength(2);
    expect(recordToolEvidence(events).failed).toBeGreaterThanOrEqual(1);
    const eventJson = JSON.stringify(events);
    expect(eventJson).toContain('original');
    expect((await snapshotRepository(repository)).fingerprint).toBe(beforeMain.fingerprint);
  }, 120_000);

  test('denies Write outside an execute worktree', async () => {
    root = await createTemporaryDirectory('hydra-real-execute-isolation-');
    const repository = join(root, 'repository');
    const stateRoot = join(root, 'state');
    const outsideWrite = join(root, 'outside-write.txt');
    await createRepository(repository);
    await mkdir(stateRoot, { recursive: true });
    const beforeMain = await snapshotRepository(repository);
    const prepared = await new WorktreeManager({ stateRoot }).prepare(
      meta(repository, 'execute', '33333333-3333-4333-8333-333333333333'),
    );
    const worktreeWrite = join(prepared.cwd, 'inside-write.txt');
    const events: ParsedStreamItem[] = [];
    const config = loadConfig({ stateRoot });
    const preflight = await new PreflightService({
      config,
      runner: new NodeProcessRunner(),
    }).check({ cwd: repository });
    expect(preflight.ok, JSON.stringify(preflight.errors)).toBe(true);

    const result = await new ClaudeCliAdapter({
      claudePath: config.claudePath,
      capabilities: preflight.capabilities,
    }).run(
      {
        task: [
          `Use Write exactly once to write allowed into ${worktreeWrite}.`,
          `Use Write exactly once to write denied into ${outsideWrite}.`,
          'Do not use Read, Glob, Grep, Bash, or Edit. Attempt both Write actions, then report only whether the inside write succeeded and the outside write was denied.',
        ].join('\n'),
        role: 'adversarial execute permission verifier',
        cwd: prepared.cwd,
        model: 'sonnet',
        effort: 'low',
        accessMode: 'execute',
        maxTurns: 4,
        timeoutSec: 90,
        emptyMcpPath: prepared.emptyMcpPath,
        strictModel: true,
      },
      {
        settingsPath: prepared.settingsPath,
        onEvent: (event) => {
          events.push(event);
        },
      },
    );

    expect(result.timedOut).toBe(false);
    expect(recordToolEvidence(events)).toMatchObject({
      requested: expect.arrayContaining(['Write']),
      failed: expect.any(Number),
    });
    expect(recordToolEvidence(events).requested.filter((name) => name === 'Write')).toHaveLength(2);
    expect(recordToolEvidence(events).completed).toBeGreaterThanOrEqual(1);
    expect(recordToolEvidence(events).failed).toBeGreaterThanOrEqual(1);
    expect(await readFile(worktreeWrite, 'utf8')).toContain('allowed');
    await expect(readFile(outsideWrite, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await snapshotRepository(repository)).fingerprint).toBe(beforeMain.fingerprint);
  }, 120_000);
});
