// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Bank, seededRng, shuffle, type Item, type Lang } from "@twototango/core";
import { z } from "zod";
import { blindSolve, chatLowReasoning, chunk, draftWords, loadPrompt, pool, withRetry, type Context, type Word } from "./bakeoff.ts";
import { checkDrafts, type PipelineIssue } from "./checks.ts";
import { DRAFT_JSON_SCHEMA, finalize, parseDraftBatch, type Draft } from "./draft.ts";
import { REPO } from "./lexicon.ts";
import type { BudgetGuard } from "./openrouter.ts";
import { relatedWords } from "./roots.ts";
import { POS_MIX, type Candidate } from "./select.ts";

/**
 * Stages 1 (model screen) and 4 to 7 for one language and level: screen the candidates,
 * draft, finalize, check, blind-solve, repair failures once, and write a staging bank
 * plus the review list and provenance. Each stage saves its output in the work
 * directory, so a rerun resumes instead of paying twice. Freezing happens after review.
 */

export interface RunOptions {
  readonly target: number;
  readonly drafter: string;
  readonly solver: string;
  readonly repairer: string;
  /** Items already rated good (the pilot), kept as they are and counted towards the target. */
  readonly keep: readonly Item[];
  readonly reviewShare: number;
  readonly seed: number;
}

export const STAGING = resolve(REPO, "content/staging");

type Level = Item["level"];
const tag = (lang: Lang, level: Level) => `${lang}-${level.toLowerCase()}`;

function cached<T>(path: string, schema: z.ZodType<T>): T | null {
  return existsSync(path) ? schema.parse(JSON.parse(readFileSync(path, "utf8"))) : null;
}
const save = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n");

const ScreenResult = z.object({ items: z.array(z.object({ lemma: z.string(), keep: z.boolean(), reason: z.string().nullable() })) });
const SCREEN_JSON_SCHEMA = {
  name: "screen",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["lemma", "keep", "reason"],
          properties: { lemma: { type: "string" }, keep: { type: "boolean" }, reason: { type: ["string", "null"] } },
        },
      },
    },
  },
} as const;

const Screened = z.array(z.object({ lemma: z.string(), pos: z.enum(["noun", "verb", "adjective"]), kind: z.enum(["sentence", "definition"]), keep: z.boolean(), reason: z.string().nullable() }));
type Screened = z.infer<typeof Screened>;

export async function screenWords(ctx: Context, model: string, candidates: readonly Candidate[], level: Level): Promise<Screened> {
  const system = loadPrompt(ctx.lang, "screen");
  const batches = chunk(candidates, 40);
  const results = await pool(
    batches.map((batch) => async () => {
      const res = await withRetry(() =>
        chatLowReasoning(ctx.client, {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: `Level: ${level}\nCandidates (lemma — part of speech):\n${batch.map((c, i) => `${i + 1}. ${c.lemma} — ${c.pos}`).join("\n")}` },
          ],
          schema: SCREEN_JSON_SCHEMA,
          maxTokens: 6000,
          temperature: 0,
        }),
      );
      ctx.ledger.record("screen", res, batch.length);
      const byLemma = new Map(ScreenResult.parse(JSON.parse(res.content)).items.map((r) => [r.lemma.toLowerCase(), r]));
      return batch.map((c) => {
        const r = byLemma.get(c.lemma.toLowerCase());
        return { lemma: c.lemma, pos: c.pos, kind: c.definition ? ("definition" as const) : ("sentence" as const), keep: r?.keep ?? false, reason: r ? r.reason : "missing" };
      });
    }),
  );
  return results.flat();
}

interface Attempt {
  readonly draft: Draft | null;
  readonly item: Item | null;
  readonly issues: PipelineIssue[];
}

/** Finalize, check and blind-solve drafts; items keyed by the provisional id given. */
export async function evaluate(ctx: Context, solver: string, drafts: readonly (Draft | null)[], ids: readonly string[]): Promise<Attempt[]> {
  const finalized = drafts.map((d, i) => (d ? finalize(d, ids[i]!, ctx.lang, ctx.level, ctx.lex) : null));
  const items = finalized.flatMap((f) => (f?.item ? [f.item] : []));
  const reports = checkDrafts(items, ctx.lex, { profanity: ctx.profanity });
  const { verdicts } = await blindSolve(ctx, solver, items);
  return drafts.map((draft, i) => {
    const f = finalized[i];
    if (!draft || !f) return { draft, item: null, issues: [{ itemId: ids[i]!, code: "no-draft", severity: "fail" as const, message: "the model returned nothing" }] };
    if (!f.item) return { draft, item: null, issues: [{ itemId: ids[i]!, code: "finalize", severity: "fail" as const, message: f.notes.join("; ") }] };
    const issues = [...(reports.find((r) => r.itemId === ids[i])?.issues ?? []), ...(verdicts.find((v) => v.itemId === ids[i])?.issues ?? [])];
    return { draft, item: f.item, issues };
  });
}

export async function repair(ctx: Context, model: string, failed: readonly { word: Word; attempt: Attempt }[]): Promise<(Draft | null)[]> {
  const system = `${loadPrompt(ctx.lang, "repair")}\n\n${loadPrompt(ctx.lang, "draft")}`;
  const results = await pool(
    chunk(failed, 8).map((batch) => async () => {
      const user = batch
        .map(({ word, attempt }, i) =>
          [
            `${i + 1}. Target: ${word.lemma} — ${word.pos} — ${word.kind}`,
            `Original: ${attempt.draft ? JSON.stringify(attempt.draft) : "(none)"}`,
            `Problems: ${attempt.issues.filter((x) => x.severity === "fail").map((x) => x.message).join(" | ")}`,
          ].join("\n"),
        )
        .join("\n\n");
      try {
        const res = await withRetry(() =>
          chatLowReasoning(ctx.client, {
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: `Level: answers are ${ctx.level}.\n\n${user}` },
            ],
            schema: DRAFT_JSON_SCHEMA,
            maxTokens: 8000,
            temperature: 0.5,
          }),
        );
        ctx.ledger.record("repair", res, batch.length);
        const byLemma = new Map(parseDraftBatch(JSON.parse(res.content)).map((d) => [d.lemma.toLowerCase(), d]));
        return batch.map(({ word }) => byLemma.get(word.lemma.toLowerCase()) ?? null);
      } catch {
        return batch.map(() => null);
      }
    }),
    4,
  );
  return results.flat();
}

export interface RunSummary {
  readonly candidates: number;
  readonly screenedIn: number;
  readonly drafted: number;
  readonly passedFirst: number;
  readonly repaired: number;
  readonly dropped: number;
  readonly kept: number;
  readonly flagged: number;
  readonly review: number;
  readonly spend: number;
}

export async function runLevel(ctx: Context, guard: BudgetGuard, candidates: readonly Candidate[], opts: RunOptions, log: (l: string) => void, workTag?: string): Promise<RunSummary> {
  const t = tag(ctx.lang, ctx.level);
  const dir = resolve(REPO, "tools/bank/work", workTag ?? t);
  mkdirSync(dir, { recursive: true });
  mkdirSync(STAGING, { recursive: true });

  // Words already used (the pilot) and anything sharing their root are out.
  const used = opts.keep.map((i) => i.lemma);
  const pool0 = candidates.filter((c) => c.level === ctx.level && !used.some((u) => relatedWords(ctx.lex, u, c.lemma)));
  log(`${pool0.length} candidates (${candidates.filter((c) => c.level === ctx.level).length - pool0.length} dropped as used by kept items)`);

  // 1. Model screen.
  let screened = cached(resolve(dir, "screen.json"), Screened);
  if (!screened) {
    await guard.ensure(0.05);
    screened = await screenWords(ctx, opts.solver, pool0, ctx.level);
    save(resolve(dir, "screen.json"), screened);
  }
  const words: Word[] = screened.filter((s) => s.keep).map(({ lemma, pos, kind }) => ({ lemma, pos, kind }));
  const reasons = screened.filter((s) => !s.keep).reduce<Record<string, number>>((m, s) => ((m[s.reason ?? "?"] = (m[s.reason ?? "?"] ?? 0) + 1), m), {});
  log(`screen: ${words.length} kept, dropped ${JSON.stringify(reasons)}`);

  // 2. Draft.
  const DraftList = z.array(z.unknown());
  let drafts = cached(resolve(dir, "drafts.json"), DraftList) as (Draft | null)[] | null;
  if (!drafts) {
    await guard.ensure(words.length * 0.0005);
    const run = await draftWords(ctx, opts.drafter, words);
    drafts = run.drafts;
    save(resolve(dir, "drafts.json"), drafts);
    log(`draft: ${drafts.filter(Boolean).length}/${words.length}, $${run.cost.toFixed(4)}${run.errors.length ? `, ${run.errors.length} errors` : ""}`);
  }
  const ids = words.map((_, i) => `${ctx.lang}-${ctx.level.toLowerCase()}-${String(5000 + i).padStart(4, "0")}`);

  // 3. Finalize, check, solve.
  const first = await evaluate(ctx, opts.solver, drafts, ids);
  const fails = (a: Attempt) => a.item === null || a.issues.some((i) => i.severity === "fail");
  const failed = first.map((attempt, i) => ({ i, word: words[i]!, attempt })).filter(({ attempt }) => fails(attempt));
  log(`check + solve: ${first.length - failed.length} pass, ${failed.length} fail`);

  // 4. One repair round with the stronger model; a second failure is dropped.
  let repairedAttempts: Attempt[] = [];
  const repairPath = resolve(dir, "repairs.json");
  let repaired = cached(repairPath, DraftList) as (Draft | null)[] | null;
  if (failed.length > 0) {
    if (!repaired) {
      await guard.ensure(failed.length * 0.003);
      repaired = await repair(ctx, opts.repairer, failed);
      save(repairPath, repaired);
    }
    repairedAttempts = await evaluate(ctx, opts.solver, repaired, failed.map(({ i }) => ids[i]!));
  }
  const final = first.slice();
  failed.forEach(({ i }, k) => (final[i] = repairedAttempts[k]!));
  const fixed = repairedAttempts.filter((a) => !fails(a)).length;
  log(`repair: ${fixed}/${failed.length} fixed, ${failed.length - fixed} dropped`);

  // 5. Cap at the target with the part-of-speech mix, preferring items without flags.
  const passing = final.filter((a) => !fails(a)) as (Attempt & { item: Item })[];
  const room = Math.max(0, opts.target - opts.keep.length);
  const rng = seededRng(opts.seed);
  const chosen: (Attempt & { item: Item })[] = [];
  for (const pos of ["noun", "verb", "adjective"] as const) {
    const want = Math.round(room * POS_MIX[pos]);
    const ofPos = shuffle(passing.filter((a) => a.item.pos === pos), rng).sort((a, b) => a.issues.length - b.issues.length);
    chosen.push(...ofPos.slice(0, want));
  }
  // Top up from any part of speech if one ran short.
  for (const a of shuffle(passing.filter((p) => !chosen.includes(p)), rng)) if (chosen.length < room) chosen.push(a);

  // 6. Staging bank, review list, provenance.
  const items = [...opts.keep, ...chosen.map((a) => a.item)];
  save(resolve(STAGING, `${t}.json`), Bank.parse({ lang: ctx.lang, level: ctx.level, items }));
  const flagged = chosen.filter((a) => a.issues.length > 0);
  const clean = chosen.filter((a) => a.issues.length === 0);
  const sample = shuffle(clean, rng).slice(0, Math.ceil(clean.length * opts.reviewShare));
  const review = [
    ...flagged.map((a) => ({ itemId: a.item.id, why: a.issues.map((x) => `${x.code}: ${x.message}`).join(" | ") })),
    ...sample.map((a) => ({ itemId: a.item.id, why: "random sample" })),
  ];
  save(resolve(STAGING, `${t}.review.json`), review);

  const promptVersion = (name: "draft" | "solve" | "screen" | "repair") =>
    /prompt: ([^(]+)/u.exec(readFileSync(resolve(REPO, `tools/bank/prompts/${ctx.lang}/${name}.md`), "utf8"))?.[1]?.trim() ?? "?";
  const summary: RunSummary = {
    candidates: pool0.length,
    screenedIn: words.length,
    drafted: drafts.filter(Boolean).length,
    passedFirst: first.length - failed.length,
    repaired: fixed,
    dropped: failed.length - fixed,
    kept: items.length,
    flagged: flagged.length,
    review: review.length,
    spend: ctx.ledger.total(),
  };
  save(resolve(STAGING, `${t}.provenance.json`), {
    date: new Date().toISOString().slice(0, 10),
    models: { screen: opts.solver, draft: opts.drafter, solve: opts.solver, repair: opts.repairer },
    prompts: { screen: promptVersion("screen"), draft: promptVersion("draft"), solve: promptVersion("solve"), repair: promptVersion("repair") },
    kept: { fromPilot: opts.keep.length, generated: chosen.length },
    summary,
    spend: ctx.ledger.rows(),
  });
  return summary;
}

/**
 * Applies the GM's review: rejected (and "fix") items leave the bank, ids are renumbered
 * after the kept pilot items, and the bank is written to content/<lang>/<level>.json.
 * Ids are permanent from here on: play history depends on them.
 */
export function freeze(lang: Lang, level: Level, verdicts: ReadonlyMap<string, "good" | "fix" | "reject">, pilotIds: ReadonlySet<string>): { bank: Bank; removed: string[]; sampleRejectRate: number } {
  const t = tag(lang, level);
  const staging = Bank.parse(JSON.parse(readFileSync(resolve(STAGING, `${t}.json`), "utf8")));
  const review = z.array(z.object({ itemId: z.string(), why: z.string() })).parse(JSON.parse(readFileSync(resolve(STAGING, `${t}.review.json`), "utf8")));
  const removed = staging.items.filter((i) => (verdicts.get(i.id) ?? "good") !== "good").map((i) => i.id);
  const kept = staging.items.filter((i) => !removed.includes(i.id));
  let n = Math.max(0, ...kept.filter((i) => pilotIds.has(i.id)).map((i) => Number(i.id.slice(-4))));
  const items = kept.map((i) => (pilotIds.has(i.id) ? i : { ...i, id: `${t}-${String(++n).padStart(4, "0")}` }));
  const bank = Bank.parse({ lang, level, items });
  const sampled = review.filter((r) => r.why === "random sample");
  const sampleRejectRate = sampled.length > 0 ? sampled.filter((r) => removed.includes(r.itemId)).length / sampled.length : 0;
  mkdirSync(resolve(REPO, "content", lang), { recursive: true });
  save(resolve(REPO, "content", lang, `${level.toLowerCase()}.json`), bank);
  const provenance = JSON.parse(readFileSync(resolve(STAGING, `${t}.provenance.json`), "utf8")) as object;
  save(resolve(REPO, "content", lang, `${level.toLowerCase()}.provenance.json`), {
    ...provenance,
    review: { reviewed: review.length, removed: removed.length, sampleRejectRate },
  });
  return { bank, removed, sampleRejectRate };
}

/** What a model would have drafted for an existing item, so the repair prompt can see it. */
function draftOf(item: Item): Draft {
  const p = item.prompt;
  return p.kind === "sentence"
    ? { lemma: item.lemma, pos: item.pos, kind: "sentence", before: `${p.before}${p.determiner ? `${p.determiner} ` : ""}`, span: p.span, after: p.after, fixedWords: item.fixedWords, answer: item.answer, acceptable: item.alternates, nearMisses: [] }
    : { lemma: item.lemma, pos: item.pos, kind: "definition", definition: p.definition, fixedWords: item.fixedWords, answer: item.answer, acceptable: item.alternates, nearMisses: [] };
}

/**
 * Re-checks a bank that hasn't shipped yet against the current rules and repairs what
 * now fails, in place: same word, same id. Items that still fail are dropped.
 */
export async function repairBank(ctx: Context, guard: BudgetGuard, bank: Bank, solver: string, repairer: string, log: (l: string) => void, withSolver = false): Promise<{ bank: Bank; fixed: string[]; dropped: string[] }> {
  const reports = checkDrafts(bank.items, ctx.lex, { profanity: ctx.profanity });
  if (withSolver) {
    // Re-read every item with the current solver prompt too.
    await guard.ensure(bank.items.length * 0.0001);
    const { verdicts } = await blindSolve(ctx, solver, bank.items);
    for (const v of verdicts) reports.find((r) => r.itemId === v.itemId)?.issues.push(...v.issues);
  }
  const failing = bank.items.filter((i) => reports.find((r) => r.itemId === i.id)?.issues.some((x) => x.severity === "fail"));
  log(`${failing.length} items fail the current checks`);
  if (failing.length === 0) return { bank, fixed: [], dropped: [] };
  await guard.ensure(failing.length * 0.003);
  const failed = failing.map((item) => ({
    word: { lemma: item.lemma, pos: item.pos, kind: item.prompt.kind } as Word,
    attempt: { draft: draftOf(item), item, issues: reports.find((r) => r.itemId === item.id)!.issues } as Attempt,
  }));
  const drafts = await repair(ctx, repairer, failed);
  const attempts = await evaluate(ctx, solver, drafts, failing.map((i) => i.id));
  const fixed: string[] = [];
  const dropped: string[] = [];
  const replaced = new Map<string, Item>();
  attempts.forEach((a, k) => {
    const id = failing[k]!.id;
    if (a.item && !a.issues.some((x) => x.severity === "fail")) {
      replaced.set(id, a.item);
      fixed.push(id);
    } else {
      dropped.push(id);
      log(`  dropped ${id} ${failing[k]!.lemma}: ${a.issues.filter((x) => x.severity === "fail").map((x) => x.message).join(" | ")}`);
    }
  });
  const items = bank.items.filter((i) => !dropped.includes(i.id)).map((i) => replaced.get(i.id) ?? i);
  return { bank: Bank.parse({ ...bank, items }), fixed, dropped };
}
