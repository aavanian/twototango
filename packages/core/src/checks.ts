// SPDX-License-Identifier: AGPL-3.0-only

import { BoxError, layoutBoxes, letters, normalizeWord, type Cell } from "./boxes.ts";
import { fitsPattern, isValidPlacement, MIN_LETTERS } from "./given.ts";
import type { Bank, Item } from "./item.ts";

export interface Issue {
  readonly itemId: string;
  readonly code: string;
  readonly message: string;
}

/** Lowercase with accents stripped, for comparing roots across accented forms. */
function fold(word: string): string {
  return normalizeWord(word).normalize("NFD").replace(/\p{Mn}/gu, "");
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Heuristic shared-root test: a common prefix of 5+ letters, or one word of
 * 4+ letters contained in the other. The pipeline adds stemming on top.
 */
export function sharesRoot(a: string, b: string): boolean {
  const x = fold(a);
  const y = fold(b);
  if (commonPrefixLength(x, y) >= 5) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.includes(short);
}

const words = (s: string): string[] => s.split(/[\s/’'-]+/u).filter(Boolean);

/** Checks one item against the bank rules that don't need a lexicon or a model. */
export function checkItem(item: Item): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, message: string) => issues.push({ itemId: item.id, code, message });

  const [idLang, idLevel] = item.id.split("-");
  if (idLang !== item.lang || idLevel !== item.level.toLowerCase()) {
    add("id-mismatch", `id ${item.id} doesn't match ${item.lang}/${item.level}`);
  }
  if (item.answer !== normalizeWord(item.answer)) add("answer-not-normalized", `store "${normalizeWord(item.answer)}"`);

  let cells: Cell[];
  try {
    cells = layoutBoxes(item.answer, item.lang);
  } catch (e) {
    if (!(e instanceof BoxError)) throw e;
    add("answer-layout", e.message);
    return issues;
  }

  const letterCount = letters(cells).length;
  if (letterCount < MIN_LETTERS) {
    add("answer-too-short", `"${item.answer}" has ${letterCount} letters`);
  } else if (!isValidPlacement(item.given, letterCount)) {
    add("given-invalid", `given [${item.given.join(", ")}] for ${letterCount} letters`);
  }

  const seen = new Set([item.answer]);
  for (const alt of item.alternates) {
    const norm = normalizeWord(alt);
    if (seen.has(norm)) add("alternate-duplicate", `"${alt}" repeats the answer or another alternate`);
    seen.add(norm);
    if (!fitsPattern(alt, cells, item.given, item.lang)) add("alternate-misfit", `"${alt}" doesn't fit the boxes`);
  }

  if (item.prompt.kind === "sentence") {
    for (const spanWord of item.prompt.span.flatMap(words)) {
      for (const answerWord of new Set([item.answer, item.lemma])) {
        if (sharesRoot(spanWord, answerWord)) {
          add("shared-root", `"${answerWord}" shares a root with span word "${spanWord}"`);
        }
      }
    }
  }
  return issues;
}

/**
 * Checks every item, plus the rules that span banks: unique ids, items matching
 * their bank's language and level, and each lemma used once per language across levels.
 */
export function checkBanks(banks: readonly Bank[]): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  const lemmas = new Map<string, string>();
  for (const bank of banks) {
    for (const item of bank.items) {
      issues.push(...checkItem(item));
      const add = (code: string, message: string) => issues.push({ itemId: item.id, code, message });
      if (item.lang !== bank.lang || item.level !== bank.level) {
        add("wrong-bank", `item is ${item.lang}/${item.level} in the ${bank.lang}/${bank.level} bank`);
      }
      if (ids.has(item.id)) add("duplicate-id", item.id);
      ids.add(item.id);
      const key = `${item.lang}:${normalizeWord(item.lemma)}`;
      const first = lemmas.get(key);
      if (first !== undefined) add("duplicate-lemma", `"${item.lemma}" already used by ${first}`);
      else lemmas.set(key, item.id);
    }
  }
  return issues;
}
