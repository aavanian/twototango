// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from "vitest";
import { devBanks } from "../fixtures/dev-bank.ts";
import { checkBanks } from "../src/index.ts";

it("the dev bank passes the bank checks", () => {
  expect(checkBanks(devBanks)).toEqual([]);
});
