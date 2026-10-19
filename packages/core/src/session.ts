// SPDX-License-Identifier: AGPL-3.0-only

import {
  apply,
  drawOrder,
  EngineError,
  findPlayerByName,
  GameEvent,
  joinOrReturn,
  MAX_NAME_LENGTH,
  normalizeName,
  playedItemIds,
  replay,
  type GameState,
  type PlayerId,
} from "./engine.ts";
import type { Item } from "./item.ts";
import { pickItems } from "./picker.ts";
import { ClientMessage, type ErrorCode, type HostMessage } from "./protocol.ts";
import type { Rng } from "./random.ts";
import { viewFor, type View } from "./view.ts";

/**
 * The GM phone's side of a game: the event log, which phone is which player, and
 * what each connection is sent. Transports (the Swift plugin, the Node dev host)
 * only move messages; everything here is plain TypeScript.
 */

export interface SessionSnapshot {
  readonly code: string;
  readonly log: readonly GameEvent[];
  readonly tokens: Readonly<Record<string, TokenEntry>>;
}

type TokenEntry = { readonly role: "player"; readonly playerId: PlayerId } | { readonly role: "spectator" };

export interface SessionDeps {
  /** Every item the GM phone ships with, by id. */
  readonly items: ReadonlyMap<string, Item>;
  /** When each item was last played; the session updates it when a game ends. */
  readonly history: Map<string, number>;
  readonly rng: Rng;
  readonly now: () => number;
  readonly send: (conn: string, message: HostMessage) => void;
  /** Called after every change; null once the session ends. */
  readonly saveGame: (snapshot: SessionSnapshot | null) => void;
  readonly saveHistory: (history: ReadonlyMap<string, number>) => void;
  /** setTimeout with a cancel function, injectable for tests. */
  readonly schedule: (ms: number, fn: () => void) => () => void;
  /** How long a player's phone may be gone before their turn passes to the next player. */
  readonly graceMs?: number;
  /** Called after every change so the GM screen can redraw. */
  readonly onChange?: () => void;
}

export interface SetupChoice {
  readonly lang: Item["lang"];
  readonly level: Item["level"];
  readonly playerCount: number;
  readonly itemCount: number;
}

export const DEFAULT_GRACE_MS = 20_000;
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export class Session {
  readonly code: string;
  #log: GameEvent[];
  #state: GameState | null;
  #tokens: Map<string, TokenEntry>;
  readonly #conns = new Map<string, string | null>();
  readonly #leaveTimers = new Map<PlayerId, () => void>();
  readonly #deps: SessionDeps;

  constructor(deps: SessionDeps, snapshot?: SessionSnapshot) {
    this.#deps = deps;
    this.code = snapshot?.code ?? Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(deps.rng() * CODE_LETTERS.length)]).join("");
    this.#log = snapshot ? snapshot.log.map((e) => GameEvent.parse(e)) : [];
    this.#state = this.#log.length > 0 ? replay(this.#log) : null;
    this.#tokens = new Map(Object.entries(snapshot?.tokens ?? {}));
    if (this.#state !== null) {
      for (const p of this.#state.players) if (p.present) this.#scheduleLeave(p.id);
      this.#checkItems(this.#state.config.itemIds);
    }
  }

  get state(): GameState | null {
    return this.#state;
  }

  gmView(): View | null {
    return this.#state && viewFor(this.#state, this.#deps.items, { role: "gm" });
  }

  /** Items available for a language and level. */
  bankSize(lang: Item["lang"], level: Item["level"]): number {
    return this.#bank(lang, level).length;
  }

  // GM actions. Each throws EngineError if not allowed now.

  /** Creates the lobby, or changes its setup. Picks fresh items whenever the choice changes. */
  setup(choice: SetupChoice): void {
    const current = this.#state?.config;
    const sameItems =
      current !== undefined &&
      current.lang === choice.lang &&
      current.level === choice.level &&
      current.itemIds.length === choice.itemCount;
    const itemIds = sameItems ? current.itemIds : this.#pick(choice.lang, choice.level, choice.itemCount);
    this.#dispatch({ type: "configure", config: { lang: choice.lang, level: choice.level, playerCount: choice.playerCount, itemIds } });
  }

  remove(playerId: PlayerId): void {
    const state = apply(this.#state, { type: "remove", playerId });
    this.#cancelLeave(playerId);
    for (const [token, entry] of this.#tokens) {
      if (entry.role === "player" && entry.playerId === playerId) {
        this.#tokens.delete(token);
        for (const [conn, t] of this.#conns) if (t === token) this.#deps.send(conn, { t: "welcome", role: null, playerId: null });
      }
    }
    this.#state = state;
    this.#log.push({ type: "remove", playerId });
    this.#changed();
  }

  start(): void {
    this.#dispatch({ type: "start", order: drawOrder(this.#need(), this.#deps.rng) });
  }

  open(): void {
    this.#dispatch({ type: "open" });
  }

  correct(playerId: PlayerId): void {
    this.#dispatch({ type: "correct", playerId });
  }

  reveal(): void {
    this.#dispatch({ type: "reveal" });
  }

  undo(): void {
    this.#dispatch({ type: "undo" });
  }

  next(): void {
    this.#dispatch({ type: "next" });
  }

  endGame(): void {
    this.#dispatch({ type: "end" });
  }

  rematch(): void {
    const state = this.#need();
    const { lang, level, itemIds } = state.config;
    this.#dispatch({
      type: "rematch",
      itemIds: this.#pick(lang, level, itemIds.length),
      order: drawOrder(state, this.#deps.rng),
    });
  }

  /** Ends the session: phones go back to waiting, the saved game is dropped. */
  endSession(): void {
    if (this.#state !== null) this.#recordHistory(this.#state);
    for (const cancel of this.#leaveTimers.values()) cancel();
    this.#leaveTimers.clear();
    this.#log = [];
    this.#state = null;
    this.#tokens.clear();
    this.#deps.saveGame(null);
    for (const conn of this.#conns.keys()) this.#deps.send(conn, { t: "welcome", role: null, playerId: null });
    this.#broadcast();
  }

  // Transport side.

  connect(conn: string): void {
    this.#conns.set(conn, null);
  }

  disconnect(conn: string): void {
    const token = this.#conns.get(conn);
    this.#conns.delete(conn);
    const entry = token == null ? undefined : this.#tokens.get(token);
    if (entry?.role === "player" && ![...this.#conns.values()].includes(token!)) this.#scheduleLeave(entry.playerId);
  }

  receive(conn: string, raw: unknown): void {
    const parsed = ClientMessage.safeParse(raw);
    if (!parsed.success) return this.#error(conn, "bad-message");
    const msg = parsed.data;
    try {
      switch (msg.t) {
        case "hello":
          return this.#hello(conn, msg.token);
        case "join":
          return this.#join(conn, msg.token, msg.name, msg.code);
        case "watch":
          if (msg.code.toUpperCase() !== this.code) return this.#error(conn, "bad-code");
          this.#tokens.set(msg.token, { role: "spectator" });
          this.#save();
          return this.#hello(conn, msg.token);
        case "pass": {
          const entry = this.#entry(conn);
          if (entry?.role !== "player") return this.#error(conn, "not-allowed");
          return this.#dispatch({ type: "pass", playerId: entry.playerId });
        }
      }
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
      this.#error(conn, "not-allowed");
    }
  }

  #hello(conn: string, token: string): void {
    this.#conns.set(conn, token);
    const entry = this.#tokens.get(token);
    const playerId = entry?.role === "player" ? entry.playerId : null;
    this.#deps.send(conn, { t: "welcome", role: entry?.role ?? null, playerId });
    if (playerId !== null) {
      this.#cancelLeave(playerId);
      const player = this.#state?.players.find((p) => p.id === playerId);
      if (player && !player.present) return this.#dispatch({ type: "return", playerId });
    }
    this.#sendView(conn);
  }

  #join(conn: string, token: string, rawName: string, code: string): void {
    if (code.toUpperCase() !== this.code) return this.#error(conn, "bad-code");
    const state = this.#state;
    if (state === null) return this.#error(conn, "no-game");
    const name = normalizeName(rawName);
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) return this.#error(conn, "bad-name");
    const existing = findPlayerByName(state, name);
    if (existing?.present) return this.#error(conn, "name-taken");
    if (existing === undefined && state.phase !== "lobby") return this.#error(conn, "started");

    const event = joinOrReturn(state, name, this.#newPlayerId());
    if (event.type !== "join" && event.type !== "return") throw new EngineError("unexpected join event");
    const { playerId } = event;
    // The name now belongs to this phone; any other token for the same player is dropped.
    for (const [t, e] of this.#tokens) if (e.role === "player" && e.playerId === playerId) this.#tokens.delete(t);
    this.#tokens.set(token, { role: "player", playerId });
    this.#conns.set(conn, token);
    this.#deps.send(conn, { t: "welcome", role: "player", playerId });
    this.#cancelLeave(playerId);
    this.#dispatch(event);
  }

  #dispatch(event: GameEvent): void {
    const before = this.#state;
    this.#state = apply(this.#state, event);
    this.#log.push(event);
    if (before?.phase === "playing" && this.#state.phase === "results") this.#recordHistory(this.#state);
    this.#changed();
  }

  #changed(): void {
    this.#save();
    this.#broadcast();
  }

  #save(): void {
    if (this.#state === null) return;
    this.#deps.saveGame({ code: this.code, log: [...this.#log], tokens: Object.fromEntries(this.#tokens) });
  }

  #broadcast(): void {
    for (const conn of this.#conns.keys()) this.#sendView(conn);
    this.#deps.onChange?.();
  }

  #sendView(conn: string): void {
    const state = this.#state;
    if (state === null) return this.#deps.send(conn, { t: "view", view: null });
    const entry = this.#entry(conn);
    const viewer =
      entry?.role === "player" ? { role: "player" as const, playerId: entry.playerId } : { role: "spectator" as const };
    this.#deps.send(conn, { t: "view", view: viewFor(state, this.#deps.items, viewer) });
  }

  #entry(conn: string): TokenEntry | undefined {
    const token = this.#conns.get(conn);
    return token == null ? undefined : this.#tokens.get(token);
  }

  #error(conn: string, code: ErrorCode): void {
    this.#deps.send(conn, { t: "error", code });
  }

  #scheduleLeave(playerId: PlayerId): void {
    this.#cancelLeave(playerId);
    const cancel = this.#deps.schedule(this.#deps.graceMs ?? DEFAULT_GRACE_MS, () => {
      this.#leaveTimers.delete(playerId);
      const player = this.#state?.players.find((p) => p.id === playerId);
      if (player?.present) this.#dispatch({ type: "leave", playerId });
    });
    this.#leaveTimers.set(playerId, cancel);
  }

  #cancelLeave(playerId: PlayerId): void {
    this.#leaveTimers.get(playerId)?.();
    this.#leaveTimers.delete(playerId);
  }

  #recordHistory(state: GameState): void {
    const now = this.#deps.now();
    for (const id of playedItemIds(state)) this.#deps.history.set(id, now);
    this.#deps.saveHistory(this.#deps.history);
  }

  #bank(lang: Item["lang"], level: Item["level"]): Item[] {
    return [...this.#deps.items.values()].filter((i) => i.lang === lang && i.level === level);
  }

  #pick(lang: Item["lang"], level: Item["level"], count: number): string[] {
    const bank = this.#bank(lang, level);
    if (bank.length < count) throw new EngineError(`only ${bank.length} ${lang} ${level} items available`);
    return pickItems(bank, count, this.#deps.history, this.#deps.rng).map((i) => i.id);
  }

  #checkItems(ids: readonly string[]): void {
    const missing = ids.filter((id) => !this.#deps.items.has(id));
    if (missing.length > 0) throw new EngineError(`saved game uses items not in this build: ${missing.join(", ")}`);
  }

  #need(): GameState {
    if (this.#state === null) throw new EngineError("no game set up");
    return this.#state;
  }

  /** Never reused within a log, even after a removal. */
  #newPlayerId(): PlayerId {
    return `p${this.#log.filter((e) => e.type === "join").length + 1}`;
  }
}
