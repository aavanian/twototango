// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { finalize, parseDraftBatch, type Draft } from "../src/draft.ts";
import { Lexicon, type FormEntry, type Pos } from "../src/lexicon.ts";

const rows: [string, string, Pos, number][] = [
  ["clemency", "clemency", "noun", 2.9],
  ["leniency", "leniency", "noun", 2.9],
  ["mercy", "mercy", "noun", 4.0],
];
const lex = new Lexicon(
  "en",
  rows.map(([form, lemma, pos, zipf]): FormEntry => ({ form, lemma, pos, zipf, lemmaZipf: zipf, gender: "", number: "", root: lemma })),
  [["clemency", "noun", ["mercy", "leniency"]]],
);

const draft: Draft = {
  lemma: "clemency",
  pos: "noun",
  kind: "sentence",
  before: "The judge showed ",
  span: ["mercy"],
  after: " to the boy.",
  fixedWords: [],
  answer: "Clemency",
  acceptable: ["leniency"],
  nearMisses: [],
};

describe("finalize", () => {
  it("turns a draft into an item whose letters rule out acceptable synonyms too", () => {
    const { item, notes } = finalize(draft, "en-c1-0001", "en", "C1", lex);
    expect(notes).toEqual([]);
    expect(item).toMatchObject({ id: "en-c1-0001", answer: "clemency", alternates: [] });
    // clemency and leniency share n, c, y at 5, 6, 7.
    expect(item!.given.every((p) => p >= 5)).toBe(false);
  });

  it("keeps acceptable words as alternates only when no placement can rule them out", () => {
    // Four letters get one given letter; each acceptable word differs from "dune" at a
    // different position, so no single letter rules them all out.
    const tight = { ...draft, lemma: "dune", answer: "dune", acceptable: ["tune", "dine", "dude", "dung"] };
    const { item, notes } = finalize(tight, "en-c1-0002", "en", "C1", lex);
    expect(item).not.toBeNull();
    expect(notes[0]).toMatch(/^alternates kept: /);
    expect(item!.alternates).toHaveLength(3);
  });

  it("drops a draft that fails the schema", () => {
    const { item, notes } = finalize({ ...draft, span: [] }, "en-c1-0003", "en", "C1", lex);
    expect(item).toBeNull();
    expect(notes[0]).toMatch(/schema/);
  });
});

describe("parseDraftBatch", () => {
  it("accepts strict-mode output with nulls for absent fields", () => {
    const [d] = parseDraftBatch({
      items: [{ ...draft, determiner: null, definition: null }],
    });
    expect(d).toMatchObject({ lemma: "clemency" });
    expect(d && "determiner" in d).toBe(false);
  });

  it("drops empty strings for fields that don't apply to the item's kind", () => {
    const [sentence, definition] = parseDraftBatch({
      items: [
        { ...draft, determiner: "", definition: "" },
        { ...draft, kind: "definition", before: "", span: [], after: "", determiner: "", definition: "Mercy shown by a judge" },
      ],
    });
    expect(sentence).not.toHaveProperty("determiner");
    expect(sentence).not.toHaveProperty("definition");
    expect(definition).toMatchObject({ kind: "definition", definition: "Mercy shown by a judge" });
    expect(definition).not.toHaveProperty("span");
  });
});

describe("splitDeterminer", async () => {
  const { splitDeterminer } = await import("../src/draft.ts");

  it("moves a trailing article out of before", () => {
    expect(splitDeterminer({ before: "I had a " }, "en")).toEqual({ before: "I had ", determiner: "a" });
    expect(splitDeterminer({ before: "The " }, "en")).toEqual({ before: "", determiner: "The" });
    expect(splitDeterminer({ before: "Elle a eu une " }, "fr")).toEqual({ before: "Elle a eu ", determiner: "une" });
    expect(splitDeterminer({ before: "Ce bruit a fini par m’" }, "fr")).toEqual({ before: "Ce bruit a fini par m’" });
  });

  it("leaves possessives and article-like word endings alone", () => {
    expect(splitDeterminer({ before: "His " }, "en")).toEqual({ before: "His " });
    expect(splitDeterminer({ before: "Nobody saw the area " }, "en")).toEqual({ before: "Nobody saw the area " });
  });

  it("removes an article repeated before a given determiner", () => {
    expect(splitDeterminer({ before: "The ", determiner: "The" }, "en")).toEqual({ before: "", determiner: "The" });
    expect(splitDeterminer({ before: "I had a strong a ", determiner: "a" }, "en")).toEqual({ before: "I had a strong ", determiner: "a" });
  });
});

describe("articleForSpan", async () => {
  const { articleForSpan } = await import("../src/draft.ts");
  it("matches a/an to the clue, not the answer", () => {
    expect(articleForSpan("an", ["curse"], "en")).toBe("a");
    expect(articleForSpan("a", ["insult"], "en")).toBe("an");
    expect(articleForSpan("An", ["curse"], "en")).toBe("A");
    expect(articleForSpan("the", ["curse"], "en")).toBe("the");
    expect(articleForSpan("une", ["peur"], "fr")).toBe("une");
  });
});
