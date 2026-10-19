// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from "svelte";
import "./app.css";
import { uiLang } from "./i18n.ts";
import GmApp from "./ui/GmApp.svelte";
import PlayerApp from "./ui/PlayerApp.svelte";

document.documentElement.lang = uiLang;
const target = document.getElementById("app")!;
// The GM page runs the session; on the iPhone it is the app itself, in dev it is /gm.
if (location.pathname.startsWith("/gm")) mount(GmApp, { target });
else mount(PlayerApp, { target });
