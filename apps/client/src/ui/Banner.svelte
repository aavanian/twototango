<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
  import type { ItemView } from "@twototango/core";
  import { t } from "../i18n.ts";

  let { view, me = null }: { view: ItemView; me?: string | null } = $props();

  const mine = $derived(view.status === "shown" && view.turn.id === me);
</script>

<div class="banner" class:mine class:open={view.status === "open"} data-testid="banner">
  {#if view.status === "revealed"}
    {#if view.outcome?.winner}
      {t.scored(view.outcome.winner.name, view.outcome.points)}
    {:else}
      {t.noScore}
    {/if}
  {:else if view.status === "open"}
    {t.openToAll}
  {:else if mine}
    {t.yourTurn}
  {:else}
    {t.turnOf(view.turn.name)}
  {/if}
  {#if view.status === "shown" && view.passed}
    <span class="muted"> · {t.passed(view.turn.name)}</span>
  {/if}
</div>
