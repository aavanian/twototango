# Two to Tango

A same-room vocabulary game for teenagers, run by a parent as game master. See [docs/SPEC.md](docs/SPEC.md) for the product and [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for the technical plan.

## Development

```sh
scripts/setup.sh  # npm packages, Python venv, lexicons in data/
npm test          # vitest
npm run typecheck # tsc -b and svelte-check
npm run dev       # build with the dev bank, start the dev host on :5170
npm run e2e       # Playwright: whole games, one browser context per phone
npm run bank      # bank pipeline commands (lexicon, select, check, key)
```

With `npm run dev`, open `http://localhost:5170/gm` as the game master and the join address the lobby shows on other devices or browser windows. In a cloud session, run Playwright with `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium`.

| Folder | What |
| --- | --- |
| `packages/core` | Item schema, answer boxes, given letters, bank checks, game engine, item picker, per-role views, session and phone protocol |
| `apps/client` | Svelte UI: GM page (runs the session) and the player/spectator page |
| `apps/devhost` | Node stand-in for the Swift plugin: serves the client, relays phone WebSockets to the GM page |
| `e2e` | Playwright game tests against the dev host |
| `content` | Item banks |
| `docs` | Spec and implementation plan |
| `tools/bank` | Bank generation pipeline: lexicon import, word selection, checks, given-letter placement, OpenRouter client |
| `scripts` | Environment setup |

## Licenses

Code and content are licensed separately.

| Part | License | Covers |
| --- | --- | --- |
| Code | [AGPL-3.0-only](LICENSE) | Everything outside `content/`, including the bank generation scripts and prompts |
| Item banks | [CC BY-SA 4.0](content/LICENSE) | Everything inside `content/` |

The copyright holder reserves the right to distribute builds of the app through app stores, whose terms are generally seen as incompatible with the GPL family of licenses.

Outside contributions need a contributor agreement allowing app-store distribution. Until one exists, this repository doesn't accept outside code.
