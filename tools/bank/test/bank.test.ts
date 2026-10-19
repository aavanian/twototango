// SPDX-License-Identifier: AGPL-3.0-only

import { Item } from "@twototango/core";
import { describe, expect, it } from "vitest";
import { checkDraft, nearDuplicates, similarity } from "../src/checks.ts";
import { Lexicon, type FormEntry, type Pos } from "../src/lexicon.ts";
import { choosePlacement, rivalsFor } from "../src/placement.ts";
import { relatedWords, stemsRelated } from "../src/roots.ts";
import { dedupeRoots, eligible, selectCandidates } from "../src/select.ts";
import { substitute } from "../src/substitute.ts";

type Row = [form: string, lemma: string, pos: Pos, zipf: number, root?: string, gender?: string];

function lexicon(lang: "en" | "fr", rows: Row[], synonyms: [string, Pos, string[]][] = []): Lexicon {
  const lemmaZipf = new Map(rows.filter(([f, l]) => f === l).map(([, l, , z]) => [l, z]));
  const entries = rows.map(
    ([form, lemma, pos, zipf, root, gender]): FormEntry => ({
      form,
      lemma,
      pos,
      zipf,
      lemmaZipf: lemmaZipf.get(lemma) ?? zipf,
      gender: gender ?? "",
      number: "",
      root: root ?? lemma,
    }),
  );
  return new Lexicon(lang, entries, synonyms);
}

const en = lexicon(
  "en",
  [
    ["adorn", "adorn", "verb", 3.0, "adorn"],
    ["adorned", "adorn", "verb", 3.4, "adorn"],
    ["decorate", "decorate", "verb", 4.0, "decor"],
    ["decorated", "decorate", "verb", 4.0, "decor"],
    ["deck", "deck", "verb", 3.5, "deck"],
    ["decked", "deck", "verb", 3.0, "deck"],
    ["arrayed", "array", "verb", 2.5, "array"],
    ["adjured", "adjure", "verb", 1.6, "adjur"],
    ["admired", "admire", "verb", 3.5, "admir"],
    ["obstinate", "obstinate", "adjective", 3.0, "obstin"],
    ["obstinacy", "obstinacy", "noun", 2.9, "obstinaci"],
    ["stubborn", "stubborn", "adjective", 3.9, "stubborn"],
    ["stubbornness", "stubbornness", "noun", 3.4, "stubborn"],
    ["shit", "shit", "noun", 4.5, "shit"],
    ["ordure", "ordure", "noun", 3.0, "ordur"],
  ],
  [
    ["adorn", "verb", ["decorate", "deck", "array"]],
    ["obstinate", "adjective", ["stubborn"]],
    ["obstinacy", "noun", ["stubbornness"]],
    ["ordure", "noun", ["shit"]],
  ],
);

const adorned = Item.parse({
  id: "en-c1-0001",
  lang: "en",
  level: "C1",
  pos: "verb",
  prompt: { kind: "sentence", before: "They ", span: ["decorated"], after: " the hall with garlands." },
  fixedWords: ["with"],
  answer: "adorned",
  lemma: "adorn",
  given: [0, 5],
  alternates: ["arrayed"],
});

const opts = { profanity: new Set(["shit"]) };

describe("roots", () => {
  it("relates stems when one extends the other", () => {
    expect(stemsRelated("obstin", "obstinaci")).toBe(true);
    expect(stemsRelated("cat", "catapult")).toBe(false);
    expect(relatedWords(en, "obstinate", "obstinacy")).toBe(true);
    expect(relatedWords(en, "stubborn", "obstinate")).toBe(false);
  });
});

describe("candidate selection", () => {
  it("keeps lemmas in a band with an easier synonym of the same part of speech", () => {
    const lemmas = eligible(en).map((c) => `${c.lemma}:${c.level}:${c.easier.join("/")}`);
    expect(lemmas).toContain("adorn:C1:decorate/deck");
    expect(lemmas).toContain("obstinate:C1:stubborn");
    expect(lemmas.some((l) => l.startsWith("decorate"))).toBe(false);
  });

  it("leaves out profanity, and words whose only easier synonym is profane", () => {
    expect(eligible(en, opts).some((c) => c.lemma === "ordure")).toBe(false);
  });

  it("keeps one lemma per root across levels", () => {
    const kept = dedupeRoots(en, eligible(en)).map((c) => c.lemma);
    expect(kept.filter((l) => l.startsWith("obstina"))).toHaveLength(1);
  });

  it("fills part-of-speech quotas and marks one in five for definitions", () => {
    const sel = selectCandidates(en, { target: 5 });
    expect(sel.counts.C1.verb).toEqual({ available: 1, taken: 1, wanted: 2 });
    expect(sel.candidates.filter((c) => c.definition).length).toBeGreaterThan(0);
  });
});

describe("given-letter placement", () => {
  it("lists unaccepted synonym forms with the answer's shape", () => {
    expect(rivalsFor(adorned, en)).toEqual([]);
    const strict = { ...adorned, alternates: [] };
    expect(rivalsFor(strict, en)).toEqual(["arrayed"]);
  });

  it("only uses placements that rule out the rivals", () => {
    const strict = { ...adorned, alternates: [] };
    const report = choosePlacement(strict, en);
    expect(report.rivals).toEqual(["arrayed"]);
    expect(report.choice).not.toBeNull();
    // arrayed and adorned share a, e and d at 0, 5 and 6: none of those placements are usable.
    expect(report.choice!.given).not.toEqual([0, 5]);
    expect(report.usable).toBeLessThan(report.total);
  });

  it("gives the most telling letters at B2 and the least at C2", () => {
    const b2 = choosePlacement({ ...adorned, level: "B2" }, en).choice!;
    const c2 = choosePlacement({ ...adorned, level: "C2" }, en).choice!;
    expect(b2.patternMatches.length).toBeLessThanOrEqual(c2.patternMatches.length);
  });
});

describe("substitution", () => {
  const fr = lexicon("fr", [
    ["effroi", "effroi", "noun", 3.0, "effroi", "m"],
    ["frayeur", "frayeur", "noun", 3.2, "frayeur", "f"],
    ["courroux", "courroux", "noun", 2.5, "courroux", "m"],
    ["fâcher", "fâcher", "verb", 3.0],
  ]);
  const frItem = (answer: string, pos: "noun" | "verb", prompt: object) =>
    Item.parse({ id: "fr-c1-0001", lang: "fr", level: "C1", pos, prompt, answer, lemma: answer, given: [0] });

  it("adapts the French article to the answer's gender and elision", () => {
    const peur = { kind: "sentence", before: "Elle a eu ", determiner: "une", span: ["peur"], after: " terrible." };
    expect(substitute(frItem("courroux", "noun", peur), fr)?.sentence).toBe("Elle a eu un courroux terrible.");
    const la = { kind: "sentence", before: "", determiner: "la", span: ["peur"], after: " la saisit." };
    expect(substitute(frItem("effroi", "noun", la), fr)?.sentence).toBe("l’effroi la saisit.");
  });

  it("undoes or adds elision right before the span", () => {
    const agacer = { kind: "sentence", before: "Ce bruit a fini par m’", span: ["agacer"], after: "." };
    expect(substitute(frItem("fâcher", "verb", agacer), fr)).toEqual({
      sentence: "Ce bruit a fini par me fâcher.",
      notes: ['"m’" → "me "'],
    });
  });

  it("switches a and an in English", () => {
    const item = { ...adorned, pos: "adjective" as const, answer: "obstinate", lemma: "obstinate", prompt: { kind: "sentence" as const, before: "a ", span: ["stubborn"], after: " child" } };
    expect(substitute(item, en)?.sentence).toBe("an obstinate child");
  });
});

describe("checkDraft", () => {
  it("passes a sound item and reports the substituted sentence", () => {
    const r = checkDraft(adorned, en, opts);
    expect(r.issues).toEqual([]);
    expect(r.substituted).toBe("They adorned the hall with garlands.");
  });

  it("fails an answer that is not a form of its lemma, or not in the lexicon", () => {
    expect(checkDraft({ ...adorned, lemma: "deck" }, en, opts).issues.map((i) => i.code)).toContain("answer-lemma");
    expect(checkDraft({ ...adorned, answer: "adornes" }, en, opts).issues.map((i) => i.code)).toContain("answer-unknown");
  });

  it("fails a rival that fits the boxes", () => {
    const r = checkDraft({ ...adorned, alternates: [] }, en, opts);
    expect(r.issues.find((i) => i.code === "rival-fits")?.message).toContain("arrayed");
  });

  it("fails a root shared through the stems, and profanity", () => {
    const item = Item.parse({ ...adorned, id: "en-c1-0002", pos: "noun", answer: "obstinacy", lemma: "obstinacy", given: [0, 3, 6], alternates: [], fixedWords: [], prompt: { kind: "definition", definition: "being obstinate, shit" } });
    const codes = checkDraft(item, en, opts).issues.map((i) => i.code);
    expect(codes).toContain("shared-root-stem");
    expect(codes).toContain("profanity");
  });

  it("flags near-duplicate prompts", () => {
    expect(similarity("They decorated the hall with garlands.", "They decorated the big hall with garlands.")).toBeGreaterThan(0.6);
    const twin = { ...adorned, id: "en-c1-0002", prompt: { ...adorned.prompt, after: " the big hall with garlands." } } as Item;
    expect(nearDuplicates([adorned, twin]).map((i) => i.itemId)).toEqual(["en-c1-0002"]);
  });
});

describe("British spelling", () => {
  const sp = lexicon("en", [
    ["colour", "colour", "noun", 4.5],
    ["color", "color", "noun", 4.6],
    ["organise", "organise", "verb", 4.0],
    ["organize", "organize", "verb", 4.2],
    ["motor", "motor", "noun", 4.0],
  ]);

  it("maps American forms to British ones the lexicon knows", async () => {
    const { britishVariant } = await import("../src/spelling.ts");
    expect(britishVariant("color", sp)).toBe("colour");
    expect(britishVariant("organize", sp)).toBe("organise");
    expect(britishVariant("motor", sp)).toBeNull();
    expect(britishVariant("colour", sp)).toBeNull();
  });

  it("fails an English item with an American answer", () => {
    const item = Item.parse({ ...adorned, id: "en-c1-0003", pos: "verb", answer: "organize", lemma: "organize", given: [0, 4], alternates: [], fixedWords: [], prompt: { kind: "definition", definition: "to arrange things" } });
    const issues = checkDraft(item, sp, opts).issues;
    expect(issues.find((i) => i.code === "us-spelling")).toMatchObject({ severity: "fail" });
  });
});
