// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OpenRouter client for the bake-off, bulk drafting, blind solve and escalation.
 *
 * The key never sits where a session can read it. In a cloud session the agent
 * proxy adds it to requests for openrouter.ai; on the GM's laptop a wrapper reads it
 * from the keychain into OPENROUTER_API_KEY for the pipeline process only. So: send
 * the header when the variable is set, send none otherwise, and treat a 401 (not a
 * missing variable) as the error.
 *
 * The key's credit limit on OpenRouter is the hard budget. Before each batch the
 * pipeline asks for the remaining limit and stops if the batch's estimated cost
 * doesn't fit (BudgetGuard). Actual spend per stage goes into the provenance file.
 */

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export class OpenRouterError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class BudgetError extends Error {}

export interface KeyInfo {
  readonly label: string;
  /** Credit limit in dollars; null when the key has none (the pipeline refuses to run then). */
  readonly limit: number | null;
  readonly usage: number;
  readonly limitRemaining: number | null;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  /** JSON schema for structured output. */
  readonly schema?: { readonly name: string; readonly schema: object };
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Most drafting wants little or no reasoning. */
  readonly reasoning?: { readonly effort?: "low" | "medium" | "high"; readonly exclude?: boolean; readonly enabled?: boolean };
}

export interface ChatResult {
  readonly id: string;
  readonly model: string;
  readonly content: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Part of completionTokens spent on reasoning, when the model reports it. */
  readonly reasoningTokens: number;
  /** Dollars, as OpenRouter reports it for this call. */
  readonly cost: number;
}

export interface ClientOptions {
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Identifies the app on OpenRouter's side. */
  readonly title?: string;
}

export class OpenRouter {
  readonly #apiKey: string | undefined;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #title: string;

  constructor(options: ClientOptions = {}) {
    this.#apiKey = "apiKey" in options ? options.apiKey : process.env.OPENROUTER_API_KEY || undefined;
    this.#base = options.baseUrl ?? OPENROUTER_BASE;
    this.#fetch = options.fetch ?? fetch;
    this.#title = options.title ?? "Two to Tango bank pipeline";
  }

  async #request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "x-title": this.#title };
    if (this.#apiKey) headers.authorization = `Bearer ${this.#apiKey}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (res.status === 401) {
      throw new OpenRouterError(
        "OpenRouter refused the key (401). In a cloud session, check that openrouter.ai is a proxy-injected host; locally, run through the keychain wrapper.",
        401,
      );
    }
    if (!res.ok) throw new OpenRouterError(`OpenRouter ${method} ${path}: ${res.status} ${text.slice(0, 300)}`, res.status);
    return JSON.parse(text);
  }

  async keyInfo(): Promise<KeyInfo> {
    const { data } = (await this.#request("GET", "/key")) as {
      data: { label?: string; limit: number | null; usage: number; limit_remaining: number | null };
    };
    return { label: data.label ?? "", limit: data.limit, usage: data.usage, limitRemaining: data.limit_remaining };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      usage: { include: true },
    };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.reasoning !== undefined) body.reasoning = req.reasoning;
    if (req.schema !== undefined) {
      body.response_format = { type: "json_schema", json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema } };
    }
    const res = (await this.#request("POST", "/chat/completions", body)) as {
      id: string;
      model: string;
      choices: { message: { content: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    };
    return {
      id: res.id,
      model: res.model,
      content: res.choices[0]?.message.content ?? "",
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      reasoningTokens: res.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      cost: res.usage?.cost ?? 0,
    };
  }
}

/** Spend per stage and model, for the provenance file. */
export class SpendLedger {
  readonly #rows = new Map<string, { stage: string; model: string; calls: number; items: number; cost: number; promptTokens: number; completionTokens: number; reasoningTokens: number }>();

  record(stage: string, result: ChatResult, items: number): void {
    const k = `${stage}|${result.model}`;
    const row = this.#rows.get(k) ?? { stage, model: result.model, calls: 0, items: 0, cost: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
    row.calls++;
    row.items += items;
    row.cost += result.cost;
    row.promptTokens += result.promptTokens;
    row.completionTokens += result.completionTokens;
    row.reasoningTokens += result.reasoningTokens;
    this.#rows.set(k, row);
  }

  /** Measured dollars per item for a stage and model, or null before the first call. */
  costPerItem(stage: string, model: string): number | null {
    const row = [...this.#rows.values()].find((r) => r.stage === stage && r.model.startsWith(model));
    return row && row.items > 0 ? row.cost / row.items : null;
  }

  rows() {
    return [...this.#rows.values()].map((r) => ({ ...r, cost: Math.round(r.cost * 1e6) / 1e6 }));
  }

  total(): number {
    return [...this.#rows.values()].reduce((s, r) => s + r.cost, 0);
  }
}

/**
 * Stops a batch whose estimated cost doesn't fit the key's remaining limit. The
 * estimate is items × measured cost per item × a safety margin; before the first
 * call of a stage there is no measurement, so the caller passes a first guess.
 */
export class BudgetGuard {
  readonly client: Pick<OpenRouter, "keyInfo">;
  readonly margin: number;
  constructor(client: Pick<OpenRouter, "keyInfo">, margin = 1.5) {
    this.client = client;
    this.margin = margin;
  }

  async ensure(estimatedCost: number): Promise<KeyInfo> {
    const info = await this.client.keyInfo();
    if (info.limit === null || info.limitRemaining === null) {
      throw new BudgetError("the OpenRouter key has no credit limit; set one before running paid stages");
    }
    const needed = estimatedCost * this.margin;
    if (needed > info.limitRemaining) {
      throw new BudgetError(
        `batch needs about $${needed.toFixed(2)} (estimate $${estimatedCost.toFixed(2)} × ${this.margin}), ` +
          `$${info.limitRemaining.toFixed(2)} left of the $${info.limit.toFixed(2)} limit; ask the GM to raise the cap`,
      );
    }
    return info;
  }
}
