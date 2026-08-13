import { describe, expect, test } from 'vitest';

import {
  assertJobId,
  assertTransition,
  parseContinueJobInput,
  parseStartJobInput,
} from '../src/domain.js';
import { PolicyEngine, type RouteInput } from '../src/policy.js';

const validStart = {
  task: 'Review the storage boundary.',
  cwd: '/tmp/hydra-repository',
  model: 'sonnet',
  effort: 'high',
  role: 'adversarial reviewer',
  accessMode: 'analyze',
} as const;

const routeInput: RouteInput = {
  taskProfile: {
    kind: 'review',
    scope: 'repo',
    ambiguity: 'high',
    novelty: 'medium',
    risk: 'critical',
    writeRequired: false,
    testsRequired: true,
    parallelizable: false,
  },
  contextProfile: {
    capsuleBytes: 12_000,
    overlap: 'high',
    partitionability: 'none',
    independentJudgmentsRequired: false,
    partitions: [],
  },
  userMode: 'auto',
};

describe('start job input', () => {
  test('applies secure defaults', () => {
    expect(parseStartJobInput(validStart)).toEqual({
      ...validStart,
      maxTurns: 12,
      timeoutSec: 1_800,
      strictModel: false,
    });
  });

  test('rejects a task that is empty after trimming', () => {
    expect(() => parseStartJobInput({ ...validStart, task: ' \n\t ' })).toThrowError(/task/i);
  });

  test('rejects a task larger than 200000 UTF-8 bytes', () => {
    expect(() => parseStartJobInput({ ...validStart, task: 'é'.repeat(100_001) })).toThrowError(
      /200000 bytes/i,
    );
  });

  test('rejects a relative working directory', () => {
    expect(() => parseStartJobInput({ ...validStart, cwd: '../repository' })).toThrowError(
      /absolute/i,
    );
  });

  test('accepts a full Claude model identifier', () => {
    const parsed = parseStartJobInput({ ...validStart, model: 'claude-opus-4-1-20250805' });

    expect(parsed.model).toBe('claude-opus-4-1-20250805');
  });

  test('rejects a model identifier containing whitespace', () => {
    expect(() => parseStartJobInput({ ...validStart, model: 'sonnet latest' })).toThrowError(
      /model/i,
    );
  });

  test.each([
    'default',
    'haiku',
    'foo',
    'claude-haiku-4-5',
    'claude-sonnet-latest',
    'claude-opus-gateway',
    'claude-sonnet-5gateway',
    'claude-opus-4..1',
    'claude-fable-5-beta',
  ]) (
    'rejects unsupported or implicit model %s',
    (model) => {
      expect(() => parseStartJobInput({ ...validStart, model })).toThrowError(/model/i);
    },
  );

  test('rejects the removed native context mode', () => {
    expect(() => parseStartJobInput({ ...validStart, contextMode: 'native' })).toThrowError(
      /unrecognized|contextMode/i,
    );
  });

  test('accepts a delegation activation bound to a route-plan digest', () => {
    const planId = new PolicyEngine().route(routeInput).planId;
    const parsed = parseStartJobInput({
      ...validStart,
      model: 'opus',
      effort: 'xhigh',
      role: 'pre-merge adversarial reviewer',
      delegation: {
        routeInput,
        planId,
        sessionIndex: 0,
        activationReason: 'Initial high-risk review lead.',
      },
    });

    expect(parsed.delegation).toMatchObject({ planId, sessionIndex: 0 });
  });

  test('rejects malformed delegation activation metadata', () => {
    expect(() =>
      parseStartJobInput({
        ...validStart,
        delegation: {
          routeInput,
          planId: 'not-a-plan-digest',
          sessionIndex: 3,
          activationReason: '',
        },
      }),
    ).toThrowError(/delegation|planId|sessionIndex|activationReason/i);
  });

  test('rejects an unsupported effort', () => {
    expect(() => parseStartJobInput({ ...validStart, effort: 'ultra' })).toThrowError(/effort/i);
  });

  test.each([0, 101, 1.5])('rejects maxTurns=%s', (maxTurns) => {
    expect(() => parseStartJobInput({ ...validStart, maxTurns })).toThrowError(/maxTurns/i);
  });

  test.each([0, 86_401, 1.5])('rejects timeoutSec=%s', (timeoutSec) => {
    expect(() => parseStartJobInput({ ...validStart, timeoutSec })).toThrowError(/timeoutSec/i);
  });

  test('rejects an output schema larger than 100000 UTF-8 bytes', () => {
    expect(() =>
      parseStartJobInput({
        ...validStart,
        outputSchema: { description: 'x'.repeat(100_001) },
      }),
    ).toThrowError(/outputSchema/i);
  });

  test('rejects unknown fields', () => {
    expect(() => parseStartJobInput({ ...validStart, fallbackModel: 'opus' })).toThrowError(
      /unrecognized|unknown/i,
    );
  });
});

describe('continue job input', () => {
  test('accepts a UUID session and optional overrides', () => {
    expect(
      parseContinueJobInput({
        sessionId: '6c6c4fc8-e0fc-41bb-b8f2-561bed30e6f6',
        message: 'Check the failed assertion.',
        effort: 'xhigh',
        outputSchema: { type: 'object' },
      }),
    ).toEqual({
      sessionId: '6c6c4fc8-e0fc-41bb-b8f2-561bed30e6f6',
      message: 'Check the failed assertion.',
      effort: 'xhigh',
      outputSchema: { type: 'object' },
    });
  });

  test('rejects a non-UUID session identifier', () => {
    expect(() =>
      parseContinueJobInput({ sessionId: '../session', message: 'Continue.' }),
    ).toThrowError(/sessionId/i);
  });
});

describe('managed identifiers and job states', () => {
  test('rejects path traversal as a job identifier', () => {
    expect(() => assertJobId('../escape')).toThrowError(/jobId/i);
  });

  test('accepts the queued to running transition', () => {
    expect(() => assertTransition('queued', 'running')).not.toThrow();
  });

  test('rejects a transition out of a terminal state', () => {
    expect(() => assertTransition('completed', 'running')).toThrowError(/completed.*running/i);
  });
});
