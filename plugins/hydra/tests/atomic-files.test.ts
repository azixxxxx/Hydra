import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';

import {
  appendJsonLine,
  atomicCreateJson,
  atomicWriteJson,
  ensurePrivateDirectory,
  readJsonFile,
  resolveManagedPath,
} from '../src/platform/atomic-files.js';

describe('secure state files', () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'hydra-atomic-test-'));
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  test('creates private directories with mode 0700', async () => {
    const directory = join(testRoot, 'state', 'jobs');

    await ensurePrivateDirectory(directory);

    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
  });

  test('writes state files with mode 0600', async () => {
    const path = join(testRoot, 'state', 'meta.json');

    await atomicWriteJson(path, { status: 'queued' });

    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  test('replaces shorter JSON without leaving bytes from the old value', async () => {
    const path = join(testRoot, 'state', 'meta.json');
    await atomicWriteJson(path, { status: 'running', padding: 'x'.repeat(1_000) });

    await atomicWriteJson(path, { status: 'completed' });

    expect(await readFile(path, 'utf8')).toBe('{"status":"completed"}\n');
  });

  test('leaves a complete value after concurrent atomic replacements', async () => {
    const path = join(testRoot, 'state', 'meta.json');
    const values = Array.from({ length: 20 }, (_, index) => ({ index, marker: `value-${index}` }));

    await Promise.all(values.map(async (value) => atomicWriteJson(path, value)));

    const stored = JSON.parse(await readFile(path, 'utf8')) as unknown;
    expect(values).toContainEqual(stored);
  });

  test('atomically creates an immutable complete JSON file', async () => {
    const path = join(testRoot, 'state', 'result.json');

    await atomicCreateJson(path, { status: 'completed', marker: 'first' });

    await expect(
      atomicCreateJson(path, { status: 'failed', marker: 'second' }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe(
      '{"status":"completed","marker":"first"}\n',
    );
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  test('validates JSON reads with the caller schema', async () => {
    const path = join(testRoot, 'state', 'meta.json');
    await atomicWriteJson(path, { status: 'unknown' });
    const schema = z.object({ status: z.literal('queued') }).strict();

    await expect(readJsonFile(path, schema)).rejects.toThrowError(/status/i);
  });

  test('serializes concurrent JSONL appends without corrupting lines', async () => {
    const path = join(testRoot, 'state', 'events.jsonl');
    const values = Array.from({ length: 100 }, (_, index) => ({ index }));

    await Promise.all(values.map(async (value) => appendJsonLine(path, value)));

    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
    const indexes = lines.map((line) => (JSON.parse(line) as { index: number }).index).sort((a, b) => a - b);
    expect(indexes).toEqual(values.map(({ index }) => index));
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  test.each(['..', '.', '', '../escape', 'nested/name', 'nested\\name', 'nul\0name'])(
    'rejects unsafe managed segment %j',
    (segment) => {
      expect(() => resolveManagedPath(testRoot, segment)).toThrowError(/managed path|segment/i);
    },
  );

  test('rejects a symlink that could escape the managed root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'hydra-atomic-outside-'));
    const link = join(testRoot, 'link');
    await symlink(outside, link);

    try {
      expect(() => resolveManagedPath(testRoot, 'link', 'meta.json')).toThrowError(/symbolic link/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('does not overwrite a symlink target with an atomic state write', async () => {
    const outside = join(testRoot, 'outside.json');
    const link = join(testRoot, 'state', 'meta.json');
    await ensurePrivateDirectory(join(testRoot, 'state'));
    await writeFile(outside, 'original', { mode: 0o600 });
    await symlink(outside, link);

    await expect(atomicWriteJson(link, { status: 'queued' })).rejects.toThrowError(/symbolic link/i);
    expect(await readFile(outside, 'utf8')).toBe('original');
  });
});
