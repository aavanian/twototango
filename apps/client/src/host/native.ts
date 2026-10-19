// SPDX-License-Identifier: AGPL-3.0-only

import type { PluginListenerHandle } from "@capacitor/core";
import type { HostMessage, SessionSnapshot } from "@twototango/core";
import type { Platform } from "./platform.ts";
import { VOICE_LANG, type GameStore } from "./services.ts";
import type { HostTransport, TransportHandlers } from "./transport.ts";

/**
 * The GM page inside the iOS app. The Swift plugin (packages/ios-host) runs the
 * listeners the phones connect to and gives the page speech, keep-awake and a
 * file store. Phone messages cross the bridge as JSON text, unparsed.
 */

export type HostFile = "game" | "history";

export interface HostPlugin {
  /** Starts the listeners (or, after a page reload, drops the old connections) and says where phones join. */
  start(): Promise<{ joinBase: string }>;
  send(options: { conn: string; data: string }): Promise<void>;
  /** No data when the file doesn't exist. */
  readFile(options: { name: HostFile }): Promise<{ data?: string | null }>;
  /** data null deletes the file. */
  writeFile(options: { name: HostFile; data: string | null }): Promise<void>;
  warmSpeech(options: { lang: string }): Promise<void>;
  speak(options: { text: string; lang: string }): Promise<void>;
  setKeepAwake(options: { on: boolean }): Promise<void>;
  /** ready again after the listeners restart, for example when the app returns to the foreground. */
  addListener(event: "ready", fn: (e: { joinBase: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "open" | "close", fn: (e: { conn: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "message", fn: (e: { conn: string; data: string }) => void): Promise<PluginListenerHandle>;
}

export async function nativePlatform(): Promise<Platform> {
  const { registerPlugin } = await import("@capacitor/core");
  return createNativePlatform(registerPlugin<HostPlugin>("Host"));
}

export async function createNativePlatform(plugin: HostPlugin): Promise<Platform> {
  return {
    transport: new NativeTransport(plugin),
    store: await NativeStore.load(plugin),
    speaker: {
      warm: (lang) => void plugin.warmSpeech({ lang: VOICE_LANG[lang] }),
      say: (word, lang) => void plugin.speak({ text: word, lang: VOICE_LANG[lang] }),
    },
    keepAwake: { set: (on) => void plugin.setKeepAwake({ on }) },
  };
}

export class NativeTransport implements HostTransport {
  readonly #plugin: HostPlugin;

  constructor(plugin: HostPlugin) {
    this.#plugin = plugin;
  }

  start(handlers: TransportHandlers): void {
    const plugin = this.#plugin;
    void (async () => {
      await plugin.addListener("ready", (e) => handlers.ready(e.joinBase));
      await plugin.addListener("open", (e) => handlers.open(e.conn));
      await plugin.addListener("close", (e) => handlers.close(e.conn));
      await plugin.addListener("message", (e) => {
        let data: unknown;
        try {
          data = JSON.parse(e.data);
        } catch {
          return;
        }
        handlers.message(e.conn, data);
      });
      const { joinBase } = await plugin.start();
      handlers.ready(joinBase);
    })();
  }

  send(conn: string, message: HostMessage): void {
    void this.#plugin.send({ conn, data: JSON.stringify(message) });
  }
}

/**
 * Files in the app's Application Support folder, read once at launch so the session
 * can load synchronously. Writes go out in order, one at a time.
 */
export class NativeStore implements GameStore {
  readonly #plugin: HostPlugin;
  #game: SessionSnapshot | null;
  #history: Map<string, number>;
  #queue: Promise<void> = Promise.resolve();

  private constructor(plugin: HostPlugin, game: SessionSnapshot | null, history: Map<string, number>) {
    this.#plugin = plugin;
    this.#game = game;
    this.#history = history;
  }

  static async load(plugin: HostPlugin): Promise<NativeStore> {
    const [game, history] = await Promise.all([plugin.readFile({ name: "game" }), plugin.readFile({ name: "history" })]);
    return new NativeStore(plugin, parse<SessionSnapshot>(game.data), new Map(parse<[string, number][]>(history.data) ?? []));
  }

  loadGame = (): SessionSnapshot | null => this.#game;

  saveGame = (snapshot: SessionSnapshot | null): void => {
    this.#game = snapshot;
    this.#write("game", snapshot === null ? null : JSON.stringify(snapshot));
  };

  loadHistory = (): Map<string, number> => new Map(this.#history);

  saveHistory = (history: ReadonlyMap<string, number>): void => {
    this.#history = new Map(history);
    this.#write("history", JSON.stringify([...history]));
  };

  /** Resolves once every write queued so far is done (tests). */
  flushed(): Promise<void> {
    return this.#queue;
  }

  #write(name: HostFile, data: string | null): void {
    // A failed write loses resume, not the game in progress.
    this.#queue = this.#queue.then(() => this.#plugin.writeFile({ name, data })).catch(() => {});
  }
}

function parse<T>(text: string | null | undefined): T | null {
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
