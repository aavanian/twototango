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
| English spelling | British (colour, organise, centre, catalogue, defence, travelled), and British vocabulary where it differs (lift, flat). Settled 19 Oct 2026. The prompt asks for it, word selection drops American forms whose British spelling the lexicon knows, and the checks fail an American answer. |
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
| Language | TypeScript everywhere: app, engine, bank pipeline. Swift only for the native plugin; Python only for the lexicon import (see Environments). |
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

### Engine

- `packages/core/src/engine.ts`: `apply(state, event)` is the whole game; `replay(log)` rebuilds the state on resume. Events are zod-validated so a saved log can be read back safely.
- Randomness never happens inside the reducer. The caller draws the items (`pickItems`) and the turn order (`drawOrder`) with an injected RNG and records them in the `configure`, `start` and `rematch` events.
- Undo is one level deep: a scoring decision (`correct` or `reveal`) remembers whether the item was shown or open, and `undo` puts it back there. `next` forgets it.
- Dropouts are `leave` and `return` events. When an item comes up, it goes to its owner if present, else to the next present player in turn order. The transport decides when a lost connection counts as a `leave` (a grace period keeps a briefly locked phone from losing its turn).
- An item counts as played for the history once it has come up, solved or not. The ranking covers decided items only.
- `viewFor(state, items, viewer)` builds what each phone is sent. Player and spectator views carry no answer, lemma, alternates or gloss; letters reach them only in the cells, once revealed.
- Item count options run from p to 30 in steps of p.

### Session and dev host

- The GM page runs the game: `Session` (`packages/core/src/session.ts`) holds the event log, maps each phone's token to a player or spectator, and sends every connection its view after each change. The host underneath only moves messages: the Swift plugin on the iPhone, `apps/devhost` on a desktop. Neither holds game state.
- Phones keep a random token in local storage and send it on every connection, so a reload or a locked phone comes back in the same seat without asking for the name. A player on a new phone takes their seat back by typing the same name, but only while the old seat is marked away.
- The join code in the QR link is checked on join and watch. A wrong code, a taken name and a new name after start each get their own error.
- A player whose phone is gone for 20 seconds is marked away (`leave`). An item that comes up meanwhile goes to the next player in turn.
- The dev host takes one GM page at a time. When it goes away, every phone is disconnected and retries each second until the GM page is back, as when the GM app is killed on the iPhone.
- The GM page saves the session snapshot (log, code, tokens) and the play history to local storage in dev; the iOS shell will use the plugin's file store. A snapshot that no longer replays (for example, items removed from the build) is discarded with a notice.
- A hand-written dev bank (30 English and 15 French C1 items, `packages/core/fixtures/dev-bank.ts`) stands in until the real banks exist. It is bundled only in builds made with `VITE_DEV_BANK=1` (`npm run dev`, `npm run e2e`), and only for languages and levels with no real bank.

## Bank generation

Budget target: tens of dollars of API spend, not hundreds. The expensive checks move into code and human review; cheap models do the bulk.

### Stages

1. **Word selection (code).** Candidate answers per language and level from `wordfreq` frequency bands, restricted to nouns, verbs and adjectives, then screened by a model for a common synonym, teen suitability, no jargon, and level fit. Duplicate lemmas and shared roots removed. About 800 candidates per language and level, to end with 600. Part-of-speech mix set up front (starting point 40% nouns, 35% verbs, 25% adjectives); 1 in 5 marked for definition items.
2. **Pilot (Claude Code, subscription).** Write the prompts, generate about 50 C1 items per language in-session, GM rates them. Those ratings become the fixed test set for everything after.
3. **Bake-off (OpenRouter).** Three or four cheap models generate the same 50 words. Score each by the code checks plus the GM accept rate; keep the cheapest acceptable one.
4. **Bulk drafting.** About 10 words per call, short structured JSON output, little or no reasoning. French prompts written in French. Sample sheets serve only as format examples; none of their text ships.
5. **Deterministic checks (code).** Schema; fits the boxes; answer exists as a word form in the lexicon; substitution rebuilt mechanically with elision; shared roots (stemming plus common-substring threshold); given-letter placement (the words matching the letter pattern, meaning not considered, only measure how telling the letters are and are never shown to reviewers); profanity list; near-duplicate sentences.
6. **Blind solve (cheap model).** The model sees the item without the answer and lists every word that fits. A valid unlisted word becomes an alternate or fails the item.
7. **Escalation.** Flagged items (expected around 15%) go to a Claude Code review session or a stronger model on OpenRouter, with one repair round. A second failure is discarded.
8. **Human review (Grist).** Flagged items plus a random 10% of passes go into a Grist doc; the GM accepts, rejects or comments from their phone and the pipeline reads the decisions back. A sample rejection rate above about 5% means fix the prompts and rerun, not patch items.
9. **Freeze.** Write the bank JSON and a provenance file (prompt version, models used, check results).

### What exists (before the pilot)

Built 16 Oct 2026; nothing here has spent API credit.

- **Lexicon import** (`tools/bank/lexicon/import_lexicon.py`, run by `scripts/setup.sh`): writes `data/lex/<lang>-forms.tsv` (form, lemma, part of speech, zipf, lemma zipf, gender, number, root) and `<lang>-synonyms.tsv`. English forms come from wordfreq's list lemmatized by lemminflect; French forms from Lexique 3.83, which writes œ as "oe" (the import restores œ where wordfreq shows it is the usual spelling). Roots are Snowball stems, or Lexique's derivational base when it has one (peureux → peur). Synonyms: WordNet 3.0 for English; for French, WOLF through Open Multilingual Wordnet 1.4, which is noisy and only used to flag.
- **Word selection** (`npm run bank -- select --lang en`): lemmas in a zipf band per level, 4 to 14 letters, with at least one same-part-of-speech synonym at least 0.3 zipf more frequent (the easier clue) that doesn't share its root. One lemma per root across all levels. 800 per level in the 40/35/25 mix, one in five marked for a definition. Output in `tools/bank/work/` (not committed; regenerated in seconds). The bands (B2 3.3–4.1, C1 2.7–3.3, C2 2.0–2.7) are a first guess to tune on the pilot ratings. French C2 runs short (225 of 280 verbs, 174 of 200 adjectives): the band widens or the level gets fewer items. The model screen is not built yet, and the lists still contain words it must drop (cadmium, knickers, keuf).
- **Deterministic checks** (`npm run bank -- check <items.json>`): core's item checks; the answer is a lexicon form of its lemma and part of speech; shared roots through the stems, against the span or definition and the fixed words; unaccepted synonyms that fit the boxes; profanity (vendored LDNOOBW lists plus `extra-<lang>`); near-duplicate prompts. It rebuilds the sentence with the answer in place, adapting only the article and the elision before the span, and lists the plausible words that also fit the boxes for the blind solve.
- **Given-letter placement**: for items without given letters, the check places them. Usable placements rule out every unaccepted synonym form of the answer's shape; among them B2 takes the most telling letters (fewest plausible words fit), C2 the least telling, C1 the middle.
- **OpenRouter client** (`tools/bank/src/openrouter.ts`): bearer header only when `OPENROUTER_API_KEY` is set, a 401 explained, structured JSON output, cost per call, a spend ledger per stage and model, and a budget guard that reads `/api/v1/key` before each batch. Node's built-in fetch ignores `HTTPS_PROXY`, so `npm run bank` sets `NODE_USE_ENV_PROXY=1`. `npm run bank -- key` reads the limit for free.

### Pilot (English C1)

Started 19 Oct 2026, in a Claude Code session; no API spend.

- **Words**: 50 from the C1 candidates, screened by hand in the session (20 nouns, 18 verbs, 12 adjectives; 10 definitions). Dropped from the pool: junk the screen must catch (cadmium, knickers), words with a UK/US spelling split (fervour, odour) while the convention was open, and words already in the dev bank.
- **Prompt**: `tools/bank/prompts/en/draft.md` (en-draft v1). The same text goes to the bake-off models. The model writes the sentence or definition, the answer form, acceptable synonyms and near misses; it never chooses ids or given letters.
- **Drafts to items**: `npm run bank -- finalize` assigns ids and places the given letters. Placement first tries to rule out every synonym, acceptable ones included (the bank rule); only when no placement can, the acceptable words that still fit become alternates. All 50 placed without alternates.
- **Files**: `content/pilot/en-c1.drafts.json` (drafts), `en-c1.json` (items), `en-c1.report.json` (check results). The app only loads `content/<lang>/<level>.json`, so pilot files never ship by accident.
- **Ratings**: Grist doc "Two to Tango – pilot ratings (EN C1)", table Pilot: verdict (good / fix / reject), difficulty (too easy / right / too hard), problem tags and a comment per item. The ratings become the fixed test set for the bake-off.
- **Spelling**: British, decided during the pilot; the prompt is now en-draft v2. The pilot items already used British spelling.
- **Ratings (19 Oct 2026)**: all 50 good; difficulty right for 45, too easy for 3 (hunch, nuance, abstain), too hard for 2 (bequest, curtail). Frequency doesn't explain the five (the too easy ones sit at zipf 3.07–3.09, ardent at 3.28 rated right), so the C1 band stays at 2.7–3.3. Saved as `content/pilot/en-c1.ratings.json`, the bake-off's test set.
- **"Also fits" was a mistake to show**: the review sheet listed words matching the letter pattern regardless of meaning (affront: affairs, alfalfa), and the GM rightly found them nonsense. They now carry the name `patternMatches` and stay internal. Words that really fit an item come from the blind solve.
- **Found while writing**: one draft had a span that doesn't take the answer's preposition ("hinted to" for "alluded to"). The deterministic checks can't see this; the blind solve or a grammar pass has to.

### Staging

C1 for both languages first (the sample sheets' level), then B2 and C2, so play starts early and review lessons improve the later levels.

## Environments

- **Cloud sessions** (claude.ai/code): engine, UI, dev host, Playwright tests, bank pipeline. The environment needs:
  - Network: "Allow package managers" plus `openrouter.ai`, `lexique.org` and the GitHub domains (`github.com`, `api.github.com`, `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`). Optional: documentation sites. `www.lexique.org` stays blocked; the download link on the bare domain is enough.
  - OpenRouter: the proxy injects the key on requests to `openrouter.ai`, so no `OPENROUTER_API_KEY` is set in the session (see [API key](#api-key) and [Spend cap](#spend-cap)).
  - No environment setup script. The repo's SessionStart hook (`.claude/settings.json`) runs `scripts/setup.sh`, which installs npm packages, the pipeline's Python packages in `.venv` (`tools/bank/requirements.txt`) and the lexicons in `data/` (Lexique 3.83, WordNet 3.0, Open Multilingual Wordnet 1.4), each pinned by checksum, then builds the plain lexicon files in `data/lex/`. It skips anything already installed. The hook runs on startup and resume, not after compaction or `/clear`; its log is `/tmp/twototango-setup.log`, and on failure the hook prints the log's last lines into the session.
- **Bank pipeline languages.** TypeScript, except the lexicon import, which is Python: `wordfreq`, `lemminflect` and the NLTK WordNet reader exist only as Python packages. The import writes plain lexicon files that the TypeScript stages read.
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

1. `packages/core`: item schema, box layout, given-letter enumeration, pattern matching. *(done)*
2. Engine: setup, lobby, turn order, item states, scoring, undo, dropouts, history picker. *(done)*
3. Dev host and client UI (GM, player, spectator views), Playwright game tests. *(done)*
4. Bank pipeline: lexicon import, checks, pilot, bake-off, C1 batches, Grist review. *(started: everything up to the pilot)*
5. Capacitor shell and Swift plugin, TestFlight build.
6. B2 and C2 banks.
