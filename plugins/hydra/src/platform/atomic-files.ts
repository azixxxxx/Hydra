import {
  constants,
  lstatSync,
  realpathSync,
} from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import type { ZodType } from 'zod';

import { HydraError } from '../domain.js';

const appendQueues = new Map<string, Promise<void>>();

function isWithinRoot(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference));
}

function assertManagedSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new HydraError('UNSAFE_MANAGED_PATH', `Invalid managed path segment: ${JSON.stringify(segment)}`);
  }
}

function canonicalExistingPath(path: string): string | undefined {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new HydraError('SYMLINK_NOT_ALLOWED', `Managed path contains a symbolic link: ${path}`);
    }
    try {
      return realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof HydraError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function assertDestinationIsNotSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new HydraError('SYMLINK_NOT_ALLOWED', `State file is a symbolic link: ${path}`);
    }
  } catch (error) {
    if (error instanceof HydraError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function serializeJsonLine(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new HydraError('NON_JSON_STATE', 'Hydra state must be JSON serializable');
  }
  return `${serialized}\n`;
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink()) {
      throw new HydraError('SYMLINK_NOT_ALLOWED', `State directory is a symbolic link: ${path}`);
    }
    if (!existing.isDirectory()) {
      throw new HydraError('STATE_PATH_NOT_DIRECTORY', `State directory path is not a directory: ${path}`);
    }
  } catch (error) {
    if (error instanceof HydraError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await chmod(path, 0o700);
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  await assertDestinationIsNotSymlink(path);
  const data = serializeJsonLine(value);
  const temporaryPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;

  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertDestinationIsNotSymlink(path);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch((unlinkError: unknown) => {
      if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw unlinkError;
      }
    });
    throw error;
  }
}

export async function atomicCreateJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  await assertDestinationIsNotSymlink(path);
  const data = serializeJsonLine(value);
  const temporaryPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;

  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, path);
    await unlink(temporaryPath);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch((unlinkError: unknown) => {
      if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw unlinkError;
      }
    });
    throw error;
  }
}

export async function readJsonFile<T>(path: string, schema: ZodType<T>): Promise<T> {
  const content = await readFile(path, 'utf8');
  return schema.parse(JSON.parse(content) as unknown);
}

async function appendJsonLineNow(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  await assertDestinationIsNotSymlink(path);
  const data = serializeJsonLine(value);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  const key = resolve(path);
  const previous = appendQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => appendJsonLineNow(key, value));
  appendQueues.set(key, current);
  try {
    await current;
  } finally {
    if (appendQueues.get(key) === current) {
      appendQueues.delete(key);
    }
  }
}

export function resolveManagedPath(root: string, ...segments: readonly string[]): string {
  if (!isAbsolute(root)) {
    throw new HydraError('UNSAFE_MANAGED_PATH', 'Managed path root must be absolute');
  }
  const canonicalRoot = canonicalExistingPath(root) ?? resolve(root);
  let candidate = canonicalRoot;

  for (const segment of segments) {
    assertManagedSegment(segment);
    candidate = join(candidate, segment);
    if (!isWithinRoot(canonicalRoot, candidate)) {
      throw new HydraError('UNSAFE_MANAGED_PATH', 'Managed path escapes its root');
    }
    const canonicalCandidate = canonicalExistingPath(candidate);
    if (canonicalCandidate !== undefined) {
      if (!isWithinRoot(canonicalRoot, canonicalCandidate)) {
        throw new HydraError('UNSAFE_MANAGED_PATH', 'Managed path resolves outside its root');
      }
      candidate = canonicalCandidate;
    }
  }

  return candidate;
}
