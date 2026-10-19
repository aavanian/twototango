// SPDX-License-Identifier: AGPL-3.0-only

import { key, type Lexicon } from "./lexicon.ts";

/**
 * English banks use British spelling (GM decision, 19 Oct 2026): colour, organise,
 * centre, catalogue, defence, travelled. wordfreq lists both spellings, so the
 * pipeline maps an American form to its British counterpart when the lexicon knows
 * that counterpart. -ise is preferred over -ize.
 */

// Stems whose British spelling ends in -re, and bases that double the l before a suffix.
// Lists rather than open patterns: "timber" is not "timbre", "filed" is not "filled".
const RE_STEMS = "cent|theat|met|lit|fib|calib|somb|spect|lust|meag|sab|manoeuv|ochre|sepul|reconnoit|accout|sceptre|goit|lit|mit|nit|kilomet|centimet|millimet|decilit|millilit";
const LL_BASES = "travel|cancel|model|label|level|fuel|signal|total|dial|marvel|quarrel|equal|rival|tunnel|counsel|jewel|duel|panel|pedal|shovel|snorkel|channel|funnel|grovel|initial|libel|pencil|refuel|revel|swivel|tinsel|towel|trowel|unravel|yodel|bevel|chisel|dishevel|enamel|gambol|label|marshal|medal|pummel|ravel|spiral|stencil|tassel|label";

const RULES: [RegExp, string][] = [
  [/([^aeiou])or(s|ed|ing|ful|ite|ites|less)?$/u, "$1our$2"], // color → colour (not "door", "motor" if no British form)
  [/^(.{4,})iz(e|es|ed|ing|ation|ations|er|ers)$/u, "$1is$2"], // organize → organise (not prize, seize)
  [/yz(e|es|ed|ing)$/u, "ys$1"], // analyze → analyse
  [new RegExp(`^((?:${RE_STEMS}))er(s)?$`, "u"), "$1re$2"], // center → centre (not timber, carer)
  [/(al|ol)og(s)?$/u, "$1ogue$2"], // catalog → catalogue
  [/ense(s)?$/u, "ence$1"], // defense → defence
  [new RegExp(`^((?:${LL_BASES}))(ed|ing|er|ers)$`, "u"), "$1l$2"], // traveled → travelled (not filed)
];

// Words spelt -ize in British English too.
const IZE_ONLY = /^(caps|downs|overs|supers|outs|res|maize|baize)iz/u;

// Word-level pairs no pattern covers.
const WORDS: Record<string, string> = { draftsman: "draughtsman", draftsmen: "draughtsmen", plow: "plough", plows: "ploughs", plowed: "ploughed", gray: "grey", tire: "tyre", tires: "tyres", curb: "kerb", mold: "mould", moldy: "mouldy", skeptic: "sceptic", skeptical: "sceptical", aluminum: "aluminium", pajamas: "pyjamas", maneuver: "manoeuvre", cozy: "cosy", jewelry: "jewellery", program: "programme" };

/** The British spelling of an American form, if the lexicon has it and it is at least as plausible. */
export function britishVariant(word: string, lex: Lexicon): string | null {
  const w = key(word);
  if (WORDS[w]) return WORDS[w];
  // Short words aren't spelling variants (for/four, or/our); the shortest real pair is color/colour.
  if (w.length < 5) return null;
  for (const [pattern, replacement] of RULES) {
    const m = pattern.exec(w);
    if (!m) continue;
    // A suffixed -or form counts only if the bare -or word exists: colored (color), not scoring (scor).
    if (pattern === RULES[0]![0] && m[2] && !lex.entries(w.slice(0, m.index + m[0].length - m[2].length)).some((e) => e.pos !== "other")) continue;
    const british = w.replace(pattern, replacement);
    // -ize: British English accepts -ise wherever -ize is used, except a few words; the
    // British forms are often missing from the (mostly American) frequency data.
    if (pattern === RULES[1]![0]) {
      if (!IZE_ONLY.test(w)) return british;
      continue;
    }
    if (british !== w && lex.has(british) && lex.zipf(british) >= lex.zipf(w) - 1.5) return british;
  }
  return null;
}
