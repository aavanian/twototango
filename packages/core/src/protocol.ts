// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import type { View } from "./view.ts";

/**
 * Messages between a player's or spectator's phone and the GM phone. The GM's own
 * screen talks to the session directly. A phone keeps a random token in local
 * storage and sends it on every connection, so it comes back without asking for
 * the name again.
 */

const token = z.string().min(8).max(64);

export const ClientMessage = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("hello"), token }),
  z.strictObject({ t: z.literal("join"), token, name: z.string().max(100), code: z.string().max(16) }),
  z.strictObject({ t: z.literal("watch"), token, code: z.string().max(16) }),
  z.strictObject({ t: z.literal("pass") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type Role = "player" | "spectator";

export type ErrorCode = "bad-code" | "no-game" | "name-taken" | "bad-name" | "started" | "not-allowed" | "bad-message";

export type HostMessage =
  /** Who this phone is. role null: show the join form. */
  | { readonly t: "welcome"; readonly role: Role | null; readonly playerId: string | null }
  /** view null: no game set up yet, or the session ended. */
  | { readonly t: "view"; readonly view: View | null }
  | { readonly t: "error"; readonly code: ErrorCode }
  /** Sent by the transport when the GM phone is gone; the next view clears it. */
  | { readonly t: "paused" };
