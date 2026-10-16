# Two to Tango — Implementation Plan

Oct 16, 2026 · companion to [SPEC.md](SPEC.md)

This records the technical choices and the spec clarifications agreed with the GM. Where it refines the spec, this document wins until the spec is updated.

## Spec clarifications

Settled on 16 Oct 2026.

| Topic | Decision |
| --- | --- |
| Articles and agreement | The span is generated with its article ("une grande peur"). On display the article is pulled out of the underline and stays in the sentence as written. Players accept that it may change with the answer. Substitution checks allow the article and elision next to the span to adapt, nothing else. Prompts avoid agreeing adjectives between the article and the noun. |
| Level | The CEFR level is the level of the answer. The span is the clue and should be easier. |
| Lemma | Every item stores the answer's lemma. A lemma appears at most once per language, across all levels. |
| Gloss | Dropped for v1. The field stays optional in the schema; when it comes back it will be a Japanese gloss. |
| Given letters | Computed by code, never by the LLM. The count is fixed at about a third; which letters are given is the difficulty knob (see below). |
| Dropped player | Their items are reassigned lazily, as each one comes up. A rejoining player takes back every item not yet reassigned. |
| Undo | Restores the state before the last scoring decision (a mistap). |
| Default item count | The multiple of p closest to 15. On a tie (p = 2: 14/16; p = 6: 12/18) take the lower one. |
| Exactly p to start | The GM can change p from the lobby. |
| Japanese UI | Interface strings in English, French and Japanese ship in v1. |
| GM interruptions | The GM phone keeps the screen awake during a game and saves the game state to disk after every action, so the game resumes after a call, a kill or a crash. |

## Architecture

### Connection: the GM phone hosts, players join in a browser

- The GM app runs an HTTP and WebSocket server on the local network and advertises itself over Bonjour (`<name>.local`).
- The lobby shows a QR code for `http://<name>.local:<port>/?code=XXXX` and the same short address in text for anyone who prefers to type it.
- Scanning opens the link in the phone's default browser. Any iOS browser works: Safari, Orion, Chrome. Players and spectators install nothing.
- To test on the players' phones: some browsers ask once for local-network permission, and an "HTTPS only" setting may refuse the page. If that bites, players install the same app (TestFlight) and join through it; the player screen is the same web page either way.
- If the home Wi-Fi isolates clients (common on guest networks), the GM turns on their personal hotspot.
- The GM app is the only source of truth. Other phones render what it broadcasts and send intents (join, pass).

Rejected for v1: native peer-to-peer (Multipeer Connectivity) on every phone. It is slicker but forces every player to install the app and puts all code in Swift.

### Stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript everywhere: app, engine, bank pipeline. Swift only for the native plugin; Python only for the `wordfreq` export in the pipeline. |
| Packages | npm workspaces. `packages/core` (schema, boxes, engine), later `apps/client` (UI), `apps/ios` (Capacitor shell), `tools/bank` (pipeline). |
| UI | Svelte 5 + Vite. The GM phone serves the bundle, so small matters. |
| Engine | Pure state machine with an event log. Undo, resume-from-disk and replay come from the log. |
| GM shell | Capacitor, with a small Swift plugin: Network.framework listener (HTTP + WebSocket), Bonjour, `AVSpeechSynthesizer` warmed at game start, keep-awake, file store for history and game snapshots. |
| Dev host | A Node implementation of the same transport interface, so whole games run in desktop browsers without an iPhone. |
| Tests | Vitest for the engine and box logic. Playwright with one browser context per phone, playing full games against the dev host. |
| Content | `content/<lang>/<level>.json`, validated by the zod schema in `packages/core`. Stable item ids (play history depends on them). |
| Distribution | TestFlight on the GM's Apple developer account; App Store later. |

### Boxes

- Answers are stored lowercase in NFC and split into grapheme clusters with `Intl.Segmenter`.
- Each letter is one box: accented letters keep their accent; œ and æ are one box.
- Hyphens and apostrophes are fixed marks between boxes (French only). English answers are letters only.
- A word matches a box pattern only if it has the same cells and the same given letters, accents included.

### Given letters

- Count: `round(L / 3)` letters for a word of L letters, at least 1, never all. No two given letters adjacent.
- Placement: the pipeline enumerates every valid placement and, for each, counts the lexicon words that fit the pattern. It keeps only placements that rule out the plausible-but-unaccepted synonyms, then picks by informativeness for the level: first letters and rare letters for B2, the least telling letters that still disambiguate for C2.
- `packages/core` provides the enumeration and pattern matching; scoring lives in the pipeline because it needs the lexicon.

## Bank generation

Budget target: tens of dollars of API spend, not hundreds. The expensive checks move into code and human review; cheap models do the bulk.

### Stages

1. **Word selection (code).** Candidate answers per language and level from `wordfreq` frequency bands (see [Python step](#python-step)), restricted to nouns, verbs and adjectives, then screened by a model for a common synonym, teen suitability, no jargon, and level fit. Duplicate lemmas and shared roots removed. About 800 candidates per language and level, to end with 600. Part-of-speech mix set up front (starting point 40% nouns, 35% verbs, 25% adjectives); 1 in 5 marked for definition items.
2. **Pilot (Claude Code, subscription).** Write the prompts, generate about 50 C1 items per language in-session, GM rates them. Those ratings become the fixed test set for everything after.
3. **Bake-off (OpenRouter).** Three or four cheap models generate the same 50 words. Score each by the code checks plus the GM accept rate; keep the cheapest acceptable one.
4. **Bulk drafting.** About 10 words per call, short structured JSON output, little or no reasoning. French prompts written in French. Sample sheets serve only as format examples; none of their text ships.
5. **Deterministic checks (code).** Schema; fits the boxes; answer exists as a word form in the lexicon; substitution rebuilt mechanically with elision; shared roots (stemming plus common-substring threshold); given-letter placement and the list of other words fitting the pattern; profanity list; near-duplicate sentences.
6. **Blind solve (cheap model).** The model sees the item without the answer and lists every word that fits. A valid unlisted word becomes an alternate or fails the item.
7. **Escalation.** Flagged items (expected around 15%) go to a Claude Code review session or a stronger model on OpenRouter, with one repair round. A second failure is discarded.
8. **Human review (Grist).** Flagged items plus a random 10% of passes go into a Grist doc; the GM accepts, rejects or comments from their phone and the pipeline reads the decisions back. A sample rejection rate above about 5% means fix the prompts and rerun, not patch items.
9. **Freeze.** Write the bank JSON and a provenance file (prompt version, models used, check results).

### Python step

`wordfreq` is a Python library. A small script in `tools/bank` exports the frequency bands per language to JSON, and the TypeScript pipeline reads that file. This is the only Python in the repo. Its dependencies are pinned in `tools/bank/requirements.txt`, and the SessionStart hook will `pip install` them once that file exists.

### Staging

C1 for both languages first (the sample sheets' level), then B2 and C2, so play starts early and review lessons improve the later levels.

## Environments

- **Cloud sessions** (claude.ai/code): engine, UI, dev host, Playwright tests, bank pipeline. The environment needs:
  - Network: "Allow package managers" plus `openrouter.ai` and the GitHub domains (`github.com`, `api.github.com`, `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`). Optional: `lexique.org`, documentation sites.
  - OpenRouter connected as a proxy credential, not as an environment variable (see [API key](#api-key)).
  - Dependencies install through the repo's SessionStart hook (`.claude/settings.json`, script in `.claude/hooks/`). It runs on session startup and resume, prints nothing on success, and on failure prints the tail of its log into the session.
- **The GM's Mac**: the Swift plugin, Xcode, signing, TestFlight and device tests, via Claude Desktop or `claude remote-control`.

### API key

The OpenRouter key never sits in an environment variable or a file the session can read, because anything there can end up in a transcript.

- **Cloud session:** the agent proxy adds the key to requests for `openrouter.ai`. The session sees no key.
- **GM's laptop:** the key lives in the macOS keychain. A wrapper script reads it and passes it to the pipeline process only, so a Claude Code session started from the same shell never inherits it.
- **Pipeline client:** sends `Authorization: Bearer $OPENROUTER_API_KEY` when that variable is set (the laptop wrapper) and no header otherwise (the proxy fills it in). A missing key is not an error at startup; a 401 from OpenRouter is.

### Spend cap

The key's credit limit on OpenRouter is the hard budget; the pipeline never relies on its own accounting alone.

1. Bake-off starts with one model under a small cap (currently $10). Its run gives the cost per item.
2. The GM raises the cap once to finish the bake-off.
3. The GM raises it once more for the bulk run, sized from the winning model's cost per item.

Before each batch the pipeline reads `GET /api/v1/key`, estimates the batch cost from the measured cost per item, and stops if the estimate exceeds `limit_remaining`. Actual spend per stage goes into the provenance file.

## Roadmap

1. `packages/core`: item schema, box layout, given-letter enumeration, pattern matching. *(started)*
2. Engine: setup, lobby, turn order, item states, scoring, undo, dropouts, history picker.
3. Dev host and client UI (GM, player, spectator views), Playwright game tests.
4. Bank pipeline: lexicon import, checks, pilot, bake-off, C1 batches, Grist review.
5. Capacitor shell and Swift plugin, TestFlight build.
6. B2 and C2 banks.
