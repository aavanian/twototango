// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Item, Lang } from "@twototango/core";
import { checkDrafts, type ItemReport } from "./checks.ts";
import { DRAFT_JSON_SCHEMA, finalize, parseDraftBatch, type Draft } from "./draft.ts";
import { REPO, type Lexicon } from "./lexicon.ts";
import { OpenRouterError, type BudgetGuard, type ChatRequest, type ChatResult, type OpenRouter, type SpendLedger } from "./openrouter.ts";
import { judgeSolve, SOLVE_JSON_SCHEMA, SolveBatch, solverView, type SolveVerdict } from "./solve.ts";

/**
 * Stage 3, the bake-off: several models draft the same words with the same prompt;
 * one fixed solver judges all of them, so drafters are compared on equal terms.
 */

export interface Word {
  readonly lemma: string;
  readonly pos: Item["pos"];
  readonly kind: "sentence" | "definition";
}

export function loadPrompt(lang: Lang, name: "draft" | "solve"): string {
  const text = readFileSync(resolve(REPO, `tools/bank/prompts/${lang}/${name}.md`), "utf8");
  return text.slice(text.indexOf("\n---\n") + 5).trim();
}

export const slug = (model: string) => model.replace(/[^a-z0-9.-]+/giu, "_");

/** Little or no reasoning; models that can't turn it off get the lowest effort. */
async function chatLowReasoning(client: OpenRouter, req: Omit<ChatRequest, "reasoning">): Promise<ChatResult> {
  try {
    return await client.chat({ ...req, reasoning: { enabled: false } });
  } catch (e) {
    if (e instanceof OpenRouterError && e.status === 400) return client.chat({ ...req, reasoning: { effort: "low", exclude: true } });
    throw e;
  }
}

async function withRetry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const retriable = !(e instanceof OpenRouterError) || e.status === 429 || e.status >= 500;
      if (!retriable || i >= tries) throw e;
      // Upstream rate limits clear in tens of seconds; back off to about a minute.
      await new Promise((r) => setTimeout(r, Math.min(60_000, 3000 * 2 ** (i - 1))));
    }
  }
}

const chunk = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export interface Context {
  readonly client: OpenRouter;
  readonly ledger: SpendLedger;
  readonly lex: Lexicon;
  readonly lang: Lang;
  readonly level: Item["level"];
  readonly profanity: ReadonlySet<string>;
  readonly batchSize: number;
}

export interface DraftRun {
  readonly drafts: (Draft | null)[];
  readonly errors: string[];
  readonly cost: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
}

export async function draftWords(ctx: Context, model: string, words: readonly Word[]): Promise<DraftRun> {
  const system = loadPrompt(ctx.lang, "draft");
  const errors: string[] = [];
  const usage = { cost: 0, completionTokens: 0, reasoningTokens: 0 };
  const batches = chunk(words, ctx.batchSize);
  const results = await Promise.all(
    batches.map(async (batch) => {
      const user =
        `Level: answers are ${ctx.level}; spans should be easier (B1–B2).\nTarget words (lemma — part of speech — kind):\n` +
        batch.map((w, i) => `${i + 1}. ${w.lemma} — ${w.pos} — ${w.kind}`).join("\n");
      try {
        const res = await withRetry(() =>
          chatLowReasoning(ctx.client, {
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            schema: DRAFT_JSON_SCHEMA,
            maxTokens: 8000,
            temperature: 0.7,
          }),
        );
        ctx.ledger.record("draft", res, batch.length);
        usage.cost += res.cost;
        usage.completionTokens += res.completionTokens;
        usage.reasoningTokens += res.reasoningTokens;
        const drafts = parseDraftBatch(JSON.parse(res.content));
        const byLemma = new Map(drafts.map((d) => [d.lemma.toLowerCase(), d]));
        return batch.map((w) => {
          const d = byLemma.get(w.lemma.toLowerCase());
          if (d === undefined) errors.push(`${w.lemma}: missing from the reply`);
          return d ?? null;
        });
      } catch (e) {
        errors.push(`batch ${batch[0]?.lemma}…: ${(e as Error).message.slice(0, 200)}`);
        return batch.map(() => null);
      }
    }),
  );
  return { drafts: results.flat(), errors, ...usage };
}

export async function blindSolve(ctx: Context, solver: string, items: readonly Item[]): Promise<{ verdicts: SolveVerdict[]; errors: string[] }> {
  const system = loadPrompt(ctx.lang, "solve");
  const errors: string[] = [];
  const results = await Promise.all(
    chunk(items, ctx.batchSize).map(async (batch) => {
      try {
        const res = await withRetry(() =>
          chatLowReasoning(ctx.client, {
            model: solver,
            messages: [
              { role: "system", content: system },
              { role: "user", content: batch.map(solverView).join("\n\n") },
            ],
            schema: SOLVE_JSON_SCHEMA,
            maxTokens: 4000,
            temperature: 0,
          }),
        );
        ctx.ledger.record("solve", res, batch.length);
        const parsed = SolveBatch.parse(JSON.parse(res.content));
        const byId = new Map(parsed.items.map((r) => [r.id, r]));
        return batch.map((item) => judgeSolve(item, byId.get(item.id), ctx.lex));
      } catch (e) {
        errors.push(`solve batch ${batch[0]?.id}…: ${(e as Error).message.slice(0, 200)}`);
        return batch.map((item) => judgeSolve(item, undefined, ctx.lex));
      }
    }),
  );
  return { verdicts: results.flat(), errors };
}

export interface ModelSummary {
  readonly model: string;
  readonly words: number;
  readonly drafted: number;
  readonly items: number;
  readonly checkFails: number;
  readonly solverFoundAnswer: number;
  readonly solverRivals: number;
  readonly clueIssues: number;
  /** Items with no failing issue from checks or the solver. */
  readonly clean: number;
  readonly draftCost: number;
  readonly draftCostPerItem: number;
  readonly reasoningTokensPerItem: number;
  readonly completionTokensPerItem: number;
  readonly seconds: number;
  readonly errors: string[];
}

export async function runModel(ctx: Context, model: string, solver: string, words: readonly Word[], outDir: string): Promise<ModelSummary> {
  const started = Date.now();
  const run = await draftWords(ctx, model, words);
  const { drafts, errors } = run;
  const seconds = (Date.now() - started) / 1000;

  const finalized = drafts.map((d, i) => (d ? finalize(d, `${ctx.lang}-${ctx.level.toLowerCase()}-${String(i + 1).padStart(4, "0")}`, ctx.lang, ctx.level, ctx.lex) : null));
  const items = finalized.flatMap((f) => (f?.item ? [f.item] : []));
  for (const f of finalized) if (f && !f.item) errors.push(`${f.draft.lemma}: ${f.notes.join("; ")}`);
  const reports = checkDrafts(items, ctx.lex, { profanity: ctx.profanity });
  const solved = await blindSolve(ctx, solver, items);
  errors.push(...solved.errors);

  const merged: ItemReport[] = reports.map((r) => ({ ...r, issues: [...r.issues, ...(solved.verdicts.find((v) => v.itemId === r.itemId)?.issues ?? [])] }));
  const draftCost = run.cost;
  const n = drafts.filter(Boolean).length;

  const dir = resolve(outDir, slug(model));
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "drafts.json"), JSON.stringify({ model, items: drafts }, null, 2) + "\n");
  writeFileSync(resolve(dir, "items.json"), JSON.stringify({ lang: ctx.lang, level: ctx.level, items }, null, 2) + "\n");
  writeFileSync(resolve(dir, "report.json"), JSON.stringify({ reports: merged, solve: solved.verdicts, errors }, null, 2) + "\n");

  const fails = (r: ItemReport) => r.issues.some((i) => i.severity === "fail");
  return {
    model,
    words: words.length,
    drafted: n,
    items: items.length,
    checkFails: reports.filter(fails).length,
    solverFoundAnswer: solved.verdicts.filter((v) => v.foundAnswer).length,
    solverRivals: solved.verdicts.filter((v) => v.rivals.length > 0).length,
    clueIssues: solved.verdicts.filter((v) => v.clueIssue).length,
    clean: merged.filter((r) => !fails(r)).length,
    draftCost,
    draftCostPerItem: n > 0 ? draftCost / n : 0,
    reasoningTokensPerItem: n > 0 ? run.reasoningTokens / n : 0,
    completionTokensPerItem: n > 0 ? run.completionTokens / n : 0,
    seconds,
    errors,
  };
}

export async function runBakeoff(
  ctx: Context,
  guard: BudgetGuard,
  models: readonly string[],
  solver: string,
  words: readonly Word[],
  outDir: string,
  log: (line: string) => void,
): Promise<ModelSummary[]> {
  const summaries: ModelSummary[] = [];
  for (const model of models) {
    // Estimate from the dearest model measured so far; before any, a cautious first guess.
    const measured = summaries.map((s) => s.draftCostPerItem);
    const perItem = measured.length > 0 ? Math.max(...measured) * 3 : 0.01;
    await guard.ensure(perItem * words.length * 2);
    log(`${model}: drafting ${words.length} words…`);
    const s = await runModel(ctx, model, solver, words, outDir);
    summaries.push(s);
    log(`  ${s.items}/${s.words} items, ${s.clean} clean, solver found ${s.solverFoundAnswer}, $${s.draftCost.toFixed(4)} (${s.seconds.toFixed(0)} s)`);
    for (const e of s.errors.slice(0, 5)) log(`  ! ${e}`);
  }
  // Merge with earlier runs in the same directory: a rerun replaces that model's row.
  const path = resolve(outDir, "summary.json");
  let previous: ModelSummary[] = [];
  try {
    previous = (JSON.parse(readFileSync(path, "utf8")) as { summaries: ModelSummary[] }).summaries;
  } catch {
    // First run here.
  }
  const merged = [...previous.filter((p) => !summaries.some((s) => s.model === p.model)), ...summaries];
  writeFileSync(path, JSON.stringify({ solver, summaries: merged }, null, 2) + "\n");
  return summaries;
}
