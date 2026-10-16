// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A small hand-written bank for development and tests, until the real banks exist.
 * Not content: it ships only in builds made with VITE_DEV_BANK=1.
 */

import { Bank, givenCount, layoutBoxes, letters, type Item } from "../src/index.ts";

type Draft = Omit<Item, "id" | "lang" | "level" | "given" | "fixedWords" | "alternates"> &
  Partial<Pick<Item, "fixedWords" | "alternates">>;

/** Given letters spread evenly across the word. */
function spread(answer: string, lang: Item["lang"]): number[] {
  const n = letters(layoutBoxes(answer, lang)).length;
  const k = givenCount(n);
  return Array.from({ length: k }, (_, i) => Math.round(((i + 0.5) * n) / k - 0.5));
}

function bank(lang: Item["lang"], level: Item["level"], drafts: Draft[]): Bank {
  return Bank.parse({
    lang,
    level,
    items: drafts.map((d, i) => ({
      ...d,
      id: `${lang}-${level.toLowerCase()}-${String(i + 1).padStart(4, "0")}`,
      lang,
      level,
      given: spread(d.answer, lang),
    })),
  });
}

const s = (before: string, span: string | string[], after: string, determiner?: string) => ({
  kind: "sentence" as const,
  before,
  span: Array.isArray(span) ? span : [span],
  after,
  ...(determiner === undefined ? {} : { determiner }),
});
const d = (definition: string) => ({ kind: "definition" as const, definition });

export const devBanks: Bank[] = [
  bank("en", "C1", [
    { pos: "verb", prompt: s("The crowd began to ", "mock", " the referee."), answer: "deride", lemma: "deride" },
    { pos: "noun", prompt: s("Her ", "reluctance", " to speak in class was obvious."), answer: "reticence", lemma: "reticence" },
    { pos: "adjective", prompt: s("Only a ", "very small", " amount was left."), answer: "minuscule", lemma: "minuscule" },
    { pos: "verb", prompt: s("They ", "decorated", " the hall with garlands."), fixedWords: ["with"], answer: "adorned", lemma: "adorn" },
    { pos: "adjective", prompt: s("The old house felt ", "gloomy", " at night."), answer: "dismal", lemma: "dismal" },
    { pos: "noun", prompt: s("The town suffered a ", "shortage", " of clean water."), fixedWords: ["of"], answer: "dearth", lemma: "dearth" },
    { pos: "verb", prompt: s("He refused to ", "give in", " to their demands."), fixedWords: ["to"], answer: "succumb", lemma: "succumb" },
    { pos: "adjective", prompt: s("She gave a ", ["clear", "easy to follow"], " explanation."), answer: "lucid", lemma: "lucid" },
    { pos: "noun", prompt: s("The film received wide ", "praise", " from critics."), answer: "acclaim", lemma: "acclaim" },
    { pos: "verb", prompt: s("They had to ", "put off", " the match because of the rain."), answer: "postpone", lemma: "postpone" },
    { pos: "adjective", prompt: s("His ", "stubborn", " refusal annoyed everyone."), answer: "obstinate", lemma: "obstinate" },
    { pos: "noun", prompt: s("There was a ", "disagreement", " about the rules."), answer: "dispute", lemma: "dispute" },
    { pos: "verb", prompt: s("The teacher tried to ", "calm", " the angry parents."), answer: "placate", lemma: "placate" },
    { pos: "adjective", prompt: s("The instructions were ", "unclear", "."), answer: "ambiguous", lemma: "ambiguous" },
    { pos: "noun", prompt: s("He kept his ", "calm", " during the interview."), answer: "composure", lemma: "composure" },
    { pos: "verb", prompt: s("Try not to ", "exaggerate", " the problem."), answer: "overstate", lemma: "overstate" },
    { pos: "adjective", prompt: s("It was a ", "lucky", " discovery."), answer: "fortuitous", lemma: "fortuitous" },
    { pos: "noun", prompt: d("A strong feeling of dislike for something"), answer: "aversion", lemma: "aversion" },
    { pos: "verb", prompt: d("To make a bad situation even worse"), answer: "exacerbate", lemma: "exacerbate" },
    { pos: "adjective", prompt: d("Lasting for a very short time"), answer: "ephemeral", lemma: "ephemeral" },
    { pos: "noun", prompt: d("A person who is new to an activity"), answer: "novice", lemma: "novice" },
    { pos: "verb", prompt: s("The endless noise began to ", "annoy", " him."), answer: "exasperate", lemma: "exasperate" },
    { pos: "adjective", prompt: s("She was a ", "talkative", " child."), answer: "loquacious", lemma: "loquacious" },
    { pos: "noun", prompt: s("A feeling of deep ", "sadness", " filled the room."), answer: "sorrow", lemma: "sorrow" },
    { pos: "verb", prompt: s("The crew ", "left", " the sinking ship."), answer: "abandoned", lemma: "abandon" },
    { pos: "adjective", prompt: s("They built a ", "huge", " statue."), answer: "colossal", lemma: "colossal" },
    { pos: "noun", prompt: s("Voters showed a ", "lack of interest", " in the election."), answer: "apathy", lemma: "apathy" },
    { pos: "verb", prompt: d("To state firmly that something is true"), answer: "assert", lemma: "assert" },
    { pos: "adjective", prompt: d("Careful to avoid risks"), answer: "prudent", lemma: "prudent" },
    { pos: "noun", prompt: s("The firefighter showed great ", "bravery", "."), answer: "courage", lemma: "courage" },
  ]),
  bank("fr", "C1", [
    { pos: "noun", prompt: s("Elle a eu ", "peur", " en voyant l’ours.", "une"), answer: "frayeur", lemma: "frayeur" },
    { pos: "verb", prompt: s("Il faut encore ", "améliorer", " ce texte."), answer: "peaufiner", lemma: "peaufiner" },
    { pos: "adjective", prompt: s("Le discours était vraiment ", "ennuyeux", "."), answer: "soporifique", lemma: "soporifique" },
    { pos: "noun", prompt: s("Elle a répondu avec ", "assurance", "."), answer: "aplomb", lemma: "aplomb" },
    { pos: "verb", prompt: s("L’équipage a ", "quitté", " le navire."), answer: "déserté", lemma: "déserter" },
    { pos: "adjective", prompt: s("Sa réponse était ", ["claire", "facile à comprendre"], "."), answer: "limpide", lemma: "limpide" },
    { pos: "noun", prompt: s("Le pompier a fait preuve de ", "courage", "."), answer: "bravoure", lemma: "bravoure" },
    { pos: "verb", prompt: s("Ce bruit a fini par m’", "agacer", "."), answer: "exaspérer", lemma: "exaspérer" },
    { pos: "adjective", prompt: s("C’est un enfant très ", "bavard", "."), answer: "loquace", lemma: "loquace" },
    { pos: "noun", prompt: d("Regret mélancolique d’une époque passée"), answer: "nostalgie", lemma: "nostalgie" },
    { pos: "verb", prompt: d("Rendre une situation encore plus tendue"), answer: "envenimer", lemma: "envenimer" },
    { pos: "adjective", prompt: d("Qui ne dure qu’un temps très court"), answer: "éphémère", lemma: "éphémère" },
    { pos: "noun", prompt: s("Elle parle au nom du groupe : c’est sa ", "représentante", "."), answer: "porte-parole", lemma: "porte-parole" },
    { pos: "noun", prompt: s("Ce tableau est ", "création", " remarquable.", "une"), answer: "œuvre", lemma: "œuvre" },
    { pos: "verb", prompt: s("Il faut ", "réfléchir", " avant d’agir."), answer: "cogiter", lemma: "cogiter" },
  ]),
];
