#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Installs everything a session needs: npm packages, the bank pipeline's Python
# packages (.venv), the lexicons (data/) and the plain lexicon files built from
# them (data/lex/). Safe to rerun: each step is skipped when its inputs haven't changed.
set -euo pipefail
cd "$(dirname "$0")/.."

stamp() { sha256sum "$@" | sha256sum | cut -d' ' -f1; }

# npm
if [ "$(cat node_modules/.setup-stamp 2>/dev/null)" != "$(stamp package-lock.json)" ]; then
  npm ci --no-audit --no-fund
  stamp package-lock.json > node_modules/.setup-stamp
fi

# Python
if [ "$(cat .venv/.setup-stamp 2>/dev/null)" != "$(stamp tools/bank/requirements.txt)" ]; then
  rm -rf .venv
  python3 -m venv .venv
  .venv/bin/pip install --quiet --disable-pip-version-check -r tools/bank/requirements.txt
  stamp tools/bank/requirements.txt > .venv/.setup-stamp
fi

# Lexicons: fetch a pinned zip, check its hash, unzip.
fetch() { # url sha256 dir
  local url=$1 sum=$2 dir=$3 zip
  zip="$dir/$(basename "$url")"
  if [ -f "$zip" ] && echo "$sum  $zip" | sha256sum -c --status; then return; fi
  mkdir -p "$dir"
  curl -fsSL --retry 3 -o "$zip.part" "$url"
  echo "$sum  $zip.part" | sha256sum -c --status || { echo "checksum mismatch: $url" >&2; rm -f "$zip.part"; exit 1; }
  mv "$zip.part" "$zip"
  unzip -q -o "$zip" -d "$dir"
}

# Lexique 3.83 (CC BY-SA 4.0). The bare domain serves the file; www.lexique.org is not needed.
fetch https://lexique.org/databases/Lexique383/Lexique383.zip \
  e181d132b3b0d3d87efc98d376968441b517353933011cebea5366321a6024e6 data/lexique
# Princeton WordNet 3.0, laid out as NLTK expects: NLTK_DATA=data/nltk_data
fetch https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip \
  cbda5ea6eef7f36a97a43d4a75f85e07fccbb4f23657d27b4ccbc93e2646ab59 data/nltk_data/corpora

# Open Multilingual Wordnet 1.4: French synonyms (WOLF, CeCILL-C), read straight from its tab file.
fetch https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/omw-1.4.zip \
  3b941e664852f3297b6040236626065796a2aaf7d7f9eec8779a3beaa1096c2d data/nltk_data/corpora

# Plain lexicon files for the TypeScript stages, rebuilt when the import script changes.
lex_inputs=(tools/bank/lexicon/import_lexicon.py tools/bank/requirements.txt data/lexique/Lexique383.zip \
  data/nltk_data/corpora/wordnet.zip data/nltk_data/corpora/omw-1.4.zip)
if [ "$(cat data/lex/.setup-stamp 2>/dev/null)" != "$(stamp "${lex_inputs[@]}")" ]; then
  .venv/bin/python tools/bank/lexicon/import_lexicon.py
  stamp "${lex_inputs[@]}" > data/lex/.setup-stamp
fi

echo "setup ok"
