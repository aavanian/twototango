// SPDX-License-Identifier: AGPL-3.0-only

import type { Item } from "@twototango/core";
import { key, type Lexicon } from "./lexicon.ts";

/**
 * Rebuilds a sentence with the answer in place of the span. Only the article and the
 * elision right before the span may change (une peur → un effroi, m’agacer → me
 * fâcher); everything else stays as written. The result feeds the blind solve and
 * human review; `notes` says what was adapted or couldn't be decided.
 */

export interface Substitution {
  readonly sentence: string;
  readonly notes: string[];
}

type Gender = "m" | "f" | null;

const FR_VOWEL = /^[aàâäeéèêëiîïoôöuùûüyœæh]/u;
// h aspiré words take no elision. Prefixes of common ones; any other h is treated as muet.
const H_ASPIRE = /^(hach|hagard|hai|haï|hall|hamac|hamea|hamster|hanch|hang|hant|harass|harcel|hardi|hargn|haricot|harpe|hasard|hâte|hâti|haut|hérisson|héro[sï]|hibou|hideu|hiérarch|hochet|homard|honte|hont|hoquet|hors|hott|houl|hous|hublot|hué|huer|huit|hurl|hutte)/u;

function frStartsWithVowelSound(word: string): boolean {
  const w = key(word);
  return FR_VOWEL.test(w) && !H_ASPIRE.test(w);
}

// English: a vowel letter, except "you"-sounding and "w"-sounding starts; silent h words.
const EN_SILENT_H = /^(hour|honest|honou?r|heir)/u;
const EN_CONSONANT_SOUND = /^(uni|use|usu|ure|uro|eu|ewe|one|once|ubiq)/u;
export function enStartsWithVowelSound(word: string): boolean {
  const w = key(word);
  if (EN_SILENT_H.test(w)) return true;
  return /^[aeiou]/u.test(w) && !EN_CONSONANT_SOUND.test(w);
}

function genderOf(item: Item, lex: Lexicon): Gender {
  const genders = new Set(
    lex
      .entries(item.answer)
      .filter((e) => e.pos === item.pos && (e.gender === "m" || e.gender === "f"))
      .map((e) => e.gender as "m" | "f"),
  );
  return genders.size === 1 ? [...genders][0]! : null;
}

const FR_ARTICLES: Record<string, { m: string; f: string; elided: string | null }> = {
  un: { m: "un", f: "une", elided: null },
  une: { m: "un", f: "une", elided: null },
  le: { m: "le", f: "la", elided: "l’" },
  la: { m: "le", f: "la", elided: "l’" },
  "l’": { m: "le", f: "la", elided: "l’" },
  du: { m: "du", f: "de la", elided: "de l’" },
  "de la": { m: "du", f: "de la", elided: "de l’" },
  "de l’": { m: "du", f: "de la", elided: "de l’" },
  ce: { m: "ce", f: "cette", elided: "cet" },
  cet: { m: "ce", f: "cette", elided: "cet" },
  cette: { m: "ce", f: "cette", elided: "cette" },
  au: { m: "au", f: "à la", elided: "à l’" },
  "à la": { m: "au", f: "à la", elided: "à l’" },
  "à l’": { m: "au", f: "à la", elided: "à l’" },
  mon: { m: "mon", f: "ma", elided: "mon" },
  ma: { m: "mon", f: "ma", elided: "mon" },
  ton: { m: "ton", f: "ta", elided: "ton" },
  ta: { m: "ton", f: "ta", elided: "ton" },
  son: { m: "son", f: "sa", elided: "son" },
  sa: { m: "son", f: "sa", elided: "son" },
};

// Elidable words before the span, outside any determiner: m’agacer ↔ me fâcher.
const FR_ELISION: [full: string, elided: string][] = [
  ["que", "qu’"],
  ["je", "j’"],
  ["me", "m’"],
  ["te", "t’"],
  ["se", "s’"],
  ["ne", "n’"],
  ["de", "d’"],
  ["le", "l’"],
  ["la", "l’"],
];

const joinDet = (det: string, word: string) => (det.endsWith("’") ? `${det}${word}` : `${det} ${word}`);

function adaptFrenchDeterminer(det: string, item: Item, lex: Lexicon, notes: string[]): string {
  const norm = det.replace(/'/gu, "’").toLowerCase();
  const row = FR_ARTICLES[norm];
  if (row === undefined) {
    notes.push(`determiner "${det}" kept as written`);
    return det;
  }
  const vowel = frStartsWithVowelSound(item.answer);
  const gender = item.pos === "noun" ? genderOf(item, lex) : null;
  if (vowel && row.elided !== null) {
    const out = row.elided === "cette" && gender === "m" ? "cet" : row.elided;
    if (out !== norm) notes.push(`determiner "${det}" → "${out}"`);
    return out;
  }
  if (gender === null) {
    notes.push(`gender of "${item.answer}" unknown; determiner "${det}" kept`);
    return norm.endsWith("’") ? row.m : det;
  }
  const out = row[gender];
  if (out !== norm) notes.push(`determiner "${det}" → "${out}"`);
  return out;
}

function adaptFrenchBefore(before: string, item: Item, notes: string[]): string {
  const vowel = frStartsWithVowelSound(item.answer);
  for (const [full, elided] of FR_ELISION) {
    const elidedRe = new RegExp(`(^|[\\s(«"])${elided.replace("’", "['’]")}$`, "iu");
    const fullRe = new RegExp(`(^|[\\s(«"])${full} $`, "iu");
    if (!vowel && elidedRe.test(before)) {
      notes.push(`"${elided}" → "${full} "`);
      return before.replace(elidedRe, `$1${full} `);
    }
    if (vowel && fullRe.test(before)) {
      notes.push(`"${full} " → "${elided}"`);
      return before.replace(fullRe, `$1${elided}`);
    }
  }
  return before;
}

function adaptEnglishBefore(before: string, item: Item, notes: string[]): string {
  const vowel = enStartsWithVowelSound(item.answer);
  const m = /(^|\s)(a|an|A|An) $/u.exec(before);
  if (m === null) return before;
  const want = vowel ? "an" : "a";
  const have = m[2]!.toLowerCase();
  if (have === want) return before;
  const cased = m[2]![0] === "A" ? want[0]!.toUpperCase() + want.slice(1) : want;
  notes.push(`"${m[2]}" → "${cased}"`);
  return before.slice(0, m.index) + `${m[1]}${cased} `;
}

export function substitute(item: Item, lex: Lexicon): Substitution | null {
  if (item.prompt.kind !== "sentence") return null;
  const notes: string[] = [];
  const { before, determiner, after } = item.prompt;
  let sentence: string;
  if (item.lang === "fr") {
    const det = determiner === undefined ? undefined : adaptFrenchDeterminer(determiner, item, lex, notes);
    const pre = det === undefined ? adaptFrenchBefore(before, item, notes) : before;
    sentence = `${pre}${det === undefined ? item.answer : joinDet(det, item.answer)}${after}`;
  } else {
    if (determiner !== undefined) {
      const det = /^an?$/iu.test(determiner) ? (enStartsWithVowelSound(item.answer) ? "an" : "a") : determiner;
      if (det !== determiner.toLowerCase()) notes.push(`determiner "${determiner}" → "${det}"`);
      sentence = `${before}${det} ${item.answer}${after}`;
    } else {
      sentence = `${adaptEnglishBefore(before, item, notes)}${item.answer}${after}`;
    }
  }
  return { sentence, notes };
}
