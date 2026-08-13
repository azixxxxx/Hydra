import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import {
  BUDGET_MODES,
  UsageBudgetSnapshotSchema,
  type UsageBudgetSnapshot,
} from './budget.js';
import {
  AllowanceObservationSchema,
  allowanceObservationId,
  type AllowanceObservation,
} from './calibration.js';
import { HydraError } from './domain.js';
import { assertCredentialFree } from './credential-shapes.js';
import {
  atomicCreateJson,
  atomicWriteJson,
  resolveManagedPath,
} from './platform/atomic-files.js';

const SnapshotIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const JobIdSchema = z.string().uuid();
export const BudgetSnapshotRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: SnapshotIdSchema,
    snapshot: UsageBudgetSnapshotSchema,
    recordedAt: z.iso.datetime(),
  })
  .strict();
const ActiveBudgetPointerSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: SnapshotIdSchema,
    capturedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const BudgetReservationBucketSchema = z
  .object({
    bucketId: z.string().trim().min(1).max(200),
    basisPoints: z.number().int().min(0).max(10_000),
  })
  .strict();

export const BudgetReservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: JobIdSchema,
    snapshotId: SnapshotIdSchema.optional(),
    cohortKey: z.string().min(1).max(2_000),
    mode: z.enum(BUDGET_MODES),
    admission: z.enum(['admit', 'defer', 'quality-floor-only', 'no-valuable-work']),
    priority: z.enum(['quality-floor', 'opportunistic']),
    forecastCalibrated: z.boolean(),
    forecastSampleCount: z.number().int().nonnegative(),
    forecastEmpiricalQuantileBasisPoints: z.number().int().min(0).max(10_000),
    forecastOrderStatisticCoverageBasisPoints: z.number().int().min(0).max(10_000),
    reasons: z.array(z.string().min(1).max(500)).max(20),
    buckets: z.array(BudgetReservationBucketSchema).max(20),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const identifiers = value.buckets.map(({ bucketId }) => bucketId);
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: 'custom',
        path: ['buckets'],
        message: 'reservation bucket IDs must be unique',
      });
    }
  });

export const BudgetReservationReleaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: JobIdSchema,
    reason: z.enum(['creation-failed', 'terminal']),
    releasedAt: z.iso.datetime(),
  })
  .strict();

export type BudgetSnapshotRecord = z.infer<typeof BudgetSnapshotRecordSchema>;
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;
export type BudgetReservationRelease = z.infer<typeof BudgetReservationReleaseSchema>;

export interface BudgetStoreDependencies {
  readonly stateRoot: string;
  readonly now?: () => Date;
}

export interface BudgetStoreHealth {
  readonly state: 'ok' | 'degraded';
  readonly issues: readonly {
    readonly code: string;
    readonly message: string;
    readonly count?: number;
  }[];
}

function snapshotIdentifier(snapshot: UsageBudgetSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
}

export class BudgetStore {
  readonly #root: string;
  readonly #snapshotsRoot: string;
  readonly #calibrationRoot: string;
  readonly #reservationsRoot: string;
  readonly #reservationReleasesRoot: string;
  readonly #now: () => Date;

  public constructor(dependencies: BudgetStoreDependencies) {
    this.#root = join(dependencies.stateRoot, 'budget');
    this.#snapshotsRoot = join(this.#root, 'snapshots');
    this.#calibrationRoot = join(this.#root, 'calibration');
    this.#reservationsRoot = join(this.#root, 'reservations');
    this.#reservationReleasesRoot = join(this.#root, 'reservation-releases');
    this.#now = dependencies.now ?? ((): Date => new Date());
  }

  public async record(value: UsageBudgetSnapshot): Promise<BudgetSnapshotRecord> {
    const snapshot = UsageBudgetSnapshotSchema.parse(value);
    assertCredentialFree(snapshot);
    const now = this.#now();
    if (Date.parse(snapshot.capturedAt) > now.getTime()) {
      throw new HydraError(
        'BUDGET_SNAPSHOT_FUTURE',
        'A manual budget snapshot cannot be captured in the future',
      );
    }
    const snapshotId = snapshotIdentifier(snapshot);
    const record: BudgetSnapshotRecord = {
      schemaVersion: 1,
      snapshotId,
      snapshot,
      recordedAt: now.toISOString(),
    };
    try {
      await atomicCreateJson(this.#snapshotPath(snapshotId), record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const existing = await this.#readRecord(snapshotId);
      if (JSON.stringify(existing.snapshot) !== JSON.stringify(snapshot)) {
        throw new HydraError(
          'BUDGET_SNAPSHOT_ID_CONFLICT',
          'An immutable budget snapshot identifier has conflicting content',
        );
      }
    }

    const active = await this.active();
    if (
      active === undefined ||
      Date.parse(snapshot.capturedAt) > Date.parse(active.snapshot.capturedAt)
    ) {
      await atomicWriteJson(this.#activePath(), {
        schemaVersion: 1,
        snapshotId,
        capturedAt: snapshot.capturedAt,
        updatedAt: now.toISOString(),
      });
    }
    return this.#readRecord(snapshotId);
  }

  public async active(): Promise<BudgetSnapshotRecord | undefined> {
    let pointer;
    try {
      pointer = ActiveBudgetPointerSchema.parse(
        JSON.parse(await readFile(this.#activePath(), 'utf8')) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw new HydraError(
        'BUDGET_STATE_CORRUPT',
        'The active budget snapshot pointer is invalid',
      );
    }
    const record = await this.#readRecord(pointer.snapshotId);
    if (record.snapshot.capturedAt !== pointer.capturedAt) {
      throw new HydraError(
        'BUDGET_STATE_CORRUPT',
        'The active budget pointer conflicts with immutable snapshot content',
      );
    }
    return record;
  }

  public async history(): Promise<readonly BudgetSnapshotRecord[]> {
    let names: string[];
    try {
      names = (await readdir(this.#snapshotsRoot)).filter((name) =>
        /^[a-f0-9]{64}\.json$/u.test(name),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const records = await Promise.all(
      names.map(async (name) => this.#readRecord(name.slice(0, -'.json'.length))),
    );
    return records.sort(
      (left, right) =>
        left.snapshot.capturedAt.localeCompare(right.snapshot.capturedAt) ||
        left.snapshotId.localeCompare(right.snapshotId),
    );
  }

  public async recordObservation(value: AllowanceObservation): Promise<AllowanceObservation> {
    const observation = AllowanceObservationSchema.parse(value);
    assertCredentialFree(observation);
    const { observationId, ...body } = observation;
    if (allowanceObservationId(body) !== observationId) {
      throw new HydraError(
        'BUDGET_OBSERVATION_ID_MISMATCH',
        'Allowance observation content does not match its identifier',
      );
    }
    try {
      await atomicCreateJson(this.#observationPath(observationId), observation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const existing = await this.#readObservation(observationId);
      if (JSON.stringify(existing) !== JSON.stringify(observation)) {
        throw new HydraError(
          'BUDGET_OBSERVATION_ID_CONFLICT',
          'An immutable allowance observation identifier has conflicting content',
        );
      }
    }
    return this.#readObservation(observationId);
  }

  public async observations(): Promise<readonly AllowanceObservation[]> {
    const identifiers = await this.#identifiers(this.#calibrationRoot);
    const observations = await Promise.all(
      identifiers.map(async (identifier) => this.#readObservation(identifier)),
    );
    return observations.sort(
      (left, right) =>
        left.observedAt.localeCompare(right.observedAt) ||
        left.observationId.localeCompare(right.observationId),
    );
  }

  public async reserve(
    value: Omit<BudgetReservation, 'schemaVersion' | 'createdAt'>,
  ): Promise<BudgetReservation> {
    const reservation = BudgetReservationSchema.parse({
      schemaVersion: 1,
      ...value,
      createdAt: this.#now().toISOString(),
    });
    assertCredentialFree(reservation);
    try {
      await atomicCreateJson(this.#reservationPath(reservation.jobId), reservation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const existing = await this.#readReservation(reservation.jobId);
      if (JSON.stringify(existing) !== JSON.stringify(reservation)) {
        throw new HydraError(
          'BUDGET_RESERVATION_CONFLICT',
          'A quota reservation already exists for this job',
        );
      }
    }
    return this.#readReservation(reservation.jobId);
  }

  public async releaseReservation(
    jobId: string,
    reason: BudgetReservationRelease['reason'],
  ): Promise<BudgetReservationRelease> {
    const reservation = await this.#readReservation(jobId);
    const release = BudgetReservationReleaseSchema.parse({
      schemaVersion: 1,
      jobId: reservation.jobId,
      reason,
      releasedAt: this.#now().toISOString(),
    });
    try {
      await atomicCreateJson(this.#reservationReleasePath(jobId), release);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      return this.#readReservationRelease(jobId);
    }
    return release;
  }

  public async activeReservations(): Promise<readonly BudgetReservation[]> {
    const reservations = await this.reservationHistory();
    const releases = new Set(await this.#identifiers(this.#reservationReleasesRoot));
    await Promise.all(
      [...releases].map(async (jobId) => this.#readReservationRelease(jobId)),
    );
    return reservations.filter(({ jobId }) => !releases.has(jobId));
  }

  public async reservationHistory(): Promise<readonly BudgetReservation[]> {
    const identifiers = await this.#identifiers(this.#reservationsRoot);
    const reservations = await Promise.all(
      identifiers.map(async (jobId) => this.#readReservation(jobId)),
    );
    return reservations.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId),
    );
  }

  public async health(): Promise<BudgetStoreHealth> {
    const checks = await Promise.allSettled([
      this.active(),
      this.history(),
      this.observations(),
      this.reservationHistory(),
      this.activeReservations(),
    ]);
    const corrupt = checks.filter(({ status }) => status === 'rejected').length;
    return corrupt === 0
      ? { state: 'ok', issues: [] }
      : {
          state: 'degraded',
          issues: [
            {
              code: 'BUDGET_STATE_CORRUPT',
              message: 'One or more durable allowance records could not be validated',
              count: corrupt,
            },
          ],
        };
  }

  async #readRecord(snapshotId: string): Promise<BudgetSnapshotRecord> {
    try {
      const value = BudgetSnapshotRecordSchema.parse(
        JSON.parse(await readFile(this.#snapshotPath(snapshotId), 'utf8')) as unknown,
      );
      if (snapshotIdentifier(value.snapshot) !== value.snapshotId) {
        throw new HydraError(
          'BUDGET_STATE_CORRUPT',
          'Immutable budget snapshot content does not match its identifier',
        );
      }
      return value;
    } catch (error) {
      if (error instanceof HydraError) {
        throw error;
      }
      throw new HydraError(
        'BUDGET_STATE_CORRUPT',
        'An immutable budget snapshot is invalid',
      );
    }
  }

  async #readObservation(observationId: string): Promise<AllowanceObservation> {
    try {
      const observation = AllowanceObservationSchema.parse(
        JSON.parse(await readFile(this.#observationPath(observationId), 'utf8')) as unknown,
      );
      const { observationId: storedId, ...body } = observation;
      if (storedId !== observationId || allowanceObservationId(body) !== storedId) {
        throw new HydraError(
          'BUDGET_STATE_CORRUPT',
          'Immutable allowance observation content does not match its identifier',
        );
      }
      return observation;
    } catch (error) {
      if (error instanceof HydraError) {
        throw error;
      }
      throw new HydraError(
        'BUDGET_STATE_CORRUPT',
        'An immutable allowance observation is invalid',
      );
    }
  }

  async #readReservation(jobId: string): Promise<BudgetReservation> {
    try {
      return BudgetReservationSchema.parse(
        JSON.parse(await readFile(this.#reservationPath(jobId), 'utf8')) as unknown,
      );
    } catch (error) {
      if (error instanceof HydraError) {
        throw error;
      }
      throw new HydraError('BUDGET_STATE_CORRUPT', 'A quota reservation is invalid');
    }
  }

  async #readReservationRelease(jobId: string): Promise<BudgetReservationRelease> {
    try {
      const release = BudgetReservationReleaseSchema.parse(
        JSON.parse(await readFile(this.#reservationReleasePath(jobId), 'utf8')) as unknown,
      );
      if (release.jobId !== jobId) {
        throw new HydraError(
          'BUDGET_STATE_CORRUPT',
          'A reservation release conflicts with its path identity',
        );
      }
      return release;
    } catch (error) {
      if (error instanceof HydraError) {
        throw error;
      }
      throw new HydraError('BUDGET_STATE_CORRUPT', 'A reservation release is invalid');
    }
  }

  async #identifiers(root: string): Promise<readonly string[]> {
    try {
      return (await readdir(root))
        .filter((name) => /^(?:[a-f0-9]{64}|[0-9a-f-]{36})\.json$/u.test(name))
        .map((name) => name.slice(0, -'.json'.length));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  #activePath(): string {
    return resolveManagedPath(this.#root, 'active.json');
  }

  #snapshotPath(snapshotId: string): string {
    SnapshotIdSchema.parse(snapshotId);
    return resolveManagedPath(this.#snapshotsRoot, `${snapshotId}.json`);
  }

  #observationPath(observationId: string): string {
    SnapshotIdSchema.parse(observationId);
    return resolveManagedPath(this.#calibrationRoot, `${observationId}.json`);
  }

  #reservationPath(jobId: string): string {
    JobIdSchema.parse(jobId);
    return resolveManagedPath(this.#reservationsRoot, `${jobId}.json`);
  }

  #reservationReleasePath(jobId: string): string {
    JobIdSchema.parse(jobId);
    return resolveManagedPath(this.#reservationReleasesRoot, `${jobId}.json`);
  }
}
