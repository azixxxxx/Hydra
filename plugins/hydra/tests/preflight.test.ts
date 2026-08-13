import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, test } from 'vitest';

import { loadConfig } from '../src/config.js';
import {
  PreflightService,
  PROHIBITED_SUBSCRIPTION_ENVIRONMENT,
  detectClaudeCapabilities,
  loadClaudeSettings,
  type SettingsSource,
} from '../src/preflight.js';
import {
  NodeProcessRunner,
  type CompletedProcess,
  type ProcessRunner,
} from '../src/platform/process.js';
import { createRepository } from './helpers/repo.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
let installedHelp = '';

beforeAll(async () => {
  installedHelp = await readFile(resolve(fixtureDirectory, 'claude-help-2.1.228.txt'), 'utf8');
});

const compatibleAuth = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
  email: 'private@example.invalid',
  orgId: 'private-org-id',
  orgName: 'Private Org',
};

function completed(stdout: string, exitCode = 0, stderr = ''): CompletedProcess {
  return {
    stdout,
    stderr,
    exitCode,
    signal: null,
    durationMs: 1,
    timedOut: false,
  };
}

class FakeClaudeRunner implements ProcessRunner {
  public constructor(
    private readonly versionOutput = '2.1.228 (Claude Code)\n',
    private readonly helpOutput = installedHelp,
    private readonly authOutput = JSON.stringify(compatibleAuth),
  ) {}

  public run(
    _command: string,
    args: readonly string[],
  ): Promise<CompletedProcess> {
    if (args.length === 1 && args[0] === '--version') {
      return Promise.resolve(completed(this.versionOutput));
    }
    if (args.length === 1 && args[0] === '--help') {
      return Promise.resolve(completed(this.helpOutput));
    }
    if (args.length === 2 && args[0] === 'auth' && args[1] === 'status') {
      return Promise.resolve(completed(this.authOutput));
    }
    return Promise.resolve(completed('', 2, 'unexpected fake invocation'));
  }
}

function createService(options: {
  runner?: ProcessRunner;
  presentEnvironment?: ReadonlySet<string>;
  settings?: readonly SettingsSource[];
} = {}): PreflightService {
  const presentEnvironment = options.presentEnvironment ?? new Set<string>();
  return new PreflightService({
    config: loadConfig({ claudePath: '/mock/claude' }),
    runner: options.runner ?? new FakeClaudeRunner(),
    environmentHas: (name) => presentEnvironment.has(name),
    loadSettings: () => Promise.resolve(options.settings ?? []),
    platform: 'darwin',
    architecture: 'arm64',
  });
}

function codes(result: Awaited<ReturnType<PreflightService['check']>>): string[] {
  return result.errors.map(({ code }) => code);
}

describe('Claude capability detection', () => {
  test('detects every flag required by Hydra from the installed help fixture', () => {
    expect(detectClaudeCapabilities(installedHelp)).toMatchObject({
      flags: {
        print: true,
        model: true,
        effort: true,
        outputFormat: true,
        verbose: true,
        permissionMode: true,
        tools: true,
        settings: true,
        settingSources: true,
        jsonSchema: true,
        resume: true,
        sessionId: true,
        mcpConfig: true,
        strictMcpConfig: true,
      },
      supportsCliMaxTurns: false,
      supportsDirectSandboxFlag: false,
    });
  });

  test('does not mistake prose for an option declaration', () => {
    expect(detectClaudeCapabilities('description mentions --model only')).toMatchObject({
      flags: { model: false },
    });
  });
});

describe('subscription-only preflight', () => {
  test('accepts a compatible first-party Max login without exposing account fields', async () => {
    const result = await createService().check({ cwd: '/tmp/repository' });

    expect(result).toMatchObject({
      ok: true,
      claudeVersion: '2.1.228',
      billingMode: 'subscription-only',
      auth: {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'max',
        compatible: true,
      },
      usageCreditsState: 'unknown',
      manualCheckRequired: true,
    });
    expect(JSON.stringify(result)).not.toContain('private@example.invalid');
    expect(JSON.stringify(result)).not.toContain('private-org-id');
  });

  test('rejects a Claude version below the verified 2.1.228 baseline', async () => {
    const result = await createService({ runner: new FakeClaudeRunner('2.1.227 (Claude Code)') }).check({
      cwd: '/tmp/repository',
    });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('CLAUDE_VERSION_UNSUPPORTED');
  });

  test('rejects an unparseable Claude version', async () => {
    const result = await createService({ runner: new FakeClaudeRunner('development build') }).check({
      cwd: '/tmp/repository',
    });

    expect(codes(result)).toContain('CLAUDE_VERSION_INVALID');
  });

  test.each([
    [{ ...compatibleAuth, loggedIn: false }, 'CLAUDE_NOT_LOGGED_IN'],
    [{ ...compatibleAuth, authMethod: 'apiKey' }, 'SUBSCRIPTION_AUTH_REQUIRED'],
    [{ ...compatibleAuth, apiProvider: 'bedrock' }, 'FIRST_PARTY_PROVIDER_REQUIRED'],
    [{ ...compatibleAuth, subscriptionType: undefined }, 'SUBSCRIPTION_TYPE_REQUIRED'],
  ] as const)('rejects incompatible auth %#', async (auth, expectedCode) => {
    const result = await createService({
      runner: new FakeClaudeRunner(undefined, undefined, JSON.stringify(auth)),
    }).check({ cwd: '/tmp/repository' });

    expect(codes(result)).toContain(expectedCode);
  });

  test.each(PROHIBITED_SUBSCRIPTION_ENVIRONMENT)(
    'rejects prohibited environment variable %s without reading its value',
    async (name) => {
    const result = await createService({ presentEnvironment: new Set([name]) }).check({
      cwd: '/tmp/repository',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'PROHIBITED_ENVIRONMENT', details: { name } }),
    );
    },
  );

  test('allows CLAUDE_CODE_OAUTH_TOKEN presence without returning a value', async () => {
    const result = await createService({
      presentEnvironment: new Set(['CLAUDE_CODE_OAUTH_TOKEN']),
    }).check({ cwd: '/tmp/repository' });

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  test.each([
    { apiKeyHelper: '/bin/get-secret' },
    { env: { ANTHROPIC_API_KEY: 'secret' } },
    { env: { ANTHROPIC_BASE_URL: 'https://gateway.invalid' } },
    { env: { CLAUDE_CODE_USE_VERTEX: '1' } },
    { awsAuthRefresh: '/bin/refresh' },
    { awsCredentialExport: '/bin/export' },
  ])('rejects prohibited provider setting %# without returning its value', async (settings) => {
    const result = await createService({
      settings: [{ path: '/safe/settings.json', value: settings }],
    }).check({ cwd: '/tmp/repository' });

    expect(codes(result)).toContain('PROHIBITED_SETTING');
    expect(JSON.stringify(result)).not.toContain('/bin/get-secret');
    expect(JSON.stringify(result)).not.toContain('gateway.invalid');
  });

  test('fails closed when a required CLI flag is absent', async () => {
    const helpWithoutSchema = installedHelp.replace(
      /\s*--json-schema <schema>[^\n]*\n/u,
      '\n',
    );
    const result = await createService({
      runner: new FakeClaudeRunner(undefined, helpWithoutSchema),
    }).check({ cwd: '/tmp/repository' });

    expect(codes(result)).toContain('CLAUDE_FLAG_MISSING');
    expect(result.errors).toContainEqual(
      expect.objectContaining({ details: { flag: '--json-schema' } }),
    );
  });

  test('loads repository settings from ancestors of a nested working directory', async () => {
    const root = await createTemporaryDirectory('hydra-settings-ancestor-');
    const repository = join(root, 'repository');
    const nested = join(repository, 'packages', 'pkg');
    try {
      await createRepository(repository);
      await mkdir(join(repository, '.claude'), { recursive: true });
      await mkdir(nested, { recursive: true });
      await writeFile(
        join(repository, '.claude', 'settings.json'),
        JSON.stringify({ env: { CLAUDE_CODE_USE_GATEWAY: '1' } }),
        'utf8',
      );
      const loaded = await loadClaudeSettings(nested);
      expect(loaded).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: join(await realpath(repository), '.claude', 'settings.json'),
          value: { env: { CLAUDE_CODE_USE_GATEWAY: '1' } },
        }),
      ]));

      const result = await new PreflightService({
        config: loadConfig({ claudePath: '/mock/claude' }),
        runner: new FakeClaudeRunner(),
        environmentHas: () => false,
        platform: 'darwin',
        architecture: 'arm64',
      }).check({ cwd: nested });
      expect(codes(result)).toContain('PROHIBITED_SETTING');
    } finally {
      await removeTemporaryDirectory(root);
    }
  });

  test('rejects relative CLAUDE_CONFIG_DIR to prevent preflight/child cwd divergence', async () => {
    const prior = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = 'relative-config';
    try {
      await expect(loadClaudeSettings('/tmp')).rejects.toMatchObject({
        code: 'CLAUDE_CONFIG_DIR_RELATIVE',
      });
    } finally {
      if (prior === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = prior;
      }
    }
  });
});

describe('NodeProcessRunner', () => {
  test('keeps stdout and stderr separate', async () => {
    const runner = new NodeProcessRunner();

    const result = await runner.run(process.execPath, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err")',
    ]);

    expect(result).toMatchObject({ stdout: 'out', stderr: 'err', exitCode: 0, signal: null });
  });

  test('force-kills a timed-out process that ignores SIGTERM', async () => {
    const runner = new NodeProcessRunner();
    const startedAt = Date.now();

    const result = await runner.run(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { timeoutMs: 100, terminationGraceMs: 20 },
    );

    expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
