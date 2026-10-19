<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import {
    defaultItemCount,
    EngineError,
    itemCountOptions,
    LANGS,
    LEVELS,
    MAX_PLAYERS,
    MIN_PLAYERS,
    Session,
    type Item,
    type View,
  } from "@twototango/core";
  import QRCode from "qrcode";
  import { onMount } from "svelte";
  import { loadItems } from "../banks.ts";
  import { localStore, webKeepAwake, webSpeaker } from "../host/services.ts";
  import { RelayTransport } from "../host/transport.ts";
  import { t } from "../i18n.ts";
  import Banner from "./Banner.svelte";
  import ItemCard from "./ItemCard.svelte";
  import Ranking from "./Ranking.svelte";

  const store = localStore;
  const speaker = webSpeaker;
  const keepAwake = webKeepAwake();
  const transport = new RelayTransport();

  let session = $state<Session | null>(null);
  let view = $state<View | null>(null);
  let joinBase = $state("");
  let qrSvg = $state("");
  let error = $state("");

  // Setup choices, mirrored from the lobby config once it exists.
  let lang = $state<Item["lang"]>("en");
  let level = $state<Item["level"]>("C1");
  let playerCount = $state(3);
  let itemCount = $state(defaultItemCount(3));

  const joinUrl = $derived(session && joinBase ? `${joinBase}/?code=${session.code}` : "");
  const bankSize = $derived(session?.bankSize(lang, level) ?? 0);

  $effect(() => {
    if (joinUrl === "") return;
    QRCode.toString(joinUrl, { type: "svg", margin: 1 }).then((svg) => (qrSvg = svg));
  });

  function refresh() {
    if (session === null) return;
    view = session.gmView();
    const state = session.state;
    keepAwake.set(state?.phase === "playing");
    if (state !== null) {
      lang = state.config.lang;
      level = state.config.level;
      playerCount = state.config.playerCount;
      itemCount = state.config.itemIds.length;
    }
  }

  function act(fn: (s: Session) => void) {
    error = "";
    try {
      if (session) fn(session);
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
      error = e.message;
    }
    refresh();
  }

  onMount(async () => {
    const items = await loadItems();
    const grace = new URLSearchParams(location.search).get("grace");
    const deps = {
      items,
      history: store.loadHistory(),
      rng: Math.random,
      now: Date.now,
      send: transport.send.bind(transport),
      saveGame: store.saveGame,
      saveHistory: store.saveHistory,
      schedule: (ms: number, fn: () => void) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      },
      onChange: refresh,
      // Dev host only: ?grace=ms shortens the reconnect grace period for tests.
      ...(import.meta.env.VITE_DEV_BANK === "1" && grace !== null ? { graceMs: Number(grace) } : {}),
    };
    const snapshot = store.loadGame();
    try {
      session = new Session(deps, snapshot ?? undefined);
    } catch {
      store.saveGame(null);
      error = t.savedGameLost;
      session = new Session(deps);
    }
    transport.start({
      ready: (base) => (joinBase = base),
      open: (conn) => session?.connect(conn),
      message: (conn, data) => session?.receive(conn, data),
      close: (conn) => session?.disconnect(conn),
      down: () => {},
    });
    refresh();
  });

  function changeSetup(next: Partial<{ lang: Item["lang"]; level: Item["level"]; playerCount: number; itemCount: number }>) {
    const p = next.playerCount ?? playerCount;
    let n = next.itemCount ?? itemCount;
    if (next.playerCount !== undefined && n % p !== 0) n = defaultItemCount(p);
    const choice = { lang: next.lang ?? lang, level: next.level ?? level, playerCount: p, itemCount: n };
    lang = choice.lang;
    level = choice.level;
    playerCount = p;
    itemCount = n;
    // Before the lobby exists, choices only update the form.
    if (session?.state) act((s) => s.setup(choice));
  }

  function openLobby() {
    act((s) => s.setup({ lang, level, playerCount, itemCount }));
  }

  function start() {
    speaker.warm(lang);
    act((s) => s.start());
  }

  function endGame() {
    if (confirm(t.confirmEndGame)) act((s) => s.endGame());
  }

  const playerCounts = Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i);
</script>

{#snippet setupFields()}
  <div class="grid">
    <div class="field">
      <label for="lang">{t.language}</label>
      <select id="lang" value={lang} onchange={(e) => changeSetup({ lang: e.currentTarget.value as Item["lang"] })}>
        {#each LANGS as l (l)}<option value={l}>{t.langName[l]}</option>{/each}
      </select>
    </div>
    <div class="field">
      <label for="level">{t.level}</label>
      <select id="level" value={level} onchange={(e) => changeSetup({ level: e.currentTarget.value as Item["level"] })}>
        {#each LEVELS as l (l)}<option value={l}>{l}</option>{/each}
      </select>
    </div>
    <div class="field">
      <label for="players">{t.players}</label>
      <select id="players" value={playerCount} onchange={(e) => changeSetup({ playerCount: Number(e.currentTarget.value) })}>
        {#each playerCounts as p (p)}<option value={p}>{p}</option>{/each}
      </select>
    </div>
    <div class="field">
      <label for="items">{t.items}</label>
      <select id="items" value={itemCount} onchange={(e) => changeSetup({ itemCount: Number(e.currentTarget.value) })}>
        {#each itemCountOptions(playerCount) as n (n)}<option value={n}>{n}</option>{/each}
      </select>
    </div>
  </div>
  {#if bankSize < itemCount}<p class="error">{t.notEnoughItems(bankSize)}</p>{/if}
{/snippet}

{#if error}<p class="error" data-testid="gm-error">{error}</p>{/if}

{#if session === null}
  <p class="muted">…</p>
{:else if view === null}
  <div class="card">
    <h1>{t.appName}</h1>
    {@render setupFields()}
    <div class="actions">
      <button class="primary" onclick={openLobby} disabled={bankSize < itemCount}>{t.createGame}</button>
    </div>
  </div>
{:else if view.phase === "lobby"}
  <div class="card join">
    <p class="muted">{t.joinWith}</p>
    {#if qrSvg}<div class="qr">{@html qrSvg}</div>{/if}
    <p class="url" data-testid="join-url">{joinUrl}</p>
    <p>{t.code}: <strong data-testid="join-code">{session.code}</strong></p>
  </div>
  <div class="card">
    <h2>{t.players} · {t.waitingFor(view.players.length, view.playerCount)}</h2>
    <ul class="plain" data-testid="gm-players">
      {#each view.players as p (p.id)}
        <li>
          <span>{p.name}{#if !p.present} <span class="muted">({t.away})</span>{/if}</span>
          <button onclick={() => act((s) => s.remove(p.id))}>{t.remove}</button>
        </li>
      {/each}
    </ul>
  </div>
  <div class="card">
    {@render setupFields()}
    <div class="actions">
      <button class="primary" onclick={start} disabled={!view.canStart}>{t.start}</button>
    </div>
  </div>
{:else if view.phase === "item"}
  {@const item = view}
  <Banner view={item} />
  <ItemCard view={item} />
  {#if item.gm}
    <div class="card answer">
      <span class="muted">{t.answer}</span>
      <strong data-testid="gm-answer">{item.gm.answer}</strong>
      {#if item.gm.alternates.length > 0}
        <span class="muted">· {t.alsoAccept}: {item.gm.alternates.join(", ")}</span>
      {/if}
    </div>
  {/if}

  {#if item.status === "shown"}
    <div class="actions">
      <button class="primary" onclick={() => act((s) => s.correct(item.turn.id))}>{t.correct(item.turn.name)}</button>
      <button onclick={() => act((s) => s.open())}>{t.open}</button>
      <button onclick={() => act((s) => s.reveal())}>{t.reveal}</button>
    </div>
  {:else if item.status === "open"}
    <p class="muted">{t.whoAnswered}</p>
    <div class="actions">
      {#each item.order as p (p.id)}
        <button class="primary" onclick={() => act((s) => s.correct(p.id))}>{p.name}</button>
      {/each}
      <button onclick={() => act((s) => s.reveal())}>{t.reveal}</button>
    </div>
  {:else}
    <div class="actions">
      <button onclick={() => speaker.say(item.gm?.answer ?? "", lang)}>{t.playWord}</button>
      {#if item.gm?.canUndo}<button onclick={() => act((s) => s.undo())}>{t.undo}</button>{/if}
      <button class="primary" onclick={() => act((s) => s.next())}>
        {item.number === item.total ? t.seeResults : t.next}
      </button>
    </div>
  {/if}

  {#if item.number === 1 && item.status !== "revealed"}
    <p class="muted">{t.turnOrder}: {item.order.map((p) => p.name).join(" → ")}</p>
  {/if}
  <div class="end">
    <button onclick={endGame}>{t.endGame}</button>
  </div>
{:else}
  <Ranking {view} />
  <div class="actions">
    <button class="primary" onclick={() => act((s) => s.rematch())}>{t.rematch}</button>
    <button onclick={() => act((s) => s.endSession())}>{t.endSession}</button>
  </div>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 12px;
  }
  .join {
    text-align: center;
  }
  .qr {
    width: min(240px, 70vw);
    margin: 8px auto;
    background: #fff;
    padding: 8px;
    border-radius: 8px;
  }
  .qr :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }
  .url {
    word-break: break-all;
    font-family: ui-monospace, monospace;
  }
  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
  }
  li button {
    min-height: 36px;
    padding: 6px 12px;
  }
  .answer {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
  }
  .answer strong {
    font-size: 1.3rem;
  }
  .end {
    margin-top: 32px;
    text-align: center;
  }
</style>
