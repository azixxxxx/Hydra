import { z } from 'zod';

export const ContextProfileSchema = z
  .object({
    capsuleBytes: z.number().int().min(0).max(200_000),
    overlap: z.enum(['low', 'medium', 'high']),
    partitionability: z.enum(['none', 'partial', 'strong']),
    independentJudgmentsRequired: z.boolean(),
    partitions: z.array(z.string().trim().min(1).max(500)).max(3),
  })
  .strict();

export const RouteInputSchema = z
  .object({
    taskProfile: z
      .object({
        kind: z.enum([
          'routine',
          'feature',
          'debug',
          'architecture',
          'review',
          'migration',
          'research',
        ]),
        scope: z.enum(['local', 'module', 'repo']),
        ambiguity: z.enum(['low', 'medium', 'high']),
        novelty: z.enum(['low', 'medium', 'high']),
        risk: z.enum(['low', 'medium', 'high', 'critical']),
        writeRequired: z.boolean(),
        testsRequired: z.boolean(),
        parallelizable: z.boolean(),
      })
      .strict(),
    contextProfile: ContextProfileSchema,
    userMode: z.enum(['auto', 'standard', 'maximum', 'burn']).default('auto'),
    hostModel: z.string().trim().min(1).max(256).optional(),
    hostEffort: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type RouteInput = z.infer<typeof RouteInputSchema>;
