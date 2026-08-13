import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  HydraError,
  assertJobId,
  type AccessMode,
  type JobMeta,
  type WorktreeEvidence,
} from './domain.js';
import { atomicWriteJson, ensurePrivateDirectory, resolveManagedPath } from './platform/atomic-files.js';
import { NodeProcessRunner, type ProcessRunner } from './platform/process.js';
import { sanitizeText } from './stream-json.js';

export interface TrackedEntry {
  readonly path: string;
  readonly mode: string;
  readonly objectId: string;
  readonly stage: number;
}

export interface LooseEntry {
  readonly path: string;
  readonly mode: string;
  readonly contentId: string;
  readonly size: number;
}

export interface RepositorySnapshot {
  readonly repositoryRoot: string;
  readonly headSha: string;
  readonly statusPorcelain: string;
  readonly stagedPatch: string;
  readonly unstagedPatch: string;
  readonly untrackedFiles: readonly string[];
  readonly untrackedEntries: readonly LooseEntry[];
  readonly ignoredFiles: readonly string[];
  readonly ignoredEntries: readonly LooseEntry[];
  readonly trackedEntries: readonly TrackedEntry[];
  readonly fingerprint: string;
}

export interface RepositoryDifference {
  readonly changed: boolean;
  readonly headChanged: boolean;
  readonly statusChanged: boolean;
  readonly stagedChanged: boolean;
  readonly unstagedChanged: boolean;
  readonly untrackedChanged: boolean;
  readonly ignoredChanged: boolean;
  readonly trackedEntriesChanged: boolean;
}

export interface PreparedAccessContext {
  readonly accessMode: AccessMode;
  readonly cwd: string;
  readonly repositoryRoot: string;
  readonly settingsPath: string;
  readonly emptyMcpPath: string;
  readonly tempPath: string;
  readonly beforeSnapshot?: RepositorySnapshot;
  readonly worktreePath?: string;
  readonly sourceHeadSha: string;
}

export interface WorktreeManagerDependencies {
  readonly stateRoot: string;
  readonly runner?: ProcessRunner;
  readonly gitPath?: string;
}

export const UNBORN_HEAD = 'UNBORN';
const MAX_PATCH_BYTES = 20_000_000;
const DEFAULT_MAX_LOOSE_FILES = 200_000;
const DEFAULT_MAX_LOOSE_BYTES = 2_000_000_000;
const SAFE_GIT_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
] as const;

function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
  };
}

function hardenedGitArgs(
  args: readonly string[],
  additionalConfig: readonly string[] = [],
): string[] {
  return [...SAFE_GIT_CONFIG, ...additionalConfig, ...args];
}

async function git(
  runner: ProcessRunner,
  gitPath: string,
  cwd: string,
  args: readonly string[],
  maxOutputBytes = 20_000_000,
  additionalConfig: readonly string[] = [],
): Promise<string> {
  const result = await runner.run(gitPath, hardenedGitArgs(args, additionalConfig), {
    cwd,
    env: safeGitEnvironment(),
    timeoutMs: 60_000,
    maxOutputBytes,
  });
  if (result.exitCode !== 0) {
    throw new HydraError('GIT_COMMAND_FAILED', `Git command failed: git ${args[0] ?? 'unknown'}`, {
      exitCode: result.exitCode,
    });
  }
  return result.stdout;
}

async function untrackedPatch(
  runner: ProcessRunner,
  gitPath: string,
  root: string,
  path: string,
  maxOutputBytes: number,
): Promise<string> {
  const result = await runner.run(
    gitPath,
    hardenedGitArgs([
      'diff',
      '--no-index',
      '--binary',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      '/dev/null',
      path,
    ]),
    { cwd: root, env: safeGitEnvironment(), timeoutMs: 60_000, maxOutputBytes },
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new HydraError('GIT_COMMAND_FAILED', 'Git could not render an untracked-file patch', {
      exitCode: result.exitCode,
    });
  }
  return result.stdout;
}

async function repositoryRoot(
  runner: ProcessRunner,
  gitPath: string,
  cwd: string,
): Promise<string> {
  try {
    const output = (await git(runner, gitPath, cwd, ['rev-parse', '--show-toplevel'])).trim();
    if (output.length === 0) {
      throw new HydraError('GIT_REPOSITORY_REQUIRED', 'A Git repository is required');
    }
    return await realpath(output);
  } catch (error) {
    if (error instanceof HydraError && error.code === 'GIT_REPOSITORY_REQUIRED') {
      throw error;
    }
    throw new HydraError('GIT_REPOSITORY_REQUIRED', 'A Git repository is required');
  }
}

async function repositoryHead(
  runner: ProcessRunner,
  gitPath: string,
  root: string,
): Promise<string> {
  const result = await runner.run(gitPath, hardenedGitArgs(['rev-parse', '--verify', 'HEAD']), {
    cwd: root,
    env: safeGitEnvironment(),
    timeoutMs: 60_000,
    maxOutputBytes: 1_000_000,
  });
  if (result.exitCode === 0 && result.stdout.trim().length > 0) {
    return result.stdout.trim();
  }
  const status = await runner.run(gitPath, hardenedGitArgs(['status', '--porcelain=v1']), {
    cwd: root,
    env: safeGitEnvironment(),
    timeoutMs: 60_000,
    maxOutputBytes: 1_000_000,
  });
  if (status.exitCode === 0) {
    return UNBORN_HEAD;
  }
  throw new HydraError('GIT_COMMAND_FAILED', 'Git could not resolve repository HEAD');
}

function nulFields(value: string): string[] {
  return value.split('\0').filter((field) => field.length > 0);
}

function parseUntracked(status: string): string[] {
  const fields = nulFields(status);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code === '??') {
      paths.push(path);
    }
    if (code.includes('R') || code.includes('C')) {
      index += 1;
    }
  }
  return paths.sort();
}

async function parseTrackedEntries(root: string, value: string): Promise<TrackedEntry[]> {
  const entries = nulFields(value)
    .map((field) => {
      const tab = field.indexOf('\t');
      const metadata = field.slice(0, tab).split(' ');
      return {
        mode: metadata[0] ?? 'unknown',
        objectId: metadata[1] ?? 'unknown',
        stage: Number(metadata[2] ?? 0),
        path: field.slice(tab + 1),
      };
    });
  const withFilesystemModes = await Promise.all(
    entries.map(async (entry) => {
      try {
        const details = await lstat(join(root, entry.path));
        const mode = details.isSymbolicLink()
          ? '120000'
          : details.isFile() && (details.mode & 0o111) !== 0
            ? '100755'
            : '100644';
        return { ...entry, mode };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return entry;
        }
        throw error;
      }
    }),
  );
  return withFilesystemModes.sort((left, right) => left.path.localeCompare(right.path));
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function looseEntry(root: string, path: string): Promise<LooseEntry> {
  const absolutePath = join(root, path);
  const details = await lstat(absolutePath);
  if (details.isSymbolicLink()) {
    const target = await readlink(absolutePath);
    return {
      path,
      mode: '120000',
      contentId: createHash('sha256').update(target).digest('hex'),
      size: Buffer.byteLength(target, 'utf8'),
    };
  }
  if (details.isFile()) {
    return {
      path,
      mode: (details.mode & 0o111) !== 0 ? '100755' : '100644',
      contentId: await fileDigest(absolutePath),
      size: details.size,
    };
  }
  return {
    path,
    mode: `special-${(details.mode & 0o170000).toString(8)}`,
    contentId: createHash('sha256').update(`${details.mode}:${details.size}`).digest('hex'),
    size: details.size,
  };
}

async function looseEntries(root: string, paths: readonly string[]): Promise<LooseEntry[]> {
  const entries = new Array<LooseEntry>(paths.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const path = paths[index];
      if (path === undefined) {
        return;
      }
      entries[index] = await looseEntry(root, path);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(16, paths.length) }, async () => worker()),
  );
  return entries;
}

async function assertLooseSnapshotBounds(
  root: string,
  paths: readonly string[],
  maxFiles: number,
  maxBytes: number,
): Promise<void> {
  if (paths.length > maxFiles) {
    throw new HydraError(
      'REPOSITORY_SNAPSHOT_LIMIT',
      `Repository snapshot exceeds the ${maxFiles} ignored/untracked file limit`,
    );
  }
  let totalBytes = 0;
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const path = paths[nextIndex];
      nextIndex += 1;
      if (path === undefined) {
        return;
      }
      const details = await lstat(join(root, path));
      totalBytes += details.size;
      if (totalBytes > maxBytes) {
        throw new HydraError(
          'REPOSITORY_SNAPSHOT_LIMIT',
          `Repository snapshot exceeds the ${maxBytes} byte ignored/untracked limit`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, paths.length) }, async () => worker()));
}

async function configuredFilterOverrides(
  runner: ProcessRunner,
  gitPath: string,
  root: string,
): Promise<string[]> {
  const result = await runner.run(
    gitPath,
    hardenedGitArgs(['config', '--local', '--name-only', '--get-regexp', '^filter\\.']),
    {
      cwd: root,
      env: safeGitEnvironment(),
      timeoutMs: 60_000,
      maxOutputBytes: 1_000_000,
    },
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new HydraError('GIT_COMMAND_FAILED', 'Git filter configuration inspection failed', {
      exitCode: result.exitCode,
    });
  }
  const drivers = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/u.exec(line.trim());
    if (match?.[1] !== undefined && /^[A-Za-z0-9._-]+$/u.test(match[1])) {
      drivers.add(match[1]);
    }
  }
  return [...drivers].sort().flatMap((driver) => [
    '-c',
    `filter.${driver}.clean=`,
    '-c',
    `filter.${driver}.smudge=`,
    '-c',
    `filter.${driver}.process=`,
    '-c',
    `filter.${driver}.required=false`,
  ]);
}

function fingerprint(snapshot: Omit<RepositorySnapshot, 'fingerprint'>): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export async function snapshotRepository(
  cwd: string,
  dependencies: {
    readonly runner?: ProcessRunner;
    readonly gitPath?: string;
    readonly maxLooseFiles?: number;
    readonly maxLooseBytes?: number;
  } = {},
): Promise<RepositorySnapshot> {
  const runner = dependencies.runner ?? new NodeProcessRunner();
  const gitPath = dependencies.gitPath ?? 'git';
  const root = await repositoryRoot(runner, gitPath, cwd);
  const [headSha, statusPorcelain, stagedPatch, unstagedPatch, trackedRaw, ignoredRaw] =
    await Promise.all([
      repositoryHead(runner, gitPath, root),
      git(runner, gitPath, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      git(runner, gitPath, root, [
        'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv',
      ]),
      git(runner, gitPath, root, [
        'diff', '--binary', '--no-ext-diff', '--no-textconv',
      ]),
      git(runner, gitPath, root, ['ls-files', '-z', '--stage']),
      git(runner, gitPath, root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard']),
    ]);
  const untrackedFiles = parseUntracked(statusPorcelain);
  const ignoredFiles = nulFields(ignoredRaw).sort();
  await assertLooseSnapshotBounds(
    root,
    [...untrackedFiles, ...ignoredFiles],
    dependencies.maxLooseFiles ?? DEFAULT_MAX_LOOSE_FILES,
    dependencies.maxLooseBytes ?? DEFAULT_MAX_LOOSE_BYTES,
  );
  const [trackedEntries, untrackedEntries, ignoredEntries] = await Promise.all([
    parseTrackedEntries(root, trackedRaw),
    looseEntries(root, untrackedFiles),
    looseEntries(root, ignoredFiles),
  ]);
  const withoutFingerprint = {
    repositoryRoot: root,
    headSha,
    statusPorcelain,
    stagedPatch,
    unstagedPatch,
    untrackedFiles,
    untrackedEntries,
    ignoredFiles,
    ignoredEntries,
    trackedEntries,
  };
  return { ...withoutFingerprint, fingerprint: fingerprint(withoutFingerprint) };
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function compareSnapshots(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
): RepositoryDifference {
  const difference = {
    headChanged: before.headSha !== after.headSha,
    statusChanged: before.statusPorcelain !== after.statusPorcelain,
    stagedChanged: before.stagedPatch !== after.stagedPatch,
    unstagedChanged: before.unstagedPatch !== after.unstagedPatch,
    untrackedChanged:
      !equalJson(before.untrackedFiles, after.untrackedFiles) ||
      !equalJson(before.untrackedEntries, after.untrackedEntries),
    ignoredChanged:
      !equalJson(before.ignoredFiles, after.ignoredFiles) ||
      !equalJson(before.ignoredEntries, after.ignoredEntries),
    trackedEntriesChanged: !equalJson(before.trackedEntries, after.trackedEntries),
  };
  return {
    changed: Object.values(difference).some(Boolean),
    ...difference,
  };
}

function accessSettings(
  accessMode: AccessMode,
  isolationRoot: string,
  tempPath: string,
): Record<string, unknown> {
  for (const path of [isolationRoot, tempPath]) {
    if (/[(){}[\]*?!\\\n\r]/u.test(path)) {
      throw new HydraError(
        'UNSAFE_PERMISSION_PATH',
        'Hydra cannot safely represent this path in a Claude permission rule',
      );
    }
  }
  const commonDeny = ['WebFetch', 'WebSearch'];
  const credentialReadDeny = [
    'Read(~/.ssh/**)',
    'Read(~/.aws/**)',
    'Read(~/.config/gcloud/**)',
    'Read(~/.claude/**)',
    'Read(~/.codex/**)',
    'Read(~/.hydra/**)',
  ];
  const permissionPath = (path: string): string => `//${path.replace(/^\/+/, '')}/**`;
  const scopedRead = [
    `Read(${permissionPath(isolationRoot)})`,
    `Glob(${permissionPath(isolationRoot)})`,
    `Grep(${permissionPath(isolationRoot)})`,
  ];
  const sandbox = {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: ['/'],
      allowRead: [isolationRoot, tempPath],
    },
    network: {
      allowedDomains: [],
      allowLocalBinding: false,
      strictAllowlist: true,
    },
  };
  if (accessMode === 'analyze') {
    return {
      autoMemoryEnabled: false,
      disableAllHooks: true,
      permissions: {
        allow: scopedRead,
        deny: [
          'Bash',
          'Edit',
          'Write',
          ...commonDeny,
          ...credentialReadDeny,
        ],
        additionalDirectories: [isolationRoot, tempPath],
      },
      sandbox,
      enableAllProjectMcpServers: false,
    };
  }
  const allow = accessMode === 'test'
    ? [...scopedRead, 'Bash']
    : [
        ...scopedRead,
        'Bash',
        `Edit(${permissionPath(isolationRoot)})`,
        `Write(${permissionPath(isolationRoot)})`,
        `Edit(${permissionPath(tempPath)})`,
        `Write(${permissionPath(tempPath)})`,
      ];
  return {
    autoMemoryEnabled: false,
    disableAllHooks: true,
    permissions: {
      allow,
      deny: [...commonDeny, ...credentialReadDeny],
      additionalDirectories: [isolationRoot, tempPath],
    },
    sandbox,
    enableAllProjectMcpServers: false,
  };
}

export class WorktreeManager {
  readonly #stateRoot: string;
  readonly #runner: ProcessRunner;
  readonly #gitPath: string;

  public constructor(dependencies: WorktreeManagerDependencies) {
    this.#stateRoot = dependencies.stateRoot;
    this.#runner = dependencies.runner ?? new NodeProcessRunner();
    this.#gitPath = dependencies.gitPath ?? 'git';
  }

  public async prepare(job: JobMeta): Promise<PreparedAccessContext> {
    assertJobId(job.jobId);
    const root = await repositoryRoot(this.#runner, this.#gitPath, job.input.cwd);
    const canonicalInputCwd = await realpath(job.input.cwd);
    const inputSubpath = relative(root, canonicalInputCwd);
    if (
      inputSubpath === '..' ||
      inputSubpath.startsWith(`..${sep}`) ||
      isAbsolute(inputSubpath)
    ) {
      throw new HydraError('CWD_OUTSIDE_REPOSITORY', 'Hydra cwd must be inside its Git repository');
    }
    const jobsRoot = join(this.#stateRoot, 'jobs');
    await ensurePrivateDirectory(jobsRoot);
    const jobRoot = resolveManagedPath(jobsRoot, job.jobId);
    await ensurePrivateDirectory(jobRoot);
    const tempPath = resolveManagedPath(jobRoot, 'tmp');
    await ensurePrivateDirectory(tempPath);
    const settingsPath = resolveManagedPath(jobRoot, 'claude-settings.json');
    const emptyMcpPath = resolveManagedPath(jobRoot, 'empty-mcp.json');
    let cwd: string;
    let worktreePath: string | undefined;
    const beforeSnapshot = await snapshotRepository(root, {
      runner: this.#runner,
      gitPath: this.#gitPath,
    });
    const sourceHeadSha = beforeSnapshot.headSha;

    if (job.input.accessMode === 'analyze') {
      cwd = canonicalInputCwd;
    } else {
      if (sourceHeadSha === UNBORN_HEAD) {
        throw new HydraError(
          'GIT_COMMIT_REQUIRED',
          'Test and execute modes require a repository with at least one commit',
        );
      }
      const worktreesRoot = join(this.#stateRoot, 'worktrees');
      await ensurePrivateDirectory(worktreesRoot);
      const repositoryHash = createHash('sha256').update(root).digest('hex').slice(0, 32);
      const repositoryWorktrees = resolveManagedPath(worktreesRoot, repositoryHash);
      await ensurePrivateDirectory(repositoryWorktrees);
      if (job.resumeWorktreePath !== undefined) {
        const resumed = await realpath(job.resumeWorktreePath).catch(() => {
          throw new HydraError(
            'SESSION_WORKTREE_MISSING',
            'The preserved worktree for this Claude session is unavailable',
          );
        });
        const difference = relative(repositoryWorktrees, resumed);
        if (
          difference === '' ||
          difference === '..' ||
          difference.startsWith(`..${sep}`) ||
          isAbsolute(difference)
        ) {
          throw new HydraError(
            'SESSION_WORKTREE_UNSAFE',
            'The preserved Claude session worktree is outside Hydra state',
          );
        }
        const resumedRoot = await repositoryRoot(this.#runner, this.#gitPath, resumed);
        if (resumedRoot !== resumed) {
          throw new HydraError(
            'SESSION_WORKTREE_INVALID',
            'The preserved Claude session path is not a worktree root',
          );
        }
        worktreePath = resumed;
      } else {
        worktreePath = resolveManagedPath(repositoryWorktrees, job.jobId);
        if (!existsSync(worktreePath)) {
          const filterOverrides = await configuredFilterOverrides(
            this.#runner,
            this.#gitPath,
            root,
          );
          await git(this.#runner, this.#gitPath, root, [
            'worktree',
            'add',
            '--detach',
            worktreePath,
            sourceHeadSha,
          ], 20_000_000, filterOverrides);
        }
      }
      const worktreeRoot = await realpath(worktreePath);
      cwd = await realpath(join(worktreeRoot, inputSubpath)).catch(() => {
        throw new HydraError(
          'CWD_MISSING_IN_WORKTREE',
          'The requested repository subdirectory does not exist in the isolated worktree',
        );
      });
      worktreePath = worktreeRoot;
    }

    await atomicWriteJson(
      settingsPath,
      accessSettings(job.input.accessMode, worktreePath ?? root, tempPath),
    );
    await atomicWriteJson(emptyMcpPath, { mcpServers: {} });
    return {
      accessMode: job.input.accessMode,
      cwd,
      repositoryRoot: root,
      settingsPath,
      emptyMcpPath,
      tempPath,
      sourceHeadSha,
      beforeSnapshot,
      ...(worktreePath === undefined ? {} : { worktreePath }),
    };
  }
}

function pathsFromStatus(status: string): string[] {
  const fields = nulFields(status);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    paths.push(field.slice(3));
    if (field.slice(0, 2).includes('R') || field.slice(0, 2).includes('C')) {
      const renamedFrom = fields[index + 1];
      if (renamedFrom !== undefined) {
        paths.push(renamedFrom);
        index += 1;
      }
    }
  }
  return [...new Set(paths)].sort();
}

export async function collectWorktreeResult(
  path: string,
  mainCheckoutBefore?: RepositorySnapshot,
  dependencies: { readonly runner?: ProcessRunner; readonly gitPath?: string } = {},
): Promise<WorktreeEvidence> {
  const runner = dependencies.runner ?? new NodeProcessRunner();
  const gitPath = dependencies.gitPath ?? 'git';
  const root = await repositoryRoot(runner, gitPath, path);
  const headSha = await repositoryHead(runner, gitPath, root);
  const [status, trackedPatch] = await Promise.all([
    git(runner, gitPath, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    headSha === UNBORN_HEAD
      ? Promise.all([
          git(runner, gitPath, root, [
            'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv',
          ]),
          git(runner, gitPath, root, [
            'diff', '--binary', '--no-ext-diff', '--no-textconv',
          ]),
        ]).then(([staged, unstaged]) => `${staged}${unstaged}`)
      : git(runner, gitPath, root, [
          'diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD',
        ]),
  ]);
  let patch = trackedPatch;
  for (const untrackedFile of parseUntracked(status)) {
    const remainingBytes = MAX_PATCH_BYTES - Buffer.byteLength(patch, 'utf8');
    if (remainingBytes <= 0) {
      throw new HydraError('PROCESS_OUTPUT_LIMIT', `Git patch exceeded ${MAX_PATCH_BYTES} bytes`);
    }
    patch += await untrackedPatch(runner, gitPath, root, untrackedFile, remainingBytes);
  }
  let mainCheckoutChanged = false;
  if (mainCheckoutBefore !== undefined) {
    const mainAfter = await snapshotRepository(mainCheckoutBefore.repositoryRoot, {
      runner,
      gitPath,
    });
    mainCheckoutChanged = compareSnapshots(mainCheckoutBefore, mainAfter).changed;
  }
  return {
    path: root,
    changedFiles: pathsFromStatus(status),
    patch: sanitizeText(patch),
    mainCheckoutChanged,
  };
}
