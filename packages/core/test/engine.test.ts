// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  apply,
  drawOrder,
  EngineError,
  GameEvent,
  joinOrReturn,
  playedItemIds,
  ranking,
  replay,
  seededRng,
  type GameState,
} from "../src/index.ts";

const itemIds = ["en-c1-0001", "en-c1-0002", "en-c1-0003", "en-c1-0004", "en-c1-0005", "en-c1-0006"];

const lobby: GameEvent[] = [
  { type: "configure", config: { lang: "en", level: "C1", playerCount: 3, itemIds } },
  { type: "join", playerId: "a", name: "Ana" },
  { type: "join", playerId: "b", name: "Ben" },
  { type: "join", playerId: "c", name: "Cy" },
];
const started = [...lobby, { type: "start", order: ["b", "a", "c"] } as GameEvent];

const run = (...events: GameEvent[]) => replay(events);
const play = (state: GameState, ...events: GameEvent[]) => events.reduce(apply, state);
const slot = (s: GameState) => s.slots[s.current]!;

describe("lobby", () => {
  it("starts with configure", () => {
    expect(() => replay([{ type: "open" }])).toThrow(EngineError);
    expect(() => replay([])).toThrow(EngineError);
  });

  it("validates the setup", () => {
    const configure = (playerCount: number, ids: string[]): GameEvent => ({
      type: "configure",
      config: { lang: "en", level: "C1", playerCount, itemIds: ids },
    });
    expect(() => run(configure(1, ["x"]))).toThrow(/player count/);
    expect(() => run(configure(7, itemIds))).toThrow(/player count/);
    expect(() => run(configure(4, itemIds))).toThrow(/shared/);
    expect(() => run(configure(2, ["x", "x"]))).toThrow(/twice/);
  });

  it("collects players, normalizing names and refusing duplicates", () => {
    const s = run(...lobby.slice(0, 2), { type: "join", playerId: "b", name: "  Ben   Ho " });
    expect(s.players.map((p) => p.name)).toEqual(["Ana", "Ben Ho"]);
    expect(() => play(s, { type: "join", playerId: "z", name: "ana" })).toThrow(/taken/);
    expect(() => play(s, { type: "join", playerId: "a", name: "Zed" })).toThrow(/already/);
    expect(() => play(s, { type: "join", playerId: "z", name: "   " })).toThrow(/characters/);
  });

  it("lets the GM remove a player and change the player count", () => {
    let s = run(...lobby, { type: "remove", playerId: "c" });
    expect(() => play(s, { type: "start", order: ["a", "b"] })).toThrow(/exactly 3/);
    s = play(s, { type: "configure", config: { lang: "en", level: "C1", playerCount: 2, itemIds: itemIds.slice(0, 4) } });
    s = play(s, { type: "start", order: ["a", "b"] });
    expect(s.phase).toBe("playing");
    expect(s.slots.map((x) => x.owner)).toEqual(["a", "b", "a", "b"]);
  });

  it("needs a turn order listing every player once", () => {
    const s = run(...lobby);
    expect(() => play(s, { type: "start", order: ["a", "b"] })).toThrow(/turn order/);
    expect(() => play(s, { type: "start", order: ["a", "b", "b"] })).toThrow(/turn order/);
    expect(() => play(s, { type: "start", order: ["a", "b", "z"] })).toThrow(/turn order/);
  });

  it("refuses joins and setup changes after start", () => {
    const s = run(...started);
    expect(() => play(s, { type: "join", playerId: "d", name: "Dee" })).toThrow(/after start/);
    expect(() => play(s, lobby[0]!)).toThrow(/lobby/);
    expect(() => play(s, { type: "remove", playerId: "a" })).toThrow(/lobby/);
  });

  it("draws a turn order with the injected rng", () => {
    const s = run(...lobby);
    const order = drawOrder(s, seededRng(1));
    expect([...order].sort()).toEqual(["a", "b", "c"]);
    expect(drawOrder(s, seededRng(1))).toEqual(order);
  });
});

describe("an item", () => {
  it("deals items round after round in turn order", () => {
    const s = run(...started);
    expect(s.slots.map((x) => x.owner)).toEqual(["b", "a", "c", "b", "a", "c"]);
    expect(slot(s)).toMatchObject({ status: "shown", assignee: "b" });
  });

  it("scores 3 when the player in turn solves it before opening", () => {
    const s = run(...started, { type: "correct", playerId: "b" });
    expect(slot(s)).toMatchObject({ status: "revealed", winner: "b", points: 3 });
    expect(() => run(...started, { type: "correct", playerId: "a" })).toThrow(/in turn/);
  });

  it("records a pass without opening the item", () => {
    const s = run(...started, { type: "pass", playerId: "b" });
    expect(slot(s)).toMatchObject({ status: "shown", passed: true });
    expect(() => run(...started, { type: "pass", playerId: "a" })).toThrow(/in turn/);
  });

  it("scores 2 for the first correct answer once open, including the player in turn", () => {
    const opened = run(...started, { type: "open" });
    expect(slot(play(opened, { type: "correct", playerId: "c" }))).toMatchObject({ winner: "c", points: 2 });
    expect(slot(play(opened, { type: "correct", playerId: "b" }))).toMatchObject({ winner: "b", points: 2 });
    expect(() => play(opened, { type: "correct", playerId: "z" })).toThrow(/no player/);
    expect(() => play(opened, { type: "pass", playerId: "b" })).toThrow(/before the item opens/);
  });

  it("can be revealed without a winner, from shown or open", () => {
    expect(slot(run(...started, { type: "reveal" }))).toMatchObject({ status: "revealed", winner: null, points: 0 });
    expect(slot(run(...started, { type: "open" }, { type: "reveal" }))).toMatchObject({ status: "revealed", points: 0 });
  });

  it("can't be decided twice", () => {
    const s = run(...started, { type: "reveal" });
    expect(() => play(s, { type: "correct", playerId: "b" })).toThrow(/decided/);
    expect(() => play(s, { type: "reveal" })).toThrow(/decided/);
    expect(() => play(s, { type: "open" })).toThrow();
  });

  it("undoes the last scoring decision back to where it was made", () => {
    const fromShown = run(...started, { type: "pass", playerId: "b" }, { type: "correct", playerId: "b" }, { type: "undo" });
    expect(slot(fromShown)).toMatchObject({ status: "shown", winner: null, points: 0, passed: true });

    const fromOpen = run(...started, { type: "open" }, { type: "correct", playerId: "a" }, { type: "undo" });
    expect(slot(fromOpen)).toMatchObject({ status: "open", winner: null });
    expect(slot(play(fromOpen, { type: "correct", playerId: "c" }))).toMatchObject({ winner: "c", points: 2 });

    expect(() => play(fromOpen, { type: "undo" })).toThrow(/nothing/);
  });

  it("can't undo after Next", () => {
    const s = run(...started, { type: "reveal" }, { type: "next" });
    expect(() => play(s, { type: "undo" })).toThrow(/nothing/);
  });

  it("needs a decision before Next", () => {
    expect(() => run(...started, { type: "next" })).toThrow(/reveal/);
  });
});

describe("a whole game", () => {
  const solveAll: GameEvent[] = [
    { type: "correct", playerId: "b" }, // 1: b, 3
    { type: "next" },
    { type: "open" }, // 2: a's item, c steals, 2
    { type: "correct", playerId: "c" },
    { type: "next" },
    { type: "correct", playerId: "c" }, // 3: c, 3
    { type: "next" },
    { type: "reveal" }, // 4: b's, nobody
    { type: "next" },
    { type: "correct", playerId: "a" }, // 5: a, 3
    { type: "next" },
    { type: "open" }, // 6: c's, b gets 2
    { type: "correct", playerId: "b" },
  ];

  it("ends with a ranking after the last item", () => {
    const beforeLast = run(...started, ...solveAll);
    expect(beforeLast.phase).toBe("playing");
    const s = play(beforeLast, { type: "next" });
    expect(s.phase).toBe("results");
    expect(ranking(s).map((r) => [r.name, r.points, r.ownSolves, r.rank])).toEqual([
      ["Ben", 5, 1, 1],
      ["Cy", 5, 1, 1],
      ["Ana", 3, 1, 3],
    ]);
    expect(playedItemIds(s)).toEqual(itemIds);
  });

  it("breaks point ties on own-turn solves", () => {
    // Ana: 3 + 3 on her own turns; Ben: 2 + 2 + 2 stolen.
    const s = run(
      ...started,
      { type: "open" },
      { type: "correct", playerId: "b" },
      { type: "next" },
      { type: "correct", playerId: "a" },
      { type: "next" },
      { type: "open" },
      { type: "correct", playerId: "b" },
      { type: "next" },
      { type: "open" },
      { type: "correct", playerId: "b" },
      { type: "next" },
      { type: "correct", playerId: "a" },
      { type: "end" },
    );
    expect(ranking(s).map((r) => [r.name, r.points, r.rank])).toEqual([
      ["Ana", 6, 1],
      ["Ben", 6, 2],
      ["Cy", 0, 3],
    ]);
  });

  it("can end early: the ranking covers decided items and later ones stay unplayed", () => {
    const s = run(...started, { type: "correct", playerId: "b" }, { type: "next" }, { type: "end" });
    expect(s).toMatchObject({ phase: "results", endedEarly: true });
    expect(ranking(s)[0]).toMatchObject({ name: "Ben", points: 3 });
    expect(playedItemIds(s)).toEqual(itemIds.slice(0, 2));
    expect(() => play(s, { type: "end" })).toThrow();
  });

  it("starts a rematch with the same players, new items and fresh scores", () => {
    const done = run(...started, ...solveAll, { type: "next" });
    const fresh = ["en-c1-0011", "en-c1-0012", "en-c1-0013"];
    const s = play(done, { type: "rematch", itemIds: fresh, order: ["c", "b", "a"] });
    expect(s).toMatchObject({ phase: "playing", round: 2, current: 0, endedEarly: false });
    expect(s.config.itemIds).toEqual(fresh);
    expect(s.slots.map((x) => x.owner)).toEqual(["c", "b", "a"]);
    expect(ranking(s).every((r) => r.points === 0)).toBe(true);
    expect(() => play(s, { type: "rematch", itemIds: fresh, order: ["a", "b", "c"] })).toThrow(/results/);
    expect(() => play(done, { type: "rematch", itemIds: fresh.slice(0, 2), order: ["a", "b", "c"] })).toThrow(/shared/);
  });

  it("replays a serialized log to the same state", () => {
    const events = [...started, ...solveAll.slice(0, 5)];
    const restored = replay(JSON.parse(JSON.stringify(events)).map((e: unknown) => GameEvent.parse(e)));
    expect(restored).toEqual(replay(events));
  });
});

describe("dropped players", () => {
  it("reassigns a dropped player's item to the next present player when it comes up", () => {
    // Order b, a, c. Ana leaves during item 1; item 2 is hers and goes to Cy.
    const s = run(...started, { type: "leave", playerId: "a" }, { type: "reveal" }, { type: "next" });
    expect(slot(s)).toMatchObject({ owner: "a", assignee: "c" });
    expect(() => play(s, { type: "correct", playerId: "a" })).toThrow(/in turn/);
    expect(slot(play(s, { type: "correct", playerId: "c" }))).toMatchObject({ winner: "c", points: 3 });
  });

  it("wraps around the turn order and skips other absent players", () => {
    // Cy (last in order) and Ben (first) both leave; item 3 is Cy's and goes to Ana.
    let s = run(...started, { type: "reveal" }, { type: "next" }, { type: "reveal" });
    s = play(s, { type: "leave", playerId: "c" }, { type: "leave", playerId: "b" }, { type: "next" });
    expect(slot(s)).toMatchObject({ owner: "c", assignee: "a" });
  });

  it("gives a rejoining player back every item not yet reassigned, and their score", () => {
    let s = run(...started, { type: "correct", playerId: "b" }, { type: "leave", playerId: "b" }, { type: "next" });
    s = play(s, { type: "reveal" }, { type: "next" }, { type: "reveal" }, { type: "next" });
    // Item 4 was Ben's and went to Ana while he was away.
    expect(slot(s)).toMatchObject({ owner: "b", assignee: "a" });
    s = play(s, joinOrReturn(s, "ben", "new-id"), { type: "reveal" }, { type: "next" });
    expect(slot(s).assignee).toBe("a");
    expect(s.players.find((p) => p.id === "b")?.present).toBe(true);
    expect(ranking(s).find((r) => r.playerId === "b")?.points).toBe(3);
  });

  it("keeps the owner when nobody is present", () => {
    let s = run(...started, { type: "reveal" });
    s = play(s, { type: "leave", playerId: "a" }, { type: "leave", playerId: "b" }, { type: "leave", playerId: "c" }, { type: "next" });
    expect(slot(s).assignee).toBe("a");
  });
});

describe("joinOrReturn", () => {
  it("joins a new name, returns an absent one, refuses a present one", () => {
    const s = run(...lobby, { type: "leave", playerId: "b" });
    expect(joinOrReturn(s, "Dee", "d")).toEqual({ type: "join", playerId: "d", name: "Dee" });
    expect(joinOrReturn(s, " BEN ", "d")).toEqual({ type: "return", playerId: "b" });
    expect(() => joinOrReturn(s, "ana", "d")).toThrow(/taken/);
  });
});
