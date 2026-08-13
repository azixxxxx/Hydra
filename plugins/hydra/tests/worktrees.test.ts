import { chmod, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { JobId, JobMeta, StartJobInput } from '../src/domain.js';
import {
  WorktreeManager,
  collectWorktreeResult,
  compareSnapshots,
  snapshotRepository,
} from '../src/worktrees.js';
import { createRepository, createUnbornRepository, runGit } from './helpers/repo.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const jobIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
] as const;

function meta(
  cwd: string,
  accessMode: StartJobInput['accessMode'],
  jobId: string = jobIds[0],
): JobMeta {
  const input: StartJobInput = {
    task: 'Inspect the repository',
    cwd,
    model: 'sonnet',
    effort: 'high',
    role: 'reviewer',
    accessMode,
    maxTurns: 12,
    timeoutSec: 1800,
    strictModel: false,
  };
  return {
    schemaVersion: 1,
    jobId: jobId as JobId,
    status: 'queued',
    input,
    requestedModel: input.model,
    requestedEffort: input.effort,
    createdAt: '2026-08-12T12:00:00.000Z',
    updatedAt: '2026-08-12T12:00:00.000Z',
    warnings: [],
    usageFeatures: {
      promptBytes: 22,
      roleBytes: 8,
      schemaBytes: 0,
      referencedBytes: 0,
      expectedTurns: input.maxTurns,
      toolClass: accessMode,
    },
  };
}

describe('repository snapshots and worktree isolation', () => {
  let root: string;
  let repository: string;
  let stateRoot: string;

  beforeEach(async () => {
    root = await createTemporaryDirectory('hydra-worktrees-');
    repository = join(root, 'repository');
    stateRoot = join(root, 'state');
    await createRepository(repository);
  });

  afterEach(async () => {
    await removeTemporaryDirectory(root);
  });

  test('fingerprints tracked, staged, unstaged, untracked, ignored, executable, and symlink state', async () => {
    const before = await snapshotRepository(repository);
    await writeFile(join(repository, 'tracked.txt'), 'unstaged change\n', 'utf8');
    await writeFile(join(repository, 'staged.txt'), 'staged change\n', 'utf8');
    await runGit(repository, ['add', 'staged.txt']);
    await writeFile(join(repository, 'untracked.txt'), 'untracked\n', 'utf8');
    await writeFile(join(repository, 'ignored.txt'), 'ignored\n', 'utf8');
    await chmod(join(repository, 'executable.sh'), 0o644);
    const after = await snapshotRepository(repository);
    const difference = compareSnapshots(before, after);

    expect(before.repositoryRoot).toBe(await realpath(repository));
    expect(before.fingerprint).not.toBe(after.fingerprint);
    expect(after.stagedPatch).toContain('staged change');
    expect(after.unstagedPatch).toContain('unstaged change');
    expect(after.untrackedFiles).toContain('untracked.txt');
    expect(after.ignoredFiles).toContain('ignored.txt');
    expect(after.trackedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'executable.sh', mode: '100644' }),
        expect.objectContaining({ path: 'tracked-link', mode: '120000' }),
      ]),
    );
    expect(difference).toMatchObject({
      changed: true,
      stagedChanged: true,
      unstagedChanged: true,
      untrackedChanged: true,
      ignoredChanged: true,
      trackedEntriesChanged: true,
    });
  });

  test('detects byte changes to a pre-existing untracked file', async () => {
    const untrackedPath = join(repository, 'untracked.txt');
    await writeFile(untrackedPath, 'before\n', 'utf8');
    const before = await snapshotRepository(repository);
    await writeFile(untrackedPath, 'after\n', 'utf8');
    const after = await snapshotRepository(repository);

    expect(before.untrackedFiles).toEqual(['untracked.txt']);
    expect(after.untrackedFiles).toEqual(['untracked.txt']);
    expect(compareSnapshots(before, after)).toMatchObject({
      changed: true,
      untrackedChanged: true,
    });
  });

  test('detects byte changes to a pre-existing ignored file', async () => {
    const ignoredPath = join(repository, 'ignored.txt');
    await writeFile(ignoredPath, 'before\n', 'utf8');
    const before = await snapshotRepository(repository);
    await writeFile(ignoredPath, 'after\n', 'utf8');
    const after = await snapshotRepository(repository);

    expect(before.ignoredFiles).toEqual(['ignored.txt']);
    expect(after.ignoredFiles).toEqual(['ignored.txt']);
    expect(compareSnapshots(before, after)).toMatchObject({
      changed: true,
      ignoredChanged: true,
    });
  });

  test('prepares analyze mode in place with read-only settings and before evidence', async () => {
    const manager = new WorktreeManager({ stateRoot });
    const prepared = await manager.prepare(meta(repository, 'analyze'));
    const settings = JSON.parse(await readFile(prepared.settingsPath, 'utf8')) as {
      autoMemoryEnabled: boolean;
      permissions: { allow: string[]; deny: string[]; additionalDirectories: string[] };
    };

    expect(prepared.cwd).toBe(await realpath(repository));
    expect(prepared.worktreePath).toBeUndefined();
    expect(prepared.beforeSnapshot?.fingerprint).toBeTruthy();
    expect(settings.autoMemoryEnabled).toBe(false);
    const canonicalRepository = await realpath(repository);
    expect(settings.permissions.allow).toEqual([
      `Read(/${canonicalRepository}/**)`,
      `Glob(/${canonicalRepository}/**)`,
      `Grep(/${canonicalRepository}/**)`,
    ]);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash',
        'Edit',
        'Write',
        'WebFetch',
        'WebSearch',
      ]),
    );
    expect(settings.permissions.additionalDirectories).toEqual([
      canonicalRepository,
      prepared.tempPath,
    ]);
    expect((await stat(prepared.settingsPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(prepared.emptyMcpPath, 'utf8'))).toEqual({ mcpServers: {} });
  });

  test.each(['test', 'execute'] as const)(
    'creates a unique detached %s worktree with fail-closed sandbox settings',
    async (accessMode) => {
      const manager = new WorktreeManager({ stateRoot });
      const first = await manager.prepare(meta(repository, accessMode, jobIds[0]));
      const second = await manager.prepare(meta(repository, accessMode, jobIds[1]));
      const settings = JSON.parse(await readFile(first.settingsPath, 'utf8')) as {
        autoMemoryEnabled: boolean;
        sandbox: {
          enabled: boolean;
          failIfUnavailable: boolean;
          filesystem: { denyRead: string[]; allowRead: string[] };
          network: { allowedDomains: string[]; allowLocalBinding: boolean; strictAllowlist: boolean };
        };
        permissions: { allow: string[]; additionalDirectories: string[] };
      };

      expect(first.worktreePath).toBe(first.cwd);
      expect(first.cwd).not.toBe(second.cwd);
      expect(
        relative(await realpath(join(stateRoot, 'worktrees')), first.cwd).startsWith(`..${sep}`),
      ).toBe(false);
      expect(await runGit(first.cwd, ['rev-parse', 'HEAD'])).toBe(await runGit(repository, ['rev-parse', 'HEAD']));
      expect(await runGit(first.cwd, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).toBe('');
      expect(settings.sandbox).toMatchObject({
        enabled: true,
        failIfUnavailable: true,
        filesystem: {
          denyRead: ['/'],
          allowRead: [first.worktreePath, first.tempPath],
        },
        network: { allowedDomains: [], allowLocalBinding: false, strictAllowlist: true },
      });
      expect(settings.autoMemoryEnabled).toBe(false);
      expect(settings.permissions.additionalDirectories).toEqual([first.cwd, first.tempPath]);
      if (accessMode === 'test') {
        expect(settings.permissions.allow).not.toContain('Edit');
        expect(settings.permissions.allow).not.toContain('Write');
      } else {
        expect(settings.permissions.allow).toEqual(
          expect.arrayContaining([
            'Bash',
            `Edit(/${first.worktreePath}/**)`,
            `Write(/${first.worktreePath}/**)`,
            `Edit(/${first.tempPath}/**)`,
            `Write(/${first.tempPath}/**)`,
          ]),
        );
        expect(settings.permissions.allow).not.toEqual(expect.arrayContaining(['Edit', 'Write']));
      }
      expect((await lstat(first.cwd)).isSymbolicLink()).toBe(false);
    },
  );

  test('preserves nested cwd semantics and resumes the same isolated worktree lineage', async () => {
    await mkdir(join(repository, 'packages', 'pkg'), { recursive: true });
    await writeFile(join(repository, 'packages', 'pkg', 'package.txt'), 'package\n', 'utf8');
    await runGit(repository, ['add', 'packages/pkg/package.txt']);
    await runGit(repository, ['commit', '-m', 'add package']);
    const manager = new WorktreeManager({ stateRoot });
    const nested = join(repository, 'packages', 'pkg');
    const first = await manager.prepare(meta(nested, 'execute', jobIds[0]));
    await writeFile(join(first.cwd, 'continued.txt'), 'first turn\n', 'utf8');
    expect(first.worktreePath).toBeDefined();
    const continuation = {
      ...meta(nested, 'execute', jobIds[1]),
      resumeWorktreePath: first.worktreePath!,
    };
    const second = await manager.prepare(continuation);

    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.cwd).toBe(join(first.worktreePath!, 'packages', 'pkg'));
    expect(await readFile(join(second.cwd, 'continued.txt'), 'utf8')).toBe('first turn\n');
  });

  test('rejects repository paths that cannot be represented as literal permission rules', async () => {
    const unsafeRepository = join(root, 'repository-with-[glob]');
    await createRepository(unsafeRepository);
    const manager = new WorktreeManager({ stateRoot });

    await expect(manager.prepare(meta(unsafeRepository, 'analyze'))).rejects.toMatchObject({
      code: 'UNSAFE_PERMISSION_PATH',
    });
  });

  test('fails closed when ignored or untracked snapshot bounds are exceeded', async () => {
    await writeFile(join(repository, 'untracked.bin'), '12345', 'utf8');

    await expect(
      snapshotRepository(repository, { maxLooseFiles: 0 }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_SNAPSHOT_LIMIT' });
    await expect(
      snapshotRepository(repository, { maxLooseBytes: 4 }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_SNAPSHOT_LIMIT' });
  });

  test('disables checkout hooks, filters, and text converters in Hydra Git operations', async () => {
    const sentinel = join(root, 'hook-ran');
    const hook = join(repository, '.git', 'hooks', 'post-checkout');
    await writeFile(hook, `#!/bin/sh\ntouch "${sentinel}"\n`, 'utf8');
    await chmod(hook, 0o755);
    await runGit(repository, ['config', 'diff.hostile.textconv', `touch ${sentinel}`]);
    await writeFile(join(repository, '.gitattributes'), '*.txt diff=hostile\n', 'utf8');
    await runGit(repository, ['add', '.gitattributes']);
    await runGit(repository, ['commit', '-m', 'hostile local config fixture']);

    const manager = new WorktreeManager({ stateRoot });
    const prepared = await manager.prepare(meta(repository, 'execute'));
    await writeFile(join(prepared.cwd, 'tracked.txt'), 'changed safely\n', 'utf8');
    await collectWorktreeResult(prepared.cwd);

    await expect(stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('collects deterministic changed-file evidence without modifying the main checkout', async () => {
    const manager = new WorktreeManager({ stateRoot });
    const beforeMain = await snapshotRepository(repository);
    const prepared = await manager.prepare(meta(repository, 'execute'));
    await writeFile(join(prepared.cwd, 'tracked.txt'), 'worktree change\n', 'utf8');
    await writeFile(join(prepared.cwd, 'new.txt'), 'new file\n', 'utf8');
    const evidence = await collectWorktreeResult(prepared.cwd, beforeMain);
    const afterMain = await snapshotRepository(repository);

    expect(evidence.changedFiles).toEqual(['new.txt', 'tracked.txt']);
    expect(evidence.patch).toContain('worktree change');
    expect(evidence.patch).toContain('new.txt');
    expect(evidence.patch).toContain('new file');
    expect(evidence.mainCheckoutChanged).toBe(false);
    expect(afterMain.fingerprint).toBe(beforeMain.fingerprint);
  });

  test('rejects non-repositories and state-root symlinks', async () => {
    const plain = join(root, 'plain');
    await mkdir(plain);
    const manager = new WorktreeManager({ stateRoot });
    await expect(manager.prepare(meta(plain, 'analyze'))).rejects.toMatchObject({
      code: 'GIT_REPOSITORY_REQUIRED',
    });
  });

  test('supports analyze in an unborn repository and rejects worktree modes clearly', async () => {
    const unborn = join(root, 'unborn');
    await createUnbornRepository(unborn);
    const manager = new WorktreeManager({ stateRoot });

    const prepared = await manager.prepare(meta(unborn, 'analyze'));
    expect(prepared.sourceHeadSha).toBe('UNBORN');
    expect(prepared.beforeSnapshot?.headSha).toBe('UNBORN');
    await expect(
      collectWorktreeResult(unborn, prepared.beforeSnapshot),
    ).resolves.toMatchObject({ mainCheckoutChanged: false });

    await expect(manager.prepare(meta(unborn, 'test', jobIds[1]))).rejects.toMatchObject({
      code: 'GIT_COMMIT_REQUIRED',
    });
  });
});
