import { z } from 'zod';

/** Categories recognized by the pinned DocJev rules (docs/evaluation/docjev-rules.yaml). */
export const PACKET_CATEGORIES = ['invoice', 'contract', 'supplemental_context', 'other'] as const;
export type PacketCategory = (typeof PACKET_CATEGORIES)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Wire contract for the pinned DocJev split result (upstream revision
 * c7abe276, SplitResult.model_dump). Unknown keys are stripped on purpose:
 * page text, per-page decisions, request metadata and provider probabilities
 * never reach the typed output.
 */
export const splitResultSchema = z.object({
  schema_version: z.literal('1'),
  task: z.literal('split'),
  segments: z
    .array(
      z.object({
        id: z.string().min(1),
        category: z.string().min(1),
        pages: z.array(z.number().int().positive()).min(1),
        needs_review: z.boolean().default(false),
        review_reasons: z
          .array(
            z.object({
              code: z.string().min(1),
              page: z.number().int().positive(),
            })
          )
          .default([]),
      })
    )
    .min(1),
  warnings: z.array(z.string()).default([]),
  document: z.object({
    page_count: z.number().int().positive(),
    source_sha256: z.string().regex(SHA256_HEX),
    canonical_sha256: z.string().regex(SHA256_HEX),
  }),
  engine: z.string().min(1),
  model: z.string().min(1),
  metrics: z.object({
    decision_ms: z.number().nullable().optional(),
    decision_cost_usd: z.number().nullable().optional(),
  }),
});

export type SplitResultWire = z.infer<typeof splitResultSchema>;
