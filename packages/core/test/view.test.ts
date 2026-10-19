// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { Item, replay, viewFor, type GameEvent, type ItemView } from "../src/index.ts";

const item = Item.parse({
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
  gloss: { ja: "飾った" },
});
const second = { ...item, id: "en-c1-0002", lemma: "x" };
const items = new Map([item, second].map((i) => [i.id, i]));

const lobby: GameEvent[] = [
  { type: "configure", config: { lang: "en", level: "C1", playerCount: 2, itemIds: [item.id, second.id] } },
  { type: "join", playerId: "a", name: "Ana" },
];
const started: GameEvent[] = [...lobby, { type: "join", playerId: "b", name: "Ben" }, { type: "start", order: ["a", "b"] }];

const asPlayer = { role: "player", playerId: "b" } as const;

describe("viewFor", () => {
  it("shows the lobby and when start is possible", () => {
    const v = viewFor(replay(lobby), items, { role: "gm" });
    expect(v).toMatchObject({ phase: "lobby", playerCount: 2, itemCount: 2, canStart: false });
    expect(viewFor(replay(started.slice(0, 3)), items, { role: "gm" })).toMatchObject({ canStart: true });
  });

  it("never sends the answer to players before it is revealed", () => {
    const v = viewFor(replay(started), items, asPlayer) as ItemView;
    expect(v).toMatchObject({ phase: "item", number: 1, total: 2, status: "shown", gm: null, outcome: null });
    expect(v.turn.name).toBe("Ana");
    expect(v.cells.map((c) => c.char)).toEqual(["a", null, null, null, null, "e", null]);
    const wire = JSON.stringify(v);
    for (const secret of ["adorned", "adorn", "arrayed", "飾"]) expect(wire).not.toContain(secret);
  });

  it("gives the GM the answer, alternates and undo", () => {
    const gm = viewFor(replay(started), items, { role: "gm" }) as ItemView;
    expect(gm.gm).toEqual({ answer: "adorned", alternates: ["arrayed"], canUndo: false });
    const decided = viewFor(replay([...started, { type: "correct", playerId: "a" }]), items, { role: "gm" }) as ItemView;
    expect(decided.gm?.canUndo).toBe(true);
  });

  it("fills the boxes and names the scorer once revealed", () => {
    const v = viewFor(replay([...started, { type: "open" }, { type: "correct", playerId: "b" }]), items, asPlayer) as ItemView;
    expect(v.status).toBe("revealed");
    expect(v.cells.map((c) => c.char).join("")).toBe("adorned");
    expect(v.outcome).toEqual({ winner: { id: "b", name: "Ben", present: true }, points: 2 });
  });

  it("shows the next player's turn and then the ranking", () => {
    const events: GameEvent[] = [...started, { type: "reveal" }, { type: "next" }];
    expect((viewFor(replay(events), items, asPlayer) as ItemView).turn.name).toBe("Ben");
    const done = viewFor(replay([...events, { type: "correct", playerId: "b" }, { type: "next" }]), items, asPlayer);
    expect(done).toMatchObject({ phase: "results", endedEarly: false, played: 2, total: 2 });
  });
});
