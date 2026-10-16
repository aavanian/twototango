// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { BoxError, layoutBoxes, letters, showCells } from "../src/index.ts";

describe("layoutBoxes", () => {
  it("gives one box per English letter", () => {
    expect(letters(layoutBoxes("Adorn", "en"))).toEqual(["a", "d", "o", "r", "n"]);
  });

  it("keeps French accents and œ as single boxes", () => {
    expect(letters(layoutBoxes("cœur", "fr"))).toEqual(["c", "œ", "u", "r"]);
    expect(letters(layoutBoxes("élève", "fr"))).toEqual(["é", "l", "è", "v", "e"]);
  });

  it("treats decomposed accents like precomposed ones", () => {
    expect(layoutBoxes("élan", "fr")).toEqual(layoutBoxes("élan", "fr"));
  });

  it("turns French hyphens and apostrophes into marks", () => {
    const cells = layoutBoxes("aujourd'hui", "fr");
    expect(cells.filter((c) => c.kind === "mark")).toEqual([{ kind: "mark", char: "’" }]);
    expect(letters(cells)).toHaveLength(10);
    expect(layoutBoxes("porte-voix", "fr")[5]).toEqual({ kind: "mark", char: "-" });
  });

  it.each([
    ["two words", "en"],
    ["well-off", "en"],
    ["café", "en"],
    ["r2d2", "fr"],
    ["-avant", "fr"],
    ["a--b", "fr"],
    ["", "fr"],
  ] as const)("rejects %j in %s", (word, lang) => {
    expect(() => layoutBoxes(word, lang)).toThrow(BoxError);
  });
});

describe("showCells", () => {
  const cells = layoutBoxes("peut-être", "fr");

  it("hides letters that aren't given, keeps marks", () => {
    expect(showCells(cells, [0, 5], false).map((c) => c.char)).toEqual(["p", null, null, null, "-", null, "t", null, null]);
  });

  it("shows every letter once revealed and still flags the given ones", () => {
    const shown = showCells(cells, [0, 5], true);
    expect(shown.map((c) => c.char).join("")).toBe("peut-être");
    expect(shown.filter((c) => c.kind === "letter" && c.given)).toHaveLength(2);
  });
});
