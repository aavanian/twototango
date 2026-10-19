// SPDX-License-Identifier: AGPL-3.0-only

import { fitsPattern, Item, layoutBoxes, PARTS_OF_SPEECH, type Lang } from "@twototango/core";
import { z } from "zod";
import { key, type Lexicon } from "./lexicon.ts";
import { choosePlacement } from "./placement.ts";

/**
 * Drafts: what a model (or a Claude Code session, for the pilot) writes. Given
 * letters and ids are never the model's job; `finalize` adds them.
 */

const text = z.string().min(1);

export const Draft = z.strictObject({
  lemma: text,
  pos: z.enum(PARTS_OF_SPEECH),
  kind: z.enum(["sentence", "definition"]),
  before: z.string().optional(),
  determiner: text.optional(),
  span: z.array(text).optional(),
  after: z.string().optional(),
  definition: text.optional(),
  fixedWords: z.array(text).default([]),
  answer: text,
  /** Words that would be just as right here, in the answer's form. */
  acceptable: z.array(text).default([]),
  /** Close but wrong: rivals the given letters should rule out. */
  nearMisses: z.array(text).default([]),
});
export type Draft = z.infer<typeof Draft>;

export const DraftBatch = z.strictObject({ items: z.array(Draft) });

/** JSON schema for structured output in the bake-off and bulk runs (strict mode: every key listed). */
export const DRAFT_JSON_SCHEMA = {
  name: "draft_items",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["lemma", "pos", "kind", "before", "determiner", "span", "after", "definition", "fixedWords", "answer", "acceptable", "nearMisses"],
          properties: {
            lemma: { type: "string" },
            pos: { type: "string", enum: [...PARTS_OF_SPEECH] },
            kind: { type: "string", enum: ["sentence", "definition"] },
            before: { type: ["string", "null"] },
            determiner: { type: ["string", "null"] },
            span: { type: ["array", "null"], items: { type: "string" } },
            after: { type: ["string", "null"] },
            definition: { type: ["string", "null"] },
            fixedWords: { type: "array", items: { type: "string" } },
            answer: { type: "string" },
            acceptable: { type: "array", items: { type: "string" } },
            nearMisses: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
} as const;

/** Strict-mode output uses null for absent fields; drop them before parsing. */
export function parseDraftBatch(raw: unknown): Draft[] {
  const strip = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(strip)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, strip(x)]))
        : v;
  return DraftBatch.parse(strip(raw)).items;
}

export interface Finalized {
  readonly item: Item | null;
  readonly draft: Draft;
  /** Why the draft couldn't become an item, or how its letters were placed. */
  readonly notes: string[];
}

/**
 * Draft → item: schema, normalized answer, then given letters. Placement first tries
 * to rule out every synonym, acceptable ones included (the bank rule: no other common
 * synonym fits). Only if no placement can, the acceptable words that still fit become
 * the GM's alternates.
 */
export function finalize(draft: Draft, id: string, lang: Lang, level: Item["level"], lex: Lexicon): Finalized {
  const notes: string[] = [];
  const prompt =
    draft.kind === "sentence"
      ? { kind: "sentence" as const, before: draft.before ?? "", ...(draft.determiner ? { determiner: draft.determiner } : {}), span: draft.span ?? [], after: draft.after ?? "" }
      : { kind: "definition" as const, definition: draft.definition ?? "" };
  const parsed = Item.safeParse({
    id,
    lang,
    level,
    pos: draft.pos,
    prompt,
    fixedWords: draft.fixedWords,
    answer: key(draft.answer).replace(/'/gu, "’"),
    lemma: key(draft.lemma),
    given: [],
    alternates: [],
  });
  if (!parsed.success) return { item: null, draft, notes: [`schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`] };
  const base = parsed.data;

  let report;
  try {
    report = choosePlacement(base, lex, [...draft.acceptable, ...draft.nearMisses]);
  } catch (e) {
    return { item: null, draft, notes: [`layout: ${(e as Error).message}`] };
  }
  if (report.choice !== null) return { item: { ...base, given: report.choice.given }, draft, notes };

  const acceptable = draft.acceptable.map(key).filter((w) => w !== base.answer);
  const withAlternates = { ...base, alternates: acceptable };
  report = choosePlacement(withAlternates, lex, draft.nearMisses);
  if (report.choice === null) {
    return { item: null, draft, notes: [`no placement rules out: ${report.rivals.join(", ")}`] };
  }
  const given = report.choice.given;
  const cells = layoutBoxes(base.answer, lang);
  const fitting = acceptable.filter((w) => fitsPattern(w, cells, given, lang));
  notes.push(`alternates kept: ${fitting.join(", ") || "none"}`);
  return { item: { ...base, given, alternates: fitting }, draft, notes };
}
