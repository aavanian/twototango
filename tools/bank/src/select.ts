// SPDX-License-Identifier: AGPL-3.0-only

import { layoutBoxes, LEVELS, letters, seededRng, shuffle, type Item, type Lang } from "@twototango/core";
import { key, type FormEntry, type Lexicon, type Pos } from "./lexicon.ts";
import { relatedWords } from "./roots.ts";
import { britishVariant } from "./spelling.ts";

/**
 * Stage 1, code part: candidate answers per level from frequency bands. The model
 * screen (teen suitability, jargon, level fit) runs on this list later.
 */

type Level = Item["level"];
type AnswerPos = Item["pos"];

/**
 * Bands on the lemma's zipf frequency. A first guess, to be tuned against the GM's
 * pilot ratings: the sample sheets (C1) sit around 2.5–3.3 in English.
 */
export const LEVEL_BANDS: Record<Lang, Record<Level, readonly [number, number]>> = {
  en: { B2: [3.3, 4.1], C1: [2.7, 3.3], C2: [2.0, 2.7] },
  fr: { B2: [3.3, 4.1], C1: [2.7, 3.3], C2: [2.0, 2.7] },
};
export const POS_MIX: Record<AnswerPos, number> = { noun: 0.4, verb: 0.35, adjective: 0.25 };
export const DEFINITION_EVERY = 5;
export const MIN_LETTERS = 4;
export const MAX_LETTERS = 14;
/** A synonym counts as an easier clue when it is this much more frequent than the answer. */
export const EASIER_BY = 0.3;

export interface Candidate {
  readonly lemma: string;
  readonly pos: AnswerPos;
  readonly level: Level;
  readonly zipf: number;
  /** Marked for a definition prompt instead of a sentence. */
  readonly definition: boolean;
  /** More frequent synonyms that could serve as the underlined clue, most frequent first. */
  readonly easier: readonly string[];
  /** Every lexicon synonym: the words the given letters will need to rule out. */
  readonly synonyms: readonly string[];
}

export interface Selection {
  readonly lang: Lang;
  readonly seed: number;
  readonly target: number;
  readonly bands: Record<Level, readonly [number, number]>;
  /** Per level and part of speech: how many passed the filters, how many were taken. */
  readonly counts: Record<Level, Record<AnswerPos, { available: number; taken: number; wanted: number }>>;
  readonly candidates: readonly Candidate[];
}

export interface SelectOptions {
  readonly target?: number;
  readonly seed?: number;
  readonly profanity?: ReadonlySet<string>;
}

const ANSWER_POS: readonly AnswerPos[] = ["noun", "verb", "adjective"];

function levelOf(zipf: number, bands: Record<Level, readonly [number, number]>): Level | null {
  for (const level of LEVELS) {
    const [lo, hi] = bands[level];
    if (zipf >= lo && zipf < hi) return level;
  }
  return null;
}

function letterCount(word: string, lang: Lang): number | null {
  try {
    return letters(layoutBoxes(word, lang)).length;
  } catch {
    return null;
  }
}

/** Candidates before root dedup: every lemma that passes the per-word filters. */
export function eligible(lex: Lexicon, options: SelectOptions = {}): Omit<Candidate, "definition">[] {
  const bands = LEVEL_BANDS[lex.lang];
  const bad = options.profanity ?? new Set<string>();
  const seen = new Set<string>();
  const out: Omit<Candidate, "definition">[] = [];
  for (const e of lex.lemmas(ANSWER_POS)) {
    const id = `${key(e.lemma)}|${e.pos}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = letterCount(e.lemma, lex.lang);
    if (n === null || n < MIN_LETTERS || n > MAX_LETTERS || bad.has(key(e.lemma))) continue;
    // British spelling for English: the American form of a word never becomes a candidate.
    if (lex.lang === "en" && britishVariant(e.lemma, lex) !== null) continue;
    const level = levelOf(e.lemmaZipf, bands);
    if (level === null) continue;
    const synonyms = lex.synonyms(e.lemma, e.pos).filter((s) => letterCount(s, lex.lang) !== null && !bad.has(key(s)));
    // A clue must be the same part of speech as the answer, as the lexicon knows it.
    const easier = synonyms
      .flatMap((s) => {
        const entry = lex.forms(s, e.pos)[0];
        return entry === undefined ? [] : [{ s, z: entry.lemmaZipf }];
      })
      .filter(({ s, z }) => z >= e.lemmaZipf + EASIER_BY && !relatedWords(lex, s, e.lemma))
      .filter(({ s }) => lex.lang !== "en" || britishVariant(s, lex) === null)
      .sort((a, b) => b.z - a.z)
      .map(({ s }) => s);
    if (easier.length === 0) continue;
    out.push({ lemma: e.lemma, pos: e.pos as AnswerPos, level, zipf: e.lemmaZipf, easier: easier.slice(0, 5), synonyms });
  }
  return out;
}

/**
 * One candidate per root across all levels (obstinate and obstinacy can't both be
 * answers): roots that extend another 4+ letter root join its group. The keeper has
 * the most easier synonyms, then sits closest to its band's middle.
 */
export function dedupeRoots<C extends Omit<Candidate, "definition">>(lex: Lexicon, list: readonly C[]): C[] {
  const bands = LEVEL_BANDS[lex.lang];
  const rootOf = (c: C) => lex.forms(c.lemma, c.pos)[0]?.root || key(c.lemma);
  const sorted = [...list].sort((a, b) => rootOf(a).localeCompare(rootOf(b)) || a.lemma.localeCompare(b.lemma));
  const groups: C[][] = [];
  let head = "";
  for (const c of sorted) {
    const root = rootOf(c);
    if (groups.length > 0 && (root === head || (head.length >= 4 && root.startsWith(head)))) groups.at(-1)!.push(c);
    else {
      head = root;
      groups.push([c]);
    }
  }
  const centre = (c: C) => {
    const [lo, hi] = bands[c.level];
    return Math.abs(c.zipf - (lo + hi) / 2);
  };
  return groups.map((g) => g.sort((a, b) => b.easier.length - a.easier.length || centre(a) - centre(b))[0]!);
}

export function selectCandidates(lex: Lexicon, options: SelectOptions = {}): Selection {
  const target = options.target ?? 800;
  const seed = options.seed ?? 1;
  const rng = seededRng(seed);
  const pool = dedupeRoots(lex, eligible(lex, options));
  const counts = {} as Selection["counts"];
  const candidates: Candidate[] = [];
  for (const level of LEVELS) {
    counts[level] = {} as Record<AnswerPos, { available: number; taken: number; wanted: number }>;
    for (const pos of ANSWER_POS) {
      const wanted = Math.round(target * POS_MIX[pos]);
      const available = pool.filter((c) => c.level === level && c.pos === pos).sort((a, b) => a.lemma.localeCompare(b.lemma));
      const taken = shuffle(available, rng).slice(0, wanted);
      counts[level][pos] = { available: available.length, taken: taken.length, wanted };
      taken.forEach((c, i) => candidates.push({ ...c, definition: i % DEFINITION_EVERY === 0 }));
    }
  }
  candidates.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.pos.localeCompare(b.pos) || a.lemma.localeCompare(b.lemma));
  return { lang: lex.lang, seed, target, bands: LEVEL_BANDS[lex.lang], counts, candidates };
}

export type { FormEntry, Pos };
