<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { ItemView } from "@twototango/core";
  import { t } from "../i18n.ts";

  let { view }: { view: ItemView } = $props();

  const prompt = $derived(view.prompt);
  // An elided determiner (l’, d’) sits against the span; any other takes a space.
  const determiner = $derived(
    prompt.kind === "sentence" && prompt.determiner !== undefined
      ? /['’]$/u.test(prompt.determiner)
        ? prompt.determiner
        : `${prompt.determiner} `
      : "",
  );
</script>

<div class="card item" data-testid="item">
  <div class="meta">
    <span class="pos">{t.pos[view.pos]}</span>
    <span class="number" data-testid="item-number">{t.itemNumber(view.number, view.total)}</span>
  </div>

  <p class="prompt">
    {#if prompt.kind === "sentence"}
      {prompt.before}{determiner}<u>{prompt.span.join("/")}</u>{prompt.after}
    {:else}
      <em>{prompt.definition}</em>
    {/if}
  </p>

  <div class="row" data-testid="boxes" style:--cells={view.cells.length}>
    {#each view.cells as cell, i (i)}
      {#if cell.kind === "mark"}
        <span class="mark">{cell.char}</span>
      {:else}
        <span class="box" class:given={cell.given} class:revealed={!cell.given && cell.char !== null}>{cell.char ?? ""}</span>
      {/if}
    {/each}
    {#each view.fixedWords as word (word)}
      <span class="fixed">{word}</span>
    {/each}
  </div>
</div>

<style>
  .meta {
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .pos {
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .prompt {
    font-size: 1.2rem;
    line-height: 1.5;
    margin: 0 0 16px;
  }
  u {
    text-decoration-thickness: 2px;
    text-underline-offset: 4px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 4px;
  }
  .box {
    /* Shrink to keep long answers on one row: card padding and gaps come off the width. */
    width: min(2rem, calc((100vw - 64px) / var(--cells) - 4px));
    height: 2.4rem;
    border: 2px solid var(--line);
    border-radius: 6px;
    display: grid;
    place-items: center;
    font-size: 1.2rem;
    font-weight: 700;
    text-transform: lowercase;
  }
  .box.given {
    background: var(--given-bg);
    color: var(--given);
    border-color: var(--given-bg);
  }
  .box.revealed {
    color: var(--revealed);
    border-color: var(--revealed);
  }
  .mark {
    font-size: 1.4rem;
    font-weight: 700;
    padding: 0 1px;
  }
  .fixed {
    margin-left: 8px;
    font-size: 1.1rem;
    font-weight: 600;
    align-self: center;
  }
</style>
