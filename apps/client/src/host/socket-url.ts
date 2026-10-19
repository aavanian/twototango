// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a phone opens its WebSocket. The dev host serves it on the same port at /ws.
 * The iPhone app listens on a second port (Network.framework handles the WebSocket
 * protocol on its own listener) and names it in a meta tag it adds to the page.
 */
export function phoneSocketUrl(): string {
  const port = document.querySelector<HTMLMetaElement>('meta[name="ttt-ws-port"]')?.content;
  if (port) return `ws://${location.hostname}:${port}/`;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}
