import { spawn } from 'node:child_process';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', [...args], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', rejectPromise);
    child.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolvePromise(Buffer.concat(stdout).toString('utf8').trim());
      } else {
        rejectPromise(new Error(Buffer.concat(stderr).toString('utf8')));
      }
    });
  });
}

export async function createRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await runGit(path, ['init', '-b', 'main']);
  await runGit(path, ['config', 'user.name', 'Hydra Tests']);
  await runGit(path, ['config', 'user.email', 'hydra@example.invalid']);
  await writeFile(join(path, '.gitignore'), 'ignored.txt\n', 'utf8');
  await writeFile(join(path, 'tracked.txt'), 'original\n', 'utf8');
  await writeFile(join(path, 'staged.txt'), 'original\n', 'utf8');
  await writeFile(join(path, 'executable.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(join(path, 'executable.sh'), 0o755);
  await symlink('tracked.txt', join(path, 'tracked-link'));
  await runGit(path, ['add', '.']);
  await runGit(path, ['commit', '-m', 'Initial fixture']);
}

export async function createUnbornRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await runGit(path, ['init', '-b', 'main']);
}
