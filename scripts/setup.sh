#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Installs everything a session needs: npm packages, the bank pipeline's Python
# packages (.venv) and the lexicons (data/). Safe to rerun: each step is skipped
# when its inputs haven't changed.
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

echo "setup ok"
