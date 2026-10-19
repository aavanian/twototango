// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { LANGS, LEVELS } from "./item.ts";
import { MAX_PLAYERS, MIN_PLAYERS } from "./picker.ts";
import { shuffle, type Rng } from "./random.ts";

/**
 * The game is a pure state machine: the GM app keeps the event log, saves it after
 * every event, and rebuilds the state with `replay` on resume. Anything random
 * (item picks, turn order) is drawn by the caller and recorded in the event, so a
 * replay always lands on the same state.
 */

const id = z.string().min(1);

export const GameConfig = z.strictObject({
  lang: z.enum(LANGS),
  level: z.enum(LEVELS),
  playerCount: z.number().int(),
  itemIds: z.array(id),
});
export type GameConfig = z.infer<typeof GameConfig>;

export const GameEvent = z.discriminatedUnion("type", [
  /** First event of every log; again in the lobby when the GM changes the setup. */
  z.strictObject({ type: z.literal("configure"), config: GameConfig }),
  z.strictObject({ type: z.literal("join"), playerId: id, name: z.string() }),
  /** GM removes a player from the lobby. */
  z.strictObject({ type: z.literal("remove"), playerId: id }),
  /** A player's phone went away, or came back. */
  z.strictObject({ type: z.literal("leave"), playerId: id }),
  z.strictObject({ type: z.literal("return"), playerId: id }),
  z.strictObject({ type: z.literal("start"), order: z.array(id) }),
  z.strictObject({ type: z.literal("pass"), playerId: id }),
  z.strictObject({ type: z.literal("open") }),
  z.strictObject({ type: z.literal("correct"), playerId: id }),
  z.strictObject({ type: z.literal("reveal") }),
  z.strictObject({ type: z.literal("undo") }),
  z.strictObject({ type: z.literal("next") }),
  z.strictObject({ type: z.literal("end") }),
  z.strictObject({ type: z.literal("rematch"), itemIds: z.array(id), order: z.array(id) }),
]);
export type GameEvent = z.infer<typeof GameEvent>;

export type PlayerId = string;

export interface Player {
  readonly id: PlayerId;
  readonly name: string;
  readonly present: boolean;
}

export type SlotStatus = "pending" | "shown" | "open" | "revealed";
export type Points = 0 | 2 | 3;

/** One item of the game, in play order. */
export interface Slot {
  readonly itemId: string;
  /** Who the item was dealt to at start. */
  readonly owner: PlayerId;
  /** Who it went to when it came up: the owner, or the next present player if the owner had left. */
  readonly assignee: PlayerId | null;
  readonly status: SlotStatus;
  readonly passed: boolean;
  readonly winner: PlayerId | null;
  readonly points: Points;
  /** The status before the scoring decision, so undo can restore it. */
  readonly decidedFrom: "shown" | "open" | null;
}

export type Phase = "lobby" | "playing" | "results";

export interface GameState {
  readonly phase: Phase;
  readonly config: GameConfig;
  readonly players: readonly Player[];
  readonly order: readonly PlayerId[];
  readonly slots: readonly Slot[];
  readonly current: number;
  readonly endedEarly: boolean;
  /** 1 for the first game, +1 per rematch. */
  readonly round: number;
}

export class EngineError extends Error {}

function fail(message: string): never {
  throw new EngineError(message);
}

export const MAX_NAME_LENGTH = 24;

export function normalizeName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/gu, " ");
}

const sameName = (a: string, b: string) => normalizeName(a).toLocaleLowerCase() === normalizeName(b).toLocaleLowerCase();

export function findPlayerByName(state: GameState, name: string): Player | undefined {
  return state.players.find((p) => sameName(p.name, name));
}

function checkConfig(config: GameConfig): void {
  const { playerCount, itemIds } = config;
  if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    fail(`player count must be ${MIN_PLAYERS} to ${MAX_PLAYERS}, got ${playerCount}`);
  }
  checkItemIds(itemIds, playerCount);
}

function checkItemIds(itemIds: readonly string[], playerCount: number): void {
  if (itemIds.length === 0 || itemIds.length % playerCount !== 0) {
    fail(`${itemIds.length} items can't be shared among ${playerCount} players`);
  }
  if (new Set(itemIds).size !== itemIds.length) fail("an item appears twice");
}

function checkOrder(state: GameState, order: readonly PlayerId[]): void {
  const ids = new Set(state.players.map((p) => p.id));
  if (order.length !== ids.size || new Set(order).size !== order.length || !order.every((p) => ids.has(p))) {
    fail("turn order must list every player once");
  }
}

function player(state: GameState, playerId: PlayerId): Player {
  return state.players.find((p) => p.id === playerId) ?? fail(`no player ${playerId}`);
}

function setPresent(state: GameState, playerId: PlayerId, present: boolean): GameState {
  player(state, playerId);
  return { ...state, players: state.players.map((p) => (p.id === playerId ? { ...p, present } : p)) };
}

/** The current slot, with the phase checked. */
function currentSlot(state: GameState): Slot {
  if (state.phase !== "playing") fail("no game in progress");
  return state.slots[state.current] ?? fail("no current item");
}

function withSlot(state: GameState, slot: Slot): GameState {
  return { ...state, slots: state.slots.map((s, i) => (i === state.current ? slot : s)) };
}

/** The owner if present, else the next present player after them in turn order, else the owner anyway. */
function resolveAssignee(state: GameState, owner: PlayerId): PlayerId {
  const start = state.order.indexOf(owner);
  for (let k = 0; k < state.order.length; k++) {
    const candidate = state.order[(start + k) % state.order.length]!;
    if (state.players.find((p) => p.id === candidate)?.present) return candidate;
  }
  return owner;
}

function showSlot(state: GameState, index: number): GameState {
  const slot = state.slots[index]!;
  const shown: Slot = { ...slot, status: "shown", assignee: resolveAssignee(state, slot.owner) };
  return { ...state, current: index, slots: state.slots.map((s, i) => (i === index ? shown : s)) };
}

function deal(state: GameState, itemIds: readonly string[], order: readonly PlayerId[]): GameState {
  const slots = itemIds.map(
    (itemId, i): Slot => ({
      itemId,
      owner: order[i % order.length]!,
      assignee: null,
      status: "pending",
      passed: false,
      winner: null,
      points: 0,
      decidedFrom: null,
    }),
  );
  return showSlot({ ...state, phase: "playing", order, slots, current: 0, endedEarly: false }, 0);
}

/** Applies one event. Throws EngineError if the event isn't allowed in this state. */
export function apply(state: GameState | null, event: GameEvent): GameState {
  if (event.type === "configure") {
    checkConfig(event.config);
    if (state === null) {
      return { phase: "lobby", config: event.config, players: [], order: [], slots: [], current: 0, endedEarly: false, round: 1 };
    }
    if (state.phase !== "lobby") fail("setup can only change in the lobby");
    return { ...state, config: event.config };
  }
  if (state === null) fail("a game log starts with configure");
  const s = state;
  switch (event.type) {
    case "join": {
      if (s.phase !== "lobby") fail("no one can join after start");
      const name = normalizeName(event.name);
      if (name.length === 0 || name.length > MAX_NAME_LENGTH) fail(`names are 1 to ${MAX_NAME_LENGTH} characters`);
      if (s.players.some((p) => p.id === event.playerId)) fail(`player ${event.playerId} already joined`);
      if (findPlayerByName(s, name)) fail(`the name ${name} is taken`);
      return { ...s, players: [...s.players, { id: event.playerId, name, present: true }] };
    }
    case "remove":
      if (s.phase !== "lobby") fail("players can only be removed in the lobby");
      player(s, event.playerId);
      return { ...s, players: s.players.filter((p) => p.id !== event.playerId) };
    case "leave":
      return setPresent(s, event.playerId, false);
    case "return":
      return setPresent(s, event.playerId, true);
    case "start":
      if (s.phase !== "lobby") fail("the game has already started");
      if (s.players.length !== s.config.playerCount) {
        fail(`start needs exactly ${s.config.playerCount} players, ${s.players.length} joined`);
      }
      checkOrder(s, event.order);
      return deal(s, s.config.itemIds, event.order);
    case "pass": {
      const slot = currentSlot(s);
      if (slot.status !== "shown") fail("pass only applies before the item opens");
      if (slot.assignee !== event.playerId) fail("only the player in turn can pass");
      return withSlot(s, { ...slot, passed: true });
    }
    case "open": {
      const slot = currentSlot(s);
      if (slot.status !== "shown") fail("the item isn't waiting on the player in turn");
      return withSlot(s, { ...slot, status: "open" });
    }
    case "correct": {
      const slot = currentSlot(s);
      if (slot.status === "shown") {
        if (slot.assignee !== event.playerId) fail("before opening, only the player in turn can score");
        return withSlot(s, { ...slot, status: "revealed", winner: event.playerId, points: 3, decidedFrom: "shown" });
      }
      if (slot.status === "open") {
        if (!s.order.includes(event.playerId)) fail(`no player ${event.playerId} in this game`);
        return withSlot(s, { ...slot, status: "revealed", winner: event.playerId, points: 2, decidedFrom: "open" });
      }
      return fail("the item is already decided");
    }
    case "reveal": {
      const slot = currentSlot(s);
      if (slot.status !== "shown" && slot.status !== "open") fail("the item is already decided");
      return withSlot(s, { ...slot, status: "revealed", winner: null, points: 0, decidedFrom: slot.status });
    }
    case "undo": {
      const slot = currentSlot(s);
      if (slot.status !== "revealed" || slot.decidedFrom === null) fail("nothing to undo");
      return withSlot(s, { ...slot, status: slot.decidedFrom, winner: null, points: 0, decidedFrom: null });
    }
    case "next": {
      const slot = currentSlot(s);
      if (slot.status !== "revealed") fail("reveal the item before moving on");
      const done = withSlot(s, { ...slot, decidedFrom: null });
      if (s.current + 1 >= s.slots.length) return { ...done, phase: "results" };
      return showSlot(done, s.current + 1);
    }
    case "end":
      if (s.phase !== "playing") fail("no game in progress");
      return { ...s, phase: "results", endedEarly: true };
    case "rematch":
      if (s.phase !== "results") fail("a rematch starts from the results");
      checkItemIds(event.itemIds, s.players.length);
      checkOrder(s, event.order);
      return deal(
        { ...s, config: { ...s.config, playerCount: s.players.length, itemIds: event.itemIds }, round: s.round + 1 },
        event.itemIds,
        event.order,
      );
  }
}

export function replay(events: readonly GameEvent[]): GameState {
  const state = events.reduce<GameState | null>(apply, null);
  return state ?? fail("empty game log");
}

/** A random turn order for start or rematch. */
export function drawOrder(state: GameState, rng: Rng): PlayerId[] {
  return shuffle(
    state.players.map((p) => p.id),
    rng,
  );
}

/**
 * What a phone that sends a name should do: join as a new player, or come back as
 * the absent player with that name. Throws if the name belongs to someone present,
 * or if a new name arrives after start.
 */
export function joinOrReturn(state: GameState, name: string, newPlayerId: PlayerId): GameEvent {
  const existing = findPlayerByName(state, name);
  if (existing === undefined) return { type: "join", playerId: newPlayerId, name };
  if (existing.present) fail(`the name ${existing.name} is taken`);
  return { type: "return", playerId: existing.id };
}

/** Items to record in the play history: every item that came up, solved or not. */
export function playedItemIds(state: GameState): string[] {
  return state.slots.filter((s) => s.status !== "pending").map((s) => s.itemId);
}

export interface Standing {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly points: number;
  /** Solves on their own turn (3 points): the first tie-break. */
  readonly ownSolves: number;
  /** Shared on a full tie: 1, 1, 3. */
  readonly rank: number;
}

/** Ranking over the decided items: points, then own-turn solves, then shared. */
export function ranking(state: GameState): Standing[] {
  const rows = state.order.map((playerId) => {
    const won = state.slots.filter((s) => s.status === "revealed" && s.winner === playerId);
    return {
      playerId,
      name: player(state, playerId).name,
      points: won.reduce((sum, s) => sum + s.points, 0),
      ownSolves: won.filter((s) => s.points === 3).length,
    };
  });
  rows.sort((a, b) => b.points - a.points || b.ownSolves - a.ownSolves || a.name.localeCompare(b.name));
  return rows.map((row, i) => {
    const first = rows.findIndex((r) => r.points === row.points && r.ownSolves === row.ownSolves);
    return { ...row, rank: first + 1 };
  });
}
