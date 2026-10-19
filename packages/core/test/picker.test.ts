// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { defaultItemCount, Item, itemCountOptions, pickItems, seededRng, shuffle } from "../src/index.ts";

const POS = ["noun", "verb", "adjective"] as const;

function makeItem(n: number, definition: boolean): Item {
  return Item.parse({
    id: `en-c1-${String(n).padStart(4, "0")}`,
    lang: "en",
    level: "C1",
    pos: POS[n % 3],
    prompt: definition
      ? { kind: "definition", definition: `definition ${n}` }
      : { kind: "sentence", before: "a ", span: [`span${n}`], after: "." },
    answer: "adorned",
    lemma: `lemma${n}`,
    given: [0, 5],
  });
}

// 60 items, every fifth a definition.
const bank = Array.from({ length: 60 }, (_, n) => makeItem(n, n % 5 === 0));

describe("item counts", () => {
  it.each([
    [2, 14],
    [3, 15],
    [4, 16],
    [5, 15],
    [6, 12],
  ])("%i players → %i items by default", (p, n) => {
    expect(defaultItemCount(p)).toBe(n);
    expect(itemCountOptions(p)).toContain(n);
  });

  it("offers only multiples of p", () => {
    expect(itemCountOptions(4)).toEqual([4, 8, 12, 16, 20, 24, 28]);
  });
});

describe("shuffle", () => {
  it("is a deterministic permutation for a given seed", () => {
    const a = shuffle([1, 2, 3, 4, 5], seededRng(7));
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(shuffle([1, 2, 3, 4, 5], seededRng(7))).toEqual(a);
  });
});

describe("pickItems", () => {
  it("picks distinct items with about one definition in five", () => {
    for (let seed = 0; seed < 20; seed++) {
      const picked = pickItems(bank, 15, new Map(), seededRng(seed));
      expect(new Set(picked.map((i) => i.id)).size).toBe(15);
      expect(picked.filter((i) => i.prompt.kind === "definition")).toHaveLength(3);
    }
  });

  it("mixes parts of speech and spaces out definitions", () => {
    const picked = pickItems(bank, 15, new Map(), seededRng(3));
    for (let k = 1; k < picked.length; k++) {
      expect(picked[k]!.pos).not.toBe(picked[k - 1]!.pos);
      expect(picked[k]!.prompt.kind === "definition" && picked[k - 1]!.prompt.kind === "definition").toBe(false);
    }
  });

  it("never repeats an item until every item has been played", () => {
    const history = new Map<string, number>();
    for (let game = 1; game <= 4; game++) {
      for (const item of pickItems(bank, 15, history, seededRng(game))) {
        expect(history.has(item.id)).toBe(false);
        history.set(item.id, game);
      }
    }
    expect(history.size).toBe(60);
  });

  it("then brings back the least recently played first", () => {
    const history = new Map(bank.map((item, n) => [item.id, n < 15 ? 1 : 2]));
    const picked = pickItems(bank, 15, history, seededRng(1));
    expect(picked.every((item) => history.get(item.id) === 1)).toBe(true);
  });

  it("takes every remaining unplayed item before replaying any", () => {
    // 50 played, 10 fresh: all 10 fresh plus 5 of the oldest.
    const history = new Map(bank.slice(0, 50).map((item, n) => [item.id, n < 25 ? 1 : 2]));
    const picked = pickItems(bank, 15, history, seededRng(1));
    const fresh = picked.filter((item) => !history.has(item.id));
    expect(fresh).toHaveLength(10);
    expect(picked.filter((item) => history.get(item.id) === 1)).toHaveLength(5);
  });

  it("fails when the bank is too small", () => {
    expect(() => pickItems(bank.slice(0, 5), 6, new Map(), seededRng(1))).toThrow(RangeError);
  });
});
