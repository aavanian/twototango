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
          required: ["lemma", "pos", "kind", "before", "span", "after", "definition", "fixedWords", "answer", "acceptable", "nearMisses"],
          properties: {
            lemma: { type: "string" },
            pos: { type: "string", enum: [...PARTS_OF_SPEECH] },
            kind: { type: "string", enum: ["sentence", "definition"] },
            before: { type: ["string", "null"] },
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

/**
 * Strict-mode output must fill every key, so models send null or "" for fields that
 * don't apply. Drop those before parsing: the definition fields for a sentence item,
 * the sentence fields for a definition item, and an empty determiner. An empty
 * before/after stays (a span may open or close the sentence).
 */
export function parseDraftBatch(raw: unknown): Draft[] {
  const SENTENCE_ONLY = ["before", "determiner", "span", "after"];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return DraftBatch.parse(raw).items;
  const cleaned = items.map((item) => {
    if (item === null || typeof item !== "object") return item;
    const entries = Object.entries(item as Record<string, unknown>).filter(([k, v]) => {
      if (v === null) return false;
      const kind = (item as { kind?: unknown }).kind;
      if (kind === "sentence" && k === "definition") return false;
      if (kind === "definition" && SENTENCE_ONLY.includes(k)) return false;
      if (k === "determiner" && v === "") return false;
      return true;
    });
    return Object.fromEntries(entries);
  });
  return DraftBatch.parse({ items: cleaned }).items;
}

// Articles that may change with the answer (a/an, un/une, le/l’). Possessives and demonstratives stay in the text.
const ARTICLES: Record<Lang, RegExp> = {
  en: /(^|\s)(a|an|the)\s+$/iu,
  fr: /(^|\s)(un|une|le|la|les|du|des|de la|de l['’]|l['’])\s*$/iu,
};

/**
 * Models write the sentence naturally, article included in `before`. The article right
 * before the span moves to `determiner`, which the game keeps outside the underline and
 * the substitution check adapts. A determiner the model did give is kept, and removed
 * from the end of `before` if repeated there ("The The [calm] lake").
 */
export function splitDeterminer(draft: Pick<Draft, "before" | "determiner">, lang: Lang): { before: string; determiner?: string } {
  let before = draft.before ?? "";
  let determiner = draft.determiner?.trim();
  if (determiner) {
    const repeated = new RegExp(`(^|\\s)${determiner.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`, "iu");
    if (repeated.test(before)) before = before.replace(repeated, "$1");
  } else {
    const m = ARTICLES[lang].exec(before);
    if (m) {
      determiner = m[2]!;
      before = before.slice(0, m.index) + m[1];
    }
  }
  return determiner ? { before, determiner } : { before };
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
      ? { kind: "sentence" as const, ...splitDeterminer(draft, lang), span: draft.span ?? [], after: draft.after ?? "" }
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
