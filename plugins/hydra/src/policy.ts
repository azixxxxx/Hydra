import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { Effort } from './domain.js';
import { RouteInputSchema, type RouteInput } from './routing-contract.js';

export { RouteInputSchema, type RouteInput } from './routing-contract.js';

export const ROUTE_NAMES = [
  'FAST',
  'STANDARD',
  'HARD_DEBUG',
  'ARCHITECTURE',
  'LONG_HORIZON_UNKNOWN',
  'PRE_MERGE_HIGH_RISK',
  'MAXIMUM',
] as const;
export type RouteName = (typeof ROUTE_NAMES)[number];

export type DelegationStrategy =
  | 'none'
  | 'single'
  | 'sequential-escalation'
  | 'partitioned-parallel'
  | 'independent-panel';

export type SessionActivation = 'immediate' | 'if-unresolved' | 'if-contradiction' | 'manual';

export const SessionRecommendationSchema = z
  .object({
    model: z.enum(['fable', 'opus', 'sonnet']),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    role: z.string().min(1).max(2_000),
    activation: z.enum(['immediate', 'if-unresolved', 'if-contradiction', 'manual']),
    distinctQuestion: z.string().min(1).max(2_000),
    scope: z.array(z.string().min(1).max(500)).max(3),
    contextPolicy: z.enum(['capsule', 'delta']),
  })
  .strict();

export interface SessionRecommendation {
  readonly model: 'fable' | 'opus' | 'sonnet';
  readonly effort: Effort;
  readonly role: string;
  readonly activation: SessionActivation;
  readonly distinctQuestion: string;
  readonly scope: readonly string[];
  readonly contextPolicy: 'capsule' | 'delta';
}

export interface DelegationPlan {
  readonly strategy: DelegationStrategy;
  readonly maxImmediateSessions: number;
  readonly maxTotalSessions: number;
  readonly sharedContextBytes: number;
  readonly replicatedContextBytesImmediate: number;
  readonly replicatedContextBytesAllActivated: number;
  readonly contextEstimateCaveat: string;
  readonly sessions: readonly SessionRecommendation[];
}

export const DelegationPlanSchema = z
  .object({
    strategy: z.enum([
      'none',
      'single',
      'sequential-escalation',
      'partitioned-parallel',
      'independent-panel',
    ]),
    maxImmediateSessions: z.number().int().min(0).max(3),
    maxTotalSessions: z.number().int().min(0).max(3),
    sharedContextBytes: z.number().int().min(0).max(200_000),
    replicatedContextBytesImmediate: z.number().int().min(0).max(600_000),
    replicatedContextBytesAllActivated: z.number().int().min(0).max(600_000),
    contextEstimateCaveat: z.string().min(1).max(2_000),
    sessions: z.array(SessionRecommendationSchema).max(3),
  })
  .strict();

export const LegacyDelegationPlanSchema = z
  .object({
    strategy: z.enum([
      'none',
      'single',
      'sequential-escalation',
      'partitioned-parallel',
      'independent-panel',
    ]),
    maxImmediateSessions: z.number().int().min(0).max(3),
    maxTotalSessions: z.number().int().min(0).max(3),
    sharedContextBytes: z.number().int().min(0).max(200_000),
    replicatedContextBytesLowerBound: z.number().int().min(0).max(600_000),
    contextEstimateCaveat: z.string().min(1).max(2_000),
    sessions: z.array(SessionRecommendationSchema).max(3),
  })
  .strict();

export const PersistedDelegationPlanInputSchema = z.union([
  DelegationPlanSchema,
  LegacyDelegationPlanSchema,
]);

export const PersistedDelegationPlanSchema = PersistedDelegationPlanInputSchema
  .transform((value): DelegationPlan => {
    if ('replicatedContextBytesImmediate' in value) {
      return value;
    }
    return {
      strategy: value.strategy,
      maxImmediateSessions: value.maxImmediateSessions,
      maxTotalSessions: value.maxTotalSessions,
      sharedContextBytes: value.sharedContextBytes,
      replicatedContextBytesImmediate:
        value.sharedContextBytes * value.maxImmediateSessions,
      replicatedContextBytesAllActivated: value.replicatedContextBytesLowerBound,
      contextEstimateCaveat: value.contextEstimateCaveat,
      sessions: value.sessions,
    };
  });

export interface RouteRecommendation {
  readonly planId: string;
  readonly route: RouteName;
  readonly rationale: readonly string[];
  readonly plan: DelegationPlan;
  readonly host: {
    readonly model?: string;
    readonly effort?: string;
    readonly unchanged: true;
  };
  readonly limits: {
    readonly maxClaudeSessions: number;
    readonly maxFableSessions: 1;
    readonly maxDebateRounds: number;
  };
  readonly warnings: readonly string[];
  readonly launchesJobs: false;
}

export const RouteRecommendationSchema = z
  .object({
    planId: z.string().regex(/^[a-f0-9]{64}$/u),
    route: z.enum(ROUTE_NAMES),
    rationale: z.array(z.string().min(1).max(2_000)).max(20),
    plan: DelegationPlanSchema,
    host: z
      .object({
        model: z.string().min(1).max(256).optional(),
        effort: z.string().min(1).max(64).optional(),
        unchanged: z.literal(true),
      })
      .strict(),
    limits: z
      .object({
        maxClaudeSessions: z.number().int().min(1).max(3),
        maxFableSessions: z.literal(1),
        maxDebateRounds: z.number().int().min(1).max(2),
      })
      .strict(),
    warnings: z.array(z.string().max(20_000)).max(100),
    launchesJobs: z.literal(false),
  })
  .strict();

export interface PolicyEngineLimits {
  readonly maxPanelMembers: number;
  readonly maxDebateRounds: number;
}

const PolicyEngineLimitsSchema = z.object({
  maxPanelMembers: z.number().int().min(1).max(3),
  maxDebateRounds: z.number().int().min(1).max(2),
});

const DEFAULT_POLICY_LIMITS: PolicyEngineLimits = Object.freeze({
  maxPanelMembers: 3,
  maxDebateRounds: 2,
});

const CONTEXT_CAVEAT =
  'Exact UTF-8 capsule-byte replication only; this is not a token, cost, cache, or allowance estimate.';

export function parseRouteInput(value: unknown): RouteInput {
  return RouteInputSchema.parse(value);
}

function uncertaintyIsHigh(profile: RouteInput['taskProfile']): boolean {
  return profile.ambiguity === 'high' || profile.novelty === 'high' || profile.risk === 'critical';
}

function session(
  model: SessionRecommendation['model'],
  effort: Effort,
  role: string,
  activation: SessionActivation,
  distinctQuestion: string,
  scope: readonly string[],
  contextPolicy: SessionRecommendation['contextPolicy'],
): SessionRecommendation {
  return { model, effort, role, activation, distinctQuestion, scope, contextPolicy };
}

function routeName(input: RouteInput): RouteName {
  const profile = input.taskProfile;
  if (input.userMode === 'maximum' || input.userMode === 'burn') {
    return 'MAXIMUM';
  }
  if (profile.kind === 'review' && profile.risk === 'critical') {
    return 'PRE_MERGE_HIGH_RISK';
  }
  if (
    (profile.kind === 'research' || profile.kind === 'migration') &&
    profile.ambiguity === 'high' &&
    profile.novelty === 'high'
  ) {
    return 'LONG_HORIZON_UNKNOWN';
  }
  if (profile.kind === 'architecture') {
    return 'ARCHITECTURE';
  }
  if (
    profile.kind === 'debug' &&
    (profile.ambiguity === 'high' || profile.risk === 'high' || profile.risk === 'critical')
  ) {
    return 'HARD_DEBUG';
  }
  const standardJustified =
    input.userMode === 'standard' ||
    profile.risk !== 'low' ||
    profile.scope !== 'local' ||
    profile.writeRequired ||
    profile.testsRequired ||
    profile.kind !== 'routine';
  return standardJustified ? 'STANDARD' : 'FAST';
}

function boundedSessions(
  input: RouteInput,
  limits: PolicyEngineLimits,
  sessions: readonly SessionRecommendation[],
): SessionRecommendation[] {
  const firstFable = sessions.findIndex(({ model }) => model === 'fable');
  const uniqueFable = sessions.filter(
    ({ model }, index) => model !== 'fable' || index === firstFable,
  );
  let immediateSeen = false;
  return uniqueFable.slice(0, limits.maxPanelMembers).map((candidate) => {
    if (candidate.activation !== 'immediate') {
      return candidate;
    }
    if (!input.taskProfile.parallelizable && immediateSeen) {
      return { ...candidate, activation: 'manual' };
    }
    immediateSeen = true;
    return candidate;
  });
}

function recommendation(
  input: RouteInput,
  limits: PolicyEngineLimits,
  route: RouteName,
  rationale: readonly string[],
  strategy: DelegationStrategy,
  proposedSessions: readonly SessionRecommendation[],
  additionalWarnings: readonly string[] = [],
): RouteRecommendation {
  const sessions = boundedSessions(input, limits, proposedSessions);
  const immediateSessions = sessions.filter(({ activation }) => activation === 'immediate').length;
  const warnings = [
    ...additionalWarnings,
    ...(input.contextProfile.capsuleBytes > 32_768
      ? [
          'The context capsule exceeds the 32768-byte default and will be duplicated by every activated fresh session.',
        ]
      : []),
  ];
  const plan: DelegationPlan = {
      strategy: sessions.length === 0 ? 'none' : sessions.length === 1 ? 'single' : strategy,
      maxImmediateSessions: immediateSessions,
      maxTotalSessions: sessions.length,
      sharedContextBytes: input.contextProfile.capsuleBytes,
      replicatedContextBytesImmediate:
        input.contextProfile.capsuleBytes * immediateSessions,
      replicatedContextBytesAllActivated:
        input.contextProfile.capsuleBytes * sessions.length,
      contextEstimateCaveat: CONTEXT_CAVEAT,
      sessions,
  };
  const effectiveLimits = {
    maxClaudeSessions: limits.maxPanelMembers,
    maxFableSessions: 1 as const,
    maxDebateRounds: limits.maxDebateRounds,
  };
  const planId = createHash('sha256')
    .update(JSON.stringify({ routeInput: input, route, plan, limits: effectiveLimits }), 'utf8')
    .digest('hex');
  return {
    planId,
    route,
    rationale,
    plan,
    host: {
      ...(input.hostModel === undefined ? {} : { model: input.hostModel }),
      ...(input.hostEffort === undefined ? {} : { effort: input.hostEffort }),
      unchanged: true,
    },
    limits: effectiveLimits,
    warnings,
    launchesJobs: false,
  };
}

function taskScope(input: RouteInput): string[] {
  return [`${input.taskProfile.scope}:${input.taskProfile.kind}`];
}

export class PolicyEngine {
  readonly #limits: PolicyEngineLimits;

  public constructor(limits: Partial<PolicyEngineLimits> = {}) {
    this.#limits = PolicyEngineLimitsSchema.parse({ ...DEFAULT_POLICY_LIMITS, ...limits });
  }

  public route(value: RouteInput): RouteRecommendation {
    const input = parseRouteInput(value);
    const profile = input.taskProfile;
    const context = input.contextProfile;
    const selectedRoute = routeName(input);
    const scope = taskScope(input);

    if (context.independentJudgmentsRequired) {
      return recommendation(
        input,
        this.#limits,
        selectedRoute,
        ['The caller explicitly requires independent judgments; parallel activation still obeys task parallelizability.'],
        'independent-panel',
        [
          session('opus', 'xhigh', 'independent lead judgment', 'immediate', 'What is the strongest repository-grounded answer?', scope, 'capsule'),
          session('sonnet', 'xhigh', 'independent falsification', 'immediate', 'Which lead assumptions fail under direct evidence?', scope, 'capsule'),
          session('fable', 'max', 'missing-perspective review', 'if-contradiction', 'Which unresolved long-horizon assumption changes the verdict?', scope, 'capsule'),
        ],
        input.userMode === 'burn'
          ? ['Burn mode cannot bypass the independent-panel or session hard limits.']
          : [],
      );
    }

    if (
      profile.parallelizable &&
      context.overlap === 'low' &&
      context.partitionability === 'strong' &&
      context.partitions.length >= 2
    ) {
      return recommendation(
        input,
        this.#limits,
        selectedRoute,
        ['Named, strongly partitionable, low-overlap scopes permit bounded parallel activation.'],
        'partitioned-parallel',
        context.partitions.map((partition, index) =>
          session(
            'sonnet',
            profile.risk === 'critical' ? 'xhigh' : 'high',
            `scoped ${partition} investigation`,
            'immediate',
            `What must change or be verified inside ${partition}?`,
            [partition],
            index === 0 ? 'capsule' : 'delta',
          ),
        ),
      );
    }

    if (selectedRoute === 'MAXIMUM') {
      const longHorizon =
        (profile.kind === 'research' || profile.kind === 'migration') && profile.novelty === 'high';
      return recommendation(
        input,
        this.#limits,
        selectedRoute,
        ['Maximum mode raises justified reasoning quality while keeping additional sessions conditional.'],
        'sequential-escalation',
        longHorizon
          ? [
              session('fable', 'max', 'long-horizon lead analysis', 'immediate', 'Which assumptions and alternatives govern the decision?', scope, 'capsule'),
              session('opus', 'xhigh', 'adversarial decision review', 'if-contradiction', 'Does repository evidence falsify the proposed direction?', scope, 'delta'),
            ]
          : [
              session('opus', 'xhigh', 'strong lead analysis', 'immediate', 'What is the complete repository-grounded solution?', scope, 'capsule'),
              session('sonnet', 'xhigh', 'targeted implementation check', 'if-unresolved', 'Which concrete implementation or test gap remains unresolved?', scope, 'delta'),
              session('fable', 'max', 'assumption review', 'if-contradiction', 'Which core assumption could reverse the lead conclusion?', scope, 'delta'),
            ],
        input.userMode === 'burn'
          ? ['Burn mode activates no extra session without a distinct unresolved question.']
          : [],
      );
    }

    if (selectedRoute === 'PRE_MERGE_HIGH_RISK') {
      const sessions: SessionRecommendation[] = [
        session('opus', 'xhigh', 'adversarial pre-merge lead review', 'immediate', 'Is the change safe to merge under repository evidence?', scope, 'capsule'),
        session('sonnet', 'high', 'targeted regression review', 'if-contradiction', 'Which testable regression contradicts the lead verdict?', scope, 'delta'),
      ];
      if (uncertaintyIsHigh(profile)) {
        sessions.push(session('fable', 'xhigh', 'core-assumption review', 'if-unresolved', 'Which unresolved assumption changes merge safety?', scope, 'delta'));
      }
      return recommendation(
        input,
        this.#limits,
        selectedRoute,
        ['A critical review starts with one strong adversarial verdict; extra perspectives require a named gap.'],
        'sequential-escalation',
        sessions,
      );
    }

    if (selectedRoute === 'LONG_HORIZON_UNKNOWN') {
      return recommendation(
        input,
        this.#limits,
        selectedRoute,
        ['High novelty and ambiguity justify a Fable lead followed only by conditional verification.'],
        'sequential-escalation',
        [
          session('fable', 'max', 'assumption and alternative lead', 'immediate', 'Which long-horizon assumptions and alternatives matter?', scope, 'capsule'),
          session('opus', 'high', 'selected-direction verification', 'if-contradiction', 'Does evidence invalidate the selected direction?', scope, 'delta'),
        ],
      );
    }

    if (selectedRoute === 'ARCHITECTURE') {
      const sessions: SessionRecommendation[] = [
        session('opus', 'xhigh', 'architecture lead', 'immediate', 'What architecture best satisfies the verified constraints?', scope, 'capsule'),
      ];
      if (uncertaintyIsHigh(profile)) {
        sessions.push(session('fable', profile.novelty === 'high' ? 'max' : 'xhigh', 'architecture assumption review', 'if-unresolved', 'Which unresolved assumption warrants a different architecture?', scope, 'delta'));
      }
      return recommendation(
        input,
        this.#limits,
        selectedRoute,
        ['Broad architecture context uses one Opus lead; Fable activates only for a distinct unresolved assumption.'],
        'sequential-escalation',
        sessions,
      );
    }

    if (selectedRoute === 'HARD_DEBUG') {
      const broadHighOverlap = profile.scope === 'repo' && context.overlap === 'high';
      return recommendation(
        input,
        this.#limits,
        selectedRoute,
        [broadHighOverlap
          ? 'Broad high-overlap debugging uses one Opus lead to avoid duplicating the full context across generic sessions.'
          : 'The defect starts with one focused investigation and escalates only if unresolved.'],
        'sequential-escalation',
        broadHighOverlap
          ? [
              session('opus', 'xhigh', 'root-cause lead', 'immediate', 'What root cause explains all reproduced evidence?', scope, 'capsule'),
              session('sonnet', 'xhigh', 'targeted reproduction check', 'if-unresolved', 'Which concrete reproduction remains unexplained?', scope, 'delta'),
            ]
          : [
              session('sonnet', 'xhigh', 'root-cause investigation', 'immediate', 'What minimal reproduction identifies the root cause?', scope, 'capsule'),
              session('opus', 'xhigh', 'escalated risk review', 'if-unresolved', 'Which unresolved systemic risk changes the fix?', scope, 'delta'),
            ],
      );
    }

    if (selectedRoute === 'STANDARD') {
      return recommendation(
        input,
        this.#limits,
        selectedRoute,
        ['Scope, risk, or verification needs justify one bounded Sonnet session.'],
        'single',
        [session('sonnet', 'high', 'implementation and evidence review', 'immediate', 'What concrete finding or change is supported by repository evidence?', scope, 'capsule')],
      );
    }

    return recommendation(
      input,
      this.#limits,
      'FAST',
      ['The task is local, routine, low-risk, and does not justify external delegation.'],
      'none',
      [],
    );
  }
}
