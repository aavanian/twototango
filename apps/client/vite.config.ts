// SPDX-License-Identifier: AGPL-3.0-only

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  build: { target: "es2022" },
  server: { fs: { allow: ["../.."] } },
});
