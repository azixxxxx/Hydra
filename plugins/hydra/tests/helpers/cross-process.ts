import { once } from 'node:events';

import { ConcurrencyManager } from '../../src/concurrency.js';
import { JobStore } from '../../src/stores.js';

function argument(index: number): string {
  const value = process.argv[index];
  if (value === undefined) {
    throw new Error(`missing argument ${index}`);
  }
  return value;
}

function queueInput(task: string) {
  return {
    task,
    cwd: '/tmp/repository',
    model: 'sonnet',
    effort: 'high' as const,
    role: 'tester',
    accessMode: 'analyze' as const,
    maxTurns: 12,
    timeoutSec: 1800,
    strictModel: false,
  };
}

async function waitForRelease(): Promise<void> {
  const data = once(process.stdin, 'data');
  process.stdin.resume();
  await data;
  process.stdin.pause();
}

async function runSlot(): Promise<void> {
  const stateRoot = argument(3);
  const jobId = argument(4);
  const model = argument(5);
  const manager = new ConcurrencyManager({
    stateRoot,
    maxConcurrentClaudeJobs: 1,
    maxConcurrentFableJobs: 1,
    staleHeartbeatMs: 5_000,
    pollIntervalMs: 5,
  });
  const lease = await manager.acquire({ jobId, model });
  process.stdout.write('ACQUIRED\n');
  await waitForRelease();
  await lease.release();
}

async function runMeta(): Promise<void> {
  const stateRoot = argument(3);
  const jobId = argument(4);
  const operation = argument(5);
  const store = new JobStore({ stateRoot });
  await waitForRelease();
  if (operation === 'worker') {
    await store.setWorker(jobId, 41_001, 'worker-marker');
  } else if (operation === 'claude') {
    await store.setClaudeGroup(jobId, 41_002, 'claude-marker');
  } else {
    throw new Error(`unknown meta operation ${operation}`);
  }
  process.stdout.write('DONE\n');
}

async function runQueue(): Promise<void> {
  const stateRoot = argument(3);
  const jobId = argument(4);
  const store = new JobStore({ stateRoot, idFactory: () => jobId });
  await waitForRelease();
  try {
    await store.createWithinCapacity(queueInput(`queue job ${jobId}`), 1);
    process.stdout.write('CREATED\n');
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : 'UNKNOWN';
    process.stdout.write(`REJECTED:${code}\n`);
  }
}

const mode = argument(2);
const operation =
  mode === 'slot'
    ? runSlot()
    : mode === 'meta'
      ? runMeta()
      : mode === 'queue'
        ? runQueue()
        : Promise.reject(new Error(`unknown mode ${mode}`));
operation.catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
