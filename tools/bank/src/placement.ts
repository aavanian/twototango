// SPDX-License-Identifier: AGPL-3.0-only

import { fitsPattern, layoutBoxes, placements, type Cell, type Item } from "@twototango/core";
import { key, shapeOf, type Lexicon } from "./lexicon.ts";

/**
 * Given-letter placement. The count is fixed (core's givenCount); which letters are
 * given is the difficulty knob. A placement is usable only if no plausible but
 * unaccepted synonym fits it. Among usable ones, B2 gets the most telling letters,
 * C2 the least telling that still disambiguate, C1 the middle.
 */

/** Words below this zipf don't count as plausible answers when measuring informativeness. */
export const PLAUSIBLE_ZIPF = 1.5;

export interface PlacementChoice {
  readonly given: number[];
  /** Plausible lexicon words, other than the answer, that fit the chosen pattern. */
  readonly fits: string[];
}

export interface PlacementReport {
  readonly choice: PlacementChoice | null;
  /** Unaccepted synonym forms that share the answer's shape: what the given letters must rule out. */
  readonly rivals: string[];
  readonly usable: number;
  readonly total: number;
}

/**
 * Forms of the lemma's lexicon synonyms (plus any extra words, e.g. from the draft or
 * the blind solve) with the answer's shape, minus the answer and accepted alternates.
 */
export function rivalsFor(item: Item, lex: Lexicon, extra: readonly string[] = []): string[] {
  const shape = shapeOf(layoutBoxes(item.answer, item.lang));
  const accepted = new Set([item.answer, ...item.alternates].map(key));
  const out = new Set<string>();
  const consider = (form: string) => {
    let cells: Cell[];
    try {
      cells = layoutBoxes(form, item.lang);
    } catch {
      return;
    }
    if (shapeOf(cells) === shape && !accepted.has(key(form))) out.add(key(form));
  };
  for (const syn of lex.synonyms(item.lemma, item.pos)) {
    const forms = lex.forms(syn, item.pos);
    if (forms.length === 0) consider(syn);
    for (const f of forms) consider(f.form);
  }
  extra.forEach(consider);
  return [...out].sort();
}

function plausibleFits(item: Item, cells: readonly Cell[], given: readonly number[], lex: Lexicon): string[] {
  const answer = key(item.answer);
  return lex
    .formsWithShape(shapeOf(cells))
    .filter((f) => f !== answer && lex.zipf(f) >= PLAUSIBLE_ZIPF && fitsPattern(f, cells, given, item.lang))
    .sort((a, b) => lex.zipf(b) - lex.zipf(a));
}

export function choosePlacement(item: Item, lex: Lexicon, extraRivals: readonly string[] = []): PlacementReport {
  const cells = layoutBoxes(item.answer, item.lang);
  const letterCount = cells.filter((c) => c.kind === "letter").length;
  const rivals = rivalsFor(item, lex, extraRivals);
  const all = [...placements(letterCount)];
  const usable = all
    .filter((given) => !rivals.some((r) => fitsPattern(r, cells, given, item.lang)))
    .map((given) => ({ given, fits: plausibleFits(item, cells, given, lex) }));
  if (usable.length === 0) return { choice: null, rivals, usable: 0, total: all.length };

  // Fewer fitting words means more telling letters.
  const byTelling = [...usable].sort(
    (a, b) => a.fits.length - b.fits.length || Number(b.given.includes(0)) - Number(a.given.includes(0)) || compare(a.given, b.given),
  );
  const pick = (level: Item["level"]) => {
    if (level === "B2") return byTelling[0]!;
    if (level === "C2") return byTelling.at(-1)!;
    return byTelling[Math.floor((byTelling.length - 1) / 2)]!;
  };
  return { choice: pick(item.level), rivals, usable: usable.length, total: all.length };
}

/** Rivals that fit an existing placement: each one is a word players could say that the GM won't accept. */
export function rivalsFitting(item: Item, lex: Lexicon, extraRivals: readonly string[] = []): string[] {
  const cells = layoutBoxes(item.answer, item.lang);
  return rivalsFor(item, lex, extraRivals).filter((r) => fitsPattern(r, cells, item.given, item.lang));
}

export function fitsFor(item: Item, lex: Lexicon): string[] {
  return plausibleFits(item, layoutBoxes(item.answer, item.lang), item.given, lex);
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
