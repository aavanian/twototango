// SPDX-License-Identifier: AGPL-3.0-only

import { layoutBoxes, letters, type Cell, type Lang } from "./boxes.ts";

export const MIN_LETTERS = 3;

/** How many letters are given for a word of `letterCount` letters: about a third, at least one. */
export function givenCount(letterCount: number): number {
  if (letterCount < MIN_LETTERS) throw new RangeError(`answers need at least ${MIN_LETTERS} letters`);
  return Math.max(1, Math.round(letterCount / 3));
}

/**
 * A valid placement has exactly `givenCount` positions, strictly increasing, in range,
 * with no two given letters side by side (so they spread across the word).
 */
export function isValidPlacement(positions: readonly number[], letterCount: number): boolean {
  if (letterCount < MIN_LETTERS || positions.length !== givenCount(letterCount)) return false;
  return positions.every((p, i) => {
    if (!Number.isInteger(p) || p < 0 || p >= letterCount) return false;
    const prev = positions[i - 1];
    return prev === undefined || p - prev >= 2;
  });
}

/** Every valid placement for a word of `letterCount` letters, in lexicographic order. */
export function* placements(letterCount: number): Generator<number[]> {
  const k = givenCount(letterCount);
  function* extend(chosen: number[], start: number): Generator<number[]> {
    if (chosen.length === k) {
      yield [...chosen];
      return;
    }
    const remaining = k - chosen.length;
    // Each remaining position needs itself plus a gap before the next one.
    for (let p = start; p <= letterCount - (2 * remaining - 1); p++) {
      chosen.push(p);
      yield* extend(chosen, p + 2);
      chosen.pop();
    }
  }
  yield* extend([], 0);
}

/**
 * Whether `candidate` fits the row: same cells, same marks in the same places,
 * and the given letters match exactly (accents included).
 */
export function fitsPattern(candidate: string, cells: readonly Cell[], given: readonly number[], lang: Lang): boolean {
  let candidateCells: Cell[];
  try {
    candidateCells = layoutBoxes(candidate, lang);
  } catch {
    return false;
  }
  if (candidateCells.length !== cells.length) return false;
  if (!candidateCells.every((c, i) => c.kind === cells[i]?.kind && (c.kind === "letter" || c.char === cells[i]?.char))) {
    return false;
  }
  const want = letters(cells);
  const have = letters(candidateCells);
  return given.every((p) => have[p] === want[p]);
}
