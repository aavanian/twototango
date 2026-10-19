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
