// SPDX-License-Identifier: AGPL-3.0-only

import { key, type Lexicon } from "./lexicon.ts";

/**
 * English banks use British spelling (GM decision, 19 Oct 2026): colour, organise,
 * centre, catalogue, defence, travelled. wordfreq lists both spellings, so the
 * pipeline maps an American form to its British counterpart when the lexicon knows
 * that counterpart. -ise is preferred over -ize.
 */

const RULES: [RegExp, string][] = [
  [/([^aeiou])or(s|ed|ing|ful|ite|ites|less)?$/u, "$1our$2"], // color → colour (not "door", "motor" if no British form)
  [/iz(e|es|ed|ing|ation|ations|er|ers)$/u, "is$1"], // organize → organise
  [/yz(e|es|ed|ing)$/u, "ys$1"], // analyze → analyse
  [/([^aeiou])er(s)?$/u, "$1re$2"], // center → centre
  [/(al|ol)og(s)?$/u, "$1ogue$2"], // catalog → catalogue
  [/ense(s)?$/u, "ence$1"], // defense → defence
  [/([aeiou])l(ed|ing|er|ers)$/u, "$1ll$2"], // traveled → travelled
];

/** The British spelling of an American form, if the lexicon has it and it is at least as plausible. */
export function britishVariant(word: string, lex: Lexicon): string | null {
  const w = key(word);
  // Short words aren't spelling variants (for/four, or/our); the shortest real pair is color/colour.
  if (w.length < 5) return null;
  for (const [pattern, replacement] of RULES) {
    const m = pattern.exec(w);
    if (!m) continue;
    // A suffixed -or form counts only if the bare -or word exists: colored (color), not scoring (scor).
    if (pattern === RULES[0]![0] && m[2] && !lex.entries(w.slice(0, m.index + m[0].length - m[2].length)).some((e) => e.pos !== "other")) continue;
    const british = w.replace(pattern, replacement);
    if (british !== w && lex.has(british) && lex.zipf(british) >= lex.zipf(w) - 1.5) return british;
  }
  return null;
}
