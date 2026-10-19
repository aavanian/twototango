// SPDX-License-Identifier: AGPL-3.0-only

import { Bank, type Item } from "@twototango/core";

/** Real banks from content/<lang>/<level>.json, plus the dev bank when built with VITE_DEV_BANK=1. */
const files = import.meta.glob<unknown>("../../../content/*/*.json", { eager: true, import: "default" });

export async function loadItems(): Promise<Map<string, Item>> {
  const banks = Object.values(files).map((raw) => Bank.parse(raw));
  if (import.meta.env.VITE_DEV_BANK === "1") {
    const { devBanks } = await import("@twototango/core/dev-bank");
    const have = new Set(banks.map((b) => `${b.lang}/${b.level}`));
    banks.push(...devBanks.filter((b) => !have.has(`${b.lang}/${b.level}`)));
  }
  return new Map(banks.flatMap((b) => b.items).map((i) => [i.id, i]));
}
