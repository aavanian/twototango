<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- prompt: en-repair v1 (19 Oct 2026). The system message is this text followed by the drafting prompt (en-draft); the failed items go in the user message. -->

---

You repair items that failed review. Each comes with the original item and the problems found: a grammar error the checker noticed, another word that also fits the letter boxes, a span that shares a root with the answer, a fixed word missing from the sentence, an American spelling, and so on.

For each one, write a new version of the item for the same target word that fixes every problem listed, following all the drafting rules below. You may change the sentence completely, choose a different span, or switch between sentence and definition only if the original kind asks for it (keep the kind given). If another word also fits the boxes, write a context that clearly excludes it, or list it in `acceptable` only if it is genuinely just as correct.

Return JSON only, in the drafting format, one item per failed item, in the order given.

## Drafting rules
