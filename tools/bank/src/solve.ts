// SPDX-License-Identifier: AGPL-3.0-only

import { fitsPattern, layoutBoxes, type Item } from "@twototango/core";
import { z } from "zod";
import { key, type Lexicon } from "./lexicon.ts";
import type { PipelineIssue } from "./checks.ts";
import { britishVariant } from "./spelling.ts";

/**
 * Stage 6, blind solve: a model sees each item without the answer and lists the words
 * it would say. The answer should be among them; any other listed word that fits the
 * boxes is a rival the GM would have to judge, so it fails the item (or becomes an
 * alternate on repair). The solver also reads the sentence for errors the deterministic
 * checks can't see, such as a span that takes the wrong preposition.
 */

export const SolveBatch = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      candidates: z.array(z.string()),
      clueIssue: z.string().nullable(),
    }),
  ),
});
export type SolveResult = z.infer<typeof SolveBatch>["items"][number];

export const SOLVE_JSON_SCHEMA = {
  name: "blind_solve",
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
          required: ["id", "candidates", "clueIssue"],
          properties: {
            id: { type: "string" },
            candidates: { type: "array", items: { type: "string" } },
            clueIssue: { type: ["string", "null"] },
          },
        },
      },
    },
  },
} as const;

/** How the solver sees an item: no answer, no alternates. */
export function solverView(item: Item): string {
  const cells = layoutBoxes(item.answer, item.lang);
  let letter = 0;
  const boxes = cells
    .map((c) => {
      if (c.kind === "mark") return c.char;
      return item.given.includes(letter++) ? c.char : "_";
    })
    .join("");
  const fixed = item.fixedWords.length > 0 ? ` + ${item.fixedWords.join(" ")}` : "";
  const prompt =
    item.prompt.kind === "sentence"
      ? `Sentence: ${item.prompt.before}${item.prompt.determiner ? `${item.prompt.determiner} ` : ""}[${item.prompt.span.join("/")}]${item.prompt.after}`
      : `Definition: ${item.prompt.definition}`;
  return `id: ${item.id}\n${prompt}\nPart of speech: ${item.pos}\nBoxes: ${boxes}${fixed}`;
}

export interface SolveVerdict {
  readonly itemId: string;
  readonly foundAnswer: boolean;
  /** Listed words, other than the answer and accepted alternates, that fit the boxes. */
  readonly rivals: string[];
  readonly clueIssue: string | null;
  readonly issues: PipelineIssue[];
}

export function judgeSolve(item: Item, result: SolveResult | undefined, lex: Lexicon): SolveVerdict {
  const issues: PipelineIssue[] = [];
  const add = (code: string, severity: "fail" | "flag", message: string) => issues.push({ itemId: item.id, code, severity, message });
  if (result === undefined) {
    add("solve-missing", "flag", "the solver returned nothing for this item");
    return { itemId: item.id, foundAnswer: false, rivals: [], clueIssue: null, issues };
  }
  const cells = layoutBoxes(item.answer, item.lang);
  const accepted = new Set([item.answer, ...item.alternates].map(key));
  const listed = [...new Set(result.candidates.map(key))];
  const foundAnswer = listed.includes(key(item.answer)) || listed.some((w) => item.lang === "en" && britishVariant(w, lex) === key(item.answer));
  // The American spelling of the answer is the same word, not a rival (itemize for itemise).
  const sameWord = (w: string) => item.lang === "en" && britishVariant(w, lex) === key(item.answer);
  const rivals = listed.filter((w) => !accepted.has(w) && !sameWord(w) && lex.has(w) && fitsPattern(w, cells, item.given, item.lang));
  if (!foundAnswer) add("solve-missed", "flag", `solver didn't find "${item.answer}" (said: ${listed.join(", ") || "nothing"})`);
  if (rivals.length > 0) add("solve-rival", "fail", `solver found other words that fit: ${rivals.join(", ")}`);
  if (result.clueIssue) add("clue-issue", "fail", result.clueIssue);
  return { itemId: item.id, foundAnswer, rivals, clueIssue: result.clueIssue, issues };
}
