// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dev host: stands in for the Swift plugin so whole games run in desktop browsers.
 * It serves the client bundle and relays WebSocket frames between the phones
 * (/ws) and the GM page (/gm), which runs the session like the GM app does.
 * Like the real host, it holds no game state: when the GM page goes away, every
 * phone is disconnected and retries until the GM is back.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { GmFrame, HostFrame } from "../../client/src/host/relay-frames.ts";

const port = Number(process.env.PORT ?? 5170);
const dist = resolve(import.meta.dirname, "../../client/dist");
const joinHost = process.env.JOIN_HOST ?? lanAddress() ?? "localhost";
const joinBase = `http://${joinHost}:${port}`;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
}

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(dist, path);
  // Every route is the single-page app.
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
  if (!existsSync(file)) {
    res.writeHead(500, { "content-type": "text/plain" }).end("Client not built: run npm run build");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
});

const phones = new Map<string, WebSocket>();
let gm: WebSocket | null = null;
let nextConn = 1;

const toGm = (frame: HostFrame) => gm?.send(JSON.stringify(frame));

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path !== "/ws" && path !== "/gm") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => (path === "/gm" ? acceptGm(ws) : acceptPhone(ws)));
});

function acceptGm(ws: WebSocket) {
  if (gm !== null) return ws.close(4001, "a GM page is already connected");
  gm = ws;
  toGm({ k: "ready", joinBase });
  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as GmFrame;
    if (frame.k === "send") phones.get(frame.conn)?.send(JSON.stringify(frame.data));
  });
  ws.on("close", () => {
    gm = null;
    for (const phone of phones.values()) phone.close(4000, "GM away");
  });
}

function acceptPhone(ws: WebSocket) {
  if (gm === null) {
    ws.send(JSON.stringify({ t: "paused" }));
    return ws.close(4000, "GM away");
  }
  const conn = `c${nextConn++}`;
  phones.set(conn, ws);
  toGm({ k: "open", conn });
  ws.on("message", (raw) => {
    let data: unknown;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }
    toGm({ k: "msg", conn, data });
  });
  ws.on("close", () => {
    phones.delete(conn);
    toGm({ k: "close", conn });
  });
}

server.listen(port, () => {
  console.log(`GM:      http://localhost:${port}/gm`);
  console.log(`Players: ${joinBase}/ (the GM lobby shows the code)`);
});
