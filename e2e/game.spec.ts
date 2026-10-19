// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/** One browser context per phone, all against the dev host, as in a real room. Each context starts with empty storage. */

interface Phone {
  context: BrowserContext;
  page: Page;
}

const open: BrowserContext[] = [];

// The dev host takes one GM page at a time, so every phone from a test goes away after it.
test.afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

async function phone(browser: Browser, url: string, locale = "en-US"): Promise<Phone> {
  const context = await browser.newContext({ locale, viewport: { width: 390, height: 844 } });
  open.push(context);
  const page = await context.newPage();
  await page.goto(url);
  return { context, page };
}

async function openLobby(browser: Browser, players: number, items: number, query = ""): Promise<{ gm: Phone; joinUrl: string }> {
  const gm = await phone(browser, `/gm${query}`);
  await gm.page.getByLabel("Players").selectOption(String(players));
  await gm.page.getByLabel("Items").selectOption(String(items));
  await gm.page.getByRole("button", { name: "Open the lobby" }).click();
  await expect(gm.page.getByTestId("join-url")).toHaveText(/\?code=[A-Z]{4}$/);
  const joinUrl = (await gm.page.getByTestId("join-url").textContent())!;
  return { gm, joinUrl };
}

async function join(browser: Browser, joinUrl: string, name: string, locale?: string): Promise<Phone> {
  const p = await phone(browser, joinUrl, locale);
  await p.page.locator("#name").fill(name);
  await p.page.locator("form button[type=submit]").click();
  await expect(p.page.getByTestId("lobby-players")).toContainText(name);
  return p;
}

/** Whose turn it is, read from the GM's banner ("Ana's turn"). */
async function turnOf(gm: Page): Promise<string> {
  const text = (await gm.getByTestId("banner").textContent())!;
  return text.match(/^\s*(.+?)'s turn/)![1]!;
}

const boxes = (p: Page) => p.getByTestId("boxes").locator(".box");

test("a full game: turns, pass, open race, reveal, undo, ranking on every phone", async ({ browser }) => {
  const { gm, joinUrl } = await openLobby(browser, 3, 6);
  const start = gm.page.getByRole("button", { name: "Start" });
  await expect(start).toBeDisabled();

  const phones: Record<string, Phone> = {
    Ana: await join(browser, joinUrl, "Ana"),
    Ben: await join(browser, joinUrl, "Ben"),
    Cy: await join(browser, joinUrl, "Cy", "fr-FR"),
  };
  const spectator = await phone(browser, joinUrl);
  await spectator.page.getByRole("button", { name: "Watch" }).click();
  await expect(spectator.page.getByRole("heading", { name: "Watching" })).toBeVisible();

  await expect(gm.page.getByTestId("gm-players")).toContainText("Cy");
  await start.click();

  const others = (name: string) => Object.entries(phones).filter(([n]) => n !== name);
  const everyone = () => [...Object.values(phones).map((p) => p.page), spectator.page];

  // Item 1: the player in turn gets it before opening (3 points).
  await expect(gm.page.getByTestId("item-number")).toHaveText("1 / 6");
  let turn = await turnOf(gm.page);
  const answer1 = (await gm.page.getByTestId("gm-answer").textContent())!;
  if (turn === "Cy") await expect(phones.Cy!.page.getByTestId("banner")).toContainText("À toi");
  else await expect(phones[turn]!.page.getByTestId("banner")).toContainText("Your turn");
  for (const [, p] of others(turn)) await expect(p.page.getByRole("button", { name: /Pass|Passer/ })).toHaveCount(0);
  // Nobody but the GM has the answer yet.
  for (const page of everyone()) {
    await expect(page.getByTestId("item-number")).toHaveText("1 / 6");
    expect(await page.content()).not.toContain(`>${answer1}<`);
  }
  await gm.page.getByRole("button", { name: `Correct (${turn})` }).click();
  for (const page of everyone()) {
    await expect(page.getByTestId("banner")).toContainText(`${turn} +3`);
    await expect(boxes(page)).toHaveText(answer1.split(""));
  }

  // Undo the mistap, then reveal with nobody scoring instead.
  await gm.page.getByRole("button", { name: "Undo" }).click();
  await expect(spectator.page.getByTestId("banner")).toContainText(`${turn}'s turn`);
  await expect(boxes(spectator.page).filter({ hasText: /^$/ })).not.toHaveCount(0);
  await gm.page.getByRole("button", { name: "Reveal" }).click();
  await expect(spectator.page.getByTestId("banner")).toContainText("No one scored");
  await gm.page.getByRole("button", { name: "Next" }).click();

  // Item 2: the player in turn passes, the GM opens it, someone else steals it (2 points).
  await expect(gm.page.getByTestId("item-number")).toHaveText("2 / 6");
  turn = await turnOf(gm.page);
  await phones[turn]!.page.getByRole("button", { name: /Pass|Passer/ }).click();
  await expect(gm.page.getByTestId("banner")).toContainText("passed");
  await gm.page.getByRole("button", { name: "Open to all" }).click();
  await expect(spectator.page.getByTestId("banner")).toContainText("Open to everyone");
  const [stealer] = others(turn)[0]!;
  await gm.page.getByRole("button", { name: stealer, exact: true }).click();
  await expect(spectator.page.getByTestId("banner")).toContainText(`${stealer} +2`);
  await gm.page.getByRole("button", { name: "Next" }).click();

  // Items 3 to 6: each player in turn solves their own.
  for (let n = 3; n <= 6; n++) {
    await expect(gm.page.getByTestId("item-number")).toHaveText(`${n} / 6`);
    turn = await turnOf(gm.page);
    await gm.page.getByRole("button", { name: `Correct (${turn})` }).click();
    await gm.page.getByRole("button", { name: n === 6 ? "Results" : "Next" }).click();
  }

  for (const page of [gm.page, ...everyone()]) {
    await expect(page.getByTestId("ranking").locator("li")).toHaveCount(3);
  }

  // Rematch keeps everyone connected and starts over at item 1.
  await gm.page.getByRole("button", { name: "Rematch" }).click();
  for (const page of [gm.page, ...everyone()]) await expect(page.getByTestId("item-number")).toHaveText("1 / 6");
});

test("refuses a wrong code, a taken name, and new players after start", async ({ browser }) => {
  const { gm, joinUrl } = await openLobby(browser, 2, 2);
  await join(browser, joinUrl, "Ana");

  const typo = await phone(browser, joinUrl.replace(/code=\w+/, "code=ZZZZ"));
  await typo.page.locator("#name").fill("Ben");
  await typo.page.locator("form button[type=submit]").click();
  await expect(typo.page.getByTestId("error")).toContainText("doesn't match");

  const twin = await phone(browser, joinUrl);
  await twin.page.locator("#name").fill("ana");
  await twin.page.locator("form button[type=submit]").click();
  await expect(twin.page.getByTestId("error")).toContainText("already has that name");

  await join(browser, joinUrl, "Ben");
  await gm.page.getByRole("button", { name: "Start" }).click();
  const late = await phone(browser, joinUrl);
  await late.page.locator("#name").fill("Cy");
  await late.page.locator("form button[type=submit]").click();
  await expect(late.page.getByTestId("error")).toContainText("already started");
});

test("the GM can lower p in the lobby when someone doesn't show up", async ({ browser }) => {
  const { gm, joinUrl } = await openLobby(browser, 3, 6);
  await join(browser, joinUrl, "Ana");
  await join(browser, joinUrl, "Ben");
  await expect(gm.page.getByRole("button", { name: "Start" })).toBeDisabled();
  await gm.page.getByLabel("Players").selectOption("2");
  await expect(gm.page.getByLabel("Items")).toHaveValue("6");
  await gm.page.getByRole("button", { name: "Start" }).click();
  await expect(gm.page.getByTestId("item-number")).toHaveText("1 / 6");
});

test("the GM page reloads mid-game: phones reconnect and pick up where they were", async ({ browser }) => {
  const { gm, joinUrl } = await openLobby(browser, 2, 4);
  const ana = await join(browser, joinUrl, "Ana");
  const ben = await join(browser, joinUrl, "Ben");
  await gm.page.getByRole("button", { name: "Start" }).click();
  await gm.page.getByRole("button", { name: "Open to all" }).click();
  await expect(ana.page.getByTestId("banner")).toContainText("Open to everyone");

  // Each context has its own storage, so the GM's saved game is there after the reload.
  await gm.page.reload();
  await expect(ben.page.getByTestId("banner")).toContainText("Open to everyone");
  await expect(ana.page.getByTestId("paused")).toHaveCount(0);
  await expect(gm.page.getByRole("button", { name: "Ana", exact: true })).toBeVisible();

  // A player's phone reloads: no name asked, same seat.
  await ana.page.reload();
  await expect(ana.page.getByTestId("banner")).toContainText("Open to everyone");
  await expect(ana.page.locator("#name")).toHaveCount(0);
});

test("a dropped player's item goes to the next player; they take back the rest on return", async ({ browser }) => {
  const { gm, joinUrl } = await openLobby(browser, 2, 4, "?grace=500");
  const ana = await join(browser, joinUrl, "Ana");
  const ben = await join(browser, joinUrl, "Ben");
  const phones: Record<string, Phone> = { Ana: ana, Ben: ben };
  await gm.page.getByRole("button", { name: "Start" }).click();

  const first = await turnOf(gm.page);
  const second = first === "Ana" ? "Ben" : "Ana";
  // The second player's phone goes away for good during item 1.
  await phones[second]!.context.close();
  await gm.page.getByRole("button", { name: "Reveal" }).click();
  await gm.page.waitForTimeout(1000);
  await gm.page.getByRole("button", { name: "Next" }).click();
  // Item 2 was theirs; it goes to the next present player.
  expect(await turnOf(gm.page)).toBe(first);

  // They come back on a new phone under the same name and get item 4.
  await gm.page.getByRole("button", { name: "Reveal" }).click();
  await gm.page.getByRole("button", { name: "Next" }).click();
  const back = await phone(browser, joinUrl);
  await back.page.locator("#name").fill(second);
  await back.page.locator("form button[type=submit]").click();
  await expect(back.page.getByTestId("item-number")).toHaveText("3 / 4");
  await gm.page.getByRole("button", { name: "Reveal" }).click();
  await gm.page.getByRole("button", { name: "Next" }).click();
  await expect(back.page.getByTestId("banner")).toContainText("Your turn");
});

test("players' phones load only the player page, never the GM code or the banks", async ({ browser }) => {
  const { joinUrl } = await openLobby(browser, 2, 2);
  const context = await browser.newContext();
  open.push(context);
  const page = await context.newPage();
  const scripts: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "script") scripts.push(new URL(r.url()).pathname);
  });
  await page.goto(joinUrl);
  await expect(page.locator("#name")).toBeVisible();
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter((s) => /GmApp|native|dev-bank/.test(s))).toEqual([]);
});
