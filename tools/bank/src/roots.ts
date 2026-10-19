// SPDX-License-Identifier: AGPL-3.0-only

import { sharesRoot } from "@twototango/core";
import type { Lexicon } from "./lexicon.ts";

/** Two stems are related when equal, or when one (4+ letters) starts the other: obstin / obstinaci. */
export function stemsRelated(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * Shared-root test for the pipeline: core's spelling heuristic, plus the lexicon's
 * stems and derivational bases for both words and their lemmas.
 */
export function relatedWords(lex: Lexicon, a: string, b: string): boolean {
  if (sharesRoot(a, b)) return true;
  // hunter / huntsman: the stems differ, but both build on "hunt", a common word.
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  if (n >= 4 && n < Math.max(x.length, y.length) && lex.zipf(x.slice(0, n)) >= 3) return true;
  const ra = lex.roots(a);
  const rb = lex.roots(b);
  return ra.some((x) => rb.some((y) => stemsRelated(x, y)));
}
