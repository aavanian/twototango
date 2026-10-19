// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { createNativePlatform, NativeStore, type HostFile, type HostPlugin } from "../src/host/native.ts";

type Listener = (e: never) => void;

/** Records calls and lets the test fire plugin events. */
function fakePlugin(files: Partial<Record<HostFile, string>> = {}) {
  const listeners = new Map<string, Listener>();
  const calls: [string, unknown][] = [];
  const disk = { ...files } as Record<HostFile, string | undefined>;
  const plugin: HostPlugin = {
    start: async () => ({ joinBase: "http://192.168.1.20:5170" }),
    send: async (o) => void calls.push(["send", o]),
    readFile: async ({ name }) => ({ data: disk[name] ?? null }),
    writeFile: async ({ name, data }) => {
      calls.push(["write", { name, data }]);
      disk[name] = data ?? undefined;
    },
    warmSpeech: async (o) => void calls.push(["warm", o]),
    speak: async (o) => void calls.push(["speak", o]),
    setKeepAwake: async (o) => void calls.push(["awake", o]),
    addListener: (async (event: string, fn: Listener) => {
      listeners.set(event, fn);
      return { remove: async () => void listeners.delete(event) };
    }) as HostPlugin["addListener"],
  };
  const fire = (event: string, e: unknown) => listeners.get(event)!(e as never);
  return { plugin, calls, disk, fire };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("native transport", () => {
  it("relays connections and parsed messages, and says where phones join", async () => {
    const { plugin, calls, fire } = fakePlugin();
    const { transport } = await createNativePlatform(plugin);
    const seen: unknown[] = [];
    transport.start({
      ready: (base) => seen.push(["ready", base]),
      open: (c) => seen.push(["open", c]),
      message: (c, d) => seen.push(["msg", c, d]),
      close: (c) => seen.push(["close", c]),
      down: () => seen.push(["down"]),
    });
    await tick();
    fire("open", { conn: "n1" });
    fire("message", { conn: "n1", data: '{"t":"pass"}' });
    fire("message", { conn: "n1", data: "not json" });
    fire("close", { conn: "n1" });
    fire("ready", { joinBase: "http://172.20.10.1:5170" });
    expect(seen).toEqual([
      ["ready", "http://192.168.1.20:5170"],
      ["open", "n1"],
      ["msg", "n1", { t: "pass" }],
      ["close", "n1"],
      ["ready", "http://172.20.10.1:5170"],
    ]);
    transport.send("n1", { t: "paused" });
    expect(calls).toContainEqual(["send", { conn: "n1", data: '{"t":"paused"}' }]);
  });
});

describe("native store", () => {
  it("loads saved files at launch and survives a corrupt one", async () => {
    const snapshot = { code: "ABCD", log: [], tokens: {} };
    const { plugin } = fakePlugin({ game: JSON.stringify(snapshot), history: "{broken" });
    const store = await NativeStore.load(plugin);
    expect(store.loadGame()).toEqual(snapshot);
    expect(store.loadHistory()).toEqual(new Map());
  });

  it("writes in order and deletes the game file on null", async () => {
    const { plugin, calls, disk } = fakePlugin();
    const store = await NativeStore.load(plugin);
    store.saveGame({ code: "ABCD", log: [], tokens: {} });
    store.saveHistory(new Map([["en-c1-0001", 1]]));
    store.saveGame(null);
    await store.flushed();
    expect(calls.map(([, o]) => (o as { name: string }).name)).toEqual(["game", "history", "game"]);
    expect(disk.game).toBeUndefined();
    expect(JSON.parse(disk.history!)).toEqual([["en-c1-0001", 1]]);
    expect(store.loadGame()).toBeNull();
  });
});

describe("native services", () => {
  it("speaks British English and keeps the screen awake through the plugin", async () => {
    const { plugin, calls } = fakePlugin();
    const { speaker, keepAwake } = await createNativePlatform(plugin);
    speaker.warm("en");
    speaker.say("hankering", "en");
    keepAwake.set(true);
    expect(calls).toEqual([
      ["warm", { lang: "en-GB" }],
      ["speak", { text: "hankering", lang: "en-GB" }],
      ["awake", { on: true }],
    ]);
  });
});
