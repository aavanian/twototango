<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { ResultsView } from "@twototango/core";
  import { t } from "../i18n.ts";

  let { view }: { view: ResultsView } = $props();
</script>

<div class="card">
  <h1>{t.results}</h1>
  {#if view.endedEarly}
    <p class="muted">{t.endedEarly(view.played, view.total)}</p>
  {/if}
  <ol class="plain" data-testid="ranking">
    {#each view.ranking as row (row.playerId)}
      <li class:first={row.rank === 1}>
        <span class="rank">{row.rank}</span>
        <span class="name">{row.name}</span>
        <span class="points">{t.points(row.points)}</span>
      </li>
    {/each}
  </ol>
</div>

<style>
  li {
    display: flex;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
    font-size: 1.1rem;
  }
  li:last-child {
    border-bottom: none;
  }
  li.first {
    font-weight: 700;
  }
  .rank {
    width: 1.5rem;
    color: var(--muted);
  }
  .name {
    flex: 1;
  }
</style>
