import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

const $ = id => document.getElementById(id);
const els = {
  inputView: $("inputView"), analysisView: $("analysisView"), pgnInput: $("pgnInput"),
  analyzeBtn: $("analyzeBtn"), exampleBtn: $("exampleBtn"), backBtn: $("backBtn"),
  errorBox: $("errorBox"), engineStatus: $("engineStatus"), board: $("board"),
  moveList: $("moveList"), moveLabel: $("moveLabel"), positionLabel: $("positionLabel"),
  gameMeta: $("gameMeta"), evalValue: $("evalValue"), depthValue: $("depthValue"),
  progressBar: $("progressBar"), positionInsight: $("positionInsight"), candidateList: $("candidateList"),
  humanFactors: $("humanFactors"), firstBtn: $("firstBtn"), prevBtn: $("prevBtn"),
  nextBtn: $("nextBtn"), lastBtn: $("lastBtn")
};

const EXAMPLE = `[Event "Human Chess Insight Demo"]
[Site "Local"]
[Date "2026.01.01"]
[Round "1"]
[White "White"]
[Black "Black"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 *`;

const ENGINE_PATH = new URL("stockfish/stockfish-19-lite-single.js", import.meta.url).toString();

let engine = null;
let engineReady = false;
let engineInitPromise = null;
let currentAnalysis = null;
let analysisToken = 0;
let positions = [];
let currentPly = 0;
let analysisCache = new Map();

function setStatus(text, type = "loading") {
  els.engineStatus.textContent = text;
  els.engineStatus.className = `status ${type}`;
}

function showError(text) {
  els.errorBox.textContent = text;
  els.errorBox.hidden = false;
}

function clearError() {
  els.errorBox.hidden = true;
  els.errorBox.textContent = "";
}

function renderProgress(percent, depth = 0) {
  els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  els.depthValue.textContent = depth ? String(depth) : "—";
}

function initEngine() {
  if (engineInitPromise) return engineInitPromise;

  engineInitPromise = new Promise((resolve, reject) => {
    setStatus("Stockfish 로딩 중…", "loading");

    try {
      engine = new Worker(ENGINE_PATH);
    } catch (e) {
      reject(e);
      return;
    }

    let phase = "boot";

    const timer = setTimeout(() => {
      reject(new Error("Stockfish 로딩 시간이 초과되었습니다."));
    }, 30000);

    engine.onerror = event => {
      clearTimeout(timer);
      reject(new Error(event?.message || "Stockfish Worker 오류"));
    };

    engine.onmessage = event => {
      const line = typeof event.data === "string" ? event.data.trim() : "";
      if (!line) return;

      if (line === "uciok" && phase === "boot") {
        phase = "waiting-ready";
        engine.postMessage("setoption name MultiPV value 3");
        engine.postMessage("isready");
        return;
      }

      if (line === "readyok" && phase === "waiting-ready") {
        clearTimeout(timer);
        phase = "ready";
        engineReady = true;
        setStatus("Stockfish 준비 완료", "ready");
        resolve();
        return;
      }

      if (currentAnalysis) currentAnalysis.onLine(line);
    };

    engine.postMessage("uci");
  }).catch(error => {
    engineReady = false;
    setStatus("엔진 오류", "error");
    throw error;
  });

  return engineInitPromise;
}

function parseScore(tokens) {
  const i = tokens.indexOf("score");
  if (i < 0) return null;

  const kind = tokens[i + 1];
  const value = Number(tokens[i + 2]);

  if (!kind || Number.isNaN(value)) return null;

  if (kind === "cp") return { type: "cp", raw: value };
  if (kind === "mate") return { type: "mate", raw: value };

  return null;
}

function whiteScore(score, turn) {
  if (!score) return null;

  if (score.type === "cp") {
    return (turn === "w" ? score.raw : -score.raw) / 100;
  }

  const sign = score.raw > 0 ? 1 : -1;
  return turn === "w" ? sign * 100 : -sign * 100;
}

function formatScore(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";

  if (Math.abs(value) >= 99) {
    return value > 0 ? "+M" : "−M";
  }

  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}`;
}

function scoreLabel(value) {
  const a = Math.abs(value ?? 0);

  if (a < 0.25) return "균형에 가까운 포지션입니다.";

  if (a < 0.8) {
    return value > 0
      ? "백이 조금 더 편한 포지션입니다."
      : "흑이 조금 더 편한 포지션입니다.";
  }

  if (a < 1.8) {
    return value > 0
      ? "백에게 뚜렷한 실전적 우세가 있습니다."
      : "흑에게 뚜렷한 실전적 우세가 있습니다.";
  }

  if (a < 3.5) {
    return value > 0
      ? "백의 우세가 상당합니다."
      : "흑의 우세가 상당합니다.";
  }

  return value > 0
    ? "백 쪽으로 크게 기울었습니다."
    : "흑 쪽으로 크게 기울었습니다.";
}

function uciToSan(fen, uci) {
  try {
    const c = new Chess(fen);

    const move = c.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4]
    });

    return move ? move.san : uci;
  } catch {
    return uci;
  }
}

function cancelCurrentAnalysis() {
  if (!currentAnalysis) return;

  const old = currentAnalysis;

  currentAnalysis = null;

  clearTimeout(old.timeout);
  old.reject?.(new Error("이전 분석이 취소되었습니다."));

  if (engineReady && engine) {
    engine.postMessage("stop");
  }
}

function analyzeFen(fen, depth = 10) {
  if (analysisCache.has(fen)) {
    return Promise.resolve(analysisCache.get(fen));
  }

  if (!engineReady || !engine) {
    return Promise.reject(
      new Error("Stockfish가 아직 준비되지 않았습니다.")
    );
  }

  cancelCurrentAnalysis();

  return new Promise((resolve, reject) => {
    const token = ++analysisToken;
    const turn = fen.split(" ")[1];

    const result = {
      fen,
      turn,
      lines: new Map(),
      depth: 0
    };

    const timeout = setTimeout(() => {
      if (currentAnalysis?.token !== token) return;

      currentAnalysis = null;
      reject(new Error("엔진 분석 시간이 초과되었습니다."));
    }, 30000);

    currentAnalysis = {
      token,
      timeout,
      reject,

      onLine(line) {
        if (currentAnalysis?.token !== token) return;

        if (line.startsWith("info ") && line.includes(" pv ")) {
          const tokens = line.split(/\s+/);

          const depthIndex = tokens.indexOf("depth");
          const multiPvIndex = tokens.indexOf("multipv");
          const pvIndex = tokens.indexOf("pv");

          const d =
            depthIndex >= 0
              ? Number(tokens[depthIndex + 1])
              : 0;

          const multiPv =
            multiPvIndex >= 0
              ? Number(tokens[multiPvIndex + 1])
              : 1;

          const score = whiteScore(
            parseScore(tokens),
            turn
          );

          const pv =
            pvIndex >= 0
              ? tokens.slice(pvIndex + 1)
              : [];

          result.depth = Math.max(result.depth, d);

          if (score !== null && pv.length) {
            result.lines.set(multiPv, {
              score,
              pv
            });
          }

          if (d > 0) {
            renderProgress(
              Math.min(95, (d / depth) * 100),
              d
            );
          }
        }

        if (line.startsWith("bestmove")) {
          clearTimeout(timeout);
          currentAnalysis = null;

          result.lines = [...result.lines.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, value]) => value);

          analysisCache.set(fen, result);

          resolve(result);
        }
      }
    };

    engine.postMessage("position fen " + fen);
    engine.postMessage(`go depth ${depth}`);
  });
}

function buildPositions(chess) {
  const list = [];

  let c = new Chess();

  list.push({
    ply: 0,
    fen: c.fen(),
    san: null,
    uci: null
  });

  chess.history({ verbose: true }).forEach((move, index) => {
    const made = c.move(move.san);

    list.push({
      ply: index + 1,
      fen: c.fen(),
      san: made.san,
      uci: `${made.from}${made.to}${made.promotion || ""}`
    });
  });

  return list;
}

function renderBoard(fen) {
  const c = new Chess(fen);
  const board = c.board();

  const white = {
    p: "♙",
    n: "♘",
    b: "♗",
    r: "♖",
    q: "♕",
    k: "♔"
  };

  const black = {
    p: "♟",
    n: "♞",
    b: "♝",
    r: "♜",
    q: "♛",
    k: "♚"
  };

  els.board.innerHTML = "";

  board.forEach((row, ri) => {
    row.forEach((piece, ci) => {
      const square = document.createElement("div");

      square.className =
        `sq ${(ri + ci) % 2 === 0 ? "light" : "dark"}`;

      if (piece) {
        square.textContent =
          piece.color === "w"
            ? white[piece.type]
            : black[piece.type];
      }

      els.board.appendChild(square);
    });
  });
}

function renderMoves() {
  els.moveList.innerHTML = "";

  positions.forEach((position, index) => {
    if (index === 0) return;

    const button = document.createElement("button");

    button.className =
      `moveItem ${index === currentPly ? "active" : ""}`;

    button.textContent =
      `${Math.ceil(index / 2)}${index % 2 ? "." : "…"} ${position.san}`;

    button.onclick = () => selectPly(index);

    els.moveList.appendChild(button);
  });
}


/* =========================================================
   인간 관점 분석
   ========================================================= */

const PIECE_NAMES = {
  p: "폰",
  n: "나이트",
  b: "비숍",
  r: "룩",
  q: "퀸",
  k: "킹"
};

const COLOR_NAMES = {
  w: "백",
  b: "흑"
};

const START_SQUARES = {
  w: {
    n: ["b1", "g1"],
    b: ["c1", "f1"],
    r: ["a1", "h1"],
    q: ["d1"],
    k: ["e1"]
  },
  b: {
    n: ["b8", "g8"],
    b: ["c8", "f8"],
    r: ["a8", "h8"],
    q: ["d8"],
    k: ["e8"]
  }
};

function squareName(square) {
  if (!square) return "";

  return square[0].toUpperCase() + square.slice(1);
}

function findOwnPiece(board, color, type) {
  for (const row of board) {
    for (const piece of row) {
      if (
        piece &&
        piece.color === color &&
        piece.type === type
      ) {
        return piece;
      }
    }
  }

  return null;
}

function findPieces(board, color, type) {
  const result = [];

  board.forEach((row, ri) => {
    row.forEach((piece, ci) => {
      if (
        piece &&
        piece.color === color &&
        piece.type === type
      ) {
        const file = String.fromCharCode(97 + ci);
        const rank = 8 - ri;

        result.push({
          piece,
          square: `${file}${rank}`
        });
      }
    });
  });

  return result;
}

function isStartingSquare(color, type, square) {
  return START_SQUARES[color]?.[type]?.includes(square);
}

function getLegalMobility(chess, square) {
  try {
    return chess.moves({
      square,
      verbose: true
    }).length;
  } catch {
    return 0;
  }
}

function getFirstBlockingPiece(board, square, dr, dc) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);

  let r = 8 - rank;
  let c = file;

  r += dr;
  c += dc;

  while (
    r >= 0 &&
    r < 8 &&
    c >= 0 &&
    c < 8
  ) {
    const piece = board[r][c];

    if (piece) {
      return piece;
    }

    r += dr;
    c += dc;
  }

  return null;
}

function bishopBlockingReason(board, square, color) {
  const directions = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1]
  ];

  let blockedByPawn = 0;

  for (const [dr, dc] of directions) {
    const blocker = getFirstBlockingPiece(
      board,
      square,
      dr,
      dc
    );

    if (
      blocker &&
      blocker.color === color &&
      blocker.type === "p"
    ) {
      blockedByPawn++;
    }
  }

  return blockedByPawn;
}

function rookBlockingReason(board, square, color) {
  const directions = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1]
  ];

  for (const [dr, dc] of directions) {
    const blocker = getFirstBlockingPiece(
      board,
      square,
      dr,
      dc
    );

    if (
      blocker &&
      blocker.color === color &&
      blocker.type === "p"
    ) {
      return true;
    }
  }

  return false;
}

function describePieceActivity(chess) {
  const board = chess.board();
  const color = chess.turn();
  const colorName = COLOR_NAMES[color];

  const knights = findPieces(board, color, "n");
  const bishops = findPieces(board, color, "b");
  const rooks = findPieces(board, color, "r");

  /* 1. 아직 전개되지 않은 나이트 */
  for (const item of knights) {
    if (isStartingSquare(color, "n", item.square)) {
      return `${colorName}의 ${squareName(item.square)} 나이트가 아직 출발 위치에 머물러 있어 중앙에서 활동하지 못하고 있습니다. 나이트를 전개해 중앙 통제와 다른 기물의 활동에 참여시키는 것이 좋습니다.`;
    }
  }

  /* 2. 비숍을 자기 폰이 막고 있는 경우 */
  for (const item of bishops) {
    const blocked = bishopBlockingReason(
      board,
      item.square,
      color
    );

    if (blocked > 0) {
      const mobility = getLegalMobility(
        chess,
        item.square
      );

      if (mobility <= 2) {
        return `${colorName}의 ${squareName(item.square)} 비숍은 자신의 폰에 막혀 있어 현재 활동 범위가 매우 제한되어 있습니다. 비숍이 사용할 대각선을 열어주는 것이 중요한 후보가 될 수 있습니다.`;
      }

      return `${colorName}의 ${squareName(item.square)} 비숍은 자신의 폰에 일부 막혀 있어 활동 범위가 제한되어 있습니다. 폰을 전진시키거나 구조를 바꿔 비숍의 대각선을 열 수 있는지 살펴볼 필요가 있습니다.`;
    }
  }

  /* 3. 룩이 자기 폰 뒤에 갇혀 있는 경우 */
  for (const item of rooks) {
    if (rookBlockingReason(
      board,
      item.square,
      color
    )) {
      return `${colorName}의 ${squareName(item.square)} 룩은 자신의 폰 뒤에 있어 아직 활동할 수 있는 공간이 제한되어 있습니다. 열린 파일이나 반열린 파일로 룩을 연결하는 것이 좋은 장기 계획이 될 수 있습니다.`;
    }
  }

  /* 4. 움직임이 거의 없는 나이트 */
  for (const item of knights) {
    const mobility = getLegalMobility(
      chess,
      item.square
    );

    if (mobility <= 1) {
      return `${colorName}의 ${squareName(item.square)} 나이트는 현재 이동할 수 있는 칸이 거의 없어 활동성이 낮습니다. 더 좋은 전초기지나 중앙의 활동적인 칸을 확보할 수 있는지 살펴보는 것이 좋습니다.`;
    }
  }

  /* 5. 전체적으로 활동성이 괜찮은 경우 */
  return `${colorName}의 주요 기물들은 현재 비교적 활동할 수 있는 위치에 있습니다. 다음 수에서는 단순히 기물을 움직이기보다 상대보다 더 좋은 활동 범위를 확보하는 수를 찾아보는 것이 좋습니다.`;
}


/* =========================================================
   킹의 안전 분석
   ========================================================= */

function getKingInfo(chess, color) {
  const board = chess.board();
  const kings = findPieces(board, color, "k");

  if (!kings.length) return null;

  return kings[0];
}

function getKingZoneSquares(square) {
  if (!square) return [];

  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;

  const result = [];

  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;

      const r = rank + dr;
      const c = file + dc;

      if (
        r >= 0 &&
        r < 8 &&
        c >= 0 &&
        c < 8
      ) {
        result.push(
          `${String.fromCharCode(97 + c)}${r + 1}`
        );
      }
    }
  }

  return result;
}

function countKingDefenders(chess, color, kingSquare) {
  let count = 0;

  const zone = getKingZoneSquares(kingSquare);
  const board = chess.board();

  for (const square of zone) {
    const file = square.charCodeAt(0) - 97;
    const rank = 8 - Number(square[1]);

    const piece = board[rank]?.[file];

    if (
      piece &&
      piece.color === color
    ) {
      count++;
    }
  }

  return count;
}

function countKingPawnShield(chess, color, kingSquare) {
  const board = chess.board();

  if (!kingSquare) return 0;

  const file = kingSquare.charCodeAt(0) - 97;
  const rank = Number(kingSquare[1]);

  const direction = color === "w" ? 1 : -1;

  let count = 0;

  for (let dc = -1; dc <= 1; dc++) {
    const c = file + dc;
    const r = rank - 1 + direction;

    if (
      r >= 0 &&
      r < 8 &&
      c >= 0 &&
      c < 8
    ) {
      const piece = board[r][c];

      if (
        piece &&
        piece.color === color &&
        piece.type === "p"
      ) {
        count++;
      }
    }
  }

  return count;
}

function isKingOnStartingSquare(color, square) {
  return color === "w"
    ? square === "e1"
    : square === "e8";
}

function countEnemyLongRangePieces(chess, color) {
  const enemy = color === "w" ? "b" : "w";
  const board = chess.board();

  let score = 0;

  const queens = findPieces(board, enemy, "q");
  const rooks = findPieces(board, enemy, "r");
  const bishops = findPieces(board, enemy, "b");

  score += queens.length * 2;
  score += rooks.length;
  score += bishops.length;

  return score;
}

function describeKingSafety(chess) {
  const side = chess.turn();
  const opponent = side === "w" ? "b" : "w";

  const sideName = COLOR_NAMES[side];

  const king = getKingInfo(chess, side);

  if (!king) {
    return `${sideName} 킹의 위치를 확인할 수 없습니다.`;
  }

  /* 현재 체크 */
  if (chess.isCheck()) {
    return `${sideName} 킹은 현재 체크를 받고 있습니다. 지금은 일반적인 기물 활동보다 먼저 체크를 해결하고 킹의 안전을 확보하는 것이 최우선입니다.`;
  }

  const defenders = countKingDefenders(
    chess,
    side,
    king.square
  );

  const pawnShield = countKingPawnShield(
    chess,
    side,
    king.square
  );

  const longRangePressure =
    countEnemyLongRangePieces(
      chess,
      side
    );

  const kingOnStart =
    isKingOnStartingSquare(
      side,
      king.square
    );

  /* 킹 주변 방어가 충분한 경우 */
  if (
    pawnShield >= 2 &&
    defenders >= 2 &&
    kingOnStart
  ) {
    return `${sideName} 킹은 현재 비교적 안전한 편입니다. 킹 주변의 폰과 방어 기물이 갖춰져 있어 당장 킹을 직접적으로 흔들기 어렵습니다. 지금은 킹을 움직이기보다 다른 기물의 활동성과 중앙 상황에 집중할 여지가 있습니다.`;
  }

  /* 폰 방패가 약한 경우 */
  if (pawnShield <= 1) {
    return `${sideName} 킹 주변의 폰 방패가 약해져 있습니다. 당장 공격받고 있지는 않지만 상대의 퀸이나 룩이 킹 쪽으로 접근하면 위험이 커질 수 있으므로 킹 주변을 보강하는 것이 중요합니다.`;
  }

  /* 방어 기물이 적은 경우 */
  if (defenders <= 1) {
    return `${sideName} 킹 주변에 방어 기물이 많지 않습니다. 현재 즉각적인 위협은 크지 않지만 상대 기물이 킹 주변에 모이면 방어가 어려워질 수 있으므로 공격받기 전에 대응할 필요가 있습니다.`;
  }

  /* 킹이 중앙에 남아 있고 장거리 기물이 많은 경우 */
  if (
    kingOnStart &&
    longRangePressure >= 3
  ) {
    return `${sideName} 킹이 아직 중앙에 남아 있고 상대의 퀸·룩·비숍 같은 장거리 기물이 충분히 활동할 수 있습니다. 중앙이 열리면 킹의 위험도가 빠르게 올라갈 수 있으므로 캐슬링이나 중앙을 닫는 계획을 고려할 만합니다.`;
  }

  /* 기본적인 안전 */
  return `${sideName} 킹은 현재 즉각적인 공격을 받고 있지는 않아 비교적 버틸 수 있는 상태입니다. 다만 킹 주변의 방어와 상대 기물의 접근 가능성을 계속 확인하면서 다음 계획을 선택하는 것이 좋습니다.`;
}


/* =========================================================
   인간 관점 요소 표시
   ========================================================= */

function renderFactors(fen) {
  const c = new Chess(fen);
  const board = c.board();

  let material = 0;

  const values = {
    p: 1,
    n: 3.2,
    b: 3.3,
    r: 5,
    q: 9,
    k: 0
  };

  board.flat().forEach(piece => {
    if (piece) {
      material +=
        (piece.color === "w" ? 1 : -1) *
        values[piece.type];
    }
  });

  const side =
    c.turn() === "w"
      ? "백"
      : "흑";

  const activityText =
    describePieceActivity(c);

  const kingSafetyText =
    describeKingSafety(c);

  els.humanFactors.innerHTML = [
    [
      "물질",
      Math.abs(material) < 0.3
        ? "기물 가치가 거의 동일합니다."
        : "기물 가치 차이가 있습니다."
    ],

    [
      "기물 활동",
      activityText
    ],

    [
      "킹 안전",
      kingSafetyText
    ],

    [
      "계획",
      `현재 ${side}의 차례입니다. 내 계획과 함께 상대의 다음 위협을 확인하세요.`
    ]
  ]
    .map(
      ([title, text]) =>
        `<div class="factor"><b>${title}</b><span>${text}</span></div>`
    )
    .join("");
}


/* =========================================================
   엔진 분석 결과 표시
   ========================================================= */

function renderAnalysis(result) {
  const position = positions[currentPly];

  const evaluation =
    result.lines[0]?.score ?? null;

  els.evalValue.textContent =
    formatScore(evaluation);

  els.positionInsight.textContent =
    scoreLabel(evaluation);

  els.depthValue.textContent =
    result.depth || "—";

  els.progressBar.style.width = "100%";

  els.candidateList.innerHTML = "";

  const labels = [
    "엔진 최선",
    "전략적 후보",
    "실전적 후보"
  ];

  const descriptions = [
    "현재 포지션에서 엔진 평가를 가장 잘 유지하는 수입니다.",
    "최선과 평가 차이가 작을 때 계획 선택지로 볼 수 있습니다.",
    "평가를 크게 훼손하지 않으면서 실전에서 이해하기 쉬운 선택지입니다."
  ];

  result.lines
    .slice(0, 3)
    .forEach((line, index) => {
      const san = uciToSan(
        position.fen,
        line.pv[0] || ""
      );

      els.candidateList.insertAdjacentHTML(
        "beforeend",
        `<div class="candidate">
          <div class="candidateTop">
            <span class="candidateName">
              ${index + 1}. ${san} · ${labels[index]}
            </span>
            <span class="candidateScore">
              ${formatScore(line.score)}
            </span>
          </div>
          <div class="candidateDesc">
            ${descriptions[index]}
          </div>
        </div>`
      );
    });

  renderFactors(position.fen);
}


/* =========================================================
   수 이동 / 화면
   ========================================================= */

async function selectPly(ply) {
  currentPly =
    Math.max(
      0,
      Math.min(
        positions.length - 1,
        ply
      )
    );

  const position =
    positions[currentPly];

  renderBoard(position.fen);
  renderMoves();

  els.moveLabel.textContent =
    `${currentPly} / ${positions.length - 1}`;

  els.positionLabel.textContent =
    currentPly === 0
      ? "시작 포지션"
      : `${Math.ceil(currentPly / 2)}${
          currentPly % 2 ? ". " : "… "
        }${position.san}`;

  els.firstBtn.disabled =
    currentPly === 0;

  els.prevBtn.disabled =
    currentPly === 0;

  els.nextBtn.disabled =
    currentPly === positions.length - 1;

  els.lastBtn.disabled =
    currentPly === positions.length - 1;

  clearError();

  renderProgress(0, 0);

  els.evalValue.textContent =
    "분석 중…";

  els.candidateList.innerHTML = "";

  renderFactors(position.fen);

  try {
    const result =
      await analyzeFen(
        position.fen,
        10
      );

    if (ply === currentPly) {
      renderAnalysis(result);
    }
  } catch (error) {
    if (
      error.message !==
        "이전 분석이 취소되었습니다." &&
      ply === currentPly
    ) {
      showError(
        error.message ||
        "분석에 실패했습니다."
      );
    }
  }
}

async function startGame() {
  clearError();

  const text =
    els.pgnInput.value.trim();

  if (!text) {
    showError("PGN을 입력해주세요.");
    return;
  }

  let chess = new Chess();

  try {
    chess.loadPgn(
      text,
      {
        strict: false
      }
    );
  } catch {
    showError(
      "PGN을 읽을 수 없습니다. 수순 형식과 PGN 태그를 확인해주세요."
    );
    return;
  }

  positions =
    buildPositions(chess);

  currentPly = 0;

  analysisCache.clear();

  els.inputView.hidden = true;
  els.analysisView.hidden = false;

  els.gameMeta.textContent =
    `${positions.length - 1}수`;

  renderMoves();

  await initEngine();

  await selectPly(0);
}


/* =========================================================
   버튼
   ========================================================= */

els.exampleBtn.onclick = () => {
  els.pgnInput.value = EXAMPLE;
  clearError();
};

els.analyzeBtn.onclick = async () => {
  els.analyzeBtn.disabled = true;

  try {
    await startGame();
  } finally {
    els.analyzeBtn.disabled = false;
  }
};

els.backBtn.onclick = () => {
  cancelCurrentAnalysis();

  els.analysisView.hidden = true;
  els.inputView.hidden = false;
};

els.firstBtn.onclick =
  () => selectPly(0);

els.prevBtn.onclick =
  () => selectPly(currentPly - 1);

els.nextBtn.onclick =
  () => selectPly(currentPly + 1);

els.lastBtn.onclick =
  () => selectPly(
    positions.length - 1
  );


/* =========================================================
   시작
   ========================================================= */

initEngine().catch(() => {});
