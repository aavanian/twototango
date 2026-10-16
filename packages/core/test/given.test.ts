// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { fitsPattern, givenCount, isValidPlacement, layoutBoxes, placements } from "../src/index.ts";

describe("givenCount", () => {
  it.each([
    [3, 1],
    [4, 1],
    [5, 2],
    [6, 2],
    [7, 2],
    [8, 3],
    [10, 3],
    [11, 4],
    [14, 5],
  ])("%i letters → %i given", (n, k) => {
    expect(givenCount(n)).toBe(k);
  });

  it("refuses words under three letters", () => {
    expect(() => givenCount(2)).toThrow(RangeError);
  });
});

describe("placements", () => {
  it("lists every non-adjacent placement", () => {
    expect([...placements(5)]).toEqual([
      [0, 2],
      [0, 3],
      [0, 4],
      [1, 3],
      [1, 4],
      [2, 4],
    ]);
  });

  it("only yields valid placements, for every length", () => {
    for (let n = 3; n <= 16; n++) {
      const all = [...placements(n)];
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((p) => isValidPlacement(p, n))).toBe(true);
    }
  });
});

describe("isValidPlacement", () => {
  it.each([
    [[1, 3], 5, true],
    [[1, 2], 5, false],
    [[3, 1], 5, false],
    [[1], 5, false],
    [[1, 5], 5, false],
    [[0, 2, 4], 8, true],
  ])("%j for %i letters → %s", (positions, n, ok) => {
    expect(isValidPlacement(positions, n)).toBe(ok);
  });
});

describe("fitsPattern", () => {
  const adorn = layoutBoxes("adorn", "en");

  it("matches words with the same length and given letters", () => {
    expect(fitsPattern("adorn", adorn, [0, 4], "en")).toBe(true);
    expect(fitsPattern("acorn", adorn, [0, 4], "en")).toBe(true);
    expect(fitsPattern("scorn", adorn, [0, 4], "en")).toBe(false);
    expect(fitsPattern("adore", adorn, [0, 4], "en")).toBe(false);
    expect(fitsPattern("adorns", adorn, [0, 4], "en")).toBe(false);
  });

  it("is accent-sensitive in French", () => {
    const eleve = layoutBoxes("élevé", "fr");
    expect(fitsPattern("élevé", eleve, [0, 4], "fr")).toBe(true);
    expect(fitsPattern("eleve", eleve, [0, 4], "fr")).toBe(false);
  });

  it("requires marks in the same places", () => {
    const cells = layoutBoxes("peut-être", "fr");
    expect(fitsPattern("peut-etre", cells, [0], "fr")).toBe(true);
    expect(fitsPattern("peutêtres", cells, [0], "fr")).toBe(false);
  });
});
