import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  ConcurrencyManager,
  readProcessStartMarker,
  type SlotOwner,
} from '../src/concurrency.js';
import { atomicWriteJson, ensurePrivateDirectory } from '../src/platform/atomic-files.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const jobIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

describe('ConcurrencyManager', () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await createTemporaryDirectory('hydra-slots-');
  });

  afterEach(async () => {
    await removeTemporaryDirectory(stateRoot);
  });

  test('allows at most two simultaneous Claude leases and wakes a waiter after release', async () => {
    const manager = new ConcurrencyManager({
      stateRoot,
      maxConcurrentClaudeJobs: 2,
      maxConcurrentFableJobs: 1,
      pollIntervalMs: 5,
      staleHeartbeatMs: 500,
    });
    const first = await manager.acquire({ jobId: jobIds[0]!, model: 'sonnet' });
    const second = await manager.acquire({ jobId: jobIds[1]!, model: 'opus' });
    let thirdResolved = false;
    const thirdPromise = manager.acquire({ jobId: jobIds[2]!, model: 'sonnet' }).then((lease) => {
      thirdResolved = true;
      return lease;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    expect(thirdResolved).toBe(false);

    await first.release();
    const third = await thirdPromise;
    expect(third.slotNames).toHaveLength(1);
    await Promise.all([second.release(), third.release()]);
  });

  test('allows only one Fable lease while preserving the total Claude limit', async () => {
    const manager = new ConcurrencyManager({
      stateRoot,
      maxConcurrentClaudeJobs: 2,
      maxConcurrentFableJobs: 1,
      pollIntervalMs: 5,
      staleHeartbeatMs: 500,
    });
    const firstFable = await manager.acquire({ jobId: jobIds[0]!, model: 'fable' });
    const opus = await manager.acquire({ jobId: jobIds[1]!, model: 'opus' });
    expect(firstFable.slotNames).toEqual(expect.arrayContaining(['fable-0']));
    expect(firstFable.slotNames.filter((name) => name.startsWith('claude-'))).toHaveLength(1);

    let secondFableResolved = false;
    const secondFablePromise = manager
      .acquire({ jobId: jobIds[2]!, model: 'claude-fable-latest' })
      .then((lease) => {
        secondFableResolved = true;
        return lease;
      });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    expect(secondFableResolved).toBe(false);

    await firstFable.release();
    const secondFable = await secondFablePromise;
    await Promise.all([opus.release(), secondFable.release()]);
  });

  test('recovers an old lease only after proving its owner is dead', async () => {
    const locksRoot = join(stateRoot, 'locks');
    const lockPath = join(locksRoot, 'claude-0');
    await ensurePrivateDirectory(locksRoot);
    await mkdir(lockPath, { mode: 0o700 });
    const stale: SlotOwner = {
      schemaVersion: 1,
      pid: 999_999_999,
      jobId: jobIds[0]!,
      processStartMarker: 'dead-process',
      acquiredAt: '2020-01-01T00:00:00.000Z',
      heartbeatAt: '2020-01-01T00:00:00.000Z',
    };
    await atomicWriteJson(join(lockPath, 'owner.json'), stale);

    const manager = new ConcurrencyManager({
      stateRoot,
      maxConcurrentClaudeJobs: 1,
      maxConcurrentFableJobs: 1,
      staleHeartbeatMs: 10,
      pollIntervalMs: 5,
    });
    const lease = await manager.acquire({ jobId: jobIds[1]!, model: 'sonnet' });

    expect(lease.slotNames).toEqual(['claude-0']);
    await lease.release();
  });

  test('recovers a stale ownerless lock left by a crash during acquisition', async () => {
    const locksRoot = join(stateRoot, 'locks');
    const lockPath = join(locksRoot, 'claude-0');
    await ensurePrivateDirectory(locksRoot);
    await mkdir(lockPath, { mode: 0o700 });
    const controller = new AbortController();
    const manager = new ConcurrencyManager({
      stateRoot,
      maxConcurrentClaudeJobs: 1,
      maxConcurrentFableJobs: 1,
      staleHeartbeatMs: 10,
      pollIntervalMs: 5,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });
    setTimeout(() => controller.abort(), 2_000);

    const lease = await manager.acquire({
      jobId: jobIds[1]!,
      model: 'sonnet',
      signal: controller.signal,
    });

    expect(lease.slotNames).toEqual(['claude-0']);
    await lease.release();
  });

  test('recovers a stale recovery guard left by a crashed contender', async () => {
    const locksRoot = join(stateRoot, 'locks');
    const recoveryPath = join(locksRoot, 'claude-0.recovery');
    await ensurePrivateDirectory(locksRoot);
    await mkdir(recoveryPath, { mode: 0o700 });
    await atomicWriteJson(join(recoveryPath, 'owner.json'), {
      schemaVersion: 1,
      pid: 999_999_999,
      processStartMarker: 'dead-process',
      acquiredAt: '2020-01-01T00:00:00.000Z',
      token: '44444444-4444-4444-8444-444444444444',
    });
    const manager = new ConcurrencyManager({
      stateRoot,
      maxConcurrentClaudeJobs: 1,
      maxConcurrentFableJobs: 1,
      staleHeartbeatMs: 10,
      pollIntervalMs: 5,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });

    const lease = await manager.acquire({ jobId: jobIds[1]!, model: 'sonnet' });

    expect(lease.slotNames).toEqual(['claude-0']);
    await lease.release();
  });

  test('does not steal a stale-looking recovery guard from a live owner', async () => {
    const locksRoot = join(stateRoot, 'locks');
    const recoveryPath = join(locksRoot, 'claude-0.recovery');
    await ensurePrivateDirectory(locksRoot);
    await mkdir(recoveryPath, { mode: 0o700 });
    await atomicWriteJson(join(recoveryPath, 'owner.json'), {
      schemaVersion: 1,
      pid: 4242,
      processStartMarker: 'live-recovery-owner',
      acquiredAt: '2020-01-01T00:00:00.000Z',
      token: '44444444-4444-4444-8444-444444444444',
    });
    const controller = new AbortController();
    const manager = new ConcurrencyManager({
      stateRoot,
      maxConcurrentClaudeJobs: 1,
      maxConcurrentFableJobs: 1,
      staleHeartbeatMs: 10,
      pollIntervalMs: 5,
      isProcessAlive: (_pid, marker) => Promise.resolve(marker === 'live-recovery-owner'),
      processStartMarker: () => Promise.resolve('contender-owner'),
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });
    setTimeout(() => controller.abort(), 30);

    await expect(
      manager.acquire({ jobId: jobIds[1]!, model: 'sonnet', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'SLOT_ACQUIRE_ABORTED' });
  });

  test('does not recover a stale heartbeat while the matching PID remains alive', async () => {
    const locksRoot = join(stateRoot, 'locks');
    const lockPath = join(locksRoot, 'claude-0');
    await ensurePrivateDirectory(locksRoot);
    await mkdir(lockPath, { mode: 0o700 });
    const live: SlotOwner = {
      schemaVersion: 1,
      pid: process.pid,
      jobId: jobIds[0]!,
      processStartMarker: await readProcessStartMarker(process.pid),
      acquiredAt: '2020-01-01T00:00:00.000Z',
      heartbeatAt: '2020-01-01T00:00:00.000Z',
    };
    await atomicWriteJson(join(lockPath, 'owner.json'), live);
    const controller = new AbortController();
    const manager = new ConcurrencyManager({
      stateRoot,
      maxConcurrentClaudeJobs: 1,
      maxConcurrentFableJobs: 1,
      staleHeartbeatMs: 10,
      pollIntervalMs: 5,
    });
    setTimeout(() => controller.abort(), 30);

    await expect(
      manager.acquire({ jobId: jobIds[1]!, model: 'sonnet', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'SLOT_ACQUIRE_ABORTED' });
  });

  test('stops a durable cancelled job while it is waiting for a slot', async () => {
    const manager = new ConcurrencyManager({
      stateRoot,
      maxConcurrentClaudeJobs: 1,
      maxConcurrentFableJobs: 1,
      staleHeartbeatMs: 500,
      pollIntervalMs: 5,
    });
    const first = await manager.acquire({ jobId: jobIds[0]!, model: 'sonnet' });
    let cancelled = false;
    const waiting = manager.acquire({
      jobId: jobIds[1]!,
      model: 'opus',
      isCancelled: () => Promise.resolve(cancelled),
    });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
    cancelled = true;

    await expect(waiting).rejects.toMatchObject({ code: 'SLOT_ACQUIRE_CANCELLED' });
    await first.release();
  });

  test('writes private owner records, supports heartbeat, and makes release idempotent', async () => {
    const manager = new ConcurrencyManager({
      stateRoot,
      maxConcurrentClaudeJobs: 1,
      maxConcurrentFableJobs: 1,
      staleHeartbeatMs: 500,
      pollIntervalMs: 5,
    });
    const lease = await manager.acquire({ jobId: jobIds[0]!, model: 'sonnet' });
    const lockPath = join(stateRoot, 'locks', lease.slotNames[0]!);

    expect((await stat(lockPath)).mode & 0o777).toBe(0o700);
    expect((await stat(join(lockPath, 'owner.json'))).mode & 0o777).toBe(0o600);
    await lease.heartbeat();
    await lease.release();
    await expect(lease.release()).resolves.toBeUndefined();
  });

  test('recovers a stale slot when its PID was reused by a different process identity', async () => {
    const locksRoot = join(stateRoot, 'locks');
    const lockPath = join(locksRoot, 'claude-0');
    await ensurePrivateDirectory(locksRoot);
    await mkdir(lockPath, { mode: 0o700 });
    await atomicWriteJson(join(lockPath, 'owner.json'), {
      schemaVersion: 1,
      pid: 4242,
      jobId: jobIds[0],
      processStartMarker: 'old-process-instance',
      acquiredAt: '2020-01-01T00:00:00.000Z',
      heartbeatAt: '2020-01-01T00:00:00.000Z',
    });
    const manager = new ConcurrencyManager({
      stateRoot,
      maxConcurrentClaudeJobs: 1,
      maxConcurrentFableJobs: 1,
      staleHeartbeatMs: 10,
      pollIntervalMs: 5,
      isProcessAlive: (_pid, marker) => Promise.resolve(marker === 'current-process-instance'),
      processStartMarker: () => Promise.resolve('current-process-instance'),
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });

    const lease = await manager.acquire({ jobId: jobIds[1]!, model: 'sonnet' });

    expect(lease.slotNames).toEqual(['claude-0']);
    await lease.release();
  });
});
