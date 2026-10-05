import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

/* Human Chess Insight — complete browser-side strategic review engine.
   No server, no API, no database. Stockfish runs in a Web Worker.
*/

const $ = id => document.getElementById(id);
const els = {
  inputView: $("inputView"), analysisView: $("analysisView"), pgnInput: $("pgnInput"),
  analyzeBtn: $("analyzeBtn"), exampleBtn: $("exampleBtn"), backBtn: $("backBtn"), errorBox: $("errorBox"),
  engineStatus: $("engineStatus"), board: $("board"), moveList: $("moveList"), moveLabel: $("moveLabel"),
  positionLabel: $("positionLabel"), gameMeta: $("gameMeta"), evalValue: $("evalValue"), depthValue: $("depthValue"),
  progressBar: $("progressBar"), positionInsight: $("positionInsight"), candidateList: $("candidateList"),
  humanFactors: $("humanFactors"), firstBtn: $("firstBtn"), prevBtn: $("prevBtn"), nextBtn: $("nextBtn"), lastBtn: $("lastBtn")
};

const EXAMPLE = `[Event "Human Chess Insight Demo"]
[Site "Local"]
[Date "2026.01.01"]
[Round "1"]
[White "White"]
[Black "Black"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 *`;

const ENGINE_PATH = new URL(
  "stockfish/stockfish-19-lite-single.js",
  import.meta.url
).toString();

const PV_LIMIT = 3;

const VALUES = {
  p: 1,
  n: 3.2,
  b: 3.3,
  r: 5,
  q: 9,
  k: 0
};

const NAMES = {
  w: "백",
  b: "흑"
};

const PIECE_NAMES = {
  p: "폰",
  n: "나이트",
  b: "비숍",
  r: "룩",
  q: "퀸",
  k: "킹"
};

const FILES = "abcdefgh";

let engine = null;
let engineReady = false;
let engineInitPromise = null;
let currentJob = null;

let positions = [];
let currentPly = 0;

let analysisCache = new Map();
let reviewCache = new Map();

let analysisToken = 0;
let gameAnalysis = null;
let criticalMoments = [];


/* =========================================================
   BASIC UI
   ========================================================= */

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

function progress(percent, depth = 0) {
  els.progressBar.style.width =
    `${Math.max(0, Math.min(100, percent))}%`;

  els.depthValue.textContent =
    depth ? `d${depth}` : "—";
}

function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[c])
  );
}


/* =========================================================
   STOCKFISH
   ========================================================= */

function parseScore(tokens) {
  const index = tokens.indexOf("score");

  if (index < 0) return null;

  const type = tokens[index + 1];
  const value = Number(tokens[index + 2]);

  if (!type || Number.isNaN(value)) return null;

  return {
    type,
    raw: value
  };
}


/*
 * Stockfish's score is relative to the side to move.
 * Human Chess Insight always displays the evaluation
 * from White's point of view.
 */
function whiteScore(score, turn) {
  if (!score) return null;

  if (score.type === "cp") {
    return (
      (turn === "w" ? score.raw : -score.raw) / 100
    );
  }

  const sign = score.raw >= 0 ? 1 : -1;

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

  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;
}

function scoreBand(value) {
  const absolute = Math.abs(value || 0);

  if (absolute < 0.25) {
    return "균형에 가까운 포지션입니다.";
  }

  if (absolute < 0.8) {
    return value > 0
      ? "백이 약간 더 편안한 포지션입니다."
      : "흑이 약간 더 편안한 포지션입니다.";
  }

  if (absolute < 1.8) {
    return value > 0
      ? "백에게 뚜렷한 실전적 우세가 있습니다."
      : "흑에게 뚜렷한 실전적 우세가 있습니다.";
  }

  if (absolute < 3.5) {
    return value > 0
      ? "백의 우세가 상당합니다."
      : "흑의 우세가 상당합니다.";
  }

  return value > 0
    ? "백 쪽으로 크게 기울었습니다."
    : "흑 쪽으로 크게 기울었습니다.";
}


/*
 * UCI move → SAN
 */
function uciToSan(fen, uci) {
  try {
    const chess = new Chess(fen);

    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4]
    });

    return move ? move.san : uci;
  } catch {
    return uci;
  }
}


/*
 * Convert a complete engine PV into human-readable SAN.
 */
function pvToSan(fen, pv) {
  const chess = new Chess(fen);
  const output = [];

  for (const uci of pv.slice(0, 7)) {
    try {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4]
      });

      if (!move) break;

      output.push(move.san);
    } catch {
      break;
    }
  }

  return output.join(" ");
}


/*
 * Only one Stockfish job is allowed at a time.
 * This is important because the browser Worker is shared.
 */
function cancelJob() {
  if (!currentJob) return;

  const oldJob = currentJob;

  currentJob = null;

  clearTimeout(oldJob.timer);

  try {
    engine?.postMessage("stop");
  } catch {}

  oldJob.reject?.(
    new Error("CANCELLED")
  );
}


/* =========================================================
   ENGINE INITIALIZATION
   ========================================================= */

function initEngine() {
  if (engineInitPromise) {
    return engineInitPromise;
  }

  engineInitPromise = new Promise((resolve, reject) => {
    setStatus(
      "Stockfish 로딩 중…",
      "loading"
    );

    try {
      engine = new Worker(ENGINE_PATH);
    } catch (error) {
      reject(error);
      return;
    }

    let phase = "uci";

    const timer = setTimeout(() => {
      reject(
        new Error(
          "Stockfish 로딩 시간이 초과되었습니다."
        )
      );
    }, 30000);

    engine.onerror = event => {
      clearTimeout(timer);

      reject(
        new Error(
          event?.message ||
          "Stockfish Worker 오류"
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
        phase === "uci"
      ) {
        phase = "ready";

        engine.postMessage(
          "setoption name MultiPV value 3"
        );

        engine.postMessage("isready");

        return;
      }

      if (
        line === "readyok" &&
        phase === "ready"
      ) {
        clearTimeout(timer);

        engineReady = true;

        setStatus(
          "Stockfish 준비 완료",
          "ready"
        );

        resolve();

        return;
      }

      currentJob?.onLine(line);
    };

    engine.postMessage("uci");
  }).catch(error => {
    engineReady = false;

    setStatus(
      "엔진 오류",
      "error"
    );

    throw error;
  });

  return engineInitPromise;
}


/* =========================================================
   ENGINE ANALYSIS
   ========================================================= */

function analyzeFen(
  fen,
  depth = 9,
  multiPV = 3,
  cache = true
) {
  const key =
    `${fen}|${depth}|${multiPV}`;

  if (
    cache &&
    analysisCache.has(key)
  ) {
    return Promise.resolve(
      analysisCache.get(key)
    );
  }

  if (!engineReady) {
    return Promise.reject(
      new Error(
        "Stockfish가 아직 준비되지 않았습니다."
      )
    );
  }

  cancelJob();

  return new Promise((resolve, reject) => {
    const token = ++analysisToken;

    const turn =
      fen.split(/\s+/)[1];

    const result = {
      fen,
      turn,
      depth: 0,
      lines: new Map()
    };

    const timer = setTimeout(() => {
      if (
        currentJob?.token !== token
      ) {
        return;
      }

      currentJob = null;

      reject(
        new Error(
          "엔진 분석 시간이 초과되었습니다."
        )
      );
    }, 30000);

    currentJob = {
      token,
      timer,
      reject,

      onLine(line) {
        if (
          currentJob?.token !== token
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

          const multiPVIndex =
            tokens.indexOf("multipv");

          const pvIndex =
            tokens.indexOf("pv");

          const depthValue =
            depthIndex >= 0
              ? Number(
                  tokens[
                    depthIndex + 1
                  ]
                )
              : 0;

          const multiPVNumber =
            multiPVIndex >= 0
              ? Number(
                  tokens[
                    multiPVIndex + 1
                  ]
                )
              : 1;

          const score =
            whiteScore(
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
              depthValue
            );

          if (
            score !== null &&
            pv.length
          ) {
            result.lines.set(
              multiPVNumber,
              {
                score,
                pv
              }
            );
          }

          if (depthValue > 0) {
            progress(
              Math.min(
                94,
                (depthValue / depth) * 100
              ),
              depthValue
            );
          }
        }

        if (
          line.startsWith("bestmove")
        ) {
          clearTimeout(timer);

          currentJob = null;

          result.lines =
            [
              ...result.lines.entries()
            ]
              .sort(
                (a, b) => a[0] - b[0]
              )
              .map(
                item => item[1]
              );

          if (cache) {
            analysisCache.set(
              key,
              result
            );
          }

          resolve(result);
        }
      }
    };

    engine.postMessage(
      `setoption name MultiPV value ${multiPV}`
    );

    engine.postMessage(
      "position fen " + fen
    );

    engine.postMessage(
      `go depth ${depth}`
    );
  });
}


/* =========================================================
   GAME POSITIONS
   ========================================================= */

function buildPositions(chess) {
  const output = [
    {
      ply: 0,
      fen: new Chess().fen(),
      san: null,
      uci: null
    }
  ];

  const current = new Chess();

  chess
    .history({ verbose: true })
    .forEach((move, index) => {
      const made =
        current.move(move.san);

      output.push({
        ply: index + 1,
        fen: current.fen(),
        san: made.san,
        uci:
          `${made.from}${made.to}${made.promotion || ""}`
      });
    });

  return output;
}


/* =========================================================
   BOARD
   ========================================================= */

function renderBoard(fen) {
  const chess = new Chess(fen);
  const board = chess.board();

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

  board.forEach((row, rowIndex) => {
    row.forEach((piece, columnIndex) => {
      const square =
        document.createElement("div");

      square.className =
        `sq ${
          (rowIndex + columnIndex) % 2 === 0
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
   BOARD GEOMETRY / ATTACK MAP
   ========================================================= */

function sqXY(square) {
  return [
    FILES.indexOf(square[0]),
    Number(square[1]) - 1
  ];
}

function xySq(x, y) {
  return (
    x >= 0 &&
    x < 8 &&
    y >= 0 &&
    y < 8
  )
    ? FILES[x] + (y + 1)
    : null;
}

function pieceAt(chess, square) {
  const [x] = sqXY(square);

  if (x < 0) return null;

  return chess.get(square);
}


function colorPieces(
  chess,
  color,
  type = null
) {
  const result = [];

  chess
    .board()
    .forEach((row, rowIndex) => {
      row.forEach(
        (piece, columnIndex) => {
          if (
            piece &&
            piece.color === color &&
            (
              !type ||
              piece.type === type
            )
          ) {
            result.push({
              square:
                FILES[columnIndex] +
                (8 - rowIndex),
              type: piece.type,
              color: piece.color
            });
          }
        }
      );
    });

  return result;
}


function lineClear(
  chess,
  from,
  to
) {
  const [
    x1,
    y1
  ] = sqXY(from);

  const [
    x2,
    y2
  ] = sqXY(to);

  const dx =
    Math.sign(x2 - x1);

  const dy =
    Math.sign(y2 - y1);

  let x = x1 + dx;
  let y = y1 + dy;

  while (
    x !== x2 ||
    y !== y2
  ) {
    if (
      chess.get(
        xySq(x, y)
      )
    ) {
      return false;
    }

    x += dx;
    y += dy;
  }

  return true;
}


function attacksSquare(
  chess,
  from,
  target
) {
  const piece =
    pieceAt(
      chess,
      from
    );

  if (!piece) return false;

  const [
    x,
    y
  ] = sqXY(from);

  const [
    tx,
    ty
  ] = sqXY(target);

  const dx = tx - x;
  const dy = ty - y;

  if (piece.type === "p") {
    const direction =
      piece.color === "w"
        ? 1
        : -1;

    return (
      dy === direction &&
      Math.abs(dx) === 1
    );
  }

  if (piece.type === "n") {
    return (
      (
        Math.abs(dx) === 1 &&
        Math.abs(dy) === 2
      ) ||
      (
        Math.abs(dx) === 2 &&
        Math.abs(dy) === 1
      )
    );
  }

  if (piece.type === "k") {
    return (
      Math.max(
        Math.abs(dx),
        Math.abs(dy)
      ) === 1
    );
  }

  if (piece.type === "b") {
    return (
      Math.abs(dx) === Math.abs(dy) &&
      lineClear(
        chess,
        from,
        target
      )
    );
  }

  if (piece.type === "r") {
    return (
      (
        dx === 0 ||
        dy === 0
      ) &&
      lineClear(
        chess,
        from,
        target
      )
    );
  }

  if (piece.type === "q") {
    return (
      (
        dx === 0 ||
        dy === 0 ||
        Math.abs(dx) === Math.abs(dy)
      ) &&
      lineClear(
        chess,
        from,
        target
      )
    );
  }

  return false;
}


function isAttacked(
  chess,
  target,
  byColor
) {
  return colorPieces(
    chess,
    byColor
  ).some(
    piece =>
      attacksSquare(
        chess,
        piece.square,
        target
      )
  );
}


function attackers(
  chess,
  target,
  byColor
) {
  return colorPieces(
    chess,
    byColor
  ).filter(
    piece =>
      attacksSquare(
        chess,
        piece.square,
        target
      )
  );
}


function defended(
  chess,
  target,
  byColor
) {
  return attackers(
    chess,
    target,
    byColor
  ).length > 0;
}


function enemyPawnAttacks(
  chess,
  square,
  color
) {
  return attackers(
    chess,
    square,
    color
  ).some(
    piece =>
      piece.type === "p"
  );
}


/*
 * chess.js generates legal moves for the side to move.
 * For strategic analysis we sometimes need the legal moves
 * of the opposite side as well, so we temporarily change
 * the active color in a FEN clone.
 */
function legalMovesForSquare(
  chess,
  square
) {
  try {
    const piece =
      chess.get(square);

    if (!piece) return [];

    const fen =
      chess.fen().split(" ");

    fen[1] = piece.color;

    const temporary =
      new Chess(
        fen.join(" ")
      );

    return temporary.moves({
      square,
      verbose: true
    });
  } catch {
    return [];
  }
}


/* =========================================================
   GAME PHASE
   ========================================================= */

function getGamePhase(chess) {
  const moveCount =
    chess.history().length;

  const queens =
    colorPieces(chess, "w", "q").length +
    colorPieces(chess, "b", "q").length;

  const minors =
    colorPieces(chess, "w", "n").length +
    colorPieces(chess, "b", "n").length +
    colorPieces(chess, "w", "b").length +
    colorPieces(chess, "b", "b").length;

  const rooks =
    colorPieces(chess, "w", "r").length +
    colorPieces(chess, "b", "r").length;

  if (
    moveCount <= 14 &&
    queens >= 2 &&
    minors >= 6
  ) {
    return "opening";
  }

  if (
    queens === 0 ||
    (
      minors <= 2 &&
      rooks <= 2
    )
  ) {
    return "endgame";
  }

  return "middlegame";
}

function phaseName(phase) {
  if (phase === "opening") {
    return "오프닝";
  }

  if (phase === "endgame") {
    return "엔드게임";
  }

  return "미들게임";
}


/* =========================================================
   MATERIAL
   ========================================================= */

function material(chess) {
  const result = {
    w: 0,
    b: 0,
    counts: {
      w: {},
      b: {}
    }
  };

  for (
    const side of ["w", "b"]
  ) {
    for (
      const type of [
        "p",
        "n",
        "b",
        "r",
        "q"
      ]
    ) {
      const count =
        colorPieces(
          chess,
          side,
          type
        ).length;

      result.counts[side][type] =
        count;

      result[side] +=
        count * VALUES[type];
    }
  }

  result.diff =
    Number(
      (
        result.w -
        result.b
      ).toFixed(2)
    );

  return result;
}


/* =========================================================
   PAWN STRUCTURE
   ========================================================= */

function pawnFiles(
  chess,
  color
) {
  const map = {};

  for (
    const pawn of colorPieces(
      chess,
      color,
      "p"
    )
  ) {
    const file =
      pawn.square[0];

    if (!map[file]) {
      map[file] = [];
    }

    map[file].push(
      Number(pawn.square[1])
    );
  }

  return map;
}


function pawnStructure(
  chess,
  color
) {
  const enemy =
    color === "w"
      ? "b"
      : "w";

  const files =
    pawnFiles(
      chess,
      color
    );

  const enemyFiles =
    pawnFiles(
      chess,
      enemy
    );

  const doubled = [];
  const isolated = [];
  const backward = [];
  const passed = [];
  const chains = [];

  /*
   * Doubled and isolated pawns.
   */
  for (
    const file of FILES
  ) {
    const own =
      files[file] || [];

    const left =
      files[
        FILES[
          FILES.indexOf(file) - 1
        ]
      ] || [];

    const right =
      files[
        FILES[
          FILES.indexOf(file) + 1
        ]
      ] || [];

    if (own.length > 1) {
      doubled.push(file);
    }

    if (
      own.length &&
      !left.length &&
      !right.length
    ) {
      isolated.push(file);
    }
  }


  /*
   * Passed / backward pawn logic.
   *
   * A pawn is not called backward simply because
   * it has not advanced.
   */
  for (
    const pawn of colorPieces(
      chess,
      color,
      "p"
    )
  ) {
    const file =
      pawn.square[0];

    const rank =
      Number(
        pawn.square[1]
      );

    const fileIndex =
      FILES.indexOf(file);

    const direction =
      color === "w"
        ? 1
        : -1;

    let enemyPawnAhead =
      false;

    for (
      let r = rank + direction;
      r >= 1 && r <= 8;
      r += direction
    ) {
      for (
        const f of [
          fileIndex - 1,
          fileIndex,
          fileIndex + 1
        ]
      ) {
        if (
          f < 0 ||
          f > 7
        ) {
          continue;
        }

        const square =
          FILES[f] + r;

        const piece =
          chess.get(square);

        if (
          piece &&
          piece.color === enemy &&
          piece.type === "p"
        ) {
          enemyPawnAhead = true;
        }
      }
    }

    /*
     * Passed pawn:
     * no enemy pawn ahead on its file
     * or the adjacent files.
     */
    if (!enemyPawnAhead) {
      passed.push(
        pawn.square
      );
    }

    const front =
      xySq(
        fileIndex,
        rank + direction
      );

    const blocked =
      front &&
      chess.get(front) &&
      chess.get(front).color === enemy;

    const adjacentOwn =
      (
        files[
          FILES[fileIndex - 1]
        ] || []
      ).concat(
        files[
          FILES[fileIndex + 1]
        ] || []
      );

    const advancedNeighbor =
      adjacentOwn.some(
        adjacentRank =>
          color === "w"
            ? adjacentRank > rank
            : adjacentRank < rank
      );

    /*
     * Backward pawn heuristic:
     * blocked, no advanced friendly pawn nearby,
     * not isolated, and not protected by a forward pawn
     * that can support its advance.
     */
    if (
      blocked &&
      !advancedNeighbor &&
      !isolated.includes(file) &&
      !enemyPawnAhead
    ) {
      backward.push(
        pawn.square
      );
    }
  }


  /*
   * Pawn chains.
   */
  const seen =
    new Set();

  const ownPawns =
    colorPieces(
      chess,
      color,
      "p"
    );

  for (
    const pawn of ownPawns
  ) {
    const [
      fileIndex,
      rank
    ] = sqXY(
      pawn.square
    );

    for (
      const other of ownPawns
    ) {
      if (
        other.square ===
        pawn.square
      ) {
        continue;
      }

      const [
        otherFile,
        otherRank
      ] = sqXY(
        other.square
      );

      if (
        Math.abs(
          otherFile -
          fileIndex
        ) === 1 &&
        Math.abs(
          otherRank -
          rank
        ) === 1
      ) {
        const key =
          [
            pawn.square,
            other.square
          ]
            .sort()
            .join("-");

        if (!seen.has(key)) {
          seen.add(key);
          chains.push(key);
        }
      }
    }
  }

  return {
    doubled,
    isolated,
    backward: [
      ...new Set(backward)
    ],
    passed,
    chains
  };
}


function pawnSummary(chess) {
  return {
    w: pawnStructure(
      chess,
      "w"
    ),
    b: pawnStructure(
      chess,
      "b"
    )
  };
}


/* =========================================================
   BISHOPS
   ========================================================= */

function bishopInfo(
  chess,
  color,
  square
) {
  const piece =
    chess.get(square);

  if (
    !piece ||
    piece.type !== "b" ||
    piece.color !== color
  ) {
    return null;
  }

  const enemy =
    color === "w"
      ? "b"
      : "w";

  const [
    x,
    y
  ] = sqXY(square);

  let emptySquares = 0;
  const blockedOwn = [];
  const enemyContacts = [];

  for (
    const [dx, dy] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1]
    ]
  ) {
    let xx = x + dx;
    let yy = y + dy;

    while (
      xx >= 0 &&
      xx < 8 &&
      yy >= 0 &&
      yy < 8
    ) {
      const target =
        xySq(xx, yy);

      const targetPiece =
        chess.get(target);

      if (!targetPiece) {
        emptySquares++;

        xx += dx;
        yy += dy;

        continue;
      }

      if (
        targetPiece.color ===
        color
      ) {
        blockedOwn.push(
          target
        );
      } else {
        enemyContacts.push(
          target
        );
      }

      break;
    }
  }

  const legal =
    legalMovesForSquare(
      chess,
      square
    );

  const moves =
    legal.length;

  const enemyPawns =
    enemyContacts.filter(
      square =>
        chess.get(square)?.type ===
        "p"
    ).length;

  const attackedByPawn =
    attackers(
      chess,
      square,
      enemy
    ).filter(
      attacker =>
        attacker.type === "p"
    ).length;

  let label =
    "활동적인 비숍";

  if (
    moves <= 3 &&
    blockedOwn.length >= 1
  ) {
    label =
      "활동이 제한된 비숍";
  }

  if (
    moves <= 2 &&
    blockedOwn.length >= 2
  ) {
    label =
      "활동을 개선할 필요가 있는 비숍";
  }

  if (
    enemyContacts.length > 0 &&
    moves >= 5
  ) {
    label =
      "적극적으로 작용하는 비숍";
  }

  return {
    square,
    moves,
    empty: emptySquares,
    blockedOwn,
    enemyContacts,
    enemyPawns,
    attackedByPawn,
    label
  };
}


function bishopAnalysis(
  chess,
  color
) {
  return colorPieces(
    chess,
    color,
    "b"
  ).map(
    piece =>
      bishopInfo(
        chess,
        color,
        piece.square
      )
  );
}


/* =========================================================
   KNIGHTS / OUTPOSTS
   ========================================================= */

function knightInfo(
  chess,
  color,
  square
) {
  const enemy =
    color === "w"
      ? "b"
      : "w";

  const legal =
    legalMovesForSquare(
      chess,
      square
    );

  const candidates = [];

  for (
    const move of legal
  ) {
    const target =
      move.to;

    const targetPiece =
      chess.get(target);

    if (
      targetPiece &&
      targetPiece.color === color
    ) {
      continue;
    }

    /*
     * A candidate outpost/support square must:
     * - not be attackable by an enemy pawn
     * - have friendly support
     * - be in a useful central zone
     */
    const attacked =
      enemyPawnAttacks(
        chess,
        target,
        enemy
      );

    const support =
      attackers(
        chess,
        target,
        color
      ).filter(
        attacker =>
          attacker.square !== square
      );

    const central =
      [
        "c3", "d3", "e3", "f3",
        "c4", "d4", "e4", "f4",
        "c5", "d5", "e5", "f5",
        "c6", "d6", "e6", "f6"
      ].includes(target);

    if (
      !attacked &&
      support.length > 0 &&
      central
    ) {
      candidates.push(
        target
      );
    }
  }

  let label =
    "활동적인 나이트";

  if (candidates.length) {
    label =
      "안정적으로 사용할 수 있는 지원점이 있습니다";
  } else if (
    legal.length <= 2
  ) {
    label =
      "활동 범위가 제한된 나이트";
  }

  return {
    square,
    moves: legal.length,
    legal: legal.map(
      move => move.to
    ),
    outposts: candidates,
    label
  };
}


function knightAnalysis(
  chess,
  color
) {
  return colorPieces(
    chess,
    color,
    "n"
  ).map(
    piece =>
      knightInfo(
        chess,
        color,
        piece.square
      )
  );
}


function minorAnalysis(
  chess,
  color
) {
  return {
    bishops:
      bishopAnalysis(
        chess,
        color
      ),

    knights:
      knightAnalysis(
        chess,
        color
      )
  };
}


/* =========================================================
   WEAK SQUARES / SPACE / CENTER
   ========================================================= */

function candidateWeakSquares(
  chess,
  color
) {
  const enemy =
    color === "w"
      ? "b"
      : "w";

  const output = [];

  for (
    let rank = 2;
    rank <= 7;
    rank++
  ) {
    for (
      const file of FILES
    ) {
      const square =
        file + rank;

      const piece =
        chess.get(square);

      if (
        piece?.type === "p" &&
        piece.color === color
      ) {
        continue;
      }

      if (
        enemyPawnAttacks(
          chess,
          square,
          enemy
        )
      ) {
        continue;
      }

      const ownAttackers =
        attackers(
          chess,
          square,
          color
        ).length;

      if (
        ownAttackers > 0
      ) {
        output.push({
          square,
          ownAttackers
        });
      }
    }
  }

  return output
    .sort(
      (a, b) =>
        b.ownAttackers -
        a.ownAttackers
    )
    .slice(0, 6);
}


function weakSquares(
  chess,
  color
) {
  const enemy =
    color === "w"
      ? "b"
      : "w";

  const list = [];

  for (
    let rank = 3;
    rank <= 6;
    rank++
  ) {
    for (
      const file of FILES
    ) {
      const square =
        file + rank;

      const piece =
        chess.get(square);

      if (
        piece &&
        piece.color === enemy
      ) {
        continue;
      }

      /*
       * A square is interesting if enemy pawns
       * cannot attack it.
       */
      if (
        !enemyPawnAttacks(
          chess,
          square,
          enemy
        )
      ) {
        const ownAttack =
          attackers(
            chess,
            square,
            color
          ).length;

        const enemyAttack =
          attackers(
            chess,
            square,
            enemy
          ).length;

        if (
          ownAttack > 0 ||
          enemyAttack === 0
        ) {
          list.push(square);
        }
      }
    }
  }

  return [
    ...new Set(list)
  ].slice(0, 10);
}


function spaceScore(
  chess,
  color
) {
  let score = 0;

  const enemy =
    color === "w"
      ? "b"
      : "w";

  for (
    const pawn of colorPieces(
      chess,
      color,
      "p"
    )
  ) {
    const rank =
      Number(
        pawn.square[1]
      );

    if (
      (
        color === "w" &&
        rank >= 4
      ) ||
      (
        color === "b" &&
        rank <= 5
      )
    ) {
      score++;
    }
  }

  for (
    const knight of colorPieces(
      chess,
      color,
      "n"
    )
  ) {
    score +=
      legalMovesForSquare(
        chess,
        knight.square
      ).length * 0.08;
  }

  for (
    const bishop of colorPieces(
      chess,
      color,
      "b"
    )
  ) {
    score +=
      Math.min(
        8,
        bishopInfo(
          chess,
          color,
          bishop.square
        )?.empty || 0
      ) * 0.04;
  }

  const enemySpace =
    colorPieces(
      chess,
      enemy,
      "p"
    ).filter(
      pawn =>
        color === "w"
          ? Number(pawn.square[1]) >= 4
          : Number(pawn.square[1]) <= 5
    ).length;

  return Number(
    (
      score -
      enemySpace * 0.25
    ).toFixed(2)
  );
}


function centerInfo(chess) {
  const centralSquares = [
    "d4",
    "e4",
    "d5",
    "e5"
  ];

  const pawns = {
    w: 0,
    b: 0
  };

  const occupancy = [];

  for (
    const square of centralSquares
  ) {
    const piece =
      chess.get(square);

    if (piece) {
      occupancy.push(
        `${square}:${NAMES[piece.color]} ${PIECE_NAMES[piece.type]}`
      );

      if (
        piece.type === "p"
      ) {
        pawns[piece.color]++;
      }
    }
  }

  return {
    squares: centralSquares,
    white: pawns.w,
    black: pawns.b,
    occupancy
  };
}


function openFiles(chess) {
  const output = [];

  for (
    const file of FILES
  ) {
    const whitePawns =
      (
        pawnFiles(
          chess,
          "w"
        )[file] || []
      ).length;

    const blackPawns =
      (
        pawnFiles(
          chess,
          "b"
        )[file] || []
      ).length;

    if (
      !whitePawns &&
      !blackPawns
    ) {
      output.push({
        file,
        type: "open"
      });
    } else if (
      !whitePawns ||
      !blackPawns
    ) {
      output.push({
        file,
        type: "semi-open",
        side:
          !whitePawns
            ? "w"
            : "b"
      });
    }
  }

  return output;
}


/* =========================================================
   DEVELOPMENT / KING SAFETY / INITIATIVE
   ========================================================= */

const START = {
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


function development(
  chess,
  color
) {
  const pieces = [
    ...colorPieces(
      chess,
      color,
      "n"
    ),
    ...colorPieces(
      chess,
      color,
      "b"
    )
  ];

  const developed =
    pieces.filter(
      piece =>
        !START[color][piece.type]
          ?.includes(
            piece.square
          )
    ).length;

  const king =
    chess.get(
      color === "w"
        ? "e1"
        : "e8"
    );

  const queen =
    chess.get(
      color === "w"
        ? "d1"
        : "d8"
    );

  return {
    developed,
    minorTotal:
      pieces.length,
    kingMoved:
      !king,
    queenMoved:
      !queen,

    score:
      developed * 1.2
  };
}


function kingSafety(
  chess,
  color
) {
  const king =
    colorPieces(
      chess,
      color,
      "k"
    )[0];

  if (!king) {
    return {
      score: 99,
      label: "킹 없음"
    };
  }

  const enemy =
    color === "w"
      ? "b"
      : "w";

  const [
    x,
    y
  ] = sqXY(
    king.square
  );

  let shield = 0;

  for (
    let dx = -1;
    dx <= 1;
    dx++
  ) {
    for (
      let dy = 1;
      dy <= 2;
      dy++
    ) {
      const yy =
        color === "w"
          ? y + dy
          : y - dy;

      const square =
        xySq(
          x + dx,
          yy
        );

      if (
        square &&
        chess.get(square)?.color === color &&
        chess.get(square)?.type === "p"
      ) {
        shield++;
      }
    }
  }

  const attackersNear =
    attackers(
      chess,
      king.square,
      enemy
    ).length;

  let adjacentEnemy = 0;

  for (
    const piece of colorPieces(
      chess,
      enemy
    )
  ) {
    const [
      px,
      py
    ] = sqXY(
      piece.square
    );

    if (
      Math.abs(px - x) <= 2 &&
      Math.abs(py - y) <= 2
    ) {
      adjacentEnemy++;
    }
  }

  const score =
    shield * 1.2 -
    attackersNear * 2 -
    adjacentEnemy * 0.25;

  return {
    square: king.square,
    shield,
    attackers: attackersNear,
    adjacentEnemy,
    score,
    label:
      score < 0
        ? "킹 주변의 압박을 주의할 필요가 있습니다"
        : "킹은 비교적 안전합니다"
  };
}


function initiative(
  chess,
  color
) {
  const enemy =
    color === "w"
      ? "b"
      : "w";

  let score = 0;

  for (
    const piece of [
      ...colorPieces(
        chess,
        color,
        "q"
      ),
      ...colorPieces(
        chess,
        color,
        "r"
      )
    ]
  ) {
    score +=
      legalMovesForSquare(
        chess,
        piece.square
      ).length * 0.04;
  }

  const temporaryFen =
    chess
      .fen()
      .split(/\s+/)
      .map(
        (value, index) =>
          index === 1
            ? color
            : value
      )
      .join(" ");

  const temporary =
    new Chess(
      temporaryFen
    );

  const checkingMoves =
    temporary
      .moves({ verbose: true })
      .filter(
        move =>
          move.san.includes("+")
      )
      .length;

  score +=
    checkingMoves * 0.7;

  score +=
    Math.max(
      0,
      development(
        chess,
        color
      ).developed -
      development(
        chess,
        enemy
      ).developed
    ) * 0.5;

  return Number(
    score.toFixed(2)
  );
}


/* =========================================================
   TACTICS / COUNTERPLAY
   ========================================================= */

function legalForSide(
  chess,
  color
) {
  const fen =
    chess.fen().split(" ");

  fen[1] = color;

  try {
    const temporary =
      new Chess(
        fen.join(" ")
      );

    return temporary.moves({
      verbose: true
    });
  } catch {
    return [];
  }
}


function tacticalMoves(
  chess,
  color
) {
  const temporary =
    new Chess(
      chess
        .fen()
        .split(" ")
        .map(
          (value, index) =>
            index === 1
              ? color
              : value
        )
        .join(" ")
    );

  return temporary
    .moves({ verbose: true })
    .filter(
      move =>
        move.san.includes("+") ||
        move.captured ||
        move.san.includes("x")
    );
}


function pawnBreaks(
  chess,
  color
) {
  const moves =
    legalForSide(
      chess,
      color
    ).filter(
      move => {
        const piece =
          chess.get(
            move.from
          );

        return (
          piece?.type === "p" &&
          Math.abs(
            Number(move.to[1]) -
            Number(move.from[1])
          ) >= 1
        );
      }
    );

  return moves.slice(0, 8);
}


function counterplay(
  chess,
  side
) {
  const enemy =
    side === "w"
      ? "b"
      : "w";

  const checks =
    tacticalMoves(
      chess,
      enemy
    ).filter(
      move =>
        move.san.includes("+")
    );

  const captures =
    tacticalMoves(
      chess,
      enemy
    ).filter(
      move =>
        move.captured
    );

  const breaks =
    pawnBreaks(
      chess,
      enemy
    );

  return {
    side,
    checks,
    captures:
      captures.slice(0, 5),
    pawnBreaks:
      breaks.slice(0, 6),

    hasImmediate:
      checks.length > 0 ||
      captures.length > 0,

    score:
      checks.length * 2 +
      captures.length * 0.7 +
      breaks.length * 0.3
  };
}


/* =========================================================
   STRATEGIC POSITION MODEL
   ========================================================= */

function snapshot(chess) {
  const phase =
    getGamePhase(chess);

  const mat =
    material(chess);

  const pawnStructureData = {
    w: pawnStructure(
      chess,
      "w"
    ),
    b: pawnStructure(
      chess,
      "b"
    )
  };

  const minor = {
    w: minorAnalysis(
      chess,
      "w"
    ),
    b: minorAnalysis(
      chess,
      "b"
    )
  };

  const weak = {
    w: weakSquares(
      chess,
      "w"
    ),
    b: weakSquares(
      chess,
      "b"
    )
  };

  const space = {
    w: spaceScore(
      chess,
      "w"
    ),
    b: spaceScore(
      chess,
      "b"
    )
  };

  const developmentData = {
    w: development(
      chess,
      "w"
    ),
    b: development(
      chess,
      "b"
    )
  };

  const king = {
    w: kingSafety(
      chess,
      "w"
    ),
    b: kingSafety(
      chess,
      "b"
    )
  };

  const init = {
    w: initiative(
      chess,
      "w"
    ),
    b: initiative(
      chess,
      "b"
    )
  };

  const center =
    centerInfo(chess);

  const files =
    openFiles(chess);

  const tactical = {
    w: counterplay(
      chess,
      "w"
    ),
    b: counterplay(
      chess,
      "b"
    )
  };

  const activity = {
    w:
      minor.w.bishops.reduce(
        (sum, bishop) =>
          sum + bishop.moves,
        0
      ) +
      minor.w.knights.reduce(
        (sum, knight) =>
          sum + knight.moves,
        0
      ),

    b:
      minor.b.bishops.reduce(
        (sum, bishop) =>
          sum + bishop.moves,
        0
      ) +
      minor.b.knights.reduce(
        (sum, knight) =>
          sum + knight.moves,
        0
      )
  };

  const pawnFeatures = {
    w:
      pawnStructureData.w.doubled.length +
      pawnStructureData.w.isolated.length +
      pawnStructureData.w.backward.length +
      pawnStructureData.w.passed.length,

    b:
      pawnStructureData.b.doubled.length +
      pawnStructureData.b.isolated.length +
      pawnStructureData.b.backward.length +
      pawnStructureData.b.passed.length
  };

  const kingDelta =
    king.w.score -
    king.b.score;

  const spaceDelta =
    space.w -
    space.b;

  const activityDelta =
    activity.w -
    activity.b;

  const developmentDelta =
    developmentData.w.developed -
    developmentData.b.developed;

  const initiativeDelta =
    init.w -
    init.b;

  const structureImpact =
    Math.abs(
      (
        pawnStructureData.w.isolated.length +
        pawnStructureData.w.backward.length
      ) -
      (
        pawnStructureData.b.isolated.length +
        pawnStructureData.b.backward.length
      )
    ) +
    (
      pawnStructureData.w.passed.length +
      pawnStructureData.b.passed.length
    ) * 0.35;


  /*
   * These are not fixed universal weights.
   * They are contextual signals used to decide
   * which imbalance deserves attention first.
   */
  const factors = [
    {
      key: "material",
      label: "기물의 개수",

      side:
        mat.diff > 0
          ? "w"
          : mat.diff < 0
            ? "b"
            : null,

      score:
        Math.abs(
          mat.diff
        ) * 1.5,

      detail:
        mat.diff === 0
          ? "물질적으로 균형입니다."
          : `${NAMES[
              mat.diff > 0
                ? "w"
                : "b"
            ]}이 약 ${Math.abs(
              mat.diff
            ).toFixed(1)}점 앞서 있습니다.`
    },

    {
      key: "activity",
      label: "기물 활동성",

      side:
        activityDelta > 0
          ? "w"
          : activityDelta < 0
            ? "b"
            : null,

      score:
        Math.abs(
          activityDelta
        ) * 0.22,

      detail:
        "실제 이동 범위와 기물 배치의 질을 비교합니다."
    },

    {
      key: "pawnStructure",
      label: "폰 구조",

      side:
        structureImpact > 1
          ? (
              pawnFeatures.w <
              pawnFeatures.b
                ? "w"
                : pawnFeatures.b <
                    pawnFeatures.w
                  ? "b"
                  : null
            )
          : null,

      score:
        structureImpact,

      detail:
        "고립폰·더블폰·뒤처진 폰·통과폰과 실제 공격 가능성을 비교합니다."
    },

    {
      key: "space",
      label: "공간",

      side:
        spaceDelta > 0
          ? "w"
          : spaceDelta < 0
            ? "b"
            : null,

      score:
        Math.abs(
          spaceDelta
        ) * 0.9,

      detail:
        "공간이 큰 쪽은 기동 여지가 많고, 작은 쪽은 교환과 반격을 찾는 경우가 많습니다."
    },

    {
      key: "kingSafety",
      label: "킹 안전",

      side:
        kingDelta > 0
          ? "w"
          : kingDelta < 0
            ? "b"
            : null,

      score:
        Math.abs(
          kingDelta
        ) * 1.2,

      detail:
        "킹 주변의 방패와 직접적인 압박을 비교합니다."
    },

    {
      key: "development",
      label: "개발",

      side:
        developmentDelta > 0
          ? "w"
          : developmentDelta < 0
            ? "b"
            : null,

      score:
        Math.abs(
          developmentDelta
        ) * 0.8,

      detail:
        "단순히 기물이 움직였는지가 아니라 현재 위치에서의 개발 속도를 봅니다."
    },

    {
      key: "initiative",
      label: "주도권",

      side:
        initiativeDelta > 0
          ? "w"
          : initiativeDelta < 0
            ? "b"
            : null,

      score:
        Math.abs(
          initiativeDelta
        ) * 0.8,

      detail:
        "상대에게 대응을 강요할 수 있는 수단을 비교합니다."
    }
  ];

  factors.sort(
    (a, b) =>
      b.score -
      a.score
  );

  const dominant =
    factors[0];

  const dominantSide =
    dominant.side;

  const sideOfBoard =
    dominantSide ||
    (
      initiativeDelta > 0
        ? "w"
        : initiativeDelta < 0
          ? "b"
          : chess.turn()
    );

  const counter =
    counterplay(
      chess,
      sideOfBoard === "w"
        ? "b"
        : "w"
    );

  const staticKeys = [
    "material",
    "pawnStructure",
    "space"
  ];

  const dynamicKeys = [
    "development",
    "initiative",
    "kingSafety"
  ];

  return {
    fen: chess.fen(),
    turn: chess.turn(),
    phase,

    material: mat,
    pawnStructure:
      pawnStructureData,

    minor,
    weakSquares: weak,

    space,
    center,
    openFiles: files,

    development:
      developmentData,

    kingSafety: king,
    initiative: init,

    activity,
    tactical,

    factors,
    dominantImbalance:
      dominant,

    sideOfBoard,
    counterplay: counter,

    staticKeys,
    dynamicKeys
  };
}


/* =========================================================
   STRATEGIC THINKING
   ========================================================= */

function strategicSentence(snapshotData) {
  const dominant =
    snapshotData.dominantImbalance;

  const side =
    dominant.side
      ? NAMES[dominant.side]
      : "양쪽";

  const map = {
    material: "기물의 개수",
    activity: "기물 활동성",
    pawnStructure: "폰 구조",
    space: "공간",
    kingSafety: "킹 안전",
    development: "개발",
    initiative: "주도권"
  };

  return (
    `현재 가장 중요한 불균형은 ${
      map[dominant.key]
    }입니다. ${
      side
    } 쪽의 차이가 실제 계획에 가장 직접적으로 연결됩니다.`
  );
}


function staticDynamic(snapshotData) {
  const staticScore =
    Math.abs(
      snapshotData.material.diff
    ) * 1.2 +
    Math.abs(
      snapshotData.space.w -
      snapshotData.space.b
    ) * 0.5 +
    Math.abs(
      (
        snapshotData.pawnStructure.w.isolated.length +
        snapshotData.pawnStructure.w.backward.length
      ) -
      (
        snapshotData.pawnStructure.b.isolated.length +
        snapshotData.pawnStructure.b.backward.length
      )
    );

  const dynamicScore =
    Math.abs(
      snapshotData.development.w.developed -
      snapshotData.development.b.developed
    ) * 0.8 +
    Math.abs(
      snapshotData.initiative.w -
      snapshotData.initiative.b
    ) * 0.8 +
    Math.abs(
      snapshotData.kingSafety.w.score -
      snapshotData.kingSafety.b.score
    );

  return {
    staticScore,
    dynamicScore,

    dominant:
      dynamicScore >
      staticScore * 1.15
        ? "dynamic"
        : staticScore >
            dynamicScore * 1.15
          ? "static"
          : "mixed"
  };
}


function conversionPlan(snapshotData) {
  const state =
    staticDynamic(
      snapshotData
    );

  if (
    state.dominant ===
    "dynamic"
  ) {
    return (
      "현재 우세가 개발·주도권·킹 안전 같은 동적인 요소에 더 가깝습니다. 이런 우세는 시간을 주면 사라질 수 있으므로 실제 이득이나 더 오래가는 우세로 바꾸는 수를 우선 확인합니다."
    );
  }

  if (
    snapshotData.material.diff >
    1.2
  ) {
    return (
      "물질적 우세가 있으므로 불필요한 위험을 만들기보다 활동적인 기물을 유지하면서 유리한 교환이나 단순화를 찾습니다."
    );
  }

  if (
    snapshotData.space.w -
    snapshotData.space.b >
    1.2
  ) {
    return (
      "공간 우세가 있다면 상대의 반격을 먼저 제한하고, 무리한 전술보다 활동 범위를 이용하는 방향을 확인합니다."
    );
  }

  if (
    snapshotData.space.b -
    snapshotData.space.w >
    1.2
  ) {
    return (
      "공간이 부족하다면 수동적으로 기다리기보다 유리한 교환이나 중앙·날개 폰 브레이크로 활동 공간을 만드는 방법을 확인합니다."
    );
  }

  return (
    "현재는 하나의 요소만으로 결론을 내리기보다 가장 큰 불균형과 상대의 반격을 함께 비교합니다."
  );
}


function preventiveText(
  snapshotData
) {
  const counter =
    snapshotData.counterplay;

  if (
    counter.hasImmediate
  ) {
    if (
      counter.checks.length
    ) {
      return (
        `${NAMES[counter.side]}의 즉각적인 체크 수단이 있어 계획을 실행하기 전에 킹에 대한 반격부터 확인해야 합니다.`
      );
    }

    if (
      counter.captures.length
    ) {
      return (
        `${NAMES[counter.side]}에게 전술적인 잡기와 교환 수단이 있어 먼저 상대의 전술을 확인해야 합니다.`
      );
    }
  }

  if (
    counter.pawnBreaks.length
  ) {
    return (
      `${NAMES[counter.side]}의 폰 브레이크 가능성을 먼저 확인합니다. 좋은 계획도 상대의 돌파를 허용하면 의미가 약해집니다.`
    );
  }

  return (
    "상대에게 즉각적인 전술적 반격은 뚜렷하지 않습니다. 그 다음에는 상대가 만들고 싶은 계획을 막는 방법을 찾습니다."
  );
}


function fantasyText(
  chess,
  snapshotData
) {
  const dominant =
    snapshotData.dominantImbalance;

  const side =
    dominant.side ||
    chess.turn();

  const enemy =
    side === "w"
      ? "b"
      : "w";

  if (
    dominant.key === "space"
  ) {
    return (
      `${NAMES[side]}의 공간 우세를 유지하면서 ${NAMES[enemy]}의 기물 활동을 제한하고, 불필요한 교환은 피하는 포지션을 목표로 합니다.`
    );
  }

  if (
    dominant.key === "material"
  ) {
    return (
      `${NAMES[side]}의 물질적 우세를 유지하면서 상대의 공격과 활동을 줄이고, 필요하면 교환을 통해 우세를 안정시키는 포지션을 목표로 합니다.`
    );
  }

  if (
    dominant.key === "pawnStructure"
  ) {
    return (
      `${NAMES[side]}이 이용할 수 있는 폰 구조상의 약점을 실제 공격 대상으로 만들고, 상대의 구조적 반격을 막는 포지션을 목표로 합니다.`
    );
  }

  if (
    dominant.key === "kingSafety"
  ) {
    return (
      `${NAMES[side]}의 킹을 안전하게 유지하면서 상대 킹 주변의 압박을 키우는 포지션을 목표로 합니다.`
    );
  }

  if (
    dominant.key === "development" ||
    dominant.key === "initiative"
  ) {
    return (
      `${NAMES[side]}의 활동적인 기물을 유지하고 상대가 수동적으로 대응하도록 만들어, 일시적인 활동 우세를 더 오래가는 우세로 바꾸는 포지션을 목표로 합니다.`
    );
  }

  return (
    `${NAMES[side]}의 활동적인 기물을 유지하고 상대의 핵심 기물을 수동적으로 만드는 포지션을 목표로 합니다.`
  );
}


/* =========================================================
   CANDIDATE MOVE GENERATION
   ========================================================= */

function moveStrategicScore(
  chess,
  move,
  snapshotData
) {
  let score = 0;

  const piece =
    chess.get(
      move.from
    );

  const target =
    chess.get(
      move.to
    );

  const enemy =
    chess.turn() === "w"
      ? "b"
      : "w";

  if (target) {
    score +=
      VALUES[target.type] *
      0.9;
  }

  if (
    piece?.type === "n" ||
    piece?.type === "b"
  ) {
    score += 0.2;
  }

  try {
    chess.move(move);
  } catch {
    return -999;
  }

  const after =
    snapshot(chess);

  if (
    snapshotData
      .dominantImbalance
      .side &&
    after
      .dominantImbalance
      .side ===
      snapshotData
        .dominantImbalance
        .side
  ) {
    score += 0.8;
  }

  if (
    after.counterplay
      .hasImmediate
  ) {
    score -= 1.5;
  }

  if (
    snapshotData.space[
      snapshotData.sideOfBoard
    ] >
    snapshotData.space[
      enemy
    ]
  ) {
    score += 0.2;
  }

  chess.undo();

  return score;
}


function generateCandidates(
  chess,
  snapshotData
) {
  const legal =
    chess.moves({
      verbose: true
    });

  const scored =
    legal
      .map(
        move => ({
          move,
          score:
            moveStrategicScore(
              chess,
              move,
              snapshotData
            )
        })
      )
      .sort(
        (a, b) =>
          b.score -
          a.score
      );

  const unique = [];
  const seen = new Set();

  for (
    const item of scored
  ) {
    const uci =
      item.move.from +
      item.move.to +
      (
        item.move.promotion ||
        ""
      );

    if (
      !seen.has(uci)
    ) {
      seen.add(uci);
      unique.push(item);
    }

    if (
      unique.length >= 12
    ) {
      break;
    }
  }

  return unique;
}


/*
 * A strategically interesting move is not automatically
 * a valid alternative.
 *
 * It must first survive an engine sanity check.
 */
function classifyCandidate(
  index,
  score,
  bestScore,
  before,
  after,
  move
) {
  const mover =
    before.turn;

  const moverPerspective =
    (
      mover === "w"
        ? score
        : -score
    ) -
    (
      mover === "w"
        ? bestScore
        : -bestScore
    );

  /*
   * Clearly inferior candidates are rejected.
   */
  if (
    moverPerspective <
    -1.2
  ) {
    return null;
  }

  if (
    moverPerspective <
    -0.65
  ) {
    return null;
  }

  if (
    index === 0
  ) {
    return "엔진 최선";
  }

  if (
    after.dominantImbalance.key ===
      before.dominantImbalance.key &&
    after.dominantImbalance.side ===
      before.dominantImbalance.side
  ) {
    return "전략적 대안";
  }

  if (
    after.counterplay
      .hasImmediate === false
  ) {
    return "실전적 대안";
  }

  return "다른 계획";
}


async function buildValidatedCandidates(
  fen,
  snapshotData,
  shallowDepth = 8
) {
  const chess =
    new Chess(fen);

  const raw =
    generateCandidates(
      chess,
      snapshotData
    );

  const main =
    await analyzeFen(
      fen,
      10,
      3
    );

  if (
    !main.lines.length
  ) {
    return [];
  }

  const best =
    main.lines[0].score;

  const engineMoves =
    main.lines
      .map(
        line =>
          line.pv[0]
      )
      .filter(Boolean);

  const candidates = [];

  for (
    let i = 0;
    i < raw.length &&
    candidates.length < 6;
    i++
  ) {
    const item =
      raw[i];

    const uci =
      item.move.from +
      item.move.to +
      (
        item.move.promotion ||
        ""
      );

    if (
      !engineMoves.includes(
        uci
      ) &&
      item.score < -5
    ) {
      continue;
    }

    const afterChess =
      new Chess(fen);

    let moved;

    try {
      moved =
        afterChess.move(
          item.move
        );
    } catch {
      continue;
    }

    const after =
      snapshot(
        afterChess
      );

    let evaluation = null;
    let pv = [];

    /*
     * If Stockfish already calculated this move
     * as one of its MultiPV lines, use that exact score.
     */
    if (
      engineMoves.includes(
        uci
      )
    ) {
      const line =
        main.lines.find(
          candidate =>
            candidate.pv[0] ===
            uci
        );

      evaluation =
        line?.score ??
        best;

      pv =
        line?.pv ||
        [];
    } else {
      /*
       * Otherwise calculate the resulting position.
       * This also gives us the opponent's best response.
       */
      const child =
        await analyzeFen(
          afterChess.fen(),
          shallowDepth,
          1
        );

      if (
        child.lines[0]
      ) {
        evaluation =
          child.lines[0].score;

        pv = [
          uci,
          ...child.lines[0].pv
        ];
      }
    }

    if (
      evaluation === null
    ) {
      continue;
    }

    const label =
      classifyCandidate(
        candidates.length,
        evaluation,
        best,
        snapshotData,
        after,
        item.move
      );

    if (!label) {
      continue;
    }

    const mover =
      snapshotData.turn;

    const moverEvaluation =
      mover === "w"
        ? evaluation
        : -evaluation;

    const bestForMover =
      mover === "w"
        ? best
        : -best;

    /*
     * Do not show a move as an alternative
     * if it is materially worse than the engine best.
     */
    if (
      moverEvaluation <
      bestForMover - 0.8
    ) {
      continue;
    }

    candidates.push({
      uci,
      san: moved.san,
      label,
      score: evaluation,
      pv,
      after
    });
  }

  /*
   * Always preserve the real Stockfish PVs.
   */
  const top =
    main.lines.map(
      (line, index) => ({
        uci:
          line.pv[0],

        san:
          uciToSan(
            fen,
            line.pv[0]
          ),

        label:
          index === 0
            ? "엔진 최선"
            : "엔진 후보",

        score:
          line.score,

        pv:
          line.pv
      })
    );

  for (
    const engineCandidate of top
  ) {
    if (
      !candidates.some(
        candidate =>
          candidate.uci ===
          engineCandidate.uci
      )
    ) {
      candidates.unshift(
        engineCandidate
      );
    }
  }

  return candidates.slice(
    0,
    3
  );
}


/* =========================================================
   MOVE REVIEW
   ========================================================= */

async function reviewMove(
  ply
) {
  if (
    ply <= 0
  ) {
    return null;
  }

  if (
    reviewCache.has(ply)
  ) {
    return reviewCache.get(
      ply
    );
  }

  const beforePosition =
    positions[ply - 1];

  const afterPosition =
    positions[ply];

  const mover =
    ply % 2
      ? "w"
      : "b";

  /*
   * Stockfish is a single shared Worker.
   * Therefore these two analyses must be sequential,
   * not Promise.all().
   */
  const before =
    await analyzeFen(
      beforePosition.fen,
      8,
      1
    );

  const after =
    await analyzeFen(
      afterPosition.fen,
      8,
      1
    );

  const beforeWhite =
    before.lines[0]?.score ??
    0;

  const afterWhite =
    after.lines[0]?.score ??
    0;

  const beforeMover =
    mover === "w"
      ? beforeWhite
      : -beforeWhite;

  const afterMover =
    mover === "w"
      ? afterWhite
      : -afterWhite;

  const loss =
    Number(
      (
        beforeMover -
        afterMover
      ).toFixed(2)
    );

  const beforeSnapshot =
    snapshot(
      new Chess(
        beforePosition.fen
      )
    );

  const afterSnapshot =
    snapshot(
      new Chess(
        afterPosition.fen
      )
    );

  let type =
    "좋은 수";

  let reason =
    "현재 포지션의 중요한 요소를 유지했습니다.";

  if (
    loss > 0.35
  ) {
    type =
      loss > 0.9
        ? "실수가 큰 수"
        : "부정확한 수";

    if (
      beforeSnapshot
        .dominantImbalance
        .key !==
      afterSnapshot
        .dominantImbalance
        .key
    ) {
      reason =
        `수 이후 핵심 불균형이 ${beforeSnapshot.dominantImbalance.label}에서 ${afterSnapshot.dominantImbalance.label} 쪽으로 바뀌었습니다.`;
    } else if (
      afterSnapshot
        .counterplay
        .hasImmediate
    ) {
      reason =
        "이 수로 상대에게 즉각적인 반격 수단이 생겼습니다.";
    } else if (
      beforeSnapshot.space[
        beforeSnapshot.turn
      ] >
      afterSnapshot.space[
        beforeSnapshot.turn
      ]
    ) {
      reason =
        "자신의 공간과 기물 활동을 충분히 유지하지 못했습니다.";
    } else {
      reason =
        "엔진 평가뿐 아니라 상대가 활용할 수 있는 새로운 자원을 허용했습니다.";
    }
  } else if (
    loss > 0.12
  ) {
    type =
      "조금 부정확한 수";

    reason =
      "포지션의 요구에 완전히 맞지는 않았지만 큰 문제를 만들지는 않았습니다.";
  }

  const next =
    loss > 0.35
      ? "다음에는 수를 두기 전에 현재 가장 큰 불균형과 상대의 가장 강한 반격을 먼저 확인합니다."
      : "다음 수를 찾을 때도 현재의 우세 요소를 유지하는지를 먼저 확인합니다.";

  const result = {
    type,
    loss,
    beforeW: beforeWhite,
    afterW: afterWhite,
    reason,
    next
  };

  reviewCache.set(
    ply,
    result
  );

  return result;
}


/* =========================================================
   HUMAN FACTOR TEXT
   ========================================================= */

function factorText(
  chess,
  snapshotData
) {
  const materialData =
    snapshotData.material;

  const lines = [];

  lines.push([
    "게임 단계",
    `현재 ${phaseName(
      snapshotData.phase
    )}입니다.`
  ]);

  lines.push([
    "기물의 개수",
    Math.abs(
      materialData.diff
    ) < 0.3
      ? "물질적으로 균형이 맞습니다."
      : `${NAMES[
          materialData.diff > 0
            ? "w"
            : "b"
        ]}이 약 ${Math.abs(
          materialData.diff
        ).toFixed(1)}점의 물질적 우세를 가지고 있습니다.`
  ]);


  /*
   * Minor pieces.
   */
  for (
    const side of ["w", "b"]
  ) {
    for (
      const bishop of
        snapshotData.minor[
          side
        ].bishops
    ) {
      lines.push([
        `${NAMES[side]} ${bishop.square} · ${bishop.label}`,

        bishop.blockedOwn.length
          ? `${NAMES[side]}의 ${bishop.square} 비숍은 ${bishop.blockedOwn.join(", ")}에 있는 자기 기물 때문에 일부 대각선이 제한됩니다. 다만 현재 ${bishop.moves}개의 합법적인 이동이 있어 활동을 개선할 여지는 남아 있습니다.`
          : `${NAMES[side]}의 ${bishop.square} 비숍은 열린 대각선을 활용하고 있으며 현재 ${bishop.moves}개의 합법적인 이동이 있습니다.`
      ]);
    }

    for (
      const knight of
        snapshotData.minor[
          side
        ].knights
    ) {
      lines.push([
        `${NAMES[side]} ${knight.square} · ${knight.label}`,

        knight.outposts.length
          ? `${NAMES[side]}의 ${knight.square} 나이트는 ${knight.outposts.join(", ")}처럼 상대 폰에 쉽게 쫓겨나지 않고 지원을 받을 수 있는 칸을 활용할 가능성이 있습니다.`
          : `${NAMES[side]}의 ${knight.square} 나이트는 현재 ${knight.moves}개의 합법적인 이동을 가지고 있습니다. 단순히 이동 수를 늘리는 것보다 실제로 유지할 수 있는 좋은 칸을 찾는 것이 중요합니다.`
      ]);
    }
  }


  /*
   * Pawn structure.
   */
  const pawnData =
    snapshotData.pawnStructure;

  const pawnDescription =
    side => {
      const pawn =
        pawnData[side];

      const pieces = [];

      if (
        pawn.doubled.length
      ) {
        pieces.push(
          `더블폰 ${pawn.doubled.join(", ")}`
        );
      }

      if (
        pawn.isolated.length
      ) {
        pieces.push(
          `고립폰 ${pawn.isolated.join(", ")}`
        );
      }

      if (
        pawn.backward.length
      ) {
        pieces.push(
          `뒤처진 폰 ${pawn.backward.join(", ")}`
        );
      }

      if (
        pawn.passed.length
      ) {
        pieces.push(
          `통과폰 ${pawn.passed.join(", ")}`
        );
      }

      return pieces.length
        ? `${NAMES[side]}의 구조에서 ${pieces.join(", ")}이 확인됩니다. 각각의 약점은 자동으로 나쁜 것이 아니라 실제 공격 가능성과 교환 상황을 함께 봐야 합니다.`
        : `${NAMES[side]}의 폰 구조에서 뚜렷한 구조적 약점은 제한적입니다.`;
    };

  lines.push([
    "폰 구조",
    `${pawnDescription("w")} ${pawnDescription("b")}`
  ]);


  /*
   * Weak squares.
   */
  lines.push([
    "약한 칸",
    `백의 활용 가능한 칸: ${
      snapshotData.weakSquares.w
        .slice(0, 5)
        .join(", ") ||
      "뚜렷하지 않음"
    } / 흑: ${
      snapshotData.weakSquares.b
        .slice(0, 5)
        .join(", ") ||
      "뚜렷하지 않음"
    }`
  ]);


  /*
   * Space.
   */
  const spaceDelta =
    snapshotData.space.w -
    snapshotData.space.b;

  lines.push([
    "공간",

    Math.abs(spaceDelta) < 0.7
      ? "공간의 차이가 현재 결정적이지 않습니다."
      : `${NAMES[
          spaceDelta > 0
            ? "w"
            : "b"
        ]}이 더 많은 공간을 확보하고 있습니다. 공간이 많은 쪽은 기동성을 활용하고, 공간이 적은 쪽은 유리한 교환이나 반격을 찾는 것이 일반적인 방향입니다.`
  ]);


  /*
   * Center.
   */
  const center =
    snapshotData.center;

  lines.push([
    "중앙",

    center.occupancy.length
      ? `중앙에는 ${center.occupancy.join(", ")}이 있습니다. 중앙의 가치는 단순 점유보다 상대 기물의 활동을 실제로 제한하는지로 판단합니다.`
      : "중앙의 직접적인 점유가 뚜렷하지 않습니다."
  ]);


  /*
   * Open files.
   */
  lines.push([
    "오픈 파일",

    snapshotData.openFiles.length
      ? snapshotData.openFiles
          .map(
            file =>
              file.type === "open"
                ? `${file.file}파일(완전 오픈)`
                : `${file.file}파일(반오픈)`
          )
          .join(", ")
      : "완전 오픈 파일이 없습니다."
  ]);


  /*
   * Development.
   */
  const developmentDelta =
    snapshotData.development.w.developed -
    snapshotData.development.b.developed;

  lines.push([
    "개발",

    Math.abs(
      developmentDelta
    ) < 1
      ? "개발 차이가 크지 않습니다."
      : `${NAMES[
          developmentDelta > 0
            ? "w"
            : "b"
        ]}이 더 많은 경량 기물을 기본 위치에서 벗어나 실제 게임에 투입했습니다. 다만 개발 우세는 일시적인 요소이므로 활용할 수 있을 때 사용해야 합니다.`
  ]);


  /*
   * King safety.
   */
  const kingDelta =
    snapshotData.kingSafety.w.score -
    snapshotData.kingSafety.b.score;

  lines.push([
    "킹 안전",

    Math.abs(
      kingDelta
    ) < 1
      ? "양쪽 킹의 안전 차이가 현재 결정적이지 않습니다."
      : `${NAMES[
          kingDelta > 0
            ? "w"
            : "b"
        ]}의 킹이 상대적으로 더 안전합니다. ${NAMES[
          kingDelta < 0
            ? "w"
            : "b"
        ]}은 계획을 세우기 전에 킹 주변의 반격 가능성을 먼저 확인해야 합니다.`
  ]);


  /*
   * Initiative.
   */
  const initiativeDelta =
    snapshotData.initiative.w -
    snapshotData.initiative.b;

  lines.push([
    "주도권",

    Math.abs(
      initiativeDelta
    ) < 0.5
      ? "주도권의 차이가 뚜렷하지 않습니다."
      : `${NAMES[
          initiativeDelta > 0
            ? "w"
            : "b"
        ]}이 상대에게 대응을 요구할 수 있는 수단을 더 많이 가지고 있습니다.`
  ]);


  /*
   * Dominant imbalance.
   */
  const state =
    staticDynamic(
      snapshotData
    );

  lines.push([
    "현재 가장 중요한 불균형",
    strategicSentence(
      snapshotData
    )
  ]);

  lines.push([
    "정적 / 동적",

    state.dominant === "dynamic"
      ? "현재 우세의 성격이 동적인 요소에 더 가깝습니다."
      : state.dominant === "static"
        ? "현재 우세의 성격이 오래 지속되는 정적인 요소에 더 가깝습니다."
        : "정적 요소와 동적 요소가 함께 작용하고 있습니다."
  ]);

  lines.push([
    "우세를 사용하는 방법",
    conversionPlan(
      snapshotData
    )
  ]);

  lines.push([
    "상대의 반격",
    preventiveText(
      snapshotData
    )
  ]);

  lines.push([
    "이상적인 포지션",
    fantasyText(
      chess,
      snapshotData
    )
  ]);

  lines.push([
    "생각의 순서",
    "불균형을 찾고 → 상대의 반격을 확인하고 → 원하는 포지션을 그린 뒤 → 후보 수를 만들고 → 엔진으로 검증합니다."
  ]);

  return lines;
}


function renderFactors(
  chess,
  snapshotData,
  review
) {
  const lines =
    factorText(
      chess,
      snapshotData
    );

  if (review) {
    lines.push(
      [
        `이번 수에 대한 복기 · ${review.type}`,
        `평가 변화: ${formatScore(
          review.beforeW
        )} → ${formatScore(
          review.afterW
        )}. ${review.reason}`
      ],

      [
        "다음에 생각할 것",
        review.next
      ]
    );
  }

  els.humanFactors.innerHTML =
    lines
      .map(
        item =>
          `<div class="factor">
            <b>${esc(item[0])}</b>
            <span>${esc(item[1])}</span>
          </div>`
      )
      .join("");
}


/* =========================================================
   POSITION RENDERING
   ========================================================= */

async function renderPosition(
  ply
) {
  const position =
    positions[ply];

  const chess =
    new Chess(
      position.fen
    );

  const snapshotData =
    snapshot(chess);

  renderBoard(
    position.fen
  );

  renderMoves();

  els.moveLabel.textContent =
    `${ply} / ${positions.length - 1}`;

  els.positionLabel.textContent =
    ply === 0
      ? "시작 포지션"
      : `${Math.ceil(
          ply / 2
        )}${
          ply % 2
            ? ". "
            : "… "
        }${position.san}`;

  els.firstBtn.disabled =
    ply === 0;

  els.prevBtn.disabled =
    ply === 0;

  els.nextBtn.disabled =
    ply ===
    positions.length - 1;

  els.lastBtn.disabled =
    ply ===
    positions.length - 1;

  renderFactors(
    chess,
    snapshotData,
    null
  );

  els.evalValue.textContent =
    "분석 중…";

  els.candidateList.innerHTML =
    "";

  progress(0, 0);


  /*
   * Main MultiPV analysis.
   */
  const result =
    await analyzeFen(
      position.fen,
      11,
      3
    );

  if (
    ply !== currentPly
  ) {
    return;
  }

  els.evalValue.textContent =
    formatScore(
      result.lines[0]?.score
    );

  els.positionInsight.textContent =
    scoreBand(
      result.lines[0]?.score
    );

  progress(
    100,
    result.depth
  );


  /*
   * Candidate generation + validation.
   */
  let candidates;

  try {
    candidates =
      await buildValidatedCandidates(
        position.fen,
        snapshotData,
        8
      );
  } catch {
    /*
     * If a secondary candidate analysis fails,
     * preserve the actual engine MultiPV instead
     * of showing fabricated strategic alternatives.
     */
    candidates =
      result.lines
        .slice(0, 3)
        .map(
          (line, index) => ({
            uci:
              line.pv[0],

            san:
              uciToSan(
                position.fen,
                line.pv[0]
              ),

            label:
              index
                ? "엔진 후보"
                : "엔진 최선",

            score:
              line.score,

            pv:
              line.pv
          })
        );
  }

  if (
    ply !== currentPly
  ) {
    return;
  }


  els.candidateList.innerHTML =
    candidates
      .map(
        (candidate, index) =>
          `<div class="candidate">
            <div class="candidateTop">
              <span class="candidateName">
                ${index + 1}. ${esc(
                  candidate.san
                )} · ${esc(
                  candidate.label
                )}
              </span>

              <span class="candidateScore">
                ${formatScore(
                  candidate.score
                )}
              </span>
            </div>

            <div class="candidateDesc">
              ${esc(
                candidateDescription(
                  candidate,
                  snapshotData
                )
              )}

              <br>

              <small>
                ${esc(
                  pvToSan(
                    position.fen,
                    candidate.pv || []
                  )
                )}
              </small>
            </div>
          </div>`
      )
      .join("");


  /*
   * Review the actual move that led to this position.
   */
  let review = null;

  if (
    ply > 0
  ) {
    try {
      review =
        await reviewMove(
          ply
        );
    } catch {}
  }

  if (
    ply === currentPly
  ) {
    renderFactors(
      chess,
      snapshotData,
      review
    );
  }
}


function candidateDescription(
  candidate,
  snapshotData
) {
  if (
    candidate.label ===
    "엔진 최선"
  ) {
    return (
      "현재 포지션에서 엔진이 가장 강하게 추천하는 수입니다."
    );
  }

  if (
    candidate.label ===
    "전략적 대안"
  ) {
    return (
      `${snapshotData.dominantImbalance.label}을 유지하거나 강화하면서 다른 수순을 선택하는 방법입니다. 상대의 반격 가능성도 함께 확인한 후보입니다.`
    );
  }

  if (
    candidate.label ===
    "실전적 대안"
  ) {
    return (
      "엔진 최선과 약간의 차이가 있더라도 상대의 계획을 제한하고 사람이 이해하기 쉬운 방향을 택하는 수입니다."
    );
  }

  return (
    "현재의 핵심 불균형을 다른 방식으로 다루는 후보입니다."
  );
}


/* =========================================================
   PLY NAVIGATION
   ========================================================= */

async function selectPly(
  ply
) {
  currentPly =
    Math.max(
      0,
      Math.min(
        positions.length - 1,
        ply
      )
    );

  try {
    await renderPosition(
      currentPly
    );
  } catch (error) {
    if (
      error.message !==
      "CANCELLED"
    ) {
      showError(
        error.message ||
        "분석에 실패했습니다."
      );
    }
  }
}


/* =========================================================
   CRITICAL MOMENTS
   ========================================================= */

/*
 * A lightweight first-pass scan.
 *
 * Large evaluation changes are flagged as possible
 * critical moments. The detailed position analysis
 * remains available when the user navigates to that move.
 */
async function scanCriticalMoments() {
  if (
    positions.length < 3
  ) {
    return;
  }

  const swings = [];

  for (
    let i = 1;
    i < positions.length;
    i++
  ) {
    try {
      const before =
        await analyzeFen(
          positions[i - 1].fen,
          6,
          1
        );

      const after =
        await analyzeFen(
          positions[i].fen,
          6,
          1
        );

      const beforeValue =
        before.lines[0]?.score ??
        0;

      const afterValue =
        after.lines[0]?.score ??
        0;

      const mover =
        i % 2
          ? "w"
          : "b";

      const swing =
        Math.abs(
          mover === "w"
            ? afterValue -
              beforeValue
            : beforeValue -
              afterValue
        );

      if (
        swing >= 0.55
      ) {
        swings.push({
          ply: i,
          swing,
          before: beforeValue,
          after: afterValue
        });
      }
    } catch (error) {
      if (
        error.message ===
        "CANCELLED"
      ) {
        return;
      }
    }
  }

  criticalMoments =
    swings
      .sort(
        (a, b) =>
          b.swing -
          a.swing
      )
      .slice(0, 8)
      .map(
        item =>
          item.ply
      );
}


/* =========================================================
   GAME START
   ========================================================= */

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
  reviewCache.clear();

  gameAnalysis = null;
  criticalMoments = [];

  els.inputView.hidden =
    true;

  els.analysisView.hidden =
    false;

  els.gameMeta.textContent =
    `${positions.length - 1}수`;

  renderMoves();

  await initEngine();

  await selectPly(0);

  /*
   * The critical-moment scan is deliberately
   * shallow and runs after the first position
   * is already visible.
   */
  const gameToken =
    positions.length;

  setTimeout(
    () => {
      if (
        positions.length ===
        gameToken
      ) {
        scanCriticalMoments()
          .catch(() => {});
      }
    },
    150
  );
}


/* =========================================================
   BUTTONS
   ========================================================= */

els.exampleBtn.onclick =
  () => {
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


els.backBtn.onclick =
  () => {
    cancelJob();

    els.analysisView.hidden =
      true;

    els.inputView.hidden =
      false;
  };


els.firstBtn.onclick =
  () =>
    selectPly(0);

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
   STARTUP
   ========================================================= */

initEngine().catch(
  () => {}
);
