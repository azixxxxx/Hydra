import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { HydraError, assertJobId } from './domain.js';
import {
  atomicCreateJson,
  atomicWriteJson,
  ensurePrivateDirectory,
  resolveManagedPath,
} from './platform/atomic-files.js';
import {
  processIdentityAlive,
  readProcessStartMarker,
} from './platform/process-identity.js';

export { readProcessStartMarker } from './platform/process-identity.js';

export interface SlotOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly jobId: string;
  readonly processStartMarker: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}

const SlotOwnerSchema: z.ZodType<SlotOwner> = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  jobId: z.string().uuid(),
  processStartMarker: z.string().min(1),
  acquiredAt: z.iso.datetime(),
  heartbeatAt: z.iso.datetime(),
});

interface RecoveryOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly processStartMarker: string;
  readonly acquiredAt: string;
  readonly token?: string;
}

const RecoveryOwnerSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  processStartMarker: z.string().min(1),
  acquiredAt: z.iso.datetime(),
  token: z.string().uuid().optional(),
}).transform((value) => ({
  schemaVersion: value.schemaVersion,
  pid: value.pid,
  processStartMarker: value.processStartMarker,
  acquiredAt: value.acquiredAt,
  ...(value.token === undefined ? {} : { token: value.token }),
}) satisfies RecoveryOwner);

export interface AcquireSlotInput {
  readonly jobId: string;
  readonly model: string;
  readonly signal?: AbortSignal;
  readonly isCancelled?: () => Promise<boolean>;
}

export interface ConcurrencyManagerDependencies {
  readonly stateRoot: string;
  readonly maxConcurrentClaudeJobs: number;
  readonly maxConcurrentFableJobs: number;
  readonly staleHeartbeatMs: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly processStartMarker?: () => Promise<string>;
  readonly isProcessAlive?: (pid: number, expectedMarker: string) => Promise<boolean>;
}


async function abortAwareDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    throw new HydraError('SLOT_ACQUIRE_ABORTED', 'Concurrency slot acquisition was aborted');
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      rejectPromise(
        new HydraError('SLOT_ACQUIRE_ABORTED', 'Concurrency slot acquisition was aborted'),
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readOwner(path: string): Promise<SlotOwner | undefined> {
  try {
    return SlotOwnerSchema.parse(JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function readRecoveryOwner(path: string): Promise<RecoveryOwner | undefined> {
  try {
    return RecoveryOwnerSchema.parse(
      JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as unknown,
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      error instanceof z.ZodError ||
      error instanceof SyntaxError
    ) {
      return undefined;
    }
    throw error;
  }
}

function sameRecoveryOwner(
  left: RecoveryOwner | undefined,
  right: RecoveryOwner | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.pid === right.pid &&
    left.processStartMarker === right.processStartMarker &&
    left.acquiredAt === right.acquiredAt &&
    left.token === right.token
  );
}

export class SlotLease {
  readonly #locksRoot: string;
  readonly #owner: SlotOwner;
  readonly #now: () => Date;
  #released = false;

  public readonly slotNames: readonly string[];

  public constructor(
    locksRoot: string,
    slotNames: readonly string[],
    owner: SlotOwner,
    now: () => Date,
  ) {
    this.#locksRoot = locksRoot;
    this.slotNames = [...slotNames];
    this.#owner = owner;
    this.#now = now;
  }

  public async heartbeat(): Promise<void> {
    if (this.#released) {
      throw new HydraError('SLOT_LEASE_RELEASED', 'Cannot heartbeat a released slot lease');
    }
    const updated: SlotOwner = { ...this.#owner, heartbeatAt: this.#now().toISOString() };
    for (const name of this.slotNames) {
      const path = resolveManagedPath(this.#locksRoot, name);
      const existing = await readOwner(path);
      if (!this.#owns(existing)) {
        throw new HydraError('SLOT_OWNERSHIP_LOST', `Hydra lost ownership of ${name}`);
      }
      await atomicWriteJson(join(path, 'owner.json'), updated);
    }
  }

  public async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    this.#released = true;
    for (const name of [...this.slotNames].reverse()) {
      const path = resolveManagedPath(this.#locksRoot, name);
      const existing = await readOwner(path);
      if (this.#owns(existing)) {
        await rm(path, { recursive: true, force: false });
      }
    }
  }

  #owns(owner: SlotOwner | undefined): boolean {
    return (
      owner !== undefined &&
      owner.pid === this.#owner.pid &&
      owner.jobId === this.#owner.jobId &&
      owner.processStartMarker === this.#owner.processStartMarker
    );
  }
}

export class ConcurrencyManager {
  readonly #locksRoot: string;
  readonly #claudeSlots: readonly string[];
  readonly #fableSlots: readonly string[];
  readonly #staleHeartbeatMs: number;
  readonly #pollIntervalMs: number;
  readonly #now: () => Date;
  readonly #pid: number;
  readonly #startMarker: () => Promise<string>;
  readonly #isProcessAlive: (pid: number, expectedMarker: string) => Promise<boolean>;

  public constructor(dependencies: ConcurrencyManagerDependencies) {
    if (
      !Number.isSafeInteger(dependencies.maxConcurrentClaudeJobs) ||
      dependencies.maxConcurrentClaudeJobs < 1 ||
      !Number.isSafeInteger(dependencies.maxConcurrentFableJobs) ||
      dependencies.maxConcurrentFableJobs < 1 ||
      dependencies.maxConcurrentFableJobs > dependencies.maxConcurrentClaudeJobs
    ) {
      throw new HydraError('INVALID_CONCURRENCY_CONFIG', 'Hydra concurrency limits are invalid');
    }
    this.#locksRoot = join(dependencies.stateRoot, 'locks');
    this.#claudeSlots = Array.from(
      { length: dependencies.maxConcurrentClaudeJobs },
      (_, index) => `claude-${index}`,
    );
    this.#fableSlots = Array.from(
      { length: dependencies.maxConcurrentFableJobs },
      (_, index) => `fable-${index}`,
    );
    this.#staleHeartbeatMs = dependencies.staleHeartbeatMs;
    this.#pollIntervalMs = dependencies.pollIntervalMs ?? 100;
    this.#now = dependencies.now ?? ((): Date => new Date());
    this.#pid = dependencies.pid ?? process.pid;
    this.#startMarker =
      dependencies.processStartMarker ?? ((): Promise<string> => readProcessStartMarker(this.#pid));
    this.#isProcessAlive = dependencies.isProcessAlive ?? processIdentityAlive;
  }

  public async acquire(input: AcquireSlotInput): Promise<SlotLease> {
    assertJobId(input.jobId);
    await ensurePrivateDirectory(this.#locksRoot);
    const processStartMarker = await this.#startMarker();
    const timestamp = this.#now().toISOString();
    const owner: SlotOwner = {
      schemaVersion: 1,
      pid: this.#pid,
      jobId: input.jobId,
      processStartMarker,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
    };
    const needsFable = input.model.toLowerCase().includes('fable');

    for (;;) {
      if (input.signal?.aborted === true) {
        throw new HydraError('SLOT_ACQUIRE_ABORTED', 'Concurrency slot acquisition was aborted');
      }
      if (await input.isCancelled?.()) {
        throw new HydraError('SLOT_ACQUIRE_CANCELLED', 'Cancelled job stopped waiting for a concurrency slot');
      }
      const claimed: string[] = [];
      const claude = await this.#tryClaimAny(this.#claudeSlots, owner);
      if (claude !== undefined) {
        claimed.push(claude);
        if (!needsFable) {
          return new SlotLease(this.#locksRoot, claimed, owner, this.#now);
        }
        const fable = await this.#tryClaimAny(this.#fableSlots, owner);
        if (fable !== undefined) {
          claimed.push(fable);
          return new SlotLease(this.#locksRoot, claimed, owner, this.#now);
        }
        await new SlotLease(this.#locksRoot, claimed, owner, this.#now).release();
      }
      const jitter = Math.floor(Math.random() * Math.max(1, this.#pollIntervalMs / 4));
      await abortAwareDelay(this.#pollIntervalMs + jitter, input.signal);
    }
  }

  async #tryClaimAny(names: readonly string[], owner: SlotOwner): Promise<string | undefined> {
    for (const name of names) {
      if (await this.#tryClaim(name, owner)) {
        return name;
      }
    }
    return undefined;
  }

  async #tryClaim(name: string, owner: SlotOwner): Promise<boolean> {
    const path = resolveManagedPath(this.#locksRoot, name);
    const recoveryPath = resolveManagedPath(this.#locksRoot, `${name}.recovery`);
    try {
      await lstat(recoveryPath);
      await this.#recoverRecoveryGuardIfStale(name, recoveryPath);
      try {
        await lstat(recoveryPath);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    try {
      await mkdir(path, { mode: 0o700 });
      try {
        try {
          await lstat(recoveryPath);
          await rm(path, { recursive: true, force: true });
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        await atomicWriteJson(join(path, 'owner.json'), owner);
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    await this.#recoverIfStale(name, path);
    return false;
  }

  async #recoverIfStale(name: string, path: string): Promise<void> {
    const recoveryPath = resolveManagedPath(this.#locksRoot, `${name}.recovery`);
    const recoveryToken = randomUUID();
    const recoveryOwner: RecoveryOwner = {
      schemaVersion: 1,
      pid: this.#pid,
      processStartMarker: await this.#startMarker(),
      acquiredAt: this.#now().toISOString(),
      token: recoveryToken,
    };
    try {
      await mkdir(recoveryPath, { mode: 0o700 });
      await atomicCreateJson(join(recoveryPath, 'owner.json'), recoveryOwner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return;
      }
      throw error;
    }

    if (!(await this.#ownsRecoveryGuard(recoveryPath, recoveryToken))) {
      return;
    }

    try {
      const owner = await readOwner(path);
      if (owner === undefined) {
        try {
          const details = await lstat(path);
          const age = this.#now().getTime() - details.mtimeMs;
          if (age > this.#staleHeartbeatMs) {
            await this.#quarantineStale(name, path);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
        return;
      }
      const age = this.#now().getTime() - new Date(owner.heartbeatAt).getTime();
      if (age <= this.#staleHeartbeatMs) {
        return;
      }
      if (await this.#isProcessAlive(owner.pid, owner.processStartMarker)) {
        return;
      }
      if (!(await this.#ownsRecoveryGuard(recoveryPath, recoveryToken))) {
        return;
      }
      await this.#quarantineStale(name, path);
    } finally {
      await this.#releaseRecoveryGuard(name, recoveryPath, recoveryToken);
    }
  }

  async #recoverRecoveryGuardIfStale(name: string, recoveryPath: string): Promise<void> {
    let details;
    try {
      details = await lstat(recoveryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    const observed = await readRecoveryOwner(recoveryPath);
    const acquiredAt = observed?.acquiredAt === undefined
      ? details.mtimeMs
      : new Date(observed.acquiredAt).getTime();
    if (this.#now().getTime() - acquiredAt <= this.#staleHeartbeatMs) {
      return;
    }
    if (
      observed !== undefined &&
      (await this.#isProcessAlive(observed.pid, observed.processStartMarker))
    ) {
      return;
    }
    const currentDetails = await lstat(recoveryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    const current = await readRecoveryOwner(recoveryPath);
    if (
      currentDetails === undefined ||
      currentDetails.dev !== details.dev ||
      currentDetails.ino !== details.ino ||
      !sameRecoveryOwner(observed, current)
    ) {
      return;
    }
    const quarantine = resolveManagedPath(
      this.#locksRoot,
      `${name}.recovery-stale-${randomUUID()}`,
    );
    try {
      await rename(recoveryPath, quarantine);
      const movedDetails = await lstat(quarantine);
      const moved = await readRecoveryOwner(quarantine);
      if (
        movedDetails.dev === details.dev &&
        movedDetails.ino === details.ino &&
        sameRecoveryOwner(observed, moved)
      ) {
        await rm(quarantine, { recursive: true, force: false });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async #ownsRecoveryGuard(path: string, token: string): Promise<boolean> {
    return (await readRecoveryOwner(path))?.token === token;
  }

  async #releaseRecoveryGuard(name: string, path: string, token: string): Promise<void> {
    if (!(await this.#ownsRecoveryGuard(path, token))) {
      return;
    }
    const quarantine = resolveManagedPath(
      this.#locksRoot,
      `${name}.recovery-release-${randomUUID()}`,
    );
    try {
      await rename(path, quarantine);
      if ((await readRecoveryOwner(quarantine))?.token === token) {
        await rm(quarantine, { recursive: true, force: false });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async #quarantineStale(name: string, path: string): Promise<void> {
    const quarantine = resolveManagedPath(this.#locksRoot, `${name}.stale-${randomUUID()}`);
    try {
      await rename(path, quarantine);
      await rm(quarantine, { recursive: true, force: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
