// SPDX-License-Identifier: AGPL-3.0-only

export type Lang = "en" | "fr";

/** One position in the answer row: a box for a letter, or a fixed mark between boxes. */
export type Cell =
  | { readonly kind: "letter"; readonly char: string }
  | { readonly kind: "mark"; readonly char: string };

export class BoxError extends Error {}

const LETTERS: Record<Lang, RegExp> = {
  en: /^[a-z]$/u,
  fr: /^[a-zàâäçéèêëîïôöùûüÿœæ]$/u,
};

// Typed and typographic apostrophes are the same mark; cells always hold the typographic one.
const MARKS: Record<Lang, ReadonlyMap<string, string>> = {
  en: new Map(),
  fr: new Map([
    ["-", "-"],
    ["'", "’"],
    ["’", "’"],
  ]),
};

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

/** The canonical stored form of an answer: NFC, lowercase, trimmed. */
export function normalizeWord(word: string): string {
  return word.normalize("NFC").toLowerCase().trim();
}

/** Splits an answer into cells. Throws BoxError if the word can't be laid out for that language. */
export function layoutBoxes(answer: string, lang: Lang): Cell[] {
  const word = normalizeWord(answer);
  const cells: Cell[] = [];
  for (const { segment } of graphemes.segment(word)) {
    const mark = MARKS[lang].get(segment);
    if (LETTERS[lang].test(segment)) cells.push({ kind: "letter", char: segment });
    else if (mark !== undefined) cells.push({ kind: "mark", char: mark });
    else throw new BoxError(`"${segment}" is not allowed in a ${lang} answer: "${answer}"`);
  }
  if (cells.length === 0) throw new BoxError("empty answer");
  if (cells[0]?.kind === "mark" || cells.at(-1)?.kind === "mark") {
    throw new BoxError(`a mark can't start or end an answer: "${answer}"`);
  }
  if (cells.some((c, i) => c.kind === "mark" && cells[i + 1]?.kind === "mark")) {
    throw new BoxError(`two marks in a row: "${answer}"`);
  }
  return cells;
}

/** The letters of a layout, in order, without marks. Given positions index into this list. */
export function letters(cells: readonly Cell[]): string[] {
  return cells.filter((c) => c.kind === "letter").map((c) => c.char);
}

/** A cell as a phone shows it: letters are hidden (null) unless given or revealed. */
export type ShownCell =
  | { readonly kind: "letter"; readonly char: string | null; readonly given: boolean }
  | { readonly kind: "mark"; readonly char: string };

export function showCells(cells: readonly Cell[], given: readonly number[], revealed: boolean): ShownCell[] {
  const givenSet = new Set(given);
  let letterIndex = 0;
  return cells.map((cell) => {
    if (cell.kind === "mark") return cell;
    const isGiven = givenSet.has(letterIndex++);
    return { kind: "letter", char: isGiven || revealed ? cell.char : null, given: isGiven };
  });
}
