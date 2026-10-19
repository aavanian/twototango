// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from "svelte";
import "./app.css";
import { isNative, loadPlatform } from "./host/platform.ts";
import { uiLang } from "./i18n.ts";
import PlayerApp from "./ui/PlayerApp.svelte";

document.documentElement.lang = uiLang;
const target = document.getElementById("app")!;
// The GM page runs the session; on the iPhone it is the app itself, in dev it is /gm.
// It loads on its own, with the banks, so players' phones never download them.
if (isNative() || location.pathname.startsWith("/gm")) {
  const [{ default: GmApp }, platform] = await Promise.all([import("./ui/GmApp.svelte"), loadPlatform()]);
  mount(GmApp, { target, props: { platform } });
} else {
  mount(PlayerApp, { target });
}
