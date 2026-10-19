// SPDX-License-Identifier: AGPL-3.0-only

import { Item } from "@twototango/core";
import { describe, expect, it } from "vitest";
import { Lexicon, type FormEntry } from "../src/lexicon.ts";
import { judgeSolve, solverView } from "../src/solve.ts";

const lex = new Lexicon(
  "en",
  ["adorned", "arrayed", "applied", "decked"].map((form): FormEntry => ({ form, lemma: form, pos: "verb", zipf: 3, lemmaZipf: 3, gender: "", number: "", root: form })),
  [],
);
const item = Item.parse({
  id: "en-c1-0001",
  lang: "en",
  level: "C1",
  pos: "verb",
  prompt: { kind: "sentence", before: "They ", span: ["decorated"], after: " the hall with garlands." },
  fixedWords: ["with"],
  answer: "adorned",
  lemma: "adorn",
  given: [0, 5],
});

describe("solverView", () => {
  it("shows the boxes and the span but never the answer", () => {
    const view = solverView(item);
    expect(view).toContain("Sentence: They [decorated] the hall with garlands.");
    expect(view).toContain("Boxes: a____e_ + with");
    expect(view).not.toContain("adorned");
  });
});

describe("judgeSolve", () => {
  it("passes when the solver finds the answer and nothing else that fits", () => {
    const v = judgeSolve(item, { id: item.id, candidates: ["Adorned", "decked"], clueIssue: null }, lex);
    expect(v).toMatchObject({ foundAnswer: true, rivals: [], issues: [] });
  });

  it("fails on a listed word that fits the boxes, flags a missed answer", () => {
    const v = judgeSolve(item, { id: item.id, candidates: ["arrayed", "applied"], clueIssue: null }, lex);
    expect(v.foundAnswer).toBe(false);
    // Both keep a at 0 and e at 5, so both fit a____e_.
    expect(v.rivals).toEqual(["arrayed", "applied"]);
    expect(v.issues.map((i) => i.code)).toEqual(["solve-missed", "solve-rival"]);
  });

  it("fails on a clue issue the solver reports", () => {
    const v = judgeSolve(item, { id: item.id, candidates: ["adorned"], clueIssue: "wrong preposition" }, lex);
    expect(v.issues.map((i) => i.code)).toEqual(["clue-issue"]);
  });
});

describe("British -ise answers", () => {
  const lexIze = new Lexicon("en", [{ form: "itemize", lemma: "itemize", pos: "verb", zipf: 2.5, lemmaZipf: 2.5, gender: "", number: "", root: "item" }], []);
  const itemise = Item.parse({ ...item, answer: "itemise", lemma: "itemise", given: [0, 4], fixedWords: [], prompt: { kind: "definition", definition: "to list one by one" } });

  it("knows an -ise form through its -ize spelling", () => {
    expect(lexIze.has("itemise")).toBe(true);
    expect(lexIze.entries("itemise")[0]).toMatchObject({ form: "itemise", lemma: "itemise", pos: "verb" });
  });

  it("does not count the American spelling of the answer as a rival", () => {
    const v = judgeSolve(itemise, { id: itemise.id, candidates: ["itemize"], clueIssue: null }, lexIze);
    expect(v).toMatchObject({ foundAnswer: true, rivals: [], issues: [] });
  });
});
