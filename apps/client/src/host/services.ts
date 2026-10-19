// SPDX-License-Identifier: AGPL-3.0-only

import type { Lang, SessionSnapshot } from "@twototango/core";

/**
 * Device services the GM page needs. The browser versions here serve the dev host;
 * the iOS shell swaps in the Swift plugin (file store, AVSpeechSynthesizer, idle timer).
 */

export interface GameStore {
  loadGame(): SessionSnapshot | null;
  saveGame(snapshot: SessionSnapshot | null): void;
  loadHistory(): Map<string, number>;
  saveHistory(history: ReadonlyMap<string, number>): void;
}

export interface Speaker {
  /** Prepares the voice so the first word plays without delay. */
  warm(lang: Lang): void;
  say(word: string, lang: Lang): void;
}

export interface KeepAwake {
  set(on: boolean): void;
}

const GAME_KEY = "twototango.game";
const HISTORY_KEY = "twototango.history";

export const localStore: GameStore = {
  loadGame() {
    try {
      const raw = localStorage.getItem(GAME_KEY);
      return raw === null ? null : (JSON.parse(raw) as SessionSnapshot);
    } catch {
      return null;
    }
  },
  saveGame(snapshot) {
    try {
      if (snapshot === null) localStorage.removeItem(GAME_KEY);
      else localStorage.setItem(GAME_KEY, JSON.stringify(snapshot));
    } catch {
      // Storage full or blocked: the game goes on, only resume is lost.
    }
  },
  loadHistory() {
    try {
      return new Map(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as [string, number][]);
    } catch {
      return new Map();
    }
  },
  saveHistory(history) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify([...history]));
    } catch {
      // As above.
    }
  },
};

const VOICE_LANG: Record<Lang, string> = { en: "en-US", fr: "fr-FR" };

export const webSpeaker: Speaker = {
  warm(lang) {
    if (!("speechSynthesis" in window)) return;
    // Loading the voice list and speaking an empty utterance wakes the engine up.
    speechSynthesis.getVoices();
    const u = new SpeechSynthesisUtterance("");
    u.lang = VOICE_LANG[lang];
    u.volume = 0;
    speechSynthesis.speak(u);
  },
  say(word, lang) {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(word);
    u.lang = VOICE_LANG[lang];
    const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith(lang));
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  },
};

export function webKeepAwake(): KeepAwake {
  let lock: WakeLockSentinel | null = null;
  let wanted = false;
  const acquire = async () => {
    if (!wanted || lock !== null || !("wakeLock" in navigator)) return;
    try {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => (lock = null));
    } catch {
      // Not allowed right now (page hidden); retried on visibility change.
    }
  };
  document.addEventListener("visibilitychange", () => void acquire());
  return {
    set(on) {
      wanted = on;
      if (on) void acquire();
      else void lock?.release();
    },
  };
}
