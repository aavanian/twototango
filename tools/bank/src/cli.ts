#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bank pipeline commands. Run through npm so the proxy settings apply:
 *
 *   npm run bank -- lexicon                 rebuild data/lex from the lexicons (Python)
 *   npm run bank -- select --lang en        candidate answers → tools/bank/work/en/candidates.json
 *   npm run bank -- check <items.json>      deterministic checks; places given letters where missing
 *   npm run bank -- finalize <drafts.json> --lang en --level C1 --out <bank.json> [--start 1]
 *                                           drafts → items (ids, given letters), then the checks
 *   npm run bank -- bakeoff --models a,b --solver s --words <drafts.json> --lang en --level C1
 *                                           draft the same words with each model, blind-solve with one solver
 *   npm run bank -- solve <bank.json> --solver s   blind-solve existing items (e.g. to calibrate the solver)
 *   npm run bank -- run --lang en --level C1 [--target 600] [--keep <bank.json>]
 *                                           screen, draft, check, solve, repair; writes content/staging
 *   npm run bank -- review-rows --lang en --level C1   Grist rows for the review list (stdout, JSON)
 *   npm run bank -- freeze --lang en --level C1 --verdicts <verdicts.json> [--keep <bank.json>]
 *                                           apply the GM's review and write content/<lang>/<level>.json
 *   npm run bank -- fix <bank.json>         repair, in place, unshipped items that fail the current checks
 *   npm run bank -- topup --lang en --level C2   repair, re-screen and refill an unshipped staging bank
 *   npm run bank -- key                     the OpenRouter key's limit and usage (free call)
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Bank, Item, LANGS, LEVELS, type Lang } from "@twototango/core";
import { z } from "zod";
import { checkDrafts } from "./checks.ts";
import { finalize, parseDraftBatch } from "./draft.ts";
import { Lexicon, profanity, REPO } from "./lexicon.ts";
import { BudgetGuard, OpenRouter, SpendLedger } from "./openrouter.ts";
import { blindSolve, runBakeoff, type Context, type Word } from "./bakeoff.ts";
import { freeze, repairBank, runLevel, screenWords, STAGING } from "./run.ts";
import { dedupeRoots, eligible, DEFINITION_EVERY, type Candidate } from "./select.ts";
import type { Selection } from "./select.ts";
import { choosePlacement } from "./placement.ts";
import { selectCandidates } from "./select.ts";

const WORK = resolve(REPO, "tools/bank/work");

function lexicon(): void {
  const result = spawnSync(resolve(REPO, ".venv/bin/python"), [resolve(REPO, "tools/bank/lexicon/import_lexicon.py")], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

function select(args: string[]): void {
  const { values } = parseArgs({ args, options: { lang: { type: "string" }, target: { type: "string" }, seed: { type: "string" } } });
  const lang = z.enum(LANGS).parse(values.lang);
  const lex = Lexicon.load(lang);
  const sel = selectCandidates(lex, {
    profanity: profanity(lang),
    ...(values.target ? { target: Number(values.target) } : {}),
    ...(values.seed ? { seed: Number(values.seed) } : {}),
  });
  const out = resolve(WORK, lang, "candidates.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(sel, null, 2) + "\n");
  console.log(`${sel.candidates.length} candidates → ${out}`);
  for (const [level, byPos] of Object.entries(sel.counts)) {
    const parts = Object.entries(byPos).map(([pos, c]) => `${pos} ${c.taken}/${c.wanted} (of ${c.available})`);
    console.log(`  ${level}: ${parts.join(", ")}`);
  }
}

/** Accepts a bank file or a bare array of items. Items may leave `given` empty for the pipeline to place. */
function readItems(path: string): Item[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (Array.isArray(raw)) return z.array(Item).parse(raw);
  return Bank.parse(raw).items;
}

function check(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { write: { type: "boolean" } } });
  const path = resolve(positionals[0] ?? "");
  const items = readItems(path);
  const lexicons = new Map<Lang, Lexicon>();
  const lex = (lang: Lang) => lexicons.get(lang) ?? lexicons.set(lang, Lexicon.load(lang)).get(lang)!;

  const unplaced: string[] = [];
  const placed = items.map((item) => {
    if (item.given.length > 0) return item;
    const report = choosePlacement(item, lex(item.lang));
    if (report.choice === null) {
      unplaced.push(`${item.id}: no placement rules out ${report.rivals.join(", ")}`);
      return item;
    }
    return { ...item, given: report.choice.given };
  });

  const reports = LANGS.flatMap((lang) => {
    const subset = placed.filter((i) => i.lang === lang);
    return subset.length === 0 ? [] : checkDrafts(subset, lex(lang), { profanity: profanity(lang) });
  });
  const reportPath = path.replace(/\.json$/u, "") + ".report.json";
  writeFileSync(reportPath, JSON.stringify(reports, null, 2) + "\n");
  if (values.write) {
    const original = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const updated = Array.isArray(original) ? placed : { ...(original as object), items: placed };
    writeFileSync(path, JSON.stringify(updated, null, 2) + "\n");
  }

  const failed = reports.filter((r) => r.issues.some((i) => i.severity === "fail"));
  const flagged = reports.filter((r) => !failed.includes(r) && r.issues.length > 0);
  console.log(`${reports.length} items: ${reports.length - failed.length - flagged.length} pass, ${flagged.length} flagged, ${failed.length} fail → ${reportPath}`);
  for (const r of [...failed, ...flagged]) for (const i of r.issues) console.log(`  ${i.itemId} ${i.severity} ${i.code}: ${i.message}`);
  for (const u of unplaced) console.log(`  ${u}`);
  if (failed.length > 0 || unplaced.length > 0) process.exitCode = 1;
}

function finalizeDrafts(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { lang: { type: "string" }, level: { type: "string" }, out: { type: "string" }, start: { type: "string" } },
  });
  const lang = z.enum(LANGS).parse(values.lang);
  const level = z.enum(LEVELS).parse(values.level);
  const out = resolve(values.out ?? "");
  const raw = JSON.parse(readFileSync(resolve(positionals[0] ?? ""), "utf8")) as { items: unknown };
  const drafts = parseDraftBatch({ items: raw.items });
  const lex = Lexicon.load(lang);
  const start = Number(values.start ?? 1);
  const results = drafts.map((d, i) => finalize(d, `${lang}-${level.toLowerCase()}-${String(start + i).padStart(4, "0")}`, lang, level, lex));
  const items = results.flatMap((r) => (r.item ? [r.item] : []));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(Bank.parse({ lang, level, items }), null, 2) + "\n");
  const reports = checkDrafts(items, lex, { profanity: profanity(lang) });
  const notes = Object.fromEntries(results.map((r, i) => [r.item?.id ?? `draft-${i + 1}:${r.draft.lemma}`, r.notes]));
  const reportPath = out.replace(/\.json$/u, "") + ".report.json";
  writeFileSync(reportPath, JSON.stringify({ notes, reports }, null, 2) + "\n");

  const failed = reports.filter((r) => r.issues.some((i) => i.severity === "fail"));
  const flagged = reports.filter((r) => !failed.includes(r) && r.issues.length > 0);
  const dropped = results.filter((r) => r.item === null);
  console.log(`${drafts.length} drafts: ${items.length} items (${dropped.length} dropped), ${failed.length} fail, ${flagged.length} flagged → ${out}`);
  for (const r of dropped) console.log(`  dropped ${r.draft.lemma}: ${r.notes.join("; ")}`);
  for (const r of results) if (r.item && r.notes.length > 0) console.log(`  ${r.item.id} ${r.item.lemma}: ${r.notes.join("; ")}`);
  for (const r of [...failed, ...flagged]) for (const i of r.issues) console.log(`  ${i.itemId} ${i.severity} ${i.code}: ${i.message}`);
  if (failed.length > 0 || dropped.length > 0) process.exitCode = 1;
}

function context(lang: Lang, level: Item["level"]): Context {
  return { client: new OpenRouter(), ledger: new SpendLedger(), lex: Lexicon.load(lang), lang, level, profanity: profanity(lang), batchSize: 10 };
}

async function bakeoff(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { models: { type: "string" }, solver: { type: "string" }, words: { type: "string" }, lang: { type: "string" }, level: { type: "string" }, out: { type: "string" } },
  });
  const lang = z.enum(LANGS).parse(values.lang);
  const level = z.enum(LEVELS).parse(values.level);
  const models = (values.models ?? "").split(",").filter(Boolean);
  const solver = z.string().min(1).parse(values.solver);
  const raw = JSON.parse(readFileSync(resolve(values.words ?? ""), "utf8")) as { items: Word[] };
  const words = raw.items.map(({ lemma, pos, kind }) => ({ lemma, pos, kind }));
  const out = resolve(values.out ?? resolve(WORK, "bakeoff", `${lang}-${level.toLowerCase()}`));
  mkdirSync(out, { recursive: true });
  const ctx = context(lang, level);
  const summaries = await runBakeoff(ctx, new BudgetGuard(ctx.client), models, solver, words, out, (l) => console.log(l));
  console.log("\nmodel | items | clean | solver found | rivals | clue issues | $ drafting | $/item | reasoning tok/item | s");
  for (const s of summaries) {
    console.log(
      `${s.model} | ${s.items}/${s.words} | ${s.clean} | ${s.solverFoundAnswer} | ${s.solverRivals} | ${s.clueIssues} | ${s.draftCost.toFixed(4)} | ${s.draftCostPerItem.toFixed(5)} | ${s.reasoningTokensPerItem.toFixed(0)} | ${s.seconds.toFixed(0)}`,
    );
  }
  for (const r of ctx.ledger.rows()) console.log(`spend ${r.stage} ${r.model}: $${r.cost} (${r.calls} calls)`);
  console.log(`total spend $${ctx.ledger.total().toFixed(4)}`);
}

async function solve(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { solver: { type: "string" } } });
  const path = resolve(positionals[0] ?? "");
  const bank = Bank.parse(JSON.parse(readFileSync(path, "utf8")));
  const ctx = context(bank.lang, bank.level);
  await new BudgetGuard(ctx.client).ensure(0.05);
  const { verdicts, errors } = await blindSolve(ctx, z.string().min(1).parse(values.solver), bank.items);
  writeFileSync(path.replace(/\.json$/u, "") + ".solve.json", JSON.stringify({ solver: values.solver, verdicts, errors }, null, 2) + "\n");
  console.log(`${verdicts.length} items: answer found ${verdicts.filter((v) => v.foundAnswer).length}, rivals ${verdicts.filter((v) => v.rivals.length).length}, clue issues ${verdicts.filter((v) => v.clueIssue).length}`);
  for (const v of verdicts) for (const i of v.issues) console.log(`  ${i.itemId} ${i.code}: ${i.message}`);
  for (const e of errors) console.log(`  ! ${e}`);
  console.log(`spend $${ctx.ledger.total().toFixed(4)}`);
}

/** The bulk run's models, chosen in the bake-off (19 Oct 2026). */
const MODELS = { drafter: "z-ai/glm-5.3-flash", solver: "deepseek/deepseek-v4.1-flash", repairer: "deepseek/deepseek-v4-pro" };

async function run(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { lang: { type: "string" }, level: { type: "string" }, target: { type: "string" }, keep: { type: "string" } } });
  const lang = z.enum(LANGS).parse(values.lang);
  const level = z.enum(LEVELS).parse(values.level);
  const selection = JSON.parse(readFileSync(resolve(WORK, lang, "candidates.json"), "utf8")) as Selection;
  const keep = values.keep ? Bank.parse(JSON.parse(readFileSync(resolve(values.keep), "utf8"))).items : [];
  const ctx = context(lang, level);
  const summary = await runLevel(
    ctx,
    new BudgetGuard(ctx.client),
    selection.candidates,
    { target: Number(values.target ?? 600), ...MODELS, keep, reviewShare: 0.1, seed: 1 },
    (l) => console.log(l),
  );
  console.log(JSON.stringify(summary, null, 2));
  for (const r of ctx.ledger.rows()) console.log(`spend ${r.stage} ${r.model}: $${r.cost} (${r.calls} calls, ${r.items} items)`);
}

/** Rows for the Grist review table: what players see, plus why the item is up for review. */
function reviewRows(args: string[]): void {
  const { values } = parseArgs({ args, options: { lang: { type: "string" }, level: { type: "string" } } });
  const lang = z.enum(LANGS).parse(values.lang);
  const level = z.enum(LEVELS).parse(values.level);
  const t = `${lang}-${level.toLowerCase()}`;
  const bank = Bank.parse(JSON.parse(readFileSync(resolve(REPO, "content/staging", `${t}.json`), "utf8")));
  const review = JSON.parse(readFileSync(resolve(REPO, "content/staging", `${t}.review.json`), "utf8")) as { itemId: string; why: string }[];
  const byId = new Map(bank.items.map((i) => [i.id, i]));
  const rows = review.map(({ itemId, why }) => {
    const item = byId.get(itemId)!;
    const p = item.prompt;
    const shown = p.kind === "sentence" ? `${p.before}${p.determiner ? `${p.determiner} ` : ""}**${p.span.join("/")}**${p.after}` : `*${p.definition}*`;
    const letters = [...item.answer].map((c, i) => (item.given.includes(i) ? c : "_")).join(" ");
    return {
      Item: itemId,
      POS: item.pos,
      Shown: shown,
      Boxes: item.fixedWords.length > 0 ? `${letters}  + ${item.fixedWords.join(" ")}` : letters,
      Answer: item.answer,
      Alternates: item.alternates.join(", "),
      Why: why === "random sample" ? "Random sample" : `Flagged: ${why}`,
    };
  });
  console.log(JSON.stringify(rows));
}

function freezeCommand(args: string[]): void {
  const { values } = parseArgs({ args, options: { lang: { type: "string" }, level: { type: "string" }, verdicts: { type: "string" }, keep: { type: "string" } } });
  const lang = z.enum(LANGS).parse(values.lang);
  const level = z.enum(LEVELS).parse(values.level);
  const verdicts = z.record(z.string(), z.enum(["good", "fix", "reject"])).parse(JSON.parse(readFileSync(resolve(values.verdicts ?? ""), "utf8")));
  const pilot = values.keep ? new Set(Bank.parse(JSON.parse(readFileSync(resolve(values.keep), "utf8"))).items.map((i) => i.id)) : new Set<string>();
  const { bank, removed, sampleRejectRate } = freeze(lang, level, new Map(Object.entries(verdicts)), pilot);
  console.log(`${bank.items.length} items frozen to content/${lang}/${level.toLowerCase()}.json; removed ${removed.length}; random-sample reject rate ${(sampleRejectRate * 100).toFixed(1)}%`);
  if (sampleRejectRate > 0.05) console.log("Above 5%: fix the prompts and rerun rather than patching items.");
}

async function fix(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const path = resolve(positionals[0] ?? "");
  const bank = Bank.parse(JSON.parse(readFileSync(path, "utf8")));
  const ctx = context(bank.lang, bank.level);
  const result = await repairBank(ctx, new BudgetGuard(ctx.client), bank, MODELS.solver, MODELS.repairer, (l) => console.log(l));
  writeFileSync(path, JSON.stringify(result.bank, null, 2) + "\n");
  console.log(`fixed ${result.fixed.length}, dropped ${result.dropped.length}; ${result.bank.items.length} items; spend $${ctx.ledger.total().toFixed(4)}`);
}

/**
 * Refills a staging bank that came out short or weak: repairs items failing the current
 * checks, re-screens the kept words with the current screen prompt, then drafts fresh
 * candidates of the same level (never screened before) until the target is met.
 */
async function topup(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { lang: { type: "string" }, level: { type: "string" }, target: { type: "string" } } });
  const lang = z.enum(LANGS).parse(values.lang);
  const level = z.enum(LEVELS).parse(values.level);
  const t = `${lang}-${level.toLowerCase()}`;
  const path = resolve(STAGING, `${t}.json`);
  const ctx = context(lang, level);
  const guard = new BudgetGuard(ctx.client);
  const log = (l: string) => console.log(l);

  // 1. Repair what fails the current checks.
  const repaired = await repairBank(ctx, guard, Bank.parse(JSON.parse(readFileSync(path, "utf8"))), MODELS.solver, MODELS.repairer, log);

  // 2. Re-screen the kept words with the current screen.
  const asCandidates = repaired.bank.items.map((i): Candidate => ({ lemma: i.lemma, pos: i.pos, level, zipf: 0, definition: i.prompt.kind === "definition", easier: [], synonyms: [] }));
  const rescreen = await screenWords(ctx, MODELS.solver, asCandidates, level);
  const out = new Set(rescreen.filter((r) => !r.keep).map((r) => r.lemma));
  log(`re-screen: ${out.size} dropped (${[...out].slice(0, 30).join(", ")}${out.size > 30 ? "…" : ""})`);
  const keep = repaired.bank.items.filter((i) => !out.has(i.lemma));

  // 3. Fresh candidates of this level, never screened before.
  const screenedBefore = new Set((JSON.parse(readFileSync(resolve(WORK, t, "screen.json"), "utf8")) as { lemma: string }[]).map((s) => s.lemma));
  const pool = dedupeRoots(ctx.lex, eligible(ctx.lex, { profanity: ctx.profanity })).filter((c) => c.level === level && !screenedBefore.has(c.lemma));
  const extra = pool.map((c, i): Candidate => ({ ...c, definition: i % DEFINITION_EVERY === 0 }));
  log(`${keep.length} kept; ${extra.length} fresh candidates`);

  // Keep the first run's provenance and review entries for the items that stay.
  const prov = resolve(STAGING, `${t}.provenance.json`);
  writeFileSync(resolve(STAGING, `${t}.provenance.run1.json`), readFileSync(prov));
  const oldReview = (JSON.parse(readFileSync(resolve(STAGING, `${t}.review.json`), "utf8")) as { itemId: string; why: string }[]).filter((r) => keep.some((i) => i.id === r.itemId));

  const summary = await runLevel(ctx, guard, extra, { target: Number(values.target ?? 600), ...MODELS, keep, reviewShare: 0.1, seed: 2 }, log, `${t}-topup`);
  const newReview = JSON.parse(readFileSync(resolve(STAGING, `${t}.review.json`), "utf8")) as { itemId: string; why: string }[];
  writeFileSync(resolve(STAGING, `${t}.review.json`), JSON.stringify([...oldReview, ...newReview], null, 2) + "\n");
  console.log(JSON.stringify({ fixedInPlace: repaired.fixed.length, droppedByRepair: repaired.dropped.length, droppedByRescreen: out.size, ...summary }, null, 2));
  console.log(`spend $${ctx.ledger.total().toFixed(4)}`);
}

async function key(): Promise<void> {
  const info = await new OpenRouter().keyInfo();
  console.log(`limit $${info.limit ?? "none"}, used $${info.usage.toFixed(4)}, remaining $${info.limitRemaining ?? "n/a"}`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "lexicon":
    lexicon();
    break;
  case "select":
    select(rest);
    break;
  case "check":
    check(rest);
    break;
  case "finalize":
    finalizeDrafts(rest);
    break;
  case "bakeoff":
    await bakeoff(rest);
    break;
  case "solve":
    await solve(rest);
    break;
  case "run":
    await run(rest);
    break;
  case "review-rows":
    reviewRows(rest);
    break;
  case "freeze":
    freezeCommand(rest);
    break;
  case "fix":
    await fix(rest);
    break;
  case "topup":
    await topup(rest);
    break;
  case "key":
    await key();
    break;
  default:
    console.log("usage: npm run bank -- <lexicon | select --lang en|fr [--target n] [--seed n] | check <items.json> [--write] | finalize <drafts.json> --lang --level --out [--start] | key>");
    process.exitCode = command === undefined ? 0 : 1;
}
