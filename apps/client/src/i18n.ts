// SPDX-License-Identifier: AGPL-3.0-only

import type { ErrorCode, Item } from "@twototango/core";

/** Interface strings. The game language is separate: it is whatever the GM picked. */

type Strings = {
  appName: string;
  // Setup and lobby
  language: string;
  langName: Record<Item["lang"], string>;
  level: string;
  players: string;
  items: string;
  createGame: string;
  notEnoughItems: (n: number) => string;
  joinWith: string;
  code: string;
  waitingFor: (joined: number, needed: number) => string;
  remove: string;
  start: string;
  away: string;
  // Joining
  yourName: string;
  play: string;
  watch: string;
  watching: string;
  waitingForGm: string;
  waitingForStart: string;
  paused: string;
  errors: Record<ErrorCode, string>;
  // Item
  pos: Record<Item["pos"], string>;
  itemNumber: (n: number, total: number) => string;
  yourTurn: string;
  turnOf: (name: string) => string;
  openToAll: string;
  pass: string;
  passed: (name: string) => string;
  correct: (name: string) => string;
  open: string;
  reveal: string;
  whoAnswered: string;
  scored: (name: string, points: number) => string;
  noScore: string;
  answer: string;
  alsoAccept: string;
  playWord: string;
  undo: string;
  next: string;
  seeResults: string;
  endGame: string;
  confirmEndGame: string;
  turnOrder: string;
  // Results
  results: string;
  endedEarly: (played: number, total: number) => string;
  points: (n: number) => string;
  rematch: string;
  endSession: string;
  savedGameLost: string;
};

const en: Strings = {
  appName: "Two to Tango",
  language: "Language",
  langName: { en: "English", fr: "French" },
  level: "Level",
  players: "Players",
  items: "Items",
  createGame: "Open the lobby",
  notEnoughItems: (n) => `Only ${n} items available for this language and level.`,
  joinWith: "Scan to join, or open",
  code: "Code",
  waitingFor: (j, n) => `${j} of ${n} players`,
  remove: "Remove",
  start: "Start",
  away: "away",
  yourName: "Your name",
  play: "Play",
  watch: "Watch",
  watching: "Watching",
  waitingForGm: "Waiting for the game master…",
  waitingForStart: "Waiting for the game to start…",
  paused: "Paused — waiting for the game master's phone",
  errors: {
    "bad-code": "That code doesn't match. Check the game master's screen.",
    "no-game": "No game is open yet.",
    "name-taken": "Someone already has that name.",
    "bad-name": "Enter a name of up to 24 characters.",
    started: "The game has already started.",
    "not-allowed": "Not now.",
    "bad-message": "Something went wrong. Reload the page.",
  },
  pos: { noun: "noun", verb: "verb", adjective: "adjective" },
  itemNumber: (n, t) => `${n} / ${t}`,
  yourTurn: "Your turn",
  turnOf: (name) => `${name}'s turn`,
  openToAll: "Open to everyone",
  pass: "Pass",
  passed: (name) => `${name} passed`,
  correct: (name) => `Correct (${name})`,
  open: "Open to all",
  reveal: "Reveal",
  whoAnswered: "Who answered first?",
  scored: (name, p) => `${name} +${p}`,
  noScore: "No one scored",
  answer: "Answer",
  alsoAccept: "Also accept",
  playWord: "Play word",
  undo: "Undo",
  next: "Next",
  seeResults: "Results",
  endGame: "End game",
  confirmEndGame: "End the game now? The ranking will cover the items played.",
  turnOrder: "Turn order",
  results: "Results",
  endedEarly: (p, t) => `Ended after ${p} of ${t} items`,
  points: (n) => `${n} pt${n === 1 ? "" : "s"}`,
  rematch: "Rematch",
  endSession: "End session",
  savedGameLost: "The saved game couldn't be restored and was discarded.",
};

const fr: Strings = {
  appName: "Two to Tango",
  language: "Langue",
  langName: { en: "Anglais", fr: "Français" },
  level: "Niveau",
  players: "Joueurs",
  items: "Questions",
  createGame: "Ouvrir la partie",
  notEnoughItems: (n) => `Seulement ${n} questions disponibles pour cette langue et ce niveau.`,
  joinWith: "Scannez pour rejoindre, ou ouvrez",
  code: "Code",
  waitingFor: (j, n) => `${j} joueurs sur ${n}`,
  remove: "Retirer",
  start: "Commencer",
  away: "absent",
  yourName: "Ton prénom",
  play: "Jouer",
  watch: "Regarder",
  watching: "Spectateur",
  waitingForGm: "En attente du meneur de jeu…",
  waitingForStart: "En attente du début de la partie…",
  paused: "Pause — en attente du téléphone du meneur",
  errors: {
    "bad-code": "Ce code ne correspond pas. Regarde l’écran du meneur.",
    "no-game": "Aucune partie n’est encore ouverte.",
    "name-taken": "Quelqu’un a déjà ce prénom.",
    "bad-name": "Entre un prénom de 24 caractères au plus.",
    started: "La partie a déjà commencé.",
    "not-allowed": "Pas maintenant.",
    "bad-message": "Un problème est survenu. Recharge la page.",
  },
  pos: { noun: "nom", verb: "verbe", adjective: "adjectif" },
  itemNumber: (n, t) => `${n} / ${t}`,
  yourTurn: "À toi",
  turnOf: (name) => `Au tour de ${name}`,
  openToAll: "Ouvert à tous",
  pass: "Passer",
  passed: (name) => `${name} passe`,
  correct: (name) => `Correct (${name})`,
  open: "Ouvrir à tous",
  reveal: "Révéler",
  whoAnswered: "Qui a répondu en premier ?",
  scored: (name, p) => `${name} +${p}`,
  noScore: "Personne n’a marqué",
  answer: "Réponse",
  alsoAccept: "Accepter aussi",
  playWord: "Écouter le mot",
  undo: "Annuler",
  next: "Suivant",
  seeResults: "Résultats",
  endGame: "Terminer",
  confirmEndGame: "Terminer la partie maintenant ? Le classement portera sur les questions jouées.",
  turnOrder: "Ordre de passage",
  results: "Résultats",
  endedEarly: (p, t) => `Terminée après ${p} questions sur ${t}`,
  points: (n) => `${n} pt${n > 1 ? "s" : ""}`,
  rematch: "Revanche",
  endSession: "Fin de la session",
  savedGameLost: "La partie enregistrée n’a pas pu être reprise et a été supprimée.",
};

const ja: Strings = {
  appName: "Two to Tango",
  language: "言語",
  langName: { en: "英語", fr: "フランス語" },
  level: "レベル",
  players: "プレイヤー",
  items: "問題数",
  createGame: "ロビーを開く",
  notEnoughItems: (n) => `この言語とレベルの問題は${n}問しかありません。`,
  joinWith: "QRコードを読み取るか、次を開いてください",
  code: "コード",
  waitingFor: (j, n) => `${n}人中${j}人`,
  remove: "外す",
  start: "スタート",
  away: "離席中",
  yourName: "名前",
  play: "参加する",
  watch: "見る",
  watching: "観戦中",
  waitingForGm: "ゲームマスターを待っています…",
  waitingForStart: "ゲーム開始を待っています…",
  paused: "一時停止中 — ゲームマスターの端末を待っています",
  errors: {
    "bad-code": "コードが違います。ゲームマスターの画面を確認してください。",
    "no-game": "まだゲームが開かれていません。",
    "name-taken": "その名前はすでに使われています。",
    "bad-name": "24文字以内で名前を入力してください。",
    started: "ゲームはすでに始まっています。",
    "not-allowed": "今はできません。",
    "bad-message": "問題が発生しました。ページを再読み込みしてください。",
  },
  pos: { noun: "名詞", verb: "動詞", adjective: "形容詞" },
  itemNumber: (n, t) => `${n} / ${t}`,
  yourTurn: "あなたの番です",
  turnOf: (name) => `${name}さんの番`,
  openToAll: "早い者勝ち",
  pass: "パス",
  passed: (name) => `${name}さんがパスしました`,
  correct: (name) => `正解（${name}）`,
  open: "全員に開放",
  reveal: "答えを見せる",
  whoAnswered: "最初に正解したのは？",
  scored: (name, p) => `${name} +${p}`,
  noScore: "得点なし",
  answer: "答え",
  alsoAccept: "別解",
  playWord: "発音を聞く",
  undo: "取り消す",
  next: "次へ",
  seeResults: "結果",
  endGame: "ゲーム終了",
  confirmEndGame: "ゲームを終了しますか？ 順位はここまでの問題で決まります。",
  turnOrder: "順番",
  results: "結果",
  endedEarly: (p, t) => `${t}問中${p}問で終了`,
  points: (n) => `${n}点`,
  rematch: "もう一度",
  endSession: "セッション終了",
  savedGameLost: "保存されたゲームを復元できなかったため、削除しました。",
};

const table = { en, fr, ja };

function pick(): Strings {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.slice(0, 2).toLowerCase();
    if (base in table) return table[base as keyof typeof table];
  }
  return en;
}

export const t = pick();
export const uiLang = (Object.keys(table) as (keyof typeof table)[]).find((k) => table[k] === t) ?? "en";
