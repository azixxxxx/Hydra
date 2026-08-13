import { z } from 'zod';

import type {
  Effort,
  ReportedUsage,
  TokenFeatureVector,
  StartJobInput,
} from './domain.js';

const RATE_SCALE = 1_000_000n;

export function usageFeaturesForStart(input: StartJobInput): TokenFeatureVector {
  return {
    promptBytes: Buffer.byteLength(input.task, 'utf8'),
    roleBytes: Buffer.byteLength(input.role, 'utf8'),
    schemaBytes:
      input.outputSchema === undefined
        ? 0
        : Buffer.byteLength(JSON.stringify(input.outputSchema), 'utf8'),
    referencedBytes: input.delegation?.routeInput.contextProfile.capsuleBytes ?? 0,
    expectedTurns: input.maxTurns,
    toolClass: input.accessMode,
  };
}

export interface UsageCandidate {
  readonly resolvedModel: string;
  readonly claudeVersion: string;
  readonly effort: Effort;
  readonly features: TokenFeatureVector;
}

export interface UsageObservation extends UsageCandidate {
  readonly usage: ReportedUsage;
  readonly completedAt: string;
}

export interface UsageUpperRates {
  readonly inputTokensPerContextByte?: number;
  readonly outputTokensPerTurn?: number;
  readonly cacheReadTokensPerContextByte?: number;
  readonly cacheCreationTokensPerContextByte?: number;
}

export interface LocalUsageForecast {
  readonly calibrated: boolean;
  readonly cohortKey: string;
  readonly sampleCount: number;
  readonly empiricalQuantileBasisPoints: 9_500;
  readonly orderStatisticCoverageBasisPoints: number;
  readonly predictedUsage: ReportedUsage;
  readonly upperRatesPerMillion: UsageUpperRates;
  readonly invalidationReason?: 'INSUFFICIENT_COHORT_SAMPLES';
}

/**
 * Expected coverage of the sample maximum for the next exchangeable observation.
 * This is deliberately reported separately from the selected empirical quantile.
 */
export function orderStatisticCoverageBasisPoints(sampleCount: number): number {
  const parsed = z.number().int().nonnegative().parse(sampleCount);
  return parsed === 0 ? 0 : Math.floor((10_000 * parsed) / (parsed + 1));
}

function contextBytes(features: TokenFeatureVector): number {
  return (
    features.promptBytes +
    features.roleBytes +
    features.schemaBytes +
    features.referencedBytes
  );
}

function contextClass(bytes: number): 'empty' | 'small' | 'medium' | 'large' {
  if (bytes === 0) {
    return 'empty';
  }
  if (bytes <= 8_192) {
    return 'small';
  }
  if (bytes <= 32_768) {
    return 'medium';
  }
  return 'large';
}

function turnClass(turns: number): 'short' | 'medium' | 'long' {
  if (turns <= 4) {
    return 'short';
  }
  if (turns <= 12) {
    return 'medium';
  }
  return 'long';
}

export function usageCohortKey(candidate: UsageCandidate): string {
  return JSON.stringify([
    candidate.resolvedModel,
    candidate.claudeVersion,
    candidate.effort,
    candidate.features.toolClass,
    contextClass(contextBytes(candidate.features)),
    turnClass(candidate.features.expectedTurns),
  ]);
}

function ceilRatioPerMillion(value: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Number(
    (BigInt(Math.ceil(value)) * RATE_SCALE + BigInt(denominator) - 1n) /
      BigInt(denominator),
  );
}

function predictFromRate(rate: number | undefined, denominator: number): number | undefined {
  if (rate === undefined) {
    return undefined;
  }
  return Number(
    (BigInt(rate) * BigInt(denominator) + RATE_SCALE - 1n) / RATE_SCALE,
  );
}

function q95(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((sorted.length * 9_500) / 10_000));
  return sorted[rank - 1];
}

function validMetric(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

export class LocalUsageForecaster {
  readonly #minimumSamples: number;

  public constructor(options: { readonly minimumSamples: number }) {
    this.#minimumSamples = z.number().int().min(3).max(100).parse(options.minimumSamples);
  }

  public forecast(
    candidate: UsageCandidate,
    observations: readonly UsageObservation[],
  ): LocalUsageForecast {
    const cohortKey = usageCohortKey(candidate);
    const samples = observations.filter(
      (observation) => usageCohortKey(observation) === cohortKey,
    );
    if (samples.length < this.#minimumSamples) {
      return {
        calibrated: false,
        cohortKey,
        sampleCount: samples.length,
        empiricalQuantileBasisPoints: 9_500,
        orderStatisticCoverageBasisPoints: orderStatisticCoverageBasisPoints(samples.length),
        predictedUsage: {},
        upperRatesPerMillion: {},
        invalidationReason: 'INSUFFICIENT_COHORT_SAMPLES',
      };
    }

    const ratesFor = (
      metric: keyof Pick<
        ReportedUsage,
        'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'
      >,
      denominator: (observation: UsageObservation) => number,
    ): number | undefined =>
      q95(
        samples.flatMap((observation) => {
          const value = observation.usage[metric];
          return validMetric(value)
            ? [ceilRatioPerMillion(value, denominator(observation))]
            : [];
        }),
      );

    const inputRate = ratesFor('inputTokens', ({ features }) => contextBytes(features));
    const outputRate = ratesFor('outputTokens', ({ features }) => features.expectedTurns);
    const cacheReadRate = ratesFor('cacheReadTokens', ({ features }) => contextBytes(features));
    const cacheCreationRate = ratesFor(
      'cacheCreationTokens',
      ({ features }) => contextBytes(features),
    );
    const candidateContextBytes = contextBytes(candidate.features);
    const inputTokens = predictFromRate(inputRate, candidateContextBytes);
    const outputTokens = predictFromRate(outputRate, candidate.features.expectedTurns);
    const cacheReadTokens = predictFromRate(cacheReadRate, candidateContextBytes);
    const cacheCreationTokens = predictFromRate(cacheCreationRate, candidateContextBytes);
    return {
      calibrated: true,
      cohortKey,
      sampleCount: samples.length,
      empiricalQuantileBasisPoints: 9_500,
      orderStatisticCoverageBasisPoints: orderStatisticCoverageBasisPoints(samples.length),
      predictedUsage: {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
        ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
      },
      upperRatesPerMillion: {
        ...(inputRate === undefined ? {} : { inputTokensPerContextByte: inputRate }),
        ...(outputRate === undefined ? {} : { outputTokensPerTurn: outputRate }),
        ...(cacheReadRate === undefined
          ? {}
          : { cacheReadTokensPerContextByte: cacheReadRate }),
        ...(cacheCreationRate === undefined
          ? {}
          : { cacheCreationTokensPerContextByte: cacheCreationRate }),
      },
    };
  }
}
