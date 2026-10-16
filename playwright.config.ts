// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "@playwright/test";

const port = 5199;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node apps/devhost/src/main.ts",
    env: { PORT: String(port), JOIN_HOST: "localhost" },
    url: `http://localhost:${port}/`,
    reuseExistingServer: false,
  },
});
