// SPDX-License-Identifier: AGPL-3.0-only

import { layoutBoxes, showCells, type ShownCell } from "./boxes.ts";
import { ranking, type GameState, type PlayerId, type Points, type Standing } from "./engine.ts";
import type { Item } from "./item.ts";

/**
 * What each phone is sent. Player and spectator views never carry the answer,
 * lemma, alternates or gloss: the letters only arrive in the cells once revealed.
 */

export type Viewer =
  | { readonly role: "gm" }
  | { readonly role: "player"; readonly playerId: PlayerId }
  | { readonly role: "spectator" };

export interface PlayerSummary {
  readonly id: PlayerId;
  readonly name: string;
  readonly present: boolean;
}

export interface LobbyView {
  readonly phase: "lobby";
  readonly lang: Item["lang"];
  readonly level: Item["level"];
  readonly playerCount: number;
  readonly itemCount: number;
  readonly players: readonly PlayerSummary[];
  readonly canStart: boolean;
}

export interface ItemView {
  readonly phase: "item";
  /** 1-based, for "7 / 15". */
  readonly number: number;
  readonly total: number;
  readonly order: readonly PlayerSummary[];
  readonly pos: Item["pos"];
  readonly prompt: Item["prompt"];
  readonly fixedWords: readonly string[];
  readonly cells: readonly ShownCell[];
  readonly status: "shown" | "open" | "revealed";
  /** The player in turn. */
  readonly turn: PlayerSummary;
  readonly passed: boolean;
  /** Set once revealed. */
  readonly outcome: { readonly winner: PlayerSummary | null; readonly points: Points } | null;
  /** GM only. */
  readonly gm: { readonly answer: string; readonly alternates: readonly string[]; readonly canUndo: boolean } | null;
}

export interface ResultsView {
  readonly phase: "results";
  readonly ranking: readonly Standing[];
  readonly endedEarly: boolean;
  /** Items decided, for "after 9 of 15". */
  readonly played: number;
  readonly total: number;
}

export type View = LobbyView | ItemView | ResultsView;

export function viewFor(state: GameState, items: ReadonlyMap<string, Item>, viewer: Viewer): View {
  const summary = (id: PlayerId): PlayerSummary => {
    const p = state.players.find((q) => q.id === id);
    if (p === undefined) throw new Error(`no player ${id}`);
    return { id: p.id, name: p.name, present: p.present };
  };

  switch (state.phase) {
    case "lobby":
      return {
        phase: "lobby",
        lang: state.config.lang,
        level: state.config.level,
        playerCount: state.config.playerCount,
        itemCount: state.config.itemIds.length,
        players: state.players.map((p) => summary(p.id)),
        canStart: state.players.length === state.config.playerCount,
      };
    case "results":
      return {
        phase: "results",
        ranking: ranking(state),
        endedEarly: state.endedEarly,
        played: state.slots.filter((s) => s.status === "revealed").length,
        total: state.slots.length,
      };
    case "playing": {
      const slot = state.slots[state.current]!;
      const item = items.get(slot.itemId);
      if (item === undefined) throw new Error(`item ${slot.itemId} is not in the bank`);
      const status = slot.status === "pending" ? "shown" : slot.status;
      const revealed = status === "revealed";
      return {
        phase: "item",
        number: state.current + 1,
        total: state.slots.length,
        order: state.order.map(summary),
        pos: item.pos,
        prompt: item.prompt,
        fixedWords: item.fixedWords,
        cells: showCells(layoutBoxes(item.answer, item.lang), item.given, revealed),
        status,
        turn: summary(slot.assignee ?? slot.owner),
        passed: slot.passed,
        outcome: revealed ? { winner: slot.winner === null ? null : summary(slot.winner), points: slot.points } : null,
        gm:
          viewer.role === "gm"
            ? { answer: item.answer, alternates: item.alternates, canUndo: revealed && slot.decidedFrom !== null }
            : null,
      };
    }
  }
}
