import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createTemporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export function removeTemporaryDirectory(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true });
}
