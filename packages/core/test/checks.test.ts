// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { Bank, checkBanks, checkItem, Item, sharesRoot } from "../src/index.ts";

const adorn = Item.parse({
  id: "en-c1-0001",
  lang: "en",
  level: "C1",
  pos: "verb",
  prompt: {
    kind: "sentence",
    before: "They ",
    span: ["decorated"],
    after: " the hall with garlands.",
  },
  fixedWords: ["with"],
  answer: "adorned",
  lemma: "adorn",
  given: [0, 5],
  alternates: [],
});

const codes = (item: Item) => checkItem(item).map((i) => i.code);

describe("sharesRoot", () => {
  it.each([
    ["decorate", "adorn", false],
    ["approach", "accost", false],
    ["tribulation", "trial", false],
    ["irritate", "irritable", true],
    ["peur", "apeuré", true],
    ["Élevé", "élever", true],
  ])("%s / %s → %s", (a, b, shared) => {
    expect(sharesRoot(a, b)).toBe(shared);
  });
});

describe("checkItem", () => {
  it("passes a well-formed item", () => {
    expect(checkItem(adorn)).toEqual([]);
  });

  it("parses defaults for fixed words and alternates", () => {
    const { fixedWords, alternates, ...rest } = adorn;
    const parsed = Item.parse(rest);
    expect(parsed.fixedWords).toEqual([]);
    expect(parsed.alternates).toEqual([]);
  });

  it("rejects unknown fields", () => {
    expect(() => Item.parse({ ...adorn, extra: 1 })).toThrow();
  });

  it("flags an id that doesn't match the language or level", () => {
    expect(codes({ ...adorn, id: "fr-c1-0001" })).toContain("id-mismatch");
    expect(codes({ ...adorn, level: "C2" })).toContain("id-mismatch");
  });

  it("flags answers that aren't stored normalized", () => {
    expect(codes({ ...adorn, answer: "Adorned" })).toContain("answer-not-normalized");
  });

  it("flags answers that can't be laid out", () => {
    expect(codes({ ...adorn, answer: "dressed up" })).toEqual(["answer-layout"]);
  });

  it("flags bad given letters", () => {
    expect(codes({ ...adorn, given: [0, 1] })).toContain("given-invalid");
    expect(codes({ ...adorn, given: [0, 2, 4, 6] })).toContain("given-invalid");
  });

  it("flags alternates that don't fit or repeat", () => {
    expect(codes({ ...adorn, alternates: ["arrayed"] })).toEqual([]);
    expect(codes({ ...adorn, alternates: ["decked"] })).toEqual(["alternate-misfit"]);
    expect(codes({ ...adorn, alternates: ["adorned"] })).toEqual(["alternate-duplicate"]);
  });

  it("flags an answer sharing a root with the span", () => {
    const item = { ...adorn, prompt: { kind: "sentence" as const, before: "", span: ["adornment"], after: "" } };
    expect(codes(item)).toContain("shared-root");
  });

  it("doesn't look for roots in definition items", () => {
    expect(codes({ ...adorn, prompt: { kind: "definition", definition: "to make more beautiful" } })).toEqual([]);
  });
});

describe("checkBanks", () => {
  const bank = (level: "C1" | "C2", items: Item[]) => Bank.parse({ lang: "en", level, items });

  it("passes distinct items", () => {
    expect(checkBanks([bank("C1", [adorn])])).toEqual([]);
  });

  it("flags duplicate ids", () => {
    const twin = { ...adorn, lemma: "deck" };
    expect(checkBanks([bank("C1", [adorn, twin])]).map((i) => i.code)).toEqual(["duplicate-id"]);
  });

  it("flags a lemma reused across levels", () => {
    const again = { ...adorn, id: "en-c2-0001", level: "C2" as const };
    expect(checkBanks([bank("C1", [adorn]), bank("C2", [again])]).map((i) => i.code)).toEqual(["duplicate-lemma"]);
  });

  it("flags an item filed in the wrong bank", () => {
    expect(checkBanks([bank("C2", [adorn])]).map((i) => i.code)).toEqual(["wrong-bank"]);
  });
});
