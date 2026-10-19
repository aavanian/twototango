// SPDX-License-Identifier: AGPL-3.0-only

import type { HostMessage } from "@twototango/core";
import type { GmFrame, HostFrame } from "./relay-frames.ts";

/**
 * How the GM page reaches the phones. On the iPhone this is the Swift plugin's
 * listener; on a desktop it is the dev host relay. Either way the session sees
 * connections open, receive parsed JSON, and close.
 */
export interface HostTransport {
  start(handlers: TransportHandlers): void;
  send(conn: string, message: HostMessage): void;
}

export interface TransportHandlers {
  ready(joinBase: string): void;
  open(conn: string): void;
  message(conn: string, data: unknown): void;
  close(conn: string): void;
  /** The transport itself is gone (dev host stopped); every connection is closed. */
  down(): void;
}

/** Talks to the dev host over /gm, reconnecting if it restarts. */
export class RelayTransport implements HostTransport {
  #ws: WebSocket | null = null;

  start(handlers: TransportHandlers): void {
    const open = new Set<string>();
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/gm`);
      this.#ws = ws;
      ws.onmessage = (e) => {
        const frame = JSON.parse(String(e.data)) as HostFrame;
        switch (frame.k) {
          case "ready":
            return handlers.ready(frame.joinBase);
          case "open":
            open.add(frame.conn);
            return handlers.open(frame.conn);
          case "msg":
            return handlers.message(frame.conn, frame.data);
          case "close":
            open.delete(frame.conn);
            return handlers.close(frame.conn);
        }
      };
      ws.onclose = () => {
        this.#ws = null;
        for (const conn of open) handlers.close(conn);
        open.clear();
        handlers.down();
        setTimeout(connect, 1000);
      };
    };
    connect();
  }

  send(conn: string, message: HostMessage): void {
    const frame: GmFrame = { k: "send", conn, data: message };
    this.#ws?.send(JSON.stringify(frame));
  }
}
