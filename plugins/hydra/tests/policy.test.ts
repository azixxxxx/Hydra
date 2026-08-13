import { describe, expect, test } from 'vitest';

import { PolicyEngine, parseRouteInput, type RouteInput } from '../src/policy.js';

function input(
  overrides: Partial<RouteInput['taskProfile']> = {},
  options: {
    readonly userMode?: RouteInput['userMode'];
    readonly contextProfile?: Partial<RouteInput['contextProfile']>;
  } = {},
): RouteInput {
  return {
    taskProfile: {
      kind: 'routine',
      scope: 'local',
      ambiguity: 'low',
      novelty: 'low',
      risk: 'low',
      writeRequired: false,
      testsRequired: false,
      parallelizable: false,
      ...overrides,
    },
    contextProfile: {
      capsuleBytes: 12_000,
      overlap: 'high',
      partitionability: 'none',
      independentJudgmentsRequired: false,
      partitions: [],
      ...options.contextProfile,
    },
    userMode: options.userMode ?? 'auto',
    hostModel: 'gpt-5.6-sol',
    hostEffort: 'high',
  };
}

describe('PolicyEngine', () => {
  const policy = new PolicyEngine();

  test.each([
    ['FAST', input()],
    ['STANDARD', input({ kind: 'feature', scope: 'module', writeRequired: true, testsRequired: true })],
    ['HARD_DEBUG', input({ kind: 'debug', ambiguity: 'high', risk: 'high', testsRequired: true })],
    ['ARCHITECTURE', input({ kind: 'architecture', scope: 'repo', ambiguity: 'medium', risk: 'high' })],
    ['LONG_HORIZON_UNKNOWN', input({ kind: 'research', scope: 'repo', ambiguity: 'high', novelty: 'high' })],
    ['PRE_MERGE_HIGH_RISK', input({ kind: 'review', scope: 'repo', risk: 'critical', testsRequired: true })],
    ['MAXIMUM', input({ kind: 'debug', risk: 'critical' }, { userMode: 'maximum' })],
  ] as const)('routes %s deterministically without launching work', (expected, routeInput) => {
    const first = policy.route(routeInput);
    const second = policy.route(routeInput);

    expect(first.route).toBe(expected);
    expect(second).toEqual(first);
    expect(first.planId).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.host).toEqual({ model: 'gpt-5.6-sol', effort: 'high', unchanged: true });
    expect(first.plan.sessions.length).toBeLessThanOrEqual(3);
    expect(first.plan.sessions.filter(({ model }) => model === 'fable')).toHaveLength(
      first.plan.sessions.some(({ model }) => model === 'fable') ? 1 : 0,
    );
    expect(first.plan.maxImmediateSessions).toBeLessThanOrEqual(1);
    expect(first.limits).toEqual({ maxClaudeSessions: 3, maxFableSessions: 1, maxDebateRounds: 2 });
    expect(first.launchesJobs).toBe(false);
  });

  test('binds each staged plan to a deterministic content digest', () => {
    const baseline = policy.route(input());
    const changed = policy.route(input({}, { contextProfile: { capsuleBytes: 12_001 } }));

    expect(policy.route(input()).planId).toBe(baseline.planId);
    expect(changed.planId).not.toBe(baseline.planId);
  });

  test('uses one stronger lead for broad high-overlap architecture context', () => {
    const result = policy.route(input({
      kind: 'architecture',
      scope: 'repo',
      ambiguity: 'high',
      novelty: 'high',
      risk: 'critical',
      parallelizable: true,
    }));

    expect(result.plan).toMatchObject({
      strategy: 'sequential-escalation',
      maxImmediateSessions: 1,
      maxTotalSessions: 2,
      sharedContextBytes: 12_000,
      replicatedContextBytesImmediate: 12_000,
      replicatedContextBytesAllActivated: 24_000,
      sessions: [
        expect.objectContaining({ model: 'opus', activation: 'immediate', contextPolicy: 'capsule' }),
        expect.objectContaining({ model: 'fable', activation: 'if-unresolved', contextPolicy: 'delta' }),
      ],
    });
  });

  test('forbids parallel starts when the task is not parallelizable', () => {
    const result = policy.route(input(
      { kind: 'review', scope: 'repo', risk: 'critical', parallelizable: false },
      {
        userMode: 'maximum',
        contextProfile: { independentJudgmentsRequired: true },
      },
    ));

    expect(result.plan.strategy).toBe('independent-panel');
    expect(result.plan.maxImmediateSessions).toBe(1);
    expect(result.plan.sessions.filter(({ activation }) => activation === 'immediate')).toHaveLength(1);
  });

  test('starts two independent panel members only when explicitly required and permitted', () => {
    const result = policy.route(input(
      { kind: 'review', scope: 'repo', risk: 'critical', parallelizable: true },
      {
        userMode: 'maximum',
        contextProfile: { independentJudgmentsRequired: true },
      },
    ));

    expect(result.plan).toMatchObject({
      strategy: 'independent-panel',
      maxImmediateSessions: 2,
      maxTotalSessions: 3,
      replicatedContextBytesImmediate: 24_000,
      replicatedContextBytesAllActivated: 36_000,
    });
    expect(result.plan.sessions.slice(0, 2)).toEqual([
      expect.objectContaining({ model: 'opus', activation: 'immediate', contextPolicy: 'capsule' }),
      expect.objectContaining({ model: 'sonnet', activation: 'immediate', contextPolicy: 'capsule' }),
    ]);
    expect(result.plan.sessions[2]).toEqual(
      expect.objectContaining({ model: 'fable', activation: 'if-contradiction' }),
    );
  });

  test('allows immediate parallel work only for named low-overlap disjoint scopes', () => {
    const result = policy.route(input(
      { kind: 'feature', scope: 'repo', writeRequired: true, testsRequired: true, parallelizable: true },
      {
        contextProfile: {
          overlap: 'low',
          partitionability: 'strong',
          partitions: ['api', 'storage'],
        },
      },
    ));

    expect(result.plan).toMatchObject({
      strategy: 'partitioned-parallel',
      maxImmediateSessions: 2,
      maxTotalSessions: 2,
    });
    expect(result.plan.sessions.map(({ activation, scope }) => ({ activation, scope }))).toEqual([
      { activation: 'immediate', scope: ['api'] },
      { activation: 'immediate', scope: ['storage'] },
    ]);
  });

  test('makes every extra generic session conditional and exposes exact capsule replication', () => {
    const result = policy.route(input(
      { kind: 'debug', scope: 'repo', ambiguity: 'high', risk: 'high', parallelizable: true },
      { contextProfile: { capsuleBytes: 32_769 } },
    ));

    expect(result.plan.maxImmediateSessions).toBe(1);
    expect(result.plan.sessions[0]?.activation).toBe('immediate');
    expect(result.plan.sessions.slice(1).every(({ activation }) => activation !== 'immediate')).toBe(true);
    expect(result.plan.replicatedContextBytesImmediate).toBe(
      32_769 * result.plan.maxImmediateSessions,
    );
    expect(result.plan.replicatedContextBytesAllActivated).toBe(
      32_769 * result.plan.maxTotalSessions,
    );
    expect(result.warnings).toContain(
      'The context capsule exceeds the 32768-byte default and will be duplicated by every activated fresh session.',
    );
    expect(result.plan.contextEstimateCaveat).toMatch(/not a token, cost, cache, or allowance estimate/iu);
  });

  test('enforces lower configured session and debate-round caps', () => {
    const constrained = new PolicyEngine({ maxPanelMembers: 1, maxDebateRounds: 1 });
    const result = constrained.route(input(
      { kind: 'review', risk: 'critical', parallelizable: true },
      { userMode: 'maximum', contextProfile: { independentJudgmentsRequired: true } },
    ));

    expect(result.plan.sessions).toHaveLength(1);
    expect(result.plan.maxImmediateSessions).toBe(1);
    expect(result.plan.maxTotalSessions).toBe(1);
    expect(result.limits).toEqual({
      maxClaudeSessions: 1,
      maxFableSessions: 1,
      maxDebateRounds: 1,
    });
  });

  test('validates the bounded strict public routing input', () => {
    expect(parseRouteInput(input())).toEqual(input());
    expect(() => parseRouteInput({ ...input(), extra: true })).toThrow();
    expect(() => parseRouteInput(input({}, { contextProfile: { capsuleBytes: 200_001 } }))).toThrow();
    expect(() => parseRouteInput(input({}, {
      contextProfile: { partitions: ['one', 'two', 'three', 'four'] },
    }))).toThrow();
  });
});
