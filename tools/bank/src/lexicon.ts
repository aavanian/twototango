// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { layoutBoxes, normalizeWord, type Cell, type Item, type Lang } from "@twototango/core";

export type Pos = Item["pos"] | "other";

export interface FormEntry {
  readonly form: string;
  readonly lemma: string;
  readonly pos: Pos;
  readonly zipf: number;
  readonly lemmaZipf: number;
  /** French nouns and adjectives: m, f or empty. */
  readonly gender: string;
  readonly number: string;
  /** Stem or derivational base of the lemma, for shared-root checks. */
  readonly root: string;
}

export const REPO = resolve(import.meta.dirname, "../../..");
export const LEX_DIR = resolve(REPO, "data/lex");

/** Lookup key: NFC lowercase with one apostrophe, so l'œuvre and l’œuvre meet. */
export const key = (word: string): string => normalizeWord(word).replace(/’/gu, "'");

/** A row's shape as boxes: L per letter, marks as themselves ("LLLL-LLLLL"). */
export function shapeOf(cells: readonly Cell[]): string {
  return cells.map((c) => (c.kind === "letter" ? "L" : c.char)).join("");
}

/**
 * The lexicon files written by tools/bank/lexicon/import_lexicon.py, indexed for
 * the checks: by form, by lemma, by box shape, plus synonyms by lemma and part of speech.
 */
export class Lexicon {
  readonly lang: Lang;
  readonly #byForm = new Map<string, FormEntry[]>();
  readonly #byLemma = new Map<string, FormEntry[]>();
  readonly #byShape = new Map<string, string[]>();
  readonly #synonyms = new Map<string, string[]>();

  constructor(lang: Lang, entries: Iterable<FormEntry>, synonyms: Iterable<[lemma: string, pos: Pos, syns: string[]]>) {
    this.lang = lang;
    for (const e of entries) {
      push(this.#byForm, key(e.form), e);
      push(this.#byLemma, `${key(e.lemma)}|${e.pos}`, e);
    }
    for (const form of this.#byForm.keys()) {
      let cells: Cell[];
      try {
        cells = layoutBoxes(form, lang);
      } catch {
        continue;
      }
      push(this.#byShape, shapeOf(cells), form);
    }
    for (const [lemma, pos, syns] of synonyms) this.#synonyms.set(`${key(lemma)}|${pos}`, syns);
  }

  static load(lang: Lang, dir = LEX_DIR): Lexicon {
    const forms = readTsv(resolve(dir, `${lang}-forms.tsv`)).map(
      (r): FormEntry => ({
        form: r[0]!,
        lemma: r[1]!,
        pos: r[2] as Pos,
        zipf: Number(r[3]),
        lemmaZipf: Number(r[4]),
        gender: r[5] ?? "",
        number: r[6] ?? "",
        root: r[7] ?? "",
      }),
    );
    const syns = readTsv(resolve(dir, `${lang}-synonyms.tsv`)).map(
      (r) => [r[0]!, r[1] as Pos, r[2]!.split(",")] as [string, Pos, string[]],
    );
    return new Lexicon(lang, forms, syns);
  }

  /**
   * Every reading of a word form. A British -ise form missing from the (mostly American)
   * frequency data borrows the readings of its -ize spelling: itemise → itemize.
   */
  entries(form: string): readonly FormEntry[] {
    const direct = this.#byForm.get(key(form));
    if (direct || this.lang !== "en") return direct ?? [];
    const ize = key(form).replace(/is(e|es|ed|ing|ation|ations|er|ers)$/u, "iz$1");
    if (ize === key(form)) return [];
    const toIse = (w: string) => w.replace(/iz(e|es|ed|ing|ation|ations|er|ers)$/u, "is$1");
    return (this.#byForm.get(ize) ?? []).map((e) => ({ ...e, form: toIse(e.form), lemma: toIse(e.lemma) }));
  }

  has(form: string): boolean {
    return this.entries(form).length > 0;
  }

  zipf(form: string): number {
    return this.entries(form)[0]?.zipf ?? 0;
  }

  /** Every form of a lemma in a part of speech (the lemma itself included when listed). */
  forms(lemma: string, pos: Pos): readonly FormEntry[] {
    return this.#byLemma.get(`${key(lemma)}|${pos}`) ?? [];
  }

  /** All lemma entries (form = lemma) of the given parts of speech. */
  *lemmas(pos: readonly Pos[]): Generator<FormEntry> {
    const want = new Set(pos);
    for (const list of this.#byForm.values()) {
      for (const e of list) if (want.has(e.pos) && key(e.form) === key(e.lemma)) yield e;
    }
  }

  synonyms(lemma: string, pos: Pos): readonly string[] {
    return this.#synonyms.get(`${key(lemma)}|${pos}`) ?? [];
  }

  /** Forms with exactly this box shape. */
  formsWithShape(shape: string): readonly string[] {
    return this.#byShape.get(shape) ?? [];
  }

  /** The root of a word: from its lemma entries when known. */
  roots(word: string): string[] {
    return [...new Set(this.entries(word).map((e) => e.root).filter(Boolean))];
  }
}

function push<K, V>(map: Map<K, V[]>, k: K, v: V): void {
  const list = map.get(k);
  if (list) list.push(v);
  else map.set(k, [v]);
}

export function readTsv(path: string): string[][] {
  const lines = readFileSync(path, "utf8").split("\n");
  return lines
    .slice(1)
    .filter((l) => l.length > 0)
    .map((l) => l.split("\t").map((cell) => cell.replace(/\\(.)/gu, "$1")));
}

/** One word per line, # comments allowed. */
export function readWordList(path: string): Set<string> {
  return new Set(
    readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*/u, "").trim())
      .filter(Boolean)
      .map(key),
  );
}

export function profanity(lang: Lang): Set<string> {
  const dir = resolve(REPO, "tools/bank/data/profanity");
  return new Set([...readWordList(resolve(dir, lang)), ...readWordList(resolve(dir, `extra-${lang}`))]);
}
