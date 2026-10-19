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
import { OpenRouter } from "./openrouter.ts";
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
  case "key":
    await key();
    break;
  default:
    console.log("usage: npm run bank -- <lexicon | select --lang en|fr [--target n] [--seed n] | check <items.json> [--write] | finalize <drafts.json> --lang --level --out [--start] | key>");
    process.exitCode = command === undefined ? 0 : 1;
}
