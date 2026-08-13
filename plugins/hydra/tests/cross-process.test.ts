import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import type { StartJobInput } from '../src/domain.js';
import { JobStore } from '../src/stores.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const jobIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
] as const;

function jobInput(): StartJobInput {
  return {
    task: 'cross-process test',
    cwd: '/tmp/repository',
    model: 'sonnet',
    effort: 'high',
    role: 'tester',
    accessMode: 'analyze',
    maxTurns: 12,
    timeoutSec: 1800,
    strictModel: false,
  };
}

async function outputLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  let buffer = '';
  for await (const chunk of child.stdout) {
    buffer += (chunk as Buffer).toString('utf8');
    if (buffer.includes(`${expected}\n`)) {
      return;
    }
  }
  throw new Error(`child exited before ${expected}: ${buffer}`);
}

async function successfulExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const [exitCode] = (await once(child, 'close')) as [number | null];
  expect(exitCode, stderr).toBe(0);
}

describe('cross-process durability', () => {
  let root: string;
  let stateRoot: string;
  let helperBundle: string;

  beforeAll(async () => {
    root = await createTemporaryDirectory('hydra-cross-process-bundle-');
    helperBundle = join(root, 'cross-process.mjs');
    const entry = fileURLToPath(new URL('./helpers/cross-process.ts', import.meta.url));
    await mkdir(dirname(helperBundle), { recursive: true });
    await build({
      entryPoints: [entry],
      outfile: helperBundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      legalComments: 'none',
    });
  });

  afterAll(async () => {
    await removeTemporaryDirectory(root);
  });

  beforeEach(async () => {
    stateRoot = await createTemporaryDirectory('hydra-cross-process-state-');
  });

  afterEach(async () => {
    await removeTemporaryDirectory(stateRoot);
  });

  function child(...args: readonly string[]): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, [helperBundle, ...args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  test('enforces a single durable Claude slot across independent Node processes', async () => {
    const first = child('slot', stateRoot, jobIds[0], 'sonnet');
    await outputLine(first, 'ACQUIRED');
    const second = child('slot', stateRoot, jobIds[1], 'opus');
    let secondAcquired = false;
    const secondLine = outputLine(second, 'ACQUIRED').then(() => {
      secondAcquired = true;
    });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 75));
    expect(secondAcquired).toBe(false);

    first.stdin.end('release\n');
    await Promise.all([successfulExit(first), secondLine]);
    expect(secondAcquired).toBe(true);
    second.stdin.end('release\n');
    await successfulExit(second);
  });

  test('serializes cross-process metadata read-modify-write operations without lost updates', async () => {
    const store = new JobStore({ stateRoot, idFactory: () => jobIds[0] });
    await store.create(jobInput());
    const worker = child('meta', stateRoot, jobIds[0], 'worker');
    const claude = child('meta', stateRoot, jobIds[0], 'claude');
    worker.stdin.end('go\n');
    claude.stdin.end('go\n');
    await Promise.all([
      outputLine(worker, 'DONE'),
      outputLine(claude, 'DONE'),
      successfulExit(worker),
      successfulExit(claude),
    ]);

    expect(await store.get(jobIds[0])).toMatchObject({
      workerPid: 41_001,
      workerProcessStartMarker: 'worker-marker',
      claudePgid: 41_002,
      claudeProcessStartMarker: 'claude-marker',
    });
  });

  test('enforces queue admission capacity across independent Node processes', async () => {
    const first = child('queue', stateRoot, jobIds[0]);
    const second = child('queue', stateRoot, jobIds[1]);
    first.stdin.end('go\n');
    second.stdin.end('go\n');
    let firstOutput = '';
    let secondOutput = '';
    first.stdout.on('data', (chunk: Buffer) => {
      firstOutput += chunk.toString('utf8');
    });
    second.stdout.on('data', (chunk: Buffer) => {
      secondOutput += chunk.toString('utf8');
    });

    await Promise.all([successfulExit(first), successfulExit(second)]);

    expect([firstOutput.trim(), secondOutput.trim()].sort()).toEqual([
      'CREATED',
      'REJECTED:JOB_QUEUE_FULL',
    ]);
    expect(await new JobStore({ stateRoot }).activeCount()).toBe(1);
  });
});
