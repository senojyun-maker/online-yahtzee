const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const MAX_PLAYERS = 10;

const categories = [
  "ones", "twos", "threes", "fours", "fives", "sixes",
  "threeKind", "fourKind", "fullHouse",
  "smallStraight", "largeStraight",
  "chance", "yahtzee"
];

let game = {
  players: [],
  turn: 0,
  dice: [1, 1, 1, 1, 1],
  held: [false, false, false, false, false],
  rollCount: 0,
  turnFlags: {
    noKeepBeforeRoll2: false,
    noKeepBeforeRoll3: false,
    hanModeArmed: false,
    hanModeTurn: false,
    doubleOrZeroUsed: false,

    // 暗転同期
    rollOverlayOpen: false,
    rollOverlayBy: null,
    dozInProgress: false,
    yahtzeeFanfareUsed: false,
  },
  report: {
    active: false,
    reporterSocketId: null,
    startedAt: null
  },
  cheatLog: [],
  gameOver: false,
  winnerName: null,
};

function newPlayer(id) {
  return {
    id,
    name: "Player" + (game.players.length + 1),
    socketId: null,
    scores: {},
    originalScores: {},   // 初回確定（or 初回イカサマ前）を保存
    cheated: {},          // そのマスが改竄されたか
    penalty: 0,           // 通報による±点、未発覚ボーナスもここに加算

    // 追加
    cheatUsed: false,     // 今回の試合で一度でもイカサマを使ったか
    cheatCaught: false,   // 通報成功でイカサマが発覚したか
    extraTurn: false,     // 再ヤッツィーで追加ターンを持っているか

    uncaughtCheatBonus: 0,   // 未発覚イカサマボーナス
    uncaughtCheatBonusAwarded: false,

    upperSubtotal: 0,
    bonus: 0,
    total: 0
  };
}

function isYahtzeeDice(dice) {
  return dice.every(d => d === dice[0]);
}

function isFinalTurnPlayer(player){
  if(!player || !player.scores) return false;
  const filledCount = Object.keys(player.scores).length;
  return filledCount >= 12;
}

function calcScore(cat, dice, hanModeTurn) {
  const counts = [0, 0, 0, 0, 0, 0];
  dice.forEach(d => counts[d - 1]++);
  const sum = dice.reduce((a, b) => a + b, 0);

  switch (cat) {
    case "ones": return counts[0] * 1;
    case "twos": return counts[1] * 2;
    case "threes": return counts[2] * 3;
    case "fours": return counts[3] * 4;
    case "fives": return counts[4] * 5;
    case "sixes": return counts[5] * 6;
    case "threeKind": return counts.some(c => c >= 3) ? sum : 0;
    case "fourKind": return counts.some(c => c >= 4) ? sum : 0;
    case "fullHouse": return (counts.includes(3) && counts.includes(2)) ? sum : 0;
    case "smallStraight": {
      const u = [...new Set(dice)].sort().join("");
      return (u.includes("1234") || u.includes("2345") || u.includes("3456")) ? 30 : 0;
    }
    case "largeStraight": {
      const u = [...new Set(dice)].sort().join("");
      return (u === "12345" || u === "23456") ? 40 : 0;
    }
    case "chance": return sum;
    case "yahtzee": {
      if (!counts.includes(5)) return 0;
      return hanModeTurn ? 100 : 50;
    }
  }
  return 0;
}

function updateTotals(p) {
  const upper = ["ones", "twos", "threes", "fours", "fives", "sixes"];
  p.upperSubtotal = upper.reduce((s, c) => s + (p.scores[c] ?? 0), 0);
  p.bonus = p.upperSubtotal >= 63 ? 35 : 0;

  const base = Object.values(p.scores).reduce((a, b) => a + b, 0) + p.bonus;
  p.total = base + (p.penalty || 0) + (p.uncaughtCheatBonus || 0);
}

function resetTurnFlags() {
  game.turnFlags = {
    noKeepBeforeRoll2: false,
    noKeepBeforeRoll3: false,
    hanModeArmed: false,
    hanModeTurn: false,
    doubleOrZeroUsed: false,
    rollOverlayOpen: false,
    rollOverlayBy: null,
    dozInProgress: false,
    yahtzeeFanfareUsed: false,
  };
}

function nextTurn() {
  const current = game.players[game.turn];

  // 再ヤッツィーの追加ターンがあるなら、同じ人のまま次ターン開始
  if (current && current.extraTurn) {
    current.extraTurn = false;
  } else {
    game.turn = (game.turn + 1) % game.players.length;
  }

  game.rollCount = 0;
  game.held = [false, false, false, false, false];
  game.dice = [1, 1, 1, 1, 1];
  resetTurnFlags();
}

function emitUpdate() {
  io.emit("update", game);
}

function emitSfx(name, payload = {}) {
  io.emit("sfx", { name, ...payload });
}

function allFinished() {
  return game.players.length > 0 &&
    game.players.every(p =>
      categories.every(c => p.scores[c] !== undefined)
    );
}

function finishGameWithBonuses() {
  for (const p of game.players) {
    p.uncaughtCheatBonusAwarded = false;
    p.uncaughtCheatBonus = 0;
  }

  for (const p of game.players) {
    const uncaughtCount = Object.keys(p.cheated || {}).filter(cat => p.cheated[cat]).length;

    if (uncaughtCount > 0) {
      p.uncaughtCheatBonus = uncaughtCount * 10;
      p.uncaughtCheatBonusAwarded = true;
    } else {
      p.uncaughtCheatBonus = 0;
      p.uncaughtCheatBonusAwarded = false;
    }

    updateTotals(p);
  }

  game.gameOver = true;

  let best = null;
  for (const p of game.players) {
    if (!best || p.total > best.total) best = p;
  }
  game.winnerName = best ? best.name : null;
}

function reportLockActive() {
  return !!game.report?.active;
}

function categoryLabel(cat){
  const map = {
    ones: "1",
    twos: "2",
    threes: "3",
    fours: "4",
    fives: "5",
    sixes: "6",
    threeKind: "3カード",
    fourKind: "4カード",
    fullHouse: "フルハウス",
    smallStraight: "Sストレート",
    largeStraight: "Lストレート",
    chance: "チャンス",
    yahtzee: "ヤッツィー"
  };
  return map[cat] || cat;
}

function isPlayerFinalTurn(player){
  const filledCount = categories.filter(c => player.scores[c] !== undefined).length;
  return filledCount === categories.length - 1;
}

io.on("connection", (socket) => {
  if (game.players.length >= MAX_PLAYERS) {
    socket.emit("full");
    return;
  }

  const player = newPlayer(socket.id);
  player.socketId = socket.id;
  game.players.push(player);

  socket.emit("init", game);
  emitUpdate();

  // =========================
  // イカサマ：確定済みの自分のマスだけ上書き
  // =========================
    socket.on("cheatSet", ({ cat, value }) => {
    if (game.gameOver) return;
    if (reportLockActive()) return;

    if (typeof cat !== "string") return;
    if (!categories.includes(cat)) return;

    if (typeof value !== "number" || !Number.isFinite(value)) return;

    const me = game.players.find(p => p.socketId === socket.id);
    if (!me) return;

    // 最終ターンではイカサマ禁止
    if (isPlayerFinalTurn(me)) return;

    if (me.scores[cat] === undefined) return;

    value = Math.trunc(value);
    if (value < 0) value = 0;
    if (value > 999) value = 999;

    if (me.originalScores[cat] === undefined) {
      me.originalScores[cat] = me.scores[cat];
    }

    const beforeValue = me.scores[cat];

    me.scores[cat] = value;
    me.cheated[cat] = (value !== me.originalScores[cat]);

    if (beforeValue !== value) {
      game.cheatLog.push({
        type: "cheat",
        playerName: me.name,
        playerSocketId: me.socketId,
        cat,
        catLabel: categoryLabel(cat),
        before: beforeValue,
        after: value,
        turnNumber: game.players.reduce((acc, p) => {
          return acc + Object.keys(p.scores).length;
        }, 0) + 1,
        atPlayerTurn: game.players[game.turn]?.name || "",
        timestamp: Date.now()
      });
    }

    if (me.cheated[cat]) {
      me.cheatUsed = true;
    }

    updateTotals(me);
    emitUpdate();
  });

  // =========================
  // 🎲 ロール暗転：全員同期（音は roll確定時のみ）
  // =========================
  socket.on("rollOverlayOpen", () => {
    if (game.gameOver) return;
    if (reportLockActive()) return;

    const current = game.players[game.turn];
    if (!current) return;
    if (socket.id !== current.socketId) return;
    if (game.rollCount >= 3) return;

    game.turnFlags.rollOverlayOpen = true;
    game.turnFlags.rollOverlayBy = socket.id;

    io.emit("rollOverlay", {
      show: true,
      bySocketId: socket.id,
      byName: current.name
    });
  });

  socket.on("rollOverlayClose", () => {
    if (reportLockActive()) return;

    const current = game.players[game.turn];
    if (!current) return;
    if (socket.id !== current.socketId) return;

    game.turnFlags.rollOverlayOpen = false;
    game.turnFlags.rollOverlayBy = null;

    io.emit("rollOverlay", { show: false });
  });

  // =========================
  // 💀 DOZ暗転：全員同期（音も全員）
  // =========================
  socket.on("dozOverlayStart", () => {
    if (game.gameOver) return;

    const current = game.players[game.turn];
    if (!current) return;
    if (socket.id !== current.socketId) return;

    // DOZの条件
    if (game.rollCount !== 3) return;
    if (game.turnFlags.doubleOrZeroUsed) return;
    if (game.turnFlags.hanModeTurn) return; // 漢モード完全時は禁止

    // 二重起動防止
    if (game.turnFlags.dozInProgress) return;

    game.turnFlags.dozInProgress = true;

    // 全員暗転
    io.emit("dozOverlay", {
      show: true,
      bySocketId: socket.id,
      byName: current.name,
      ms: 2500
    });

    // 全員にサウンド（開始）
    emitSfx("doz");
    setTimeout(() => emitSfx("heartStart"), 350);

    // 2.5秒後にサーバが結果まで実行して解除
    setTimeout(() => {
      emitSfx("heartStop");

      const now = game.players[game.turn];
      const isSamePlayer = now && now.socketId === socket.id;

      if (
        isSamePlayer &&
        game.rollCount === 3 &&
        !game.turnFlags.doubleOrZeroUsed &&
        !game.turnFlags.hanModeTurn
      ) {
        for (let i = 0; i < 5; i++) {
          game.dice[i] = Math.floor(Math.random() * 6) + 1;
          game.held[i] = false;
        }
        game.turnFlags.doubleOrZeroUsed = true;

        emitSfx("roll");
      }

      game.turnFlags.dozInProgress = false;
      io.emit("dozOverlay", { show: false });

      emitUpdate();
    }, 2500);
  });

  // =========================
  // ✅ 通報：開始
  // =========================
  socket.on("reportStart", () => {
    if (game.gameOver) return;
    if (reportLockActive()) return;

    // 暗転中は不可
    if (game.turnFlags.rollOverlayOpen) return;
    if (game.turnFlags.dozInProgress) return;

    game.report.active = true;
    game.report.reporterSocketId = socket.id;
    game.report.startedAt = Date.now();

    emitSfx("siren");
    emitUpdate();
  });

  // =========================
  // ✅ 通報：マス選択
  // =========================
  socket.on("reportSelect", ({ targetSocketId, cat }) => {
    if (game.gameOver) return;
    if (!reportLockActive()) return;

    if (socket.id !== game.report.reporterSocketId) return;

    if (typeof targetSocketId !== "string") return;
    if (typeof cat !== "string") return;
    if (!categories.includes(cat)) return;

    const reporter = game.players.find(p => p.socketId === socket.id);
    const target = game.players.find(p => p.socketId === targetSocketId);
    if (!reporter || !target) return;

    if (target.scores[cat] === undefined) return;

    const wasCheated = !!target.cheated[cat];

    if (wasCheated) {
      // 正解：通報者 +5 / イカサマ者は元に戻す
      reporter.penalty = (reporter.penalty || 0) + 5;

      const orig = (target.originalScores[cat] !== undefined)
        ? target.originalScores[cat]
        : target.scores[cat];

      const beforeRestore = target.scores[cat];

      target.scores[cat] = orig;
      target.cheated[cat] = false;
      target.cheatCaught = true;

      game.cheatLog.push({
        type: "report-success",
        reporterName: reporter.name,
        targetName: target.name,
        targetSocketId: target.socketId,
        cat,
        catLabel: categoryLabel(cat),
        before: beforeRestore,
        after: orig,
        turnNumber: game.players.reduce((acc, p) => {
          return acc + Object.keys(p.scores).length;
        }, 0) + 1,
        atPlayerTurn: game.players[game.turn]?.name || "",
        timestamp: Date.now()
      });

      updateTotals(target);
      emitSfx("correct");
    } else {
// 間違い：通報者 -5
      reporter.penalty = (reporter.penalty || 0) - 5;

      game.cheatLog.push({
        type: "report-fail",
        reporterName: reporter.name,
        targetName: target.name,
        targetSocketId: target.socketId,
        cat,
        catLabel: categoryLabel(cat),
        before: target.scores[cat],
        after: target.scores[cat],
        turnNumber: game.players.reduce((acc, p) => {
          return acc + Object.keys(p.scores).length;
        }, 0) + 1,
        atPlayerTurn: game.players[game.turn]?.name || "",
        timestamp: Date.now()
      });

      emitSfx("wrong");
    }
    updateTotals(reporter);

    game.report.active = false;
    game.report.reporterSocketId = null;
    game.report.startedAt = null;

    emitUpdate();
  });

  // =========================
  // ロール本処理
  // =========================
  socket.on("roll", () => {
    if (game.gameOver) return;
    if (reportLockActive()) return;

    const current = game.players[game.turn];
    if (!current) return;
    if (socket.id !== current.socketId) return;
    if (game.rollCount >= 3) return;

    const heldCount = game.held.filter(Boolean).length;

    if (game.rollCount === 1) {
      game.turnFlags.noKeepBeforeRoll2 = (heldCount === 0);
    }
    if (game.rollCount === 2) {
      game.turnFlags.noKeepBeforeRoll3 = (heldCount === 0);
    }

    for (let i = 0; i < 5; i++) {
      if (!game.held[i]) {
        game.dice[i] = Math.floor(Math.random() * 6) + 1;
      }
    }

    game.rollCount++;

    if (!game.turnFlags.yahtzeeFanfareUsed && isYahtzeeDice(game.dice)) {
      game.turnFlags.yahtzeeFanfareUsed = true;
      emitSfx("fanfare");
    }

    if (game.rollCount === 2) {
      game.turnFlags.hanModeArmed = game.turnFlags.noKeepBeforeRoll2;
    }

    if (game.rollCount === 3) {
      game.turnFlags.hanModeTurn =
        game.turnFlags.noKeepBeforeRoll2 &&
        game.turnFlags.noKeepBeforeRoll3;

      if (game.turnFlags.hanModeTurn) {
        game.turnFlags.hanModeArmed = true;
      }
    }

    // ロール確定で暗転を閉じる
    if (game.turnFlags.rollOverlayOpen) {
      game.turnFlags.rollOverlayOpen = false;
      game.turnFlags.rollOverlayBy = null;
      io.emit("rollOverlay", { show: false });
    }

    const isY = isYahtzeeDice(game.dice);

    if (isY) {
      emitSfx("fanfare");
    } else {
      emitSfx("roll");
    }

    emitUpdate();
  });

  socket.on("toggleHold", (i) => {
    if (game.gameOver) return;
    if (reportLockActive()) return;

    const current = game.players[game.turn];
    if (!current) return;
    if (socket.id !== current.socketId) return;

    if (game.rollCount === 0) return;
    if (!Number.isInteger(i) || i < 0 || i >= 5) return;

    game.held[i] = !game.held[i];
    emitUpdate();
  });

  socket.on("doubleOrZero", () => {
    if (game.gameOver) return;
    if (reportLockActive()) return;

    const current = game.players[game.turn];
    if (!current) return;
    if (socket.id !== current.socketId) return;

    if (game.rollCount !== 3) return;
    if (game.turnFlags.doubleOrZeroUsed) return;
    if (game.turnFlags.hanModeTurn) return;

    for (let i = 0; i < 5; i++) {
      game.dice[i] = Math.floor(Math.random() * 6) + 1;
      game.held[i] = false;
    }

    game.turnFlags.doubleOrZeroUsed = true;
    emitSfx("roll");
    emitUpdate();
  });

  socket.on("godReYahtzee", () => {
    if (game.gameOver) return;
    if (reportLockActive()) return;

    const current = game.players[game.turn];
    if (!current) return;
    if (socket.id !== current.socketId) return;

    if (game.rollCount !== 3) return;
    if (!game.turnFlags.hanModeTurn) return;
    if (!isYahtzeeDice(game.dice)) return;

    for (let i = 0; i < 5; i++) {
      game.dice[i] = Math.floor(Math.random() * 6) + 1;
      game.held[i] = false;
    }

    if (isYahtzeeDice(game.dice)) {
      game.gameOver = true;
      game.winnerName = current.name;
    }

    emitUpdate();
  });

  socket.on("score", (cat) => {
    if (game.gameOver) return;
    if (reportLockActive()) return;

    const current = game.players[game.turn];
    if (!current) return;
    if (socket.id !== current.socketId) return;

    if (typeof cat !== "string") return;
    if (!categories.includes(cat)) return;
    if (game.rollCount === 0) return;

    const rolledYahtzee = isYahtzeeDice(game.dice);
    const alreadyHasYahtzee = current.scores.yahtzee !== undefined;

    // =========================
    // 再ヤッツィー処理
    // 2回目以降のヤッツィーは
    // - ヤッツィー欄に +100
    // - マス消費なし
    // - 追加ターン
    // =========================
    if (rolledYahtzee && alreadyHasYahtzee) {
      current.scores.yahtzee += 100;
      current.extraTurn = true;

      // originalScores は最初に正規記入された点のまま維持
      // cheated は触らない
      updateTotals(current);

      if (allFinished()) {
        finishGameWithBonuses();
        emitUpdate();
        return;
      }

      nextTurn();
      emitUpdate();
      return;
    }

    // 通常の記入
    if (current.scores[cat] !== undefined) return;

    const v = calcScore(cat, game.dice, game.turnFlags.hanModeTurn);
    current.scores[cat] = v;

    // この時点が「正規の元点」
    current.originalScores[cat] = v;
    current.cheated[cat] = false;

    updateTotals(current);

    if (allFinished()) {
      finishGameWithBonuses();
      emitUpdate();
      return;
    }

    nextTurn();
    emitUpdate();
  });

  socket.on("disconnect", () => {
    // 通報中の通報者が落ちたら解除
    if (game.report?.active && game.report.reporterSocketId === socket.id) {
      game.report.active = false;
      game.report.reporterSocketId = null;
      game.report.startedAt = null;
    }

    // 暗転中の本人が落ちたら解除
    if (game.turnFlags.rollOverlayBy === socket.id) {
      game.turnFlags.rollOverlayOpen = false;
      game.turnFlags.rollOverlayBy = null;
      io.emit("rollOverlay", { show: false });
    }
    if (game.turnFlags.dozInProgress) {
      game.turnFlags.dozInProgress = false;
      io.emit("dozOverlay", { show: false });
      emitSfx("heartStop");
    }

    game.players = game.players.filter(p => p.socketId !== socket.id);

        if (game.players.length === 0) {
      game.turn = 0;
      game.rollCount = 0;
      game.dice = [1, 1, 1, 1, 1];
      game.held = [false, false, false, false, false];
      resetTurnFlags();
      game.report = { active: false, reporterSocketId: null, startedAt: null };
      game.cheatLog = [];
      game.gameOver = false;
      game.winnerName = null;
      emitUpdate();
      return;
    }

    emitUpdate();
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});