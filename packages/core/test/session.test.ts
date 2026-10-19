// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from "vitest";
import { devBanks } from "../fixtures/dev-bank.ts";
import { seededRng, Session, type HostMessage, type ItemView, type SessionSnapshot, type View } from "../src/index.ts";

const items = new Map(devBanks.flatMap((b) => b.items).map((i) => [i.id, i]));

function harness(snapshot?: SessionSnapshot) {
  const sent: [string, HostMessage][] = [];
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  let clock = 0;
  const saved: { game: SessionSnapshot | null } = { game: null };
  const history = new Map<string, number>();
  const session = new Session(
    {
      items,
      history,
      rng: seededRng(42),
      now: () => clock,
      send: (conn, msg) => sent.push([conn, msg]),
      saveGame: (s) => (saved.game = s),
      saveHistory: () => {},
      schedule: (ms, fn) => {
        const t = { at: clock + ms, fn, live: true };
        timers.push(t);
        return () => (t.live = false);
      },
      graceMs: 1000,
    },
    snapshot,
  );
  return {
    session,
    sent,
    saved,
    history,
    advance(ms: number) {
      clock += ms;
      for (const t of timers) if (t.live && t.at <= clock) (t.live = false), t.fn();
    },
    last(conn: string, t: HostMessage["t"]) {
      return sent.filter(([c, m]) => c === conn && m.t === t).at(-1)?.[1];
    },
    view(conn: string): View | null | undefined {
      const m = sent.filter(([c, m]) => c === conn && m.t === "view").at(-1)?.[1];
      return m?.t === "view" ? m.view : undefined;
    },
  };
}

type H = ReturnType<typeof harness>;

function joinPlayer(h: H, conn: string, name: string, token = `token-${name}`) {
  h.session.connect(conn);
  h.session.receive(conn, { t: "hello", token });
  h.session.receive(conn, { t: "join", token, name, code: h.session.code });
}

describe("Session", () => {
  let h: H;
  beforeEach(() => {
    h = harness();
    h.session.setup({ lang: "en", level: "C1", playerCount: 2, itemCount: 4 });
  });

  it("has a four-letter join code and picks items for the setup", () => {
    expect(h.session.code).toMatch(/^[A-Z]{4}$/);
    expect(h.session.state?.config.itemIds).toHaveLength(4);
  });

  it("keeps the picked items when only the player count changes", () => {
    const before = h.session.state!.config.itemIds;
    h.session.setup({ lang: "en", level: "C1", playerCount: 4, itemCount: 4 });
    expect(h.session.state!.config.itemIds).toEqual(before);
    h.session.setup({ lang: "en", level: "C1", playerCount: 4, itemCount: 8 });
    expect(h.session.state!.config.itemIds).toHaveLength(8);
  });

  it("refuses a setup the bank can't fill", () => {
    expect(() => h.session.setup({ lang: "fr", level: "C2", playerCount: 2, itemCount: 4 })).toThrow(/available/);
  });

  it("joins players, refusing a wrong code or a taken name", () => {
    joinPlayer(h, "c1", "Ana");
    expect(h.last("c1", "welcome")).toEqual({ t: "welcome", role: "player", playerId: "p1" });
    expect(h.view("c1")).toMatchObject({ phase: "lobby", players: [{ name: "Ana" }] });

    h.session.connect("c2");
    h.session.receive("c2", { t: "join", token: "token-zzzz", name: "Ben", code: "NOPE" });
    expect(h.last("c2", "error")).toEqual({ t: "error", code: "bad-code" });
    h.session.receive("c2", { t: "join", token: "token-zzzz", name: "ana", code: h.session.code.toLowerCase() });
    expect(h.last("c2", "error")).toEqual({ t: "error", code: "name-taken" });
  });

  it("ignores malformed messages", () => {
    h.session.connect("c1");
    h.session.receive("c1", { t: "launch" });
    expect(h.last("c1", "error")).toEqual({ t: "error", code: "bad-message" });
  });

  it("lets spectators watch without counting as players", () => {
    h.session.connect("s");
    h.session.receive("s", { t: "watch", token: "token-spec", code: h.session.code });
    expect(h.last("s", "welcome")).toEqual({ t: "welcome", role: "spectator", playerId: null });
    expect(h.session.state!.players).toHaveLength(0);
  });

  it("plays an item: only the player in turn can pass, and nobody gets the answer early", () => {
    joinPlayer(h, "c1", "Ana");
    joinPlayer(h, "c2", "Ben");
    h.session.start();
    const turn = (h.view("c1") as ItemView).turn.id;
    const [mine, other] = turn === "p1" ? ["c1", "c2"] : ["c2", "c1"];
    h.session.receive(other, { t: "pass" });
    expect(h.last(other, "error")).toEqual({ t: "error", code: "not-allowed" });
    h.session.receive(mine, { t: "pass" });
    expect((h.view(other) as ItemView).passed).toBe(true);

    const answer = (h.session.gmView() as ItemView).gm!.answer;
    const wire = JSON.stringify(h.sent.filter(([, m]) => m.t === "view"));
    expect(wire).not.toContain(`"${answer}"`);
  });

  it("refuses new names after start but takes back an absent player by name", () => {
    joinPlayer(h, "c1", "Ana");
    joinPlayer(h, "c2", "Ben");
    h.session.start();
    joinPlayer(h, "c3", "Cy");
    expect(h.last("c3", "error")).toEqual({ t: "error", code: "started" });

    h.session.disconnect("c1");
    h.advance(1000);
    expect(h.session.state!.players.find((p) => p.name === "Ana")?.present).toBe(false);
    // Ana comes back on a new phone.
    joinPlayer(h, "c4", "ANA", "token-new-phone");
    expect(h.last("c4", "welcome")).toEqual({ t: "welcome", role: "player", playerId: "p1" });
    expect(h.session.state!.players.find((p) => p.name === "Ana")?.present).toBe(true);
  });

  it("keeps a player present through a short disconnect", () => {
    joinPlayer(h, "c1", "Ana");
    h.session.disconnect("c1");
    h.advance(500);
    h.session.connect("c1b");
    h.session.receive("c1b", { t: "hello", token: "token-Ana" });
    expect(h.last("c1b", "welcome")).toEqual({ t: "welcome", role: "player", playerId: "p1" });
    h.advance(1000);
    expect(h.session.state!.players[0]?.present).toBe(true);
  });

  it("sends a removed player back to the join form", () => {
    joinPlayer(h, "c1", "Ana");
    h.session.remove("p1");
    expect(h.last("c1", "welcome")).toEqual({ t: "welcome", role: null, playerId: null });
    expect(h.session.state!.players).toHaveLength(0);
    joinPlayer(h, "c2", "Ben");
    expect(h.last("c2", "welcome")).toMatchObject({ playerId: "p2" });
  });

  it("records the played items in the history when a game ends, and rematches with new ones", () => {
    joinPlayer(h, "c1", "Ana");
    joinPlayer(h, "c2", "Ben");
    h.session.start();
    for (let k = 0; k < 4; k++) {
      h.session.reveal();
      h.session.next();
    }
    expect(h.session.state!.phase).toBe("results");
    const first = h.session.state!.config.itemIds;
    expect([...h.history.keys()].sort()).toEqual([...first].sort());
    h.session.rematch();
    expect(h.session.state!.config.itemIds.some((id) => first.includes(id))).toBe(false);
  });

  it("resumes from a snapshot: same game, phones recognized by token", () => {
    joinPlayer(h, "c1", "Ana");
    joinPlayer(h, "c2", "Ben");
    h.session.start();
    h.session.open();
    const snapshot = JSON.parse(JSON.stringify(h.saved.game)) as SessionSnapshot;

    const r = harness(snapshot);
    expect(r.session.code).toBe(h.session.code);
    expect(r.session.state).toEqual(h.session.state);
    r.session.connect("x");
    r.session.receive("x", { t: "hello", token: "token-Ben" });
    expect(r.last("x", "welcome")).toEqual({ t: "welcome", role: "player", playerId: "p2" });
    // Ana's phone never comes back: she is marked absent after the grace period.
    r.advance(1000);
    expect(r.session.state!.players.map((p) => p.present)).toEqual([false, true]);
  });

  it("ends the session: phones go back to waiting and the saved game is dropped", () => {
    joinPlayer(h, "c1", "Ana");
    h.session.endSession();
    expect(h.saved.game).toBeNull();
    expect(h.last("c1", "welcome")).toEqual({ t: "welcome", role: null, playerId: null });
    expect(h.view("c1")).toBeNull();
  });
});
