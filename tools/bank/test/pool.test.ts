// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from "vitest";
import { pool } from "../src/bakeoff.ts";

it("pool keeps order and never runs more than the limit at once", async () => {
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 20 }, (_, i) => async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5 + (i % 3)));
    running--;
    return i;
  });
  expect(await pool(tasks, 4)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  expect(peak).toBeLessThanOrEqual(4);
});

it("assertUnique refuses duplicate ids and lemmas", async () => {
  const { assertUnique } = await import("../src/run.ts");
  const a = { id: "en-c1-0001", lemma: "adorn" } as never;
  const b = { id: "en-c1-0001", lemma: "deck" } as never;
  const c = { id: "en-c1-0002", lemma: "adorn" } as never;
  expect(() => assertUnique([a, b])).toThrow(/duplicate id/);
  expect(() => assertUnique([a, c])).toThrow(/duplicate lemma/);
});
