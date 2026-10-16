// SPDX-License-Identifier: AGPL-3.0-only

/** Frames between the dev host and the GM page. Phone messages ride inside them unchanged. */

export type HostFrame =
  | { readonly k: "ready"; readonly joinBase: string }
  | { readonly k: "open"; readonly conn: string }
  | { readonly k: "msg"; readonly conn: string; readonly data: unknown }
  | { readonly k: "close"; readonly conn: string };

export type GmFrame = { readonly k: "send"; readonly conn: string; readonly data: unknown };
