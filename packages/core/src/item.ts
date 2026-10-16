// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

export const LANGS = ["en", "fr"] as const;
export const LEVELS = ["B2", "C1", "C2"] as const;
export const PARTS_OF_SPEECH = ["noun", "verb", "adjective"] as const;

const text = z.string().min(1);

/**
 * A sentence with the target span underlined. On screen it reads
 * `before` + `determiner` + [span] + `after`. The determiner sits outside the
 * underline because it may change with the answer ("une peur" → "un effroi").
 * The first span entry is the main one; any others are the slash alternates
 * shown as extra help ("tribulation/hardship/torment").
 */
export const SentencePrompt = z.strictObject({
  kind: z.literal("sentence"),
  before: z.string(),
  determiner: text.optional(),
  span: z.array(text).min(1),
  after: z.string(),
});

export const DefinitionPrompt = z.strictObject({
  kind: z.literal("definition"),
  definition: text,
});

export const Item = z.strictObject({
  /** Stable forever: play history is keyed by it. */
  id: z.string().regex(/^(en|fr)-(b2|c1|c2)-\d{4}$/),
  lang: z.enum(LANGS),
  level: z.enum(LEVELS),
  pos: z.enum(PARTS_OF_SPEECH),
  prompt: z.discriminatedUnion("kind", [SentencePrompt, DefinitionPrompt]),
  /** Words printed after the boxes: capitulate **to**. */
  fixedWords: z.array(text).default([]),
  /** The word as it fits the sentence (inflected), lowercase NFC. */
  answer: text,
  lemma: text,
  /** Positions of the given letters, indexing the answer's letters (marks excluded). */
  given: z.array(z.number().int().nonnegative()),
  /** Other words that fit the boxes and the meaning; GM only. */
  alternates: z.array(text).default([]),
  /** Not shown in v1. */
  gloss: z.strictObject({ ja: text.optional() }).optional(),
});
export type Item = z.infer<typeof Item>;

export const Bank = z.strictObject({
  lang: z.enum(LANGS),
  level: z.enum(LEVELS),
  items: z.array(Item),
});
export type Bank = z.infer<typeof Bank>;
