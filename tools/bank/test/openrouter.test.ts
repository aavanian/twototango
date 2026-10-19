// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { BudgetError, BudgetGuard, OpenRouter, OpenRouterError, SpendLedger } from "../src/openrouter.ts";

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const keyBody = { data: { label: "pipeline", limit: 10, usage: 2.5, limit_remaining: 7.5 } };

describe("OpenRouter", () => {
  it("sends no authorization header without a key: the proxy adds it", async () => {
    const f = fakeFetch(200, keyBody);
    const info = await new OpenRouter({ apiKey: undefined, fetch: f.fn }).keyInfo();
    expect(info).toEqual({ label: "pipeline", limit: 10, usage: 2.5, limitRemaining: 7.5 });
    expect(f.calls[0]!.url).toBe("https://openrouter.ai/api/v1/key");
    expect(new Headers(f.calls[0]!.init.headers).has("authorization")).toBe(false);
  });

  it("sends the key from the wrapper when given", async () => {
    const f = fakeFetch(200, keyBody);
    await new OpenRouter({ apiKey: "sk-or-test", fetch: f.fn }).keyInfo();
    expect(new Headers(f.calls[0]!.init.headers).get("authorization")).toBe("Bearer sk-or-test");
  });

  it("turns a 401 into an explanation", async () => {
    const f = fakeFetch(401, { error: "no auth" });
    await expect(new OpenRouter({ apiKey: undefined, fetch: f.fn }).keyInfo()).rejects.toThrow(/proxy-injected|keychain/);
  });

  it("asks for structured output and reports cost", async () => {
    const f = fakeFetch(200, {
      id: "gen-1",
      model: "some/model",
      choices: [{ message: { content: '{"items":[]}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0004 },
    });
    const result = await new OpenRouter({ apiKey: undefined, fetch: f.fn }).chat({
      model: "some/model",
      messages: [{ role: "user", content: "hi" }],
      schema: { name: "items", schema: { type: "object" } },
      reasoning: { enabled: false },
      maxTokens: 500,
    });
    expect(result).toMatchObject({ content: '{"items":[]}', promptTokens: 100, completionTokens: 20, cost: 0.0004 });
    const sent = JSON.parse(String(f.calls[0]!.init.body));
    expect(sent).toMatchObject({ usage: { include: true }, max_tokens: 500, reasoning: { enabled: false } });
    expect(sent.response_format.json_schema).toMatchObject({ name: "items", strict: true });
  });

  it("reports other errors with the status", async () => {
    const f = fakeFetch(402, { error: "insufficient credits" });
    const err = await new OpenRouter({ apiKey: undefined, fetch: f.fn }).keyInfo().catch((e) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(err.status).toBe(402);
  });
});

describe("BudgetGuard", () => {
  const client = (limit: number | null, remaining: number | null) => ({
    keyInfo: async () => ({ label: "", limit, usage: 0, limitRemaining: remaining }),
  });

  it("lets a batch through when the estimate with margin fits", async () => {
    await expect(new BudgetGuard(client(10, 7.5)).ensure(4)).resolves.toMatchObject({ limitRemaining: 7.5 });
  });

  it("stops a batch that doesn't fit, and a key without a limit", async () => {
    await expect(new BudgetGuard(client(10, 7.5)).ensure(6)).rejects.toThrow(BudgetError);
    await expect(new BudgetGuard(client(null, null)).ensure(0.01)).rejects.toThrow(/no credit limit/);
  });
});

describe("SpendLedger", () => {
  it("measures cost per item by stage and model", () => {
    const ledger = new SpendLedger();
    const call = { id: "x", model: "m/a", content: "", promptTokens: 10, completionTokens: 5, cost: 0.02 };
    ledger.record("draft", call, 10);
    ledger.record("draft", call, 10);
    expect(ledger.costPerItem("draft", "m/a")).toBeCloseTo(0.002);
    expect(ledger.costPerItem("solve", "m/a")).toBeNull();
    expect(ledger.total()).toBeCloseTo(0.04);
  });
});
