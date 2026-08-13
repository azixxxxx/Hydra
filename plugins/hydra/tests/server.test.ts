import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import {
  HYDRA_VERSION,
  TOOL_OUTPUT_SCHEMAS,
  loadHydraRuntimeIdentity,
} from '../src/contract.js';
import type { RecordOutcomeInput } from '../src/domain.js';
import { PolicyEngine, type RouteInput } from '../src/policy.js';
import { createHydraServer, createProductionServices, pruneExpiredJobs, type HydraServices } from '../src/server.js';
import { createTemporaryDirectory, removeTemporaryDirectory } from './helpers/temporary.js';

const jobId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-08-12T12:00:00.000Z';
const persistedInput = {
  task: 'Review this repository',
  cwd: '/tmp/repository',
  model: 'sonnet',
  effort: 'high',
  role: 'reviewer',
  accessMode: 'analyze',
  maxTurns: 12,
  timeoutSec: 1_800,
  strictModel: false,
} as const;

function jobMeta(
  status: 'queued' | 'completed' | 'cancelled',
  requestedJobId: string = jobId,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    jobId: requestedJobId,
    status,
    input: persistedInput,
    requestedModel: 'sonnet',
    requestedEffort: 'high',
    createdAt: timestamp,
    updatedAt: timestamp,
    warnings: [],
    usageFeatures: {
      promptBytes: 22,
      roleBytes: 8,
      schemaBytes: 0,
      referencedBytes: 0,
      expectedTurns: 12,
      toolClass: 'analyze',
    },
    ...(status === 'queued' ? {} : { completedAt: timestamp }),
  };
}

function services(): HydraServices {
  return {
    preflight: {
      check: vi.fn(() => Promise.resolve({
        ok: true,
        billingMode: 'subscription-only',
        claudeVersion: '2.1.228',
        minimumClaudeVersion: '2.1.228',
        platform: 'darwin',
        architecture: 'arm64',
        auth: { loggedIn: true, compatible: true },
        capabilities: {
          flags: {},
          supportsCliMaxTurns: true,
          supportsDirectSandboxFlag: true,
        },
        usageCreditsState: 'unknown',
        manualCheckRequired: true,
        errors: [],
        warnings: [],
      })),
    },
    policy: {
      route: vi.fn((input: RouteInput) => new PolicyEngine().route(input)),
    },
    jobs: {
      start: vi.fn(() => Promise.resolve({ jobId, status: 'queued' as const })),
      status: vi.fn((requested?: string) =>
        Promise.resolve(requested === undefined ? [] : jobMeta('queued', requested)),
      ),
      health: vi.fn(() => Promise.resolve({ state: 'ok' as const, issues: [] })),
      result: vi.fn(() => Promise.resolve({ meta: jobMeta('completed'), events: [], stderr: '' })),
      continue: vi.fn(() => Promise.resolve({ jobId, status: 'queued' as const })),
      cancel: vi.fn(() => Promise.resolve(jobMeta('cancelled'))),
    },
    outcomes: {
      record: vi.fn((input: RecordOutcomeInput) => Promise.resolve({
        schemaVersion: 2,
        jobId: input.jobId,
        taskType: input.taskType,
        scope: input.scope,
        requestedModel: 'sonnet',
        model: 'claude-sonnet-5',
        effort: 'high',
        status: 'completed',
        durationMs: 1_000,
        completedAt: timestamp,
        observedTests: [],
        accepted: input.accepted,
        recordedAt: timestamp,
        acceptedClaims: input.acceptedClaims,
        rejectedClaims: input.rejectedClaims,
        falsePositives: input.falsePositives,
        testsBefore: input.testsBefore,
        testsAfter: input.testsAfter,
        ...(input.testsPassed === undefined ? {} : { testsPassed: input.testsPassed }),
        ...(input.patchAccepted === undefined ? {} : { patchAccepted: input.patchAccepted }),
        ...(input.userVerdict === undefined ? {} : { userVerdict: input.userVerdict }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      })),
    },
    budget: {
      status: vi.fn(() => Promise.resolve({ snapshotCount: 0, observationCount: 0, activeReservations: [] })),
      evaluate: vi.fn(() => Promise.resolve({ decision: { mode: 'unknown' } })),
      recordSnapshot: vi.fn((snapshot) => Promise.resolve({ record: { snapshot }, observationsAdded: [] })),
    },
    now: () => new Date('2026-08-12T12:00:00.000Z'),
  };
}

describe('Hydra MCP server', () => {
  let hydraServices: HydraServices;
  let server: ReturnType<typeof createHydraServer>;
  let client: Client;

  beforeEach(async () => {
    hydraServices = services();
    server = createHydraServer(hydraServices);
    client = new Client({ name: 'hydra-tests', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
  });

  test('registers exactly nine documented tools with correct read-only annotations', async () => {
    const listed = await client.listTools();
    const names = listed.tools.map(({ name }) => name);

    expect(names).toEqual([
      'hydra_preflight',
      'hydra_route',
      'hydra_start',
      'hydra_status',
      'hydra_result',
      'hydra_continue',
      'hydra_cancel',
      'hydra_record_outcome',
      'hydra_budget',
    ]);
    for (const name of ['hydra_preflight', 'hydra_route', 'hydra_status', 'hydra_result']) {
      expect(listed.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
    for (const name of ['hydra_start', 'hydra_continue', 'hydra_cancel', 'hydra_record_outcome', 'hydra_budget']) {
      expect(listed.tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
    }
    expect(listed.tools.find(({ name }) => name === 'hydra_start')?.description).toMatch(
      /subscription allowance/u,
    );
    expect(listed.tools.find(({ name }) => name === 'hydra_continue')?.description).toMatch(
      /subscription allowance/u,
    );
    for (const tool of listed.tools) {
      expect(tool.outputSchema, `${tool.name} output schema`).toEqual(expect.any(Object));
      expect(JSON.stringify(tool.outputSchema)).toContain('schemaVersion');
      expect(JSON.stringify(tool.outputSchema)).toContain('hydraVersion');
    }
    const contractFields = new Map([
      ['hydra_preflight', 'billingMode'],
      ['hydra_route', 'planId'],
      ['hydra_start', 'delegationGroupId'],
      ['hydra_status', 'requestedModel'],
      ['hydra_result', 'eventsComplete'],
      ['hydra_continue', 'delegationGroupId'],
      ['hydra_cancel', 'requestedModel'],
      ['hydra_record_outcome', 'acceptedClaims'],
      ['hydra_budget', 'orderStatisticCoverageBasisPoints'],
    ]);
    for (const tool of listed.tools) {
      expect(JSON.stringify(tool.outputSchema), tool.name).toContain(
        contractFields.get(tool.name),
      );

      const requiredSets: string[][] = [];
      const collectRequiredSets = (value: unknown): void => {
        if (value === null || typeof value !== 'object') {
          return;
        }
        if (Array.isArray(value)) {
          value.forEach(collectRequiredSets);
          return;
        }
        const record = value as Record<string, unknown>;
        if (Array.isArray(record.required)) {
          requiredSets.push(record.required.filter((item): item is string => typeof item === 'string'));
        }
        Object.values(record).forEach(collectRequiredSets);
      };
      collectRequiredSets(tool.outputSchema);
      expect(requiredSets, `${tool.name} envelope`).toContainEqual(
        expect.arrayContaining(['schemaVersion', 'hydraVersion', 'response']),
      );
      expect(requiredSets, `${tool.name} success response`).toContainEqual(
        expect.arrayContaining(['ok', 'data', 'warnings']),
      );
      expect(requiredSets, `${tool.name} failure response`).toContainEqual(
        expect.arrayContaining(['ok', 'error']),
      );
    }
  });

  test('rejects envelopes that omit or contradict the published discriminator', () => {
    expect(TOOL_OUTPUT_SCHEMAS.start.safeParse({
      schemaVersion: 1,
      hydraVersion: HYDRA_VERSION,
      response: { ok: true },
    }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.start.safeParse({
      schemaVersion: 1,
      hydraVersion: HYDRA_VERSION,
      response: {
        ok: true,
        data: { jobId, status: 'queued' },
        warnings: [],
        error: { code: 'IMPOSSIBLE', message: 'both branches' },
      },
    }).success).toBe(false);
  });

  test('exposes strict JSON object input schemas', async () => {
    const tools = (await client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    expect(tools.find(({ name }) => name === 'hydra_start')?.inputSchema.required).toEqual(
      expect.arrayContaining(['task', 'cwd', 'model', 'effort', 'role', 'accessMode']),
    );
  });

  test('calls every tool and returns JSON-compatible structured content', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['hydra_preflight', { cwd: '/tmp/repository' }],
      ['hydra_route', {
        taskProfile: {
          kind: 'routine', scope: 'local', ambiguity: 'low', novelty: 'low', risk: 'low',
          writeRequired: false, testsRequired: false, parallelizable: false,
        },
        contextProfile: {
          capsuleBytes: 0,
          overlap: 'low',
          partitionability: 'none',
          independentJudgmentsRequired: false,
          partitions: [],
        },
      }],
      ['hydra_start', {
        task: 'Review this repository', cwd: '/tmp/repository', model: 'sonnet', effort: 'high',
        role: 'reviewer', accessMode: 'analyze',
      }],
      ['hydra_status', { jobId }],
      ['hydra_result', { jobId }],
      ['hydra_continue', { sessionId, message: 'Continue the review' }],
      ['hydra_cancel', { jobId }],
      ['hydra_record_outcome', {
        jobId, taskType: 'review', scope: 'repo', accepted: true,
        acceptedClaims: ['finding'], rejectedClaims: [], testsPassed: true,
      }],
      ['hydra_budget', { action: 'status' }],
    ];

    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        schemaVersion: 1,
        hydraVersion: HYDRA_VERSION,
        response: {
          ok: true,
          data: expect.anything(),
          warnings: [],
        },
      });
      expect(() => JSON.stringify(result.structuredContent)).not.toThrow();
    }
    expect(hydraServices.outcomes.record).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        taskType: 'review',
        scope: 'repo',
        accepted: true,
        acceptedClaims: ['finding'],
        falsePositives: [],
        testsBefore: [],
        testsAfter: [],
      }),
    );
    expect(hydraServices.budget.status).toHaveBeenCalledTimes(1);
    await client.callTool({
      name: 'hydra_result',
      arguments: { jobId, eventOffset: 10, eventLimit: 50 },
    });
    expect(hydraServices.jobs.result).toHaveBeenLastCalledWith(jobId, {
      eventOffset: 10,
      eventLimit: 50,
    });
  });

  test('normalizes status to one list shape and accepts omitted optional arguments', async () => {
    const empty = await client.callTool({ name: 'hydra_status' });
    expect(empty.isError).not.toBe(true);
    expect(empty.structuredContent).toMatchObject({
      response: {
        data: {
          jobs: [],
          health: { state: 'ok', issues: [] },
        },
      },
    });
    expect(hydraServices.jobs.status).toHaveBeenLastCalledWith(undefined);

    const one = await client.callTool({ name: 'hydra_status', arguments: { jobId } });
    expect(one.structuredContent).toMatchObject({
      response: {
        data: {
          jobs: [{ jobId, status: 'queued' }],
          health: { state: 'ok', issues: [] },
        },
      },
    });

    const preflight = await client.callTool({ name: 'hydra_preflight' });
    expect(preflight.isError).not.toBe(true);
    expect(hydraServices.preflight.check).toHaveBeenLastCalledWith({});
  });

  test('does not echo secret values in validation errors', async () => {
    const secret = 'oauth-super-secret-value';
    const result = await client.callTool({
      name: 'hydra_start',
      arguments: {
        task: 'Review', cwd: '/tmp/repository', model: 'sonnet', effort: 'high',
        role: 'reviewer', accessMode: 'analyze', authorization: secret,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      schemaVersion: 1,
      hydraVersion: HYDRA_VERSION,
      response: {
        ok: false,
        error: { code: expect.any(String), message: expect.any(String) },
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test('computes and applies the configured retention cutoff', async () => {
    const pruneOlderThan = vi.fn(() => Promise.resolve(['old-job']));

    await expect(
      pruneExpiredJobs(
        { pruneOlderThan },
        30,
        new Date('2026-08-12T12:00:00.000Z'),
      ),
    ).resolves.toEqual(['old-job']);
    expect(pruneOlderThan).toHaveBeenCalledWith(new Date('2026-07-13T12:00:00.000Z'));
  });

  test('derives runtime identity from the plugin manifest without freezing it into schemas', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(HYDRA_VERSION).toBe(manifest.version);
    for (const tool of (await client.listTools()).tools) {
      const versionProperty = (
        tool.outputSchema as { readonly properties?: Record<string, unknown> } | undefined
      )?.properties?.hydraVersion;
      expect(versionProperty).toEqual({ type: 'string' });
    }
  });

  test('falls back to a typed degraded runtime identity when the manifest cannot be read', () => {
    const unreadable = loadHydraRuntimeIdentity(() => {
      throw new Error('missing manifest');
    });
    const malformed = loadHydraRuntimeIdentity(() => '{not-json');

    expect(unreadable).toEqual({
      version: '0.0.0-unknown',
      issue: {
        code: 'HYDRA_MANIFEST_UNREADABLE',
        message: 'Hydra could not validate its plugin manifest and started read-only',
      },
    });
    expect(malformed).toEqual(unreadable);
  });

  test.each([
    ['invalid configuration', 'HYDRA_CONFIG_INVALID'],
    ['retention failure', 'HYDRA_RETENTION_FAILED'],
  ] as const)('keeps all tools readable in degraded mode after %s', async (failure, issueCode) => {
    const stateRoot = await createTemporaryDirectory('hydra-degraded-startup-');
    try {
      await mkdir(stateRoot, { recursive: true });
      const staleStore = new (await import('../src/stores.js')).JobStore({
        stateRoot,
        idFactory: () => jobId,
        now: () => new Date('2020-01-01T00:00:00.000Z'),
      });
      await staleStore.create(persistedInput);
      if (failure === 'invalid configuration') {
        await writeFile(join(stateRoot, 'config.json'), '{not-json', 'utf8');
      }
      const prune = vi.fn(
        failure === 'retention failure'
          ? () => Promise.reject(new Error('simulated retention failure'))
          : () => Promise.resolve([]),
      );
      const production = await createProductionServices({
        defaultConfig: loadConfig({ stateRoot }),
        prune,
      });

      expect(prune).toHaveBeenCalledTimes(failure === 'invalid configuration' ? 0 : 1);

      await expect(production.jobs.health()).resolves.toMatchObject({
        state: 'degraded',
        issues: [expect.objectContaining({ code: issueCode })],
      });
      await expect(production.jobs.start({
        task: 'Must be blocked while persistence health is degraded',
        cwd: stateRoot,
        model: 'sonnet',
        effort: 'high',
        role: 'reviewer',
        accessMode: 'analyze',
        maxTurns: 1,
        timeoutSec: 30,
        strictModel: true,
      })).rejects.toMatchObject({ code: 'HYDRA_DEGRADED_READ_ONLY' });
      await expect(production.jobs.status(jobId)).resolves.toMatchObject({
        jobId,
        status: 'queued',
      });
      await expect(staleStore.get(jobId)).resolves.toMatchObject({ status: 'queued' });
      await expect(staleStore.readResult(jobId)).resolves.toBeUndefined();
      await expect(production.jobs.cancel(jobId)).rejects.toMatchObject({
        code: 'HYDRA_DEGRADED_READ_ONLY',
      });

      const degradedServer = createHydraServer(production);
      const degradedClient = new Client(
        { name: 'hydra-degraded-test', version: '1.0.0' },
        { capabilities: {} },
      );
      const [degradedClientTransport, degradedServerTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        degradedServer.connect(degradedServerTransport),
        degradedClient.connect(degradedClientTransport),
      ]);
      expect((await degradedClient.listTools()).tools).toHaveLength(9);
      await Promise.all([degradedClient.close(), degradedServer.close()]);
    } finally {
      await removeTemporaryDirectory(stateRoot);
    }
  });

  test('treats an invalid runtime manifest as a degraded startup issue', async () => {
    const stateRoot = await createTemporaryDirectory('hydra-degraded-manifest-');
    try {
      const runtimeIdentity = loadHydraRuntimeIdentity(() => '{broken');
      const prune = vi.fn(() => Promise.resolve([]));
      const production = await createProductionServices({
        defaultConfig: loadConfig({ stateRoot }),
        runtimeIdentity,
        prune,
      });

      await expect(production.jobs.health()).resolves.toMatchObject({
        state: 'degraded',
        issues: [expect.objectContaining({ code: 'HYDRA_MANIFEST_UNREADABLE' })],
      });
      expect(prune).not.toHaveBeenCalled();
      await expect(production.jobs.start(persistedInput)).rejects.toMatchObject({
        code: 'HYDRA_DEGRADED_READ_ONLY',
      });
    } finally {
      await removeTemporaryDirectory(stateRoot);
    }
  });
});
