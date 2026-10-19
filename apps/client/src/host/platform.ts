// SPDX-License-Identifier: AGPL-3.0-only

import type { GameStore, KeepAwake, Speaker } from "./services.ts";
import type { HostTransport } from "./transport.ts";

/** Everything the GM page needs from the device it runs on. */
export interface Platform {
  readonly transport: HostTransport;
  readonly store: GameStore;
  readonly speaker: Speaker;
  readonly keepAwake: KeepAwake;
}

/** Inside the iOS app the page is served from capacitor://localhost. */
export const isNative = (): boolean => location.protocol === "capacitor:";

export async function loadPlatform(): Promise<Platform> {
  if (isNative()) return (await import("./native.ts")).nativePlatform();
  const [{ localStore, webKeepAwake, webSpeaker }, { RelayTransport }] = await Promise.all([
    import("./services.ts"),
    import("./transport.ts"),
  ]);
  return { transport: new RelayTransport(), store: localStore, speaker: webSpeaker, keepAwake: webKeepAwake() };
}
