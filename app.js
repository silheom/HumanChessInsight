import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

const $ = id => document.getElementById(id);

const els = {
  inputView: $("inputView"),
  analysisView: $("analysisView"),
  pgnInput: $("pgnInput"),
  analyzeBtn: $("analyzeBtn"),
  exampleBtn: $("exampleBtn"),
  backBtn: $("backBtn"),
  errorBox: $("errorBox"),
  engineStatus: $("engineStatus"),
  board: $("board"),
  moveList: $("moveList"),
  moveLabel: $("moveLabel"),
  positionLabel: $("positionLabel"),
  gameMeta: $("gameMeta"),
  evalValue: $("evalValue"),
  depthValue: $("depthValue"),
  progressBar: $("progressBar"),
  positionInsight: $("positionInsight"),
  candidateList: $("candidateList"),
  humanFactors: $("humanFactors"),
  firstBtn: $("firstBtn"),
  prevBtn: $("prevBtn"),
  nextBtn: $("nextBtn"),
  lastBtn: $("lastBtn")
};

const EXAMPLE = `[Event "Human Chess Insight Demo"]
[Site "Local"]
[Date "2026.01.01"]
[Round "1"]
[White "White"]
[Black "Black"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 *`;

const ENGINE_PATH =
  new URL("stockfish/stockfish-19-lite-single.js", import.meta.url).toString();

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
  els.progressBar.style.width =
    `${Math.max(0, Math.min(100, percent))}%`;

  els.depthValue.textContent =
    depth ? String(depth) : "—";
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
      reject(
        new Error("Stockfish 로딩 시간이 초과되었습니다.")
      );
    }, 30000);

    engine.onerror = event => {
      clearTimeout(timer);
      reject(
        new Error(
          event?.message || "Stockfish Worker 오류"
        )
      );
    };

    engine.onmessage = event => {
      const line =
        typeof event.data === "string"
          ? event.data.trim()
          : "";

      if (!line) return;

      if (
        line === "uciok" &&
        phase === "boot"
      ) {
        phase = "waiting-ready";

        engine.postMessage(
          "setoption name MultiPV value 3"
        );

        engine.postMessage("isready");
        return;
      }

      if (
        line === "readyok" &&
        phase === "waiting-ready"
      ) {
        clearTimeout(timer);

        phase = "ready";
        engineReady = true;

        setStatus(
          "Stockfish 준비 완료",
          "ready"
        );

        resolve();
        return;
      }

      if (currentAnalysis) {
        currentAnalysis.onLine(line);
      }
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

  if (!kind || Number.isNaN(value)) {
    return null;
  }

  if (kind === "cp") {
    return {
      type: "cp",
      raw: value
    };
  }

  if (kind === "mate") {
    return {
      type: "mate",
      raw: value
    };
  }

  return null;
}

function whiteScore(score, turn) {
  if (!score) return null;

  if (score.type === "cp") {
    return (
      (turn === "w"
        ? score.raw
        : -score.raw) / 100
    );
  }

  const sign =
    score.raw > 0 ? 1 : -1;

  return turn === "w"
    ? sign * 100
    : -sign * 100;
}

function formatScore(value) {
  if (
    value === null ||
    value === undefined ||
    Number.isNaN(value)
  ) {
    return "—";
  }

  if (Math.abs(value) >= 99) {
    return value > 0 ? "+M" : "−M";
  }

  return `${
    value >= 0 ? "+" : "−"
  }${Math.abs(value).toFixed(1)}`;
}

function scoreLabel(value) {
  const a = Math.abs(value ?? 0);

  if (a < 0.25) {
    return "균형에 가까운 포지션입니다.";
  }

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

  old.reject?.(
    new Error("이전 분석이 취소되었습니다.")
  );

  if (engineReady && engine) {
    engine.postMessage("stop");
  }
}

function analyzeFen(fen, depth = 10) {
  if (analysisCache.has(fen)) {
    return Promise.resolve(
      analysisCache.get(fen)
    );
  }

  if (!engineReady || !engine) {
    return Promise.reject(
      new Error(
        "Stockfish가 아직 준비되지 않았습니다."
      )
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
      if (
        currentAnalysis?.token !== token
      ) {
        return;
      }

      currentAnalysis = null;

      reject(
        new Error(
          "엔진 분석 시간이 초과되었습니다."
        )
      );
    }, 30000);

    currentAnalysis = {
      token,
      timeout,
      reject,

      onLine(line) {
        if (
          currentAnalysis?.token !== token
        ) {
          return;
        }

        if (
          line.startsWith("info ") &&
          line.includes(" pv ")
        ) {
          const tokens =
            line.split(/\s+/);

          const depthIndex =
            tokens.indexOf("depth");

          const multiPvIndex =
            tokens.indexOf("multipv");

          const pvIndex =
            tokens.indexOf("pv");

          const d =
            depthIndex >= 0
              ? Number(
                  tokens[depthIndex + 1]
                )
              : 0;

          const multiPv =
            multiPvIndex >= 0
              ? Number(
                  tokens[multiPvIndex + 1]
                )
              : 1;

          const score = whiteScore(
            parseScore(tokens),
            turn
          );

          const pv =
            pvIndex >= 0
              ? tokens.slice(
                  pvIndex + 1
                )
              : [];

          result.depth =
            Math.max(
              result.depth,
              d
            );

          if (
            score !== null &&
            pv.length
          ) {
            result.lines.set(
              multiPv,
              {
                score,
                pv
              }
            );
          }

          if (d > 0) {
            renderProgress(
              Math.min(
                95,
                (d / depth) * 100
              ),
              d
            );
          }
        }

        if (
          line.startsWith("bestmove")
        ) {
          clearTimeout(timeout);

          currentAnalysis = null;

          result.lines =
            [...result.lines.entries()]
              .sort(
                (a, b) =>
                  a[0] - b[0]
              )
              .map(
                ([, value]) =>
                  value
              );

          analysisCache.set(
            fen,
            result
          );

          resolve(result);
        }
      }
    };

    engine.postMessage(
      "position fen " + fen
    );

    engine.postMessage(
      `go depth ${depth}`
    );
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

  chess
    .history({ verbose: true })
    .forEach((move, index) => {
      const made = c.move(
        move.san
      );

      list.push({
        ply: index + 1,
        fen: c.fen(),
        san: made.san,
        uci:
          `${made.from}${made.to}${made.promotion || ""}`
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
      const square =
        document.createElement("div");

      square.className =
        `sq ${
          (ri + ci) % 2 === 0
            ? "light"
            : "dark"
        }`;

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

  positions.forEach(
    (position, index) => {
      if (index === 0) return;

      const button =
        document.createElement("button");

      button.className =
        `moveItem ${
          index === currentPly
            ? "active"
            : ""
        }`;

      button.textContent =
        `${Math.ceil(index / 2)}${
          index % 2 ? "." : "…"
        } ${position.san}`;

      button.onclick = () =>
        selectPly(index);

      els.moveList.appendChild(
        button
      );
    }
  );
}


/* =========================================================
   인간 관점 분석
   ========================================================= */

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

function findPieces(board, color, type) {
  const result = [];

  board.forEach((row, ri) => {
    row.forEach((piece, ci) => {
      if (
        piece &&
        piece.color === color &&
        piece.type === type
      ) {
        const file =
          String.fromCharCode(
            97 + ci
          );

        const rank = 8 - ri;

        result.push({
          piece,
          square:
            `${file}${rank}`
        });
      }
    });
  });

  return result;
}

function isStartingSquare(
  color,
  type,
  square
) {
  return (
    START_SQUARES[color]?.[type]
      ?.includes(square) ?? false
  );
}

function getLegalMobility(
  chess,
  square
) {
  try {
    return chess.moves({
      square,
      verbose: true
    }).length;
  } catch {
    return 0;
  }
}

function getPieceAt(
  board,
  square
) {
  if (!square) return null;

  const file =
    square.charCodeAt(0) - 97;

  const rank =
    8 - Number(square[1]);

  if (
    rank < 0 ||
    rank >= 8 ||
    file < 0 ||
    file >= 8
  ) {
    return null;
  }

  return board[rank]?.[file] || null;
}

function getFirstBlockingPiece(
  board,
  square,
  dr,
  dc
) {
  const file =
    square.charCodeAt(0) - 97;

  const rank =
    Number(square[1]) - 1;

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


/* ---------------------------------------------------------
   비숍의 실제 전개 가능성
   --------------------------------------------------------- */

function getBishopDiagonalStatus(
  board,
  square,
  color
) {
  const directions = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1]
  ];

  let openDirections = 0;
  let ownPawnBlocks = 0;
  let ownPieceBlocks = 0;

  for (const [dr, dc] of directions) {
    const blocker =
      getFirstBlockingPiece(
        board,
        square,
        dr,
        dc
      );

    if (!blocker) {
      openDirections++;
      continue;
    }

    if (
      blocker.color === color &&
      blocker.type === "p"
    ) {
      ownPawnBlocks++;
    } else if (
      blocker.color === color
    ) {
      ownPieceBlocks++;
    }
  }

  return {
    openDirections,
    ownPawnBlocks,
    ownPieceBlocks
  };
}

function getBishopPlans(
  chess,
  bishop
) {
  const board = chess.board();
  const color = bishop.piece.color;

  const status =
    getBishopDiagonalStatus(
      board,
      bishop.square,
      color
    );

  const plans = [];

  /*
   * 실제로 d7 또는 d2를 통해 전개할 수 있는
   * 비숍인지 확인한다.
   */
  const bishopMoveSquares =
    chess.moves({
      square: bishop.square,
      verbose: true
    })
      .map(move => move.to);

  const naturalDevelopment =
    color === "w"
      ? ["d2", "e3", "f4", "g5", "h6"]
      : ["d7", "e6", "f5", "g4", "h3"];

  const canUseCentralDiagonal =
    naturalDevelopment.some(
      square =>
        bishopMoveSquares.includes(
          square
        )
    );

  /*
   * 피앙케토 가능성:
   * c8 비숍 -> b7
   * f8 비숍 -> g7
   * c1 비숍 -> b2
   * f1 비숍 -> g2
   */
  let fianchettoPlan = null;

  if (
    color === "b" &&
    bishop.square === "c8"
  ) {
    const b7 = getPieceAt(
      board,
      "b7"
    );

    if (
      b7 &&
      b7.color === color &&
      b7.type === "p"
    ) {
      fianchettoPlan =
        "...b6 → ...Bb7";
    }
  }

  if (
    color === "b" &&
    bishop.square === "f8"
  ) {
    const g7 = getPieceAt(
      board,
      "g7"
    );

    if (
      g7 &&
      g7.color === color &&
      g7.type === "p"
    ) {
      fianchettoPlan =
        "...g6 → ...Bg7";
    }
  }

  if (
    color === "w" &&
    bishop.square === "c1"
  ) {
    const b2 = getPieceAt(
      board,
      "b2"
    );

    if (
      b2 &&
      b2.color === color &&
      b2.type === "p"
    ) {
      fianchettoPlan =
        "b3 → Bb2";
    }
  }

  if (
    color === "w" &&
    bishop.square === "f1"
  ) {
    const g2 = getPieceAt(
      board,
      "g2"
    );

    if (
      g2 &&
      g2.color === color &&
      g2.type === "p"
    ) {
      fianchettoPlan =
        "g3 → Bg2";
    }
  }

  return {
    ...status,
    canUseCentralDiagonal,
    fianchettoPlan
  };
}


/* ---------------------------------------------------------
   기물 활동성
   --------------------------------------------------------- */

function describePieceActivity(
  chess,
  phase
) {
  const board = chess.board();
  const color = chess.turn();
  const colorName =
    COLOR_NAMES[color];

  const knights =
    findPieces(
      board,
      color,
      "n"
    );

  const bishops =
    findPieces(
      board,
      color,
      "b"
    );

  const rooks =
    findPieces(
      board,
      color,
      "r"
    );

  /*
   * 오프닝 초반에는 아직 전개되지 않은 기물이
   * 자연스러운 상태일 수 있다.
   */
  if (
    phase === "opening" &&
    chess.history().length <= 4
  ) {
    return `${colorName}의 기물은 아직 오프닝 전개 단계에 있습니다. 지금은 특정 기물이 나쁘다고 보기보다 나이트와 비숍을 자연스럽게 전개하고 중앙에서 활동할 수 있는 자리를 확보하는 것이 중요합니다.`;
  }

  /*
   * 나이트가 출발 위치에 있고
   * 실제로 전개할 수 있는 경우
   */
  for (const item of knights) {
    if (
      isStartingSquare(
        color,
        "n",
        item.square
      )
    ) {
      const mobility =
        getLegalMobility(
          chess,
          item.square
        );

      if (mobility >= 2) {
        return `${colorName}의 ${item.square} 나이트는 아직 출발 위치에 있지만 전개할 수 있는 칸이 충분합니다. 오프닝에서는 이 나이트를 자연스럽게 전개해 중앙 통제와 다른 기물의 활동을 돕는 것을 고려할 수 있습니다.`;
      }
    }
  }

  /*
   * 비숍은 "한쪽이 막혔다"만으로
   * 활동성이 낮다고 판단하지 않는다.
   */
  for (const bishop of bishops) {
    const plan =
      getBishopPlans(
        chess,
        bishop
      );

    const mobility =
      getLegalMobility(
        chess,
        bishop.square
      );

    /*
     * c8 비숍의 경우
     * d7 방향이 살아 있다면
     * b7 쪽 폰 때문에 막혔다는 이유만으로
     * 나쁜 기물이라고 판단하지 않는다.
     */
    if (
      bishop.square ===
        (color === "b"
          ? "c8"
          : "c1")
    ) {
      if (
        plan.canUseCentralDiagonal &&
        mobility > 0
      ) {
        if (
          plan.fianchettoPlan
        ) {
          return `${colorName}의 ${bishop.square} 비숍은 한쪽 대각선이 폰에 의해 제한되어 있지만 다른 대각선은 열려 있어 현재 활동성이 크게 나쁘지 않습니다. 일반적인 전개와 함께 ${plan.fianchettoPlan}처럼 피앙케토를 선택하는 계획도 가능합니다.`;
        }

        return `${colorName}의 ${bishop.square} 비숍은 한쪽 대각선이 자신의 폰에 의해 제한되어 있지만 다른 대각선은 열려 있어 전개할 수 있습니다. 따라서 현재 이 비숍을 단순히 갇힌 기물로 볼 필요는 없습니다.`;
      }
    }

    /*
     * f8 / f1 비숍도 같은 방식으로 처리
     */
    if (
      bishop.square ===
        (color === "b"
          ? "f8"
          : "f1")
    ) {
      if (
        mobility > 0
      ) {
        if (
          plan.fianchettoPlan
        ) {
          return `${colorName}의 ${bishop.square} 비숍은 현재 전개할 수 있는 대각선이 있습니다. 중앙으로 전개할 수도 있고 ${plan.fianchettoPlan}처럼 긴 대각선을 확보하는 계획도 가능합니다.`;
        }

        return `${colorName}의 ${bishop.square} 비숍은 현재 전개할 수 있는 대각선이 있어 활동성이 크게 제한된 상태는 아닙니다. 다음 계획에 따라 중앙이나 긴 대각선으로 배치할 수 있습니다.`;
      }
    }

    /*
     * 정말 움직일 수 없는 비숍만
     * 활동성 문제로 지적
     */
    if (
      mobility <= 1 &&
      plan.ownPawnBlocks >= 2
    ) {
      return `${colorName}의 ${bishop.square} 비숍은 자신의 폰에 여러 방향이 막혀 있어 실제 활동 범위가 제한되어 있습니다. 이 비숍이 사용할 대각선을 열어주는 것이 중요한 장기 계획이 될 수 있습니다.`;
    }
  }

  /*
   * 룩이 자기 폰 뒤에 있지만
   * 오프닝에서는 정상적인 경우가 많다.
   */
  if (phase !== "opening") {
    for (const rook of rooks) {
      const mobility =
        getLegalMobility(
          chess,
          rook.square
        );

      if (
        mobility <= 1
      ) {
        return `${colorName}의 ${rook.square} 룩은 현재 활동할 수 있는 공간이 많지 않습니다. 열린 파일이나 반열린 파일을 확보해 룩을 더 활동적인 위치로 옮길 계획을 생각해볼 수 있습니다.`;
      }
    }
  }

  /*
   * 정말 활동성이 낮은 나이트
   */
  for (const knight of knights) {
    const mobility =
      getLegalMobility(
        chess,
        knight.square
      );

    if (
      mobility <= 1
    ) {
      return `${colorName}의 ${knight.square} 나이트는 현재 이동할 수 있는 칸이 거의 없어 활동성이 낮습니다. 더 좋은 전초기지나 중앙의 활동적인 칸을 확보할 수 있는지 살펴보는 것이 좋습니다.`;
    }
  }

  return `${colorName}의 주요 기물들은 현재 비교적 활동할 수 있는 위치에 있습니다. 다음 수에서는 단순히 기물을 움직이기보다 상대보다 더 좋은 활동 범위를 확보하는 수를 찾아보는 것이 좋습니다.`;
}


/* =========================================================
   게임 단계 판단
   ========================================================= */

function countPiecesByType(
  chess,
  color,
  type
) {
  return findPieces(
    chess.board(),
    color,
    type
  ).length;
}

function getGamePhase(chess) {
  const moveCount =
    chess.history().length;

  const queens =
    countPiecesByType(
      chess,
      "w",
      "q"
    ) +
    countPiecesByType(
      chess,
      "b",
      "q"
    );

  const rooks =
    countPiecesByType(
      chess,
      "w",
      "r"
    ) +
    countPiecesByType(
      chess,
      "b",
      "r"
    );

  const bishops =
    countPiecesByType(
      chess,
      "w",
      "b"
    ) +
    countPiecesByType(
      chess,
      "b",
      "b"
    );

  const knights =
    countPiecesByType(
      chess,
      "w",
      "n"
    ) +
    countPiecesByType(
      chess,
      "b",
      "n"
    );

  /*
   * 아주 초반
   */
  if (
    moveCount <= 12 &&
    queens >= 2 &&
    rooks >= 4 &&
    bishops + knights >= 6
  ) {
    return "opening";
  }

  /*
   * 엔드게임:
   * 퀸이 사라졌거나 기물이 상당히 줄어든 경우
   */
  if (
    queens === 0 ||
    (
      rooks <= 2 &&
      bishops + knights <= 2
    )
  ) {
    return "endgame";
  }

  /*
   * 그 외는 미들게임
   */
  return "middlegame";
}


/* =========================================================
   킹 안전
   ========================================================= */

function getKingInfo(
  chess,
  color
) {
  const kings =
    findPieces(
      chess.board(),
      color,
      "k"
    );

  return kings.length
    ? kings[0]
    : null;
}

function getKingZoneSquares(
  square
) {
  if (!square) return [];

  const file =
    square.charCodeAt(0) - 97;

  const rank =
    Number(square[1]) - 1;

  const result = [];

  for (
    let dr = -1;
    dr <= 1;
    dr++
  ) {
    for (
      let dc = -1;
      dc <= 1;
      dc++
    ) {
      if (
        dr === 0 &&
        dc === 0
      ) {
        continue;
      }

      const r =
        rank + dr;

      const c =
        file + dc;

      if (
        r >= 0 &&
        r < 8 &&
        c >= 0 &&
        c < 8
      ) {
        result.push(
          `${String.fromCharCode(
            97 + c
          )}${r + 1}`
        );
      }
    }
  }

  return result;
}

function countKingDefenders(
  chess,
  color,
  kingSquare
) {
  const board = chess.board();

  let count = 0;

  const zone =
    getKingZoneSquares(
      kingSquare
    );

  for (const square of zone) {
    const piece =
      (() => {
        const file =
          square.charCodeAt(0) -
          97;

        const rank =
          8 -
          Number(square[1]);

        return board[rank]?.[file];
      })();

    if (
      piece &&
      piece.color === color
    ) {
      count++;
    }
  }

  return count;
}

function countKingPawnShield(
  chess,
  color,
  kingSquare
) {
  const board = chess.board();

  if (!kingSquare) return 0;

  const file =
    kingSquare.charCodeAt(0) -
    97;

  const rank =
    Number(kingSquare[1]);

  /*
   * 킹이 어느 쪽에 있는지를 보고
   * 실제 앞쪽의 폰을 확인한다.
   */
  const targetRank =
    color === "w"
      ? rank + 1
      : rank - 1;

  let count = 0;

  for (
    let dc = -1;
    dc <= 1;
    dc++
  ) {
    const c =
      file + dc;

    const boardRow =
      8 - targetRank;

    if (
      boardRow < 0 ||
      boardRow >= 8 ||
      c < 0 ||
      c >= 8
    ) {
      continue;
    }

    const piece =
      board[boardRow][c];

    if (
      piece &&
      piece.color === color &&
      piece.type === "p"
    ) {
      count++;
    }
  }

  return count;
}

function hasCastled(
  chess,
  color
) {
  const king =
    getKingInfo(
      chess,
      color
    );

  if (!king) return false;

  return (
    (
      color === "w" &&
      (
        king.square === "g1" ||
        king.square === "c1"
      )
    ) ||
    (
      color === "b" &&
      (
        king.square === "g8" ||
        king.square === "c8"
      )
    )
  );
}

function countEnemyAttackersNearKing(
  chess,
  color,
  kingSquare
) {
  if (!kingSquare) return 0;

  const enemy =
    color === "w"
      ? "b"
      : "w";

  const zone =
    getKingZoneSquares(
      kingSquare
    );

  let count = 0;

  for (const square of zone) {
    try {
      const attackers =
        chess.attackers(
          square,
          enemy
        );

      count += attackers.length;
    } catch {
      /* 무시 */
    }
  }

  return count;
}

function describeKingSafety(
  chess,
  phase
) {
  const side =
    chess.turn();

  const sideName =
    COLOR_NAMES[side];

  const king =
    getKingInfo(
      chess,
      side
    );

  if (!king) {
    return `${sideName} 킹의 위치를 확인할 수 없습니다.`;
  }

  /*
   * 시작 포지션 및 초반:
   * 킹 안전을 과도하게 문제 삼지 않는다.
   */
  if (
    phase === "opening" &&
    chess.history().length <= 4
  ) {
    return `${sideName} 킹은 아직 오프닝 초기 단계에 있습니다. 현재는 킹을 위험하다고 볼 만한 특별한 징후가 없으므로 빠른 기물 전개와 중앙 장악을 우선하는 것이 자연스럽습니다.`;
  }

  /*
   * 체크
   */
  if (chess.isCheck()) {
    return `${sideName} 킹은 현재 체크를 받고 있습니다. 지금은 다른 계획보다 먼저 체크를 해결하고 킹의 안전을 확보하는 것이 최우선입니다.`;
  }

  /*
   * 엔드게임에서는 킹 안전의 의미 자체가 달라진다.
   */
  if (phase === "endgame") {
    return `${sideName} 킹은 현재 직접적인 공격을 받고 있지 않습니다. 엔드게임에서는 킹을 뒤에 숨겨두는 것보다 중앙으로 적극적으로 가져와 폰과 주요 칸을 통제하는 것이 더 중요할 수 있습니다.`;
  }

  const pawnShield =
    countKingPawnShield(
      chess,
      side,
      king.square
    );

  const defenders =
    countKingDefenders(
      chess,
      side,
      king.square
    );

  const attackers =
    countEnemyAttackersNearKing(
      chess,
      side,
      king.square
    );

  const castled =
    hasCastled(
      chess,
      side
    );

  /*
   * 캐슬링 완료 + 충분한 폰 방패
   */
  if (
    castled &&
    pawnShield >= 2 &&
    attackers === 0
  ) {
    return `${sideName} 킹은 현재 비교적 안전한 편입니다. 이미 캐슬링했고 킹 앞의 폰 구조도 유지되고 있으며 당장 킹 주변으로 들어오는 공격도 보이지 않습니다. 지금은 킹 안전보다 중앙과 기물 활동에 집중하는 것이 좋습니다.`;
  }

  /*
   * 캐슬링했지만 공격 가능성이 있는 경우
   */
  if (
    castled &&
    attackers >= 2
  ) {
    return `${sideName} 킹은 캐슬링으로 기본적인 안전은 확보했지만 상대 기물들이 킹 주변의 칸을 바라보고 있습니다. 당장 위협이라고 단정할 수는 없지만 상대의 공격 기물이 더 모이기 전에 대응할 필요가 있습니다.`;
  }

  /*
   * 캐슬링했고 폰 구조도 정상
   */
  if (
    castled &&
    pawnShield >= 2
  ) {
    return `${sideName} 킹은 현재 안정적인 편입니다. 캐슬링이 완료되어 있고 킹 앞의 폰 방패도 유지되고 있어 당장 킹 안전을 가장 먼저 해결해야 하는 상황은 아닙니다.`;
  }

  /*
   * 아직 중앙에 있는 킹
   */
  const centralKing =
    (
      side === "w" &&
      (
        king.square === "e1" ||
        king.square === "d1"
      )
    ) ||
    (
      side === "b" &&
      (
        king.square === "e8" ||
        king.square === "d8"
      )
    );

  if (
    centralKing &&
    attackers >= 1
  ) {
    return `${sideName} 킹이 아직 중앙에 있고 상대 기물의 공격 가능성이 보입니다. 중앙이 열리면 킹의 위험이 커질 수 있으므로 캐슬링이나 중앙을 안정시키는 계획을 우선적으로 고려하는 것이 좋습니다.`;
  }

  /*
   * 폰 방패가 실제로 약한 경우.
   * 단순히 1개라는 이유가 아니라
   * 공격과 함께 판단한다.
   */
  if (
    pawnShield <= 1 &&
    attackers >= 1
  ) {
    return `${sideName} 킹 주변의 폰 방패가 약해진 상태에서 상대 기물의 접근도 보입니다. 아직 즉각적인 공격이라고 할 정도는 아니지만 킹 쪽을 보강하거나 상대의 공격 기물을 교환하는 것이 중요할 수 있습니다.`;
  }

  /*
   * 그 외
   */
  return `${sideName} 킹은 현재 즉각적인 공격을 받고 있지 않아 비교적 안정적입니다. 킹 안전을 지나치게 걱정하기보다 현재 중앙과 기물의 활동성을 보고 다음 계획을 선택하는 것이 좋습니다.`;
}


/* =========================================================
   인간 관점 표시
   ========================================================= */

function renderFactors(fen) {
  const c =
    new Chess(fen);

  const board =
    c.board();

  let material = 0;

  const values = {
    p: 1,
    n: 3.2,
    b: 3.3,
    r: 5,
    q: 9,
    k: 0
  };

  board.flat().forEach(
    piece => {
      if (piece) {
        material +=
          (
            piece.color === "w"
              ? 1
              : -1
          ) *
          values[piece.type];
      }
    }
  );

  const side =
    c.turn() === "w"
      ? "백"
      : "흑";

  const phase =
    getGamePhase(c);

  const phaseName =
    phase === "opening"
      ? "오프닝"
      : phase === "middlegame"
        ? "미들게임"
        : "엔드게임";

  const activityText =
    describePieceActivity(
      c,
      phase
    );

  const kingSafetyText =
    describeKingSafety(
      c,
      phase
    );

  els.humanFactors.innerHTML = [
    [
      "게임 단계",
      `현재 ${phaseName}입니다.`
    ],

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
      phase === "opening"
        ? `현재 ${side}의 차례입니다. 오프닝에서는 빠른 전개와 중앙 장악을 먼저 생각하고, 그 다음 구체적인 기물 배치를 결정하세요.`
        : phase === "endgame"
          ? `현재 ${side}의 차례입니다. 엔드게임에서는 킹의 활동 범위와 폰 구조, 통과폰을 중심으로 계획을 세우는 것이 중요합니다.`
          : `현재 ${side}의 차례입니다. 내 기물의 활동성과 상대의 위협을 함께 확인한 뒤 다음 계획을 선택하세요.`
    ]
  ]
    .map(
      ([title, text]) =>
        `<div class="factor"><b>${title}</b><span>${text}</span></div>`
    )
    .join("");
}


/* =========================================================
   엔진 결과
   ========================================================= */

function renderAnalysis(result) {
  const position =
    positions[currentPly];

  const evaluation =
    result.lines[0]?.score ??
    null;

  els.evalValue.textContent =
    formatScore(evaluation);

  els.positionInsight.textContent =
    scoreLabel(evaluation);

  els.depthValue.textContent =
    result.depth || "—";

  els.progressBar.style.width =
    "100%";

  els.candidateList.innerHTML =
    "";

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
    .forEach(
      (line, index) => {
        const san =
          uciToSan(
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
      }
    );

  renderFactors(
    position.fen
  );
}


/* =========================================================
   수 이동
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

  renderBoard(
    position.fen
  );

  renderMoves();

  els.moveLabel.textContent =
    `${currentPly} / ${positions.length - 1}`;

  els.positionLabel.textContent =
    currentPly === 0
      ? "시작 포지션"
      : `${Math.ceil(currentPly / 2)}${
          currentPly % 2
            ? ". "
            : "… "
        }${position.san}`;

  els.firstBtn.disabled =
    currentPly === 0;

  els.prevBtn.disabled =
    currentPly === 0;

  els.nextBtn.disabled =
    currentPly ===
    positions.length - 1;

  els.lastBtn.disabled =
    currentPly ===
    positions.length - 1;

  clearError();

  renderProgress(0, 0);

  els.evalValue.textContent =
    "분석 중…";

  els.candidateList.innerHTML =
    "";

  renderFactors(
    position.fen
  );

  try {
    const result =
      await analyzeFen(
        position.fen,
        10
      );

    if (
      ply === currentPly
    ) {
      renderAnalysis(
        result
      );
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
    showError(
      "PGN을 입력해주세요."
    );
    return;
  }

  const chess =
    new Chess();

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
    buildPositions(
      chess
    );

  currentPly = 0;

  analysisCache.clear();

  els.inputView.hidden =
    true;

  els.analysisView.hidden =
    false;

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
  els.pgnInput.value =
    EXAMPLE;

  clearError();
};

els.analyzeBtn.onclick =
  async () => {
    els.analyzeBtn.disabled =
      true;

    try {
      await startGame();
    } finally {
      els.analyzeBtn.disabled =
        false;
    }
  };

els.backBtn.onclick = () => {
  cancelCurrentAnalysis();

  els.analysisView.hidden =
    true;

  els.inputView.hidden =
    false;
};

els.firstBtn.onclick =
  () => selectPly(0);

els.prevBtn.onclick =
  () =>
    selectPly(
      currentPly - 1
    );

els.nextBtn.onclick =
  () =>
    selectPly(
      currentPly + 1
    );

els.lastBtn.onclick =
  () =>
    selectPly(
      positions.length - 1
    );


/* =========================================================
   시작
   ========================================================= */

initEngine().catch(() => {});
