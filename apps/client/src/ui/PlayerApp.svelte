<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { ErrorCode, HostMessage, Role, View } from "@twototango/core";
  import { onMount } from "svelte";
  import { phoneSocketUrl } from "../host/socket-url.ts";
  import { t } from "../i18n.ts";
  import Banner from "./Banner.svelte";
  import ItemCard from "./ItemCard.svelte";
  import Ranking from "./Ranking.svelte";

  const TOKEN_KEY = "twototango.token";
  const NAME_KEY = "twototango.name";

  function stored(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function store(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private mode: the phone just won't be recognized after a reload.
    }
  }

  // crypto.randomUUID needs a secure context; the LAN page is plain http.
  function newToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  const token = stored(TOKEN_KEY) ?? newToken();
  store(TOKEN_KEY, token);

  const linkCode = new URLSearchParams(location.search).get("code")?.toUpperCase() ?? "";
  const codeFromLink = linkCode !== "";
  let code = $state(linkCode);
  let name = $state(stored(NAME_KEY) ?? "");
  let role = $state<Role | null>(null);
  let me = $state<string | null>(null);
  let view = $state<View | null>(null);
  let welcomed = $state(false);
  let paused = $state(false);
  let error = $state<ErrorCode | null>(null);
  let ws: WebSocket | null = null;

  function send(message: object) {
    ws?.send(JSON.stringify(message));
  }

  function connect() {
    const socket = new WebSocket(phoneSocketUrl());
    ws = socket;
    socket.onopen = () => send({ t: "hello", token });
    socket.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as HostMessage;
      switch (msg.t) {
        case "welcome":
          welcomed = true;
          paused = false;
          role = msg.role;
          me = msg.playerId;
          if (role !== null) error = null;
          break;
        case "view":
          paused = false;
          view = msg.view;
          if (role !== null) error = null;
          break;
        case "error":
          error = msg.code;
          break;
        case "paused":
          paused = true;
          break;
      }
    };
    socket.onclose = () => {
      ws = null;
      paused = true;
      setTimeout(connect, 1000);
    };
  }

  onMount(connect);

  function join(asRole: Role) {
    error = null;
    if (asRole === "player") {
      store(NAME_KEY, name.trim());
      send({ t: "join", token, name, code });
    } else {
      send({ t: "watch", token, code });
    }
  }
</script>

{#if paused}
  <div class="overlay" data-testid="paused">{t.paused}</div>
{/if}

{#if !welcomed}
  <p class="muted">{t.waitingForGm}</p>
{:else if role === null}
  <div class="card">
    <h1>{t.appName}</h1>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        join("player");
      }}
    >
      <div class="field">
        <label for="name">{t.yourName}</label>
        <input id="name" bind:value={name} maxlength="24" autocomplete="nickname" />
      </div>
      {#if !codeFromLink}
        <div class="field">
          <label for="code">{t.code}</label>
          <input id="code" bind:value={code} maxlength="8" autocapitalize="characters" />
        </div>
      {/if}
      {#if error}<p class="error" data-testid="error">{t.errors[error]}</p>{/if}
      <div class="actions">
        <button class="primary" type="submit" disabled={name.trim() === ""}>{t.play}</button>
        <button type="button" onclick={() => join("spectator")}>{t.watch}</button>
      </div>
    </form>
  </div>
{:else if view === null}
  <p class="muted">{t.waitingForGm}</p>
{:else if view.phase === "lobby"}
  <div class="card">
    <h1>{role === "spectator" ? t.watching : t.waitingForStart}</h1>
    <p class="muted">{t.waitingFor(view.players.length, view.playerCount)}</p>
    <ul class="plain" data-testid="lobby-players">
      {#each view.players as p (p.id)}
        <li class:me={p.id === me}>{p.name}</li>
      {/each}
    </ul>
  </div>
{:else if view.phase === "item"}
  <Banner {view} {me} />
  <ItemCard {view} />
  {#if role === "player" && view.status === "shown" && view.turn.id === me}
    <div class="actions">
      <button onclick={() => send({ t: "pass" })} disabled={view.passed}>{t.pass}</button>
    </div>
  {/if}
  {#if view.number === 1 && view.status !== "revealed"}
    <p class="muted order">{t.turnOrder}: {view.order.map((p) => p.name).join(" → ")}</p>
  {/if}
  {#if error}<p class="error">{t.errors[error]}</p>{/if}
{:else}
  <Ranking {view} />
{/if}

<style>
  li {
    padding: 6px 0;
  }
  li.me {
    font-weight: 700;
  }
  .order {
    margin-top: 16px;
  }
</style>
