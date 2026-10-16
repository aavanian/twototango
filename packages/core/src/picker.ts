// SPDX-License-Identifier: AGPL-3.0-only

import type { Item } from "./item.ts";
import { shuffle, type Rng } from "./random.ts";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const TARGET_ITEMS = 15;
export const MAX_ITEMS = 30;
export const DEFINITION_SHARE = 0.2;

/** The item counts offered for p players: multiples of p up to MAX_ITEMS. */
export function itemCountOptions(playerCount: number): number[] {
  const out: number[] = [];
  for (let n = playerCount; n <= MAX_ITEMS; n += playerCount) out.push(n);
  return out;
}

/** The multiple of p closest to 15; on a tie the lower one (p = 2 → 14, p = 6 → 12). */
export function defaultItemCount(playerCount: number): number {
  const low = Math.floor(TARGET_ITEMS / playerCount) * playerCount;
  const high = low + playerCount;
  if (low === 0) return high;
  return TARGET_ITEMS - low <= high - TARGET_ITEMS ? low : high;
}

/** When each item was last played (any increasing number: a timestamp or a game counter). */
export type PlayHistory = ReadonlyMap<string, number>;

/**
 * Picks `count` items for a game. Freshness comes first: unplayed items, then the
 * least recently played. Within the group where the cut falls, about one item in
 * five is a definition. The result is ordered so neighbours differ in part of
 * speech and definitions don't come back to back, where the pick allows.
 */
export function pickItems(items: readonly Item[], count: number, history: PlayHistory, rng: Rng): Item[] {
  if (items.length < count) throw new RangeError(`the bank has ${items.length} items, ${count} needed`);

  // Shuffle first so the stable sort leaves each freshness group in random order.
  const byFreshness = shuffle(items, rng).sort(
    (a, b) => (history.get(a.id) ?? -Infinity) - (history.get(b.id) ?? -Infinity),
  );

  const picked: Item[] = [];
  let i = 0;
  while (picked.length < count) {
    const stamp = history.get(byFreshness[i]!.id);
    let j = i;
    while (j < byFreshness.length && history.get(byFreshness[j]!.id) === stamp) j++;
    const group = byFreshness.slice(i, j);
    if (picked.length + group.length <= count) picked.push(...group);
    else picked.push(...pickFromGroup(group, count - picked.length, picked, count));
    i = j;
  }
  return arrange(picked);
}

function pickFromGroup(group: readonly Item[], need: number, already: readonly Item[], total: number): Item[] {
  const isDef = (it: Item) => it.prompt.kind === "definition";
  const wantDefs = Math.max(0, Math.round(total * DEFINITION_SHARE) - already.filter(isDef).length);
  const defs = group.filter(isDef).slice(0, Math.min(wantDefs, need));
  const rest = group.filter((it) => !defs.includes(it));
  // Sentences fill the rest; leftover definitions only if sentences run out.
  rest.sort((a, b) => Number(isDef(a)) - Number(isDef(b)));
  return [...defs, ...rest.slice(0, need - defs.length)];
}

/** Greedy reorder: each item differs from the previous in part of speech, and no two definitions in a row. */
function arrange(items: readonly Item[]): Item[] {
  const pool = [...items];
  const out: Item[] = [];
  while (pool.length > 0) {
    const prev = out.at(-1);
    let k = pool.findIndex(
      (it) => prev === undefined || (it.pos !== prev.pos && !(it.prompt.kind === "definition" && prev.prompt.kind === "definition")),
    );
    if (k < 0) k = pool.findIndex((it) => it.pos !== prev?.pos);
    if (k < 0) k = 0;
    out.push(...pool.splice(k, 1));
  }
  return out;
}
