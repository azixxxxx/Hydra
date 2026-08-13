import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import type { HydraConfig } from './config.js';
import { HydraError, type ClaudeCapabilities, type JsonValue, type SafeError } from './domain.js';
import type { ProcessRunner } from './platform/process.js';

export const PROHIBITED_SUBSCRIPTION_ENVIRONMENT = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_LOCATION',
  'ANTHROPIC_GOOGLE_CLOUD_PROJECT',
  'ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_API_BASE_URL',
  'CLAUDE_CODE_API_KEY',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_GB_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_CCR_V2',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_CODE_WEBFETCH_USE_CCR_PROXY',
  'CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY',
] as const);

const PROHIBITED_SETTING_KEYS = new Set([
  'apikeyhelper',
  'awsauthrefresh',
  'awscredentialexport',
  'gcpauthrefresh',
  'azureauthrefresh',
]);
const PROHIBITED_ENVIRONMENT_SET = new Set<string>(PROHIBITED_SUBSCRIPTION_ENVIRONMENT);

const REQUIRED_FLAGS = Object.freeze({
  print: '--print',
  model: '--model',
  effort: '--effort',
  outputFormat: '--output-format',
  verbose: '--verbose',
  permissionMode: '--permission-mode',
  tools: '--tools',
  settings: '--settings',
  settingSources: '--setting-sources',
  jsonSchema: '--json-schema',
  resume: '--resume',
  sessionId: '--session-id',
  mcpConfig: '--mcp-config',
  strictMcpConfig: '--strict-mcp-config',
} as const);

const AuthStatusSchema = z
  .object({
    loggedIn: z.boolean(),
    authMethod: z.string().optional(),
    apiProvider: z.string().optional(),
    subscriptionType: z.string().optional(),
  })
  .passthrough();

export interface SettingsSource {
  readonly path: string;
  readonly value: unknown;
}

export interface SafeAuthStatus {
  readonly loggedIn: boolean;
  readonly authMethod?: string;
  readonly apiProvider?: string;
  readonly subscriptionType?: string;
  readonly compatible: boolean;
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly billingMode: 'subscription-only';
  readonly claudeVersion: string | null;
  readonly minimumClaudeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly auth: SafeAuthStatus;
  readonly capabilities: ClaudeCapabilities;
  readonly usageCreditsState: 'unknown';
  readonly manualCheckRequired: true;
  readonly errors: readonly SafeError[];
  readonly warnings: readonly string[];
}

export const PreflightResultSchema = z
  .object({
    ok: z.boolean(),
    billingMode: z.literal('subscription-only'),
    claudeVersion: z.string().nullable(),
    minimumClaudeVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
    platform: z.string().min(1).max(100),
    architecture: z.string().min(1).max(100),
    auth: z
      .object({
        loggedIn: z.boolean(),
        authMethod: z.string().max(200).optional(),
        apiProvider: z.string().max(200).optional(),
        subscriptionType: z.string().max(200).optional(),
        compatible: z.boolean(),
      })
      .strict(),
    capabilities: z
      .object({
        flags: z.record(z.string(), z.boolean()),
        supportsCliMaxTurns: z.boolean(),
        supportsDirectSandboxFlag: z.boolean(),
      })
      .strict(),
    usageCreditsState: z.literal('unknown'),
    manualCheckRequired: z.literal(true),
    errors: z.array(
      z
        .object({
          code: z.string().min(1).max(200),
          message: z.string().min(1).max(20_000),
          details: z.record(z.string(), z.json()).optional(),
        })
        .strict(),
    ),
    warnings: z.array(z.string().max(20_000)).max(1_000),
  })
  .strict();

export interface PreflightDependencies {
  readonly config: HydraConfig;
  readonly runner: ProcessRunner;
  readonly environmentHas?: (name: string) => boolean;
  readonly loadSettings?: (cwd: string) => Promise<readonly SettingsSource[]>;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
}

function declaredOptions(helpText: string): ReadonlySet<string> {
  const options = new Set<string>();
  for (const line of helpText.split(/\r?\n/u)) {
    if (!/^\s{2,}-/u.test(line)) {
      continue;
    }
    for (const match of line.matchAll(/--[A-Za-z0-9-]+/gu)) {
      options.add(match[0]);
    }
  }
  return options;
}

export function detectClaudeCapabilities(helpText: string): ClaudeCapabilities {
  const options = declaredOptions(helpText);
  const flags = Object.fromEntries(
    Object.entries(REQUIRED_FLAGS).map(([name, option]) => [name, options.has(option)]),
  );
  return {
    flags,
    supportsCliMaxTurns: options.has('--max-turns'),
    supportsDirectSandboxFlag: options.has('--sandbox'),
  };
}

function parseVersion(output: string): readonly [number, number, number] | null {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(output.trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function formatVersion(version: readonly [number, number, number]): string {
  return version.join('.');
}

function compareVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (const index of [0, 1, 2] as const) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function safeError(
  code: string,
  message: string,
  details?: Readonly<Record<string, JsonValue>>,
): SafeError {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function findProhibitedSettings(value: unknown): readonly string[] {
  const found = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object') {
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      const normalized = key.toLowerCase();
      if (PROHIBITED_SETTING_KEYS.has(normalized) || PROHIBITED_ENVIRONMENT_SET.has(key)) {
        found.add(key);
      }
      visit(child);
    }
  };
  visit(value);
  return [...found].sort();
}

async function readSettingsFile(path: string): Promise<SettingsSource | null> {
  try {
    return { path, value: JSON.parse(await readFile(path, 'utf8')) as unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function loadClaudeSettings(cwd: string): Promise<readonly SettingsSource[]> {
  const configDirectory = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  if (!isAbsolute(configDirectory)) {
    throw new HydraError(
      'CLAUDE_CONFIG_DIR_RELATIVE',
      'CLAUDE_CONFIG_DIR must be absolute so Hydra and Claude inspect the same settings',
    );
  }
  const canonicalCwd = await realpath(cwd);
  const projectDirectories: string[] = [];
  let current = canonicalCwd;
  for (;;) {
    projectDirectories.push(current);
    try {
      await lstat(join(current, '.git'));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const paths = new Set([
    join(configDirectory, 'settings.json'),
    join(configDirectory, 'settings.local.json'),
    ...projectDirectories.flatMap((directory) => [
      join(directory, '.claude', 'settings.json'),
      join(directory, '.claude', 'settings.local.json'),
    ]),
    ...(process.platform === 'darwin'
      ? ['/Library/Application Support/ClaudeCode/managed-settings.json']
      : ['/etc/claude-code/managed-settings.json']),
  ]);
  const sources = await Promise.all([...paths].map(async (path) => readSettingsFile(resolve(path))));
  return sources.filter((source): source is SettingsSource => source !== null);
}

export class PreflightService {
  private readonly config: HydraConfig;
  private readonly runner: ProcessRunner;
  private readonly environmentHas: (name: string) => boolean;
  private readonly settingsLoader: (cwd: string) => Promise<readonly SettingsSource[]>;
  private readonly platform: NodeJS.Platform;
  private readonly architecture: string;

  public constructor(dependencies: PreflightDependencies) {
    this.config = dependencies.config;
    this.runner = dependencies.runner;
    this.environmentHas =
      dependencies.environmentHas ?? ((name: string): boolean => Object.hasOwn(process.env, name));
    this.settingsLoader = dependencies.loadSettings ?? loadClaudeSettings;
    this.platform = dependencies.platform ?? process.platform;
    this.architecture = dependencies.architecture ?? process.arch;
  }

  public async check(input: { readonly cwd?: string }): Promise<PreflightResult> {
    const errors: SafeError[] = [];
    const warnings: string[] = [];
    const cwd = input.cwd ?? process.cwd();
    let version: string | null = null;
    let capabilities = detectClaudeCapabilities('');
    let auth: SafeAuthStatus = { loggedIn: false, compatible: false };

    if (!isAbsolute(cwd)) {
      errors.push(safeError('CWD_NOT_ABSOLUTE', 'Preflight cwd must be an absolute path'));
    }
    if (this.platform !== 'darwin' && this.platform !== 'linux') {
      errors.push(
        safeError('PLATFORM_UNSUPPORTED', `Hydra v1 does not support ${this.platform}`),
      );
    }

    try {
      const versionProcess = await this.runner.run(this.config.claudePath, ['--version'], {
        cwd,
        timeoutMs: 10_000,
      });
      if (versionProcess.exitCode !== 0) {
        errors.push(
          safeError('CLAUDE_VERSION_COMMAND_FAILED', 'claude --version failed', {
            exitCode: versionProcess.exitCode,
          }),
        );
      } else {
        const parsedVersion = parseVersion(versionProcess.stdout);
        const minimumVersion = parseVersion(this.config.minClaudeVersion);
        if (parsedVersion === null || minimumVersion === null) {
          errors.push(
            safeError('CLAUDE_VERSION_INVALID', 'Claude Code returned an unparseable version'),
          );
        } else {
          version = formatVersion(parsedVersion);
          if (compareVersions(parsedVersion, minimumVersion) < 0) {
            errors.push(
              safeError(
                'CLAUDE_VERSION_UNSUPPORTED',
                `Claude Code ${version} is below required ${this.config.minClaudeVersion}`,
              ),
            );
          }
        }
      }
    } catch {
      errors.push(
        safeError('CLAUDE_VERSION_COMMAND_FAILED', 'Unable to execute claude --version'),
      );
    }

    try {
      const helpProcess = await this.runner.run(this.config.claudePath, ['--help'], {
        cwd,
        timeoutMs: 10_000,
      });
      if (helpProcess.exitCode !== 0) {
        errors.push(safeError('CLAUDE_HELP_COMMAND_FAILED', 'claude --help failed'));
      } else {
        capabilities = detectClaudeCapabilities(helpProcess.stdout);
        for (const [name, option] of Object.entries(REQUIRED_FLAGS)) {
          if (capabilities.flags[name] !== true) {
            errors.push(
              safeError('CLAUDE_FLAG_MISSING', `Claude Code does not expose required ${option}`, {
                flag: option,
              }),
            );
          }
        }
        if (!capabilities.supportsCliMaxTurns) {
          warnings.push('Claude CLI has no --max-turns flag; Hydra enforces the limit from events.');
        }
        if (!capabilities.supportsDirectSandboxFlag) {
          warnings.push('Claude CLI has no direct sandbox flag; Hydra requires verified settings.');
        }
      }
    } catch {
      errors.push(safeError('CLAUDE_HELP_COMMAND_FAILED', 'Unable to execute claude --help'));
    }

    try {
      const authProcess = await this.runner.run(this.config.claudePath, ['auth', 'status'], {
        cwd,
        timeoutMs: 10_000,
      });
      if (authProcess.exitCode !== 0) {
        errors.push(safeError('CLAUDE_AUTH_COMMAND_FAILED', 'claude auth status failed'));
      } else {
        const parsedAuth = AuthStatusSchema.parse(JSON.parse(authProcess.stdout) as unknown);
        const subscriptionType = parsedAuth.subscriptionType?.toLowerCase();
        const compatible =
          parsedAuth.loggedIn &&
          parsedAuth.authMethod === 'claude.ai' &&
          parsedAuth.apiProvider === 'firstParty' &&
          (subscriptionType === 'pro' || subscriptionType === 'max');
        auth = {
          loggedIn: parsedAuth.loggedIn,
          ...(parsedAuth.authMethod === undefined ? {} : { authMethod: parsedAuth.authMethod }),
          ...(parsedAuth.apiProvider === undefined ? {} : { apiProvider: parsedAuth.apiProvider }),
          ...(subscriptionType === undefined ? {} : { subscriptionType }),
          compatible,
        };
        if (compatible) {
          warnings.push(
            'claude auth status verifies local login metadata only; live token validity is checked by an invocation.',
          );
        }

        if (!parsedAuth.loggedIn) {
          errors.push(safeError('CLAUDE_NOT_LOGGED_IN', 'Claude Code is not logged in'));
        } else {
          if (parsedAuth.authMethod !== 'claude.ai') {
            errors.push(
              safeError('SUBSCRIPTION_AUTH_REQUIRED', 'Claude.ai subscription auth is required'),
            );
          }
          if (parsedAuth.apiProvider !== 'firstParty') {
            errors.push(
              safeError('FIRST_PARTY_PROVIDER_REQUIRED', 'First-party Claude routing is required'),
            );
          }
          if (subscriptionType === undefined) {
            errors.push(
              safeError('SUBSCRIPTION_TYPE_REQUIRED', 'Claude subscription type is missing'),
            );
          } else if (subscriptionType !== 'pro' && subscriptionType !== 'max') {
            errors.push(
              safeError(
                'SUBSCRIPTION_TYPE_UNSUPPORTED',
                'Claude Pro or Max subscription is required',
              ),
            );
          }
        }
      }
    } catch {
      errors.push(
        safeError('CLAUDE_AUTH_STATUS_INVALID', 'Claude auth status was unavailable or invalid'),
      );
    }

    for (const name of PROHIBITED_SUBSCRIPTION_ENVIRONMENT) {
      if (this.environmentHas(name)) {
        errors.push(
          safeError('PROHIBITED_ENVIRONMENT', 'Subscription-only mode rejects provider credentials and routing', {
            name,
          }),
        );
      }
    }

    try {
      const settings = await this.settingsLoader(cwd);
      for (const source of settings) {
        for (const key of findProhibitedSettings(source.value)) {
          errors.push(
            safeError('PROHIBITED_SETTING', 'Subscription-only mode rejects provider settings', {
              path: source.path,
              key,
            }),
          );
        }
      }
    } catch {
      errors.push(
        safeError('CLAUDE_SETTINGS_INVALID', 'Claude settings could not be safely inspected'),
      );
    }

    return {
      ok: errors.length === 0,
      billingMode: 'subscription-only',
      claudeVersion: version,
      minimumClaudeVersion: this.config.minClaudeVersion,
      platform: this.platform,
      architecture: this.architecture,
      auth,
      capabilities,
      usageCreditsState: 'unknown',
      manualCheckRequired: true,
      errors,
      warnings,
    };
  }
}
