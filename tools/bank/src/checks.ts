// SPDX-License-Identifier: AGPL-3.0-only

import { checkItem, type Item } from "@twototango/core";
import { key, type Lexicon } from "./lexicon.ts";
import { fitsFor, rivalsFitting } from "./placement.ts";
import { relatedWords } from "./roots.ts";
import { substitute } from "./substitute.ts";

/**
 * Stage 5: the deterministic checks, run on every drafted item before the blind
 * solve. A "fail" sends the item to repair; a "flag" sends it to review.
 */

export type Severity = "fail" | "flag";

export interface PipelineIssue {
  readonly itemId: string;
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
}

export interface ItemReport {
  readonly itemId: string;
  readonly issues: PipelineIssue[];
  /** The sentence with the answer in place, for the blind solve and reviewers. */
  readonly substituted: string | null;
  /** Plausible lexicon words that also fit the boxes; the blind solve decides which matter. */
  readonly fits: string[];
}

export interface CheckOptions {
  readonly profanity: ReadonlySet<string>;
  /** Extra unaccepted words for this item (from the draft or the blind solve). */
  readonly rivals?: ReadonlyMap<string, readonly string[]>;
}

/** Words of a text, lowercase, apostrophes split off (l’œuvre → l, œuvre). */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFC")
    .split(/[^\p{L}-]+/u)
    .filter((w) => w.length > 0 && w !== "-");
}

// Words too common to signal a shared root ("give in" doesn't share a root with "succumb" through "in").
const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "les", "des", "une", "dans", "pour", "avec", "sans", "sur", "par", "est", "qui", "que"]);

function textOf(item: Item): string {
  return item.prompt.kind === "sentence"
    ? `${item.prompt.before} ${item.prompt.determiner ?? ""} ${item.prompt.span.join(" ")} ${item.prompt.after}`
    : item.prompt.definition;
}

export function checkDraft(item: Item, lex: Lexicon, options: CheckOptions): ItemReport {
  const issues: PipelineIssue[] = [];
  const add = (code: string, severity: Severity, message: string) => issues.push({ itemId: item.id, code, severity, message });

  // Schema-level rules from core: layout, given placement, alternates, roots against the span.
  for (const issue of checkItem(item)) add(issue.code, "fail", issue.message);
  if (issues.some((i) => i.code === "answer-layout" || i.code === "answer-too-short")) {
    return { itemId: item.id, issues, substituted: null, fits: [] };
  }

  // The answer is a real form of the stated lemma and part of speech.
  const readings = lex.entries(item.answer);
  if (readings.length === 0) add("answer-unknown", item.lang === "fr" && item.answer.includes("-") ? "flag" : "fail", `"${item.answer}" is not in the lexicon`);
  else if (!readings.some((e) => e.pos === item.pos)) add("answer-pos", "fail", `"${item.answer}" is not a ${item.pos} in the lexicon`);
  else if (!readings.some((e) => e.pos === item.pos && key(e.lemma) === key(item.lemma))) {
    add("answer-lemma", "fail", `"${item.answer}" is not a form of "${item.lemma}" (lexicon: ${[...new Set(readings.map((e) => e.lemma))].join(", ")})`);
  }
  for (const alt of item.alternates) {
    if (!lex.has(alt)) add("alternate-unknown", "flag", `alternate "${alt}" is not in the lexicon`);
  }

  // Shared roots, with the lexicon's stems: against the span or the definition, and fixed words.
  const clueWords = item.prompt.kind === "sentence" ? item.prompt.span.flatMap(words) : words(item.prompt.definition);
  for (const w of new Set([...clueWords, ...item.fixedWords.flatMap(words)])) {
    if (w.length < 3 || STOP.has(w)) continue;
    for (const target of new Set([item.answer, item.lemma])) {
      if (relatedWords(lex, w, target)) add("shared-root-stem", "fail", `"${target}" shares a root with "${w}"`);
    }
  }

  // Unaccepted synonyms that the given letters don't rule out.
  const fitting = rivalsFitting(item, lex, options.rivals?.get(item.id) ?? []);
  if (fitting.length > 0) add("rival-fits", "fail", `also fits the boxes: ${fitting.join(", ")}`);

  // Profanity anywhere in the item.
  const bad = [...new Set([...words(textOf(item)), ...words(item.answer), ...item.alternates.flatMap(words)])].filter((w) => options.profanity.has(key(w)));
  if (bad.length > 0) add("profanity", "fail", `contains: ${bad.join(", ")}`);

  const sub = substitute(item, lex);
  for (const note of sub?.notes ?? []) if (note.includes("unknown")) add("substitution", "flag", note);

  return { itemId: item.id, issues, substituted: sub?.sentence ?? null, fits: fitsFor(item, lex).slice(0, 20) };
}

/** Token-set similarity of two prompts, 0 to 1. */
export function similarity(a: string, b: string): number {
  const x = new Set(words(a).filter((w) => !STOP.has(w)));
  const y = new Set(words(b).filter((w) => !STOP.has(w)));
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

export const NEAR_DUPLICATE = 0.6;

/** Near-duplicate prompts within a set of items: flags the later item of each pair. */
export function nearDuplicates(items: readonly Item[]): PipelineIssue[] {
  const issues: PipelineIssue[] = [];
  const texts = items.map(textOf);
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < i; j++) {
      if (items[i]!.lang !== items[j]!.lang) continue;
      const s = similarity(texts[i]!, texts[j]!);
      if (s >= NEAR_DUPLICATE) {
        issues.push({ itemId: items[i]!.id, code: "near-duplicate", severity: "flag", message: `${Math.round(s * 100)}% like ${items[j]!.id}` });
      }
    }
  }
  return issues;
}

export function checkDrafts(items: readonly Item[], lex: Lexicon, options: CheckOptions): ItemReport[] {
  const dupes = nearDuplicates(items);
  return items.map((item) => {
    const report = checkDraft(item, lex, options);
    return { ...report, issues: [...report.issues, ...dupes.filter((d) => d.itemId === item.id)] };
  });
}
