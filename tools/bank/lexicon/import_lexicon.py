# SPDX-License-Identifier: AGPL-3.0-only
"""Lexicon import: the pipeline's only Python step.

wordfreq, lemminflect and the WordNet readers exist only in Python, so this script
turns them into plain TSV files that the TypeScript stages read:

  data/lex/<lang>-forms.tsv     form, lemma, pos, zipf, lemma_zipf, gender, number, root
  data/lex/<lang>-synonyms.tsv  lemma, pos, synonyms (comma-separated lemmas)
  data/lex/meta.json            sources and versions

pos is noun, verb, adjective or other. zipf is wordfreq's log scale (about 1 for
very rare words, 7 for "the"). root is the lemma's Snowball stem, or for French
the base Lexique gives in its derivational analysis (peureux: peur-eux → peur)
when it has one. Sources:
  English forms: wordfreq's large list, lemmatized with lemminflect.
  French forms: Lexique 3.83, with œ restored where wordfreq says it is the usual spelling.
  English synonyms: Princeton WordNet 3.0. French synonyms: WOLF via OMW 1.4 (noisy; flags only).

Run from the repo root: .venv/bin/python tools/bank/lexicon/import_lexicon.py
"""

from __future__ import annotations

import csv
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

import lemminflect
import nltk
import wordfreq
from lemminflect import getAllLemmas
from nltk.stem.snowball import SnowballStemmer
from wordfreq import top_n_list, zipf_frequency

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / "data"
OUT = DATA / "lex"

EN_FORMS = 150_000
POS = {"NOUN": "noun", "VERB": "verb", "ADJ": "adjective"}
LEXIQUE_POS = {"NOM": "noun", "VER": "verb", "ADJ": "adjective"}
WN_POS = {"n": "noun", "v": "verb", "a": "adjective", "s": "adjective"}

EN_WORD = re.compile(r"^[a-z]+$")
FR_WORD = re.compile(r"^[a-zàâäçéèêëîïôöùûüÿœæ]+(?:[-'][a-zàâäçéèêëîïôöùûüÿœæ]+)*$")


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s).lower().strip()


def write_tsv(path: Path, header: list[str], rows) -> int:
    n = 0
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, delimiter="\t", lineterminator="\n", quoting=csv.QUOTE_NONE, escapechar="\\")
        w.writerow(header)
        for row in rows:
            w.writerow(row)
            n += 1
    return n


def z(word: str, lang: str) -> float:
    return round(zipf_frequency(word, lang), 2)


STEMMERS = {"en": SnowballStemmer("english"), "fr": SnowballStemmer("french")}


def stem(lemma: str, lang: str) -> str:
    return "-".join(STEMMERS[lang].stem(part) for part in re.split(r"[-']", lemma))


# English


def english_forms():
    rows = {}
    for form in top_n_list("en", EN_FORMS, wordlist="large"):
        form = nfc(form)
        if not EN_WORD.match(form):
            continue
        lemmas = getAllLemmas(form)
        tagged = [(lemma, POS[upos]) for upos, ls in lemmas.items() if upos in POS for lemma in ls]
        if not tagged:
            tagged = [(form, "other")]
        for lemma, pos in tagged:
            if EN_WORD.match(lemma):
                rows[(form, lemma, pos)] = (form, lemma, pos, z(form, "en"), z(lemma, "en"), "", "", stem(lemma, "en"))
    return rows.values()


def english_synonyms():
    nltk.data.path.insert(0, str(DATA / "nltk_data"))
    from nltk.corpus import wordnet as wn

    syns: dict[tuple[str, str], set[str]] = defaultdict(set)
    for synset in wn.all_synsets():
        pos = WN_POS.get(synset.pos())
        if pos is None:
            continue
        names = {n.lower() for n in synset.lemma_names() if EN_WORD.match(n.lower())}
        for name in names:
            syns[(name, pos)] |= names - {name}
    return ((lemma, pos, ",".join(sorted(s))) for (lemma, pos), s in sorted(syns.items()) if s)


# French


def restore_oe(word: str) -> str:
    """Lexique writes oe for œ. Use œ when wordfreq knows that spelling better (cœur, but coefficient)."""
    if "oe" not in word:
        return word
    lig = word.replace("oe", "œ")
    return lig if zipf_frequency(lig, "fr") > zipf_frequency(word, "fr") else word


def french_root(lemma: str, morphoder: str, nbmorph: str) -> str:
    """The base of a derived word when Lexique analyses it (a-peur-é → peur), else the stem."""
    if nbmorph not in ("", "1") and "-" in morphoder:
        parts = [restore_oe(nfc(p)) for p in morphoder.split("-") if p]
        if parts:
            return stem(max(parts, key=len), "fr")
    return stem(lemma, "fr")


def french_forms():
    rows = {}
    lemma_z: dict[str, float] = {}
    roots: dict[str, str] = {}
    with (DATA / "lexique" / "Lexique383.tsv").open(encoding="utf-8") as f:
        for r in csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            form = restore_oe(nfc(r["ortho"]))
            lemma = restore_oe(nfc(r["lemme"]))
            if not FR_WORD.match(form) or not FR_WORD.match(lemma):
                continue
            pos = LEXIQUE_POS.get(r["cgram"], "other")
            if lemma not in lemma_z:
                lemma_z[lemma] = z(lemma, "fr")
            if lemma not in roots:
                roots[lemma] = french_root(lemma, r["morphoder"], r["nbmorph"])
            rows[(form, lemma, pos)] = (
                form, lemma, pos, z(form, "fr"), lemma_z[lemma], r["genre"], r["nombre"], roots[lemma]
            )
    return rows.values()


def french_synonyms():
    path = DATA / "nltk_data" / "corpora" / "omw-1.4" / "fra" / "wn-data-fra.tab"
    synsets: dict[str, set[str]] = defaultdict(set)
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            offset_pos, kind, lemma = line.rstrip("\n").split("\t")
            lemma = nfc(lemma).replace("’", "'")
            if kind == "fra:lemma" and FR_WORD.match(lemma):
                synsets[offset_pos].add(lemma)
    syns: dict[tuple[str, str], set[str]] = defaultdict(set)
    for offset_pos, names in synsets.items():
        pos = WN_POS.get(offset_pos[-1])
        if pos is None:
            continue
        for name in names:
            syns[(name, pos)] |= names - {name}
    return ((lemma, pos, ",".join(sorted(s))) for (lemma, pos), s in sorted(syns.items()) if s)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    header = ["form", "lemma", "pos", "zipf", "lemma_zipf", "gender", "number", "root"]
    counts = {
        "en-forms": write_tsv(OUT / "en-forms.tsv", header, english_forms()),
        "en-synonyms": write_tsv(OUT / "en-synonyms.tsv", ["lemma", "pos", "synonyms"], english_synonyms()),
        "fr-forms": write_tsv(OUT / "fr-forms.tsv", header, french_forms()),
        "fr-synonyms": write_tsv(OUT / "fr-synonyms.tsv", ["lemma", "pos", "synonyms"], french_synonyms()),
    }
    meta = {
        "counts": counts,
        "versions": {
            "wordfreq": wordfreq.__version__ if hasattr(wordfreq, "__version__") else "3.1.1",
            "lemminflect": lemminflect.__version__,
            "nltk": nltk.__version__,
            "lexique": "3.83",
            "wordnet": "3.0",
            "omw": "1.4 (WOLF)",
        },
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    for name, n in counts.items():
        print(f"{name}: {n} rows", file=sys.stderr)


if __name__ == "__main__":
    main()
