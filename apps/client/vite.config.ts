// SPDX-License-Identifier: AGPL-3.0-only

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  build: {
    target: "es2022",
    // The GM chunk carries the banks; it loads from the app bundle, never over the network.
    chunkSizeWarningLimit: 1500,
  },
  server: { fs: { allow: ["../.."] } },
});
