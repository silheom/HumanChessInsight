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

const EXAMPLE = `[Event "Human Chess Insight Demo"]\n[Site "Local"]\n[Date "2026.01.01"]\n[Round "1"]\n[White "White"]\n[Black "Black"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 *`;

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
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }

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

          const score = whiteScore(parseScore(tokens), turn);

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
   사람의 관점 - 기물 활동 분석
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

function squareName(row, col) {
  return "abcdefgh"[col] + String(8 - row);
}

function findOwnPiece(c, color, type, square) {
  const board = c.board();

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];

      if (
        piece &&
        piece.color === color &&
        piece.type === type &&
        (!square || squareName(row, col) === square)
      ) {
        return {
          piece,
          square: squareName(row, col),
          row,
          col
        };
      }
    }
  }

  return null;
}

function findPieces(c, color, type) {
  const result = [];
  const board = c.board();

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];

      if (piece && piece.color === color && piece.type === type) {
        result.push({
          piece,
          square: squareName(row, col),
          row,
          col
        });
      }
    }
  }

  return result;
}

function isStartingSquare(color, type, square) {
  return START_SQUARES[color]?.[type]?.includes(square);
}

function getLegalMobility(c, square) {
  try {
    return c.moves({
      square,
      verbose: true
    }).length;
  } catch {
    return 0;
  }
}

function getFirstBlockingPiece(c, square, dr, dc) {
  const file = "abcdefgh".indexOf(square[0]);
  const rank = Number(square[1]);

  let row = 8 - rank + dr;
  let col = file + dc;

  while (
    row >= 0 &&
    row < 8 &&
    col >= 0 &&
    col < 8
  ) {
    const piece = c.board()[row][col];

    if (piece) {
      return {
        piece,
        square: squareName(row, col)
      };
    }

    row += dr;
    col += dc;
  }

  return null;
}

function bishopBlockingReason(c, info) {
  const directions = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1]
  ];

  const blockers = [];

  for (const [dr, dc] of directions) {
    const blocker = getFirstBlockingPiece(
      c,
      info.square,
      dr,
      dc
    );

    if (
      blocker &&
      blocker.piece.color === info.piece.color &&
      blocker.piece.type === "p"
    ) {
      blockers.push(blocker.square);
    }
  }

  if (blockers.length === 0) return null;

  const color = COLOR_NAMES[info.piece.color];

  if (blockers.length === 1) {
    return `${color}의 ${info.square} 비숍은 자신의 ${blockers[0]} 폰에 막혀 있어 현재 활동 범위가 제한되어 있습니다.`;
  }

  return `${color}의 ${info.square} 비숍은 자신의 폰들에 막혀 있어 현재 활동할 수 있는 대각선이 제한되어 있습니다.`;
}

function rookBlockingReason(c, info) {
  const directions = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1]
  ];

  for (const [dr, dc] of directions) {
    const blocker = getFirstBlockingPiece(
      c,
      info.square,
      dr,
      dc
    );

    if (
      blocker &&
      blocker.piece.color === info.piece.color &&
      blocker.piece.type === "p"
    ) {
      return `${COLOR_NAMES[info.piece.color]}의 ${info.square} 룩은 ${blocker.square}의 자기 폰 뒤에 있어 아직 활동할 수 있는 공간이 제한되어 있습니다.`;
    }
  }

  return null;
}

function describePieceActivity(c) {
  const color = c.turn();
  const colorName = COLOR_NAMES[color];

  const pieces = [];

  for (const type of ["n", "b", "r", "q"]) {
    findPieces(c, color, type).forEach(info => {
      pieces.push({
        ...info,
        type,
        mobility: getLegalMobility(c, info.square)
      });
    });
  }

  /*
   * 1순위:
   * 아직 출발 위치에 있는 나이트/비숍
   */
  const undevelopedMinor = pieces.filter(info =>
    ["n", "b"].includes(info.type) &&
    isStartingSquare(color, info.type, info.square)
  );

  for (const info of undevelopedMinor) {
    if (info.type === "b") {
      const blocked = bishopBlockingReason(c, info);

      if (blocked) {
        return blocked;
      }
    }

    if (info.type === "n") {
      return `${colorName}의 ${info.square} 나이트가 아직 출발 위치에 머물러 있어 중앙에서 활동하지 못하고 있습니다. 나이트를 전개해 중앙 통제와 다른 기물의 활동에 참여시키는 것이 좋습니다.`;
    }

    if (info.type === "b") {
      return `${colorName}의 ${info.square} 비숍이 아직 전개되지 않았습니다. 비숍의 대각선을 열어 기물 전체의 전개를 마무리하는 것이 좋습니다.`;
    }
  }

  /*
   * 2순위:
   * 비숍이 자기 폰에 막혀 있는 경우
   */
  const bishops = pieces.filter(info => info.type === "b");

  for (const bishop of bishops) {
    const blocked = bishopBlockingReason(c, bishop);

    if (blocked) {
      return blocked;
    }
  }

  /*
   * 3순위:
   * 룩이 자기 폰 뒤에 갇혀 있는 경우
   */
  const rooks = pieces.filter(info => info.type === "r");

  for (const rook of rooks) {
    const blocked = rookBlockingReason(c, rook);

    if (blocked) {
      return blocked;
    }
  }

  /*
   * 4순위:
   * 나이트의 이동 가능 칸이 매우 적은 경우
   */
  const knights = pieces.filter(info => info.type === "n");

  for (const knight of knights) {
    if (knight.mobility <= 1) {
      return `${colorName}의 ${knight.square} 나이트는 현재 이동할 수 있는 칸이 매우 제한되어 있어 활동성이 낮습니다. 주변 폰 구조를 바꾸거나 더 좋은 전초기지를 확보하는 방법을 고려할 수 있습니다.`;
    }
  }

  /*
   * 5순위:
   * 전반적으로 기물들이 어느 정도 전개된 경우
   */
  if (pieces.length > 0) {
    const averageMobility =
      pieces.reduce((sum, piece) => sum + piece.mobility, 0) /
      pieces.length;

    if (averageMobility >= 4) {
      return `${colorName}의 주요 기물들이 비교적 활발하게 배치되어 있습니다. 현재는 특정 기물의 전개보다 상대의 약점과 다음 계획을 살펴보는 것이 중요합니다.`;
    }
  }

  return `${colorName}의 기물 배치는 아직 뚜렷한 문제를 보이지 않습니다. 각 기물이 중앙과 주요 공격선에서 얼마나 활동하고 있는지 살펴보세요.`;
}


/* =========================================================
   사람의 관점 - 현재 요소 표시
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

  const activityText = describePieceActivity(c);

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
      c.isCheck()
        ? "현재 체크 상태입니다."
        : "킹 주변의 안전과 상대의 공격 가능성을 확인하세요."
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

function renderAnalysis(result) {
  const position = positions[currentPly];
  const evaluation = result.lines[0]?.score ?? null;

  els.evalValue.textContent = formatScore(evaluation);
  els.positionInsight.textContent = scoreLabel(evaluation);
  els.depthValue.textContent = result.depth || "—";
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

  result.lines.slice(0, 3).forEach((line, index) => {
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

async function selectPly(ply) {
  currentPly = Math.max(
    0,
    Math.min(
      positions.length - 1,
      ply
    )
  );

  const position = positions[currentPly];

  renderBoard(position.fen);
  renderMoves();

  els.moveLabel.textContent =
    `${currentPly} / ${positions.length - 1}`;

  els.positionLabel.textContent =
    currentPly === 0
      ? "시작 포지션"
      : `${Math.ceil(currentPly / 2)}${currentPly % 2 ? ". " : "… "}${position.san}`;

  els.firstBtn.disabled = currentPly === 0;
  els.prevBtn.disabled = currentPly === 0;
  els.nextBtn.disabled =
    currentPly === positions.length - 1;
  els.lastBtn.disabled =
    currentPly === positions.length - 1;

  clearError();

  renderProgress(0, 0);

  els.evalValue.textContent = "분석 중…";
  els.candidateList.innerHTML = "";

  renderFactors(position.fen);

  try {
    const result = await analyzeFen(
      position.fen,
      10
    );

    if (ply === currentPly) {
      renderAnalysis(result);
    }
  } catch (error) {
    if (
      error.message !== "이전 분석이 취소되었습니다." &&
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
    chess.loadPgn(text, {
      strict: false
    });
  } catch {
    showError(
      "PGN을 읽을 수 없습니다. 수순 형식과 PGN 태그를 확인해주세요."
    );
    return;
  }

  positions = buildPositions(chess);
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

els.firstBtn.onclick = () =>
  selectPly(0);

els.prevBtn.onclick = () =>
  selectPly(currentPly - 1);

els.nextBtn.onclick = () =>
  selectPly(currentPly + 1);

els.lastBtn.onclick = () =>
  selectPly(positions.length - 1);

initEngine().catch(() => {});
