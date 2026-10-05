import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

/*
 * Human Chess Insight
 * STEP 1 — New analysis architecture
 *
 * 유지:
 * - PGN 입력
 * - 체스판
 * - 수순 이동
 * - Stockfish
 * - 엔진 평가
 * - MultiPV 3
 *
 * 새 구조:
 * POSITION
 * → GAME PHASE
 * → POSITION SNAPSHOT
 * → MATERIAL
 *
 * 이후 단계:
 * → MINOR PIECES
 * → PAWN STRUCTURE
 * → WEAK SQUARES
 * → SPACE
 * → CENTER
 * → OPEN FILES
 * → DEVELOPMENT / INITIATIVE
 * → KING SAFETY
 * → DOMINANT IMBALANCE
 * → COUNTERPLAY
 * → FANTASY POSITION
 * → CANDIDATES
 * → STOCKFISH VALIDATION
 * → HUMAN EXPLANATION
 */

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
  new URL(
    "stockfish/stockfish-19-lite-single.js",
    import.meta.url
  ).toString();

let engine = null;
let engineReady = false;
let engineInitPromise = null;

let currentAnalysis = null;
let analysisToken = 0;

let positions = [];
let currentPly = 0;

let analysisCache = new Map();


/* =========================================================
   UI / ENGINE
   ========================================================= */

function setStatus(text, type = "loading") {
  els.engineStatus.textContent = text;
  els.engineStatus.className =
    `status ${type}`;
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


/* =========================================================
   STOCKFISH
   ========================================================= */

function initEngine() {
  if (engineInitPromise) {
    return engineInitPromise;
  }

  engineInitPromise =
    new Promise((resolve, reject) => {
      setStatus(
        "Stockfish 로딩 중…",
        "loading"
      );

      try {
        engine =
          new Worker(ENGINE_PATH);
      } catch (e) {
        reject(e);
        return;
      }

      let phase = "boot";

      const timer =
        setTimeout(() => {
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

        if (!line) {
          return;
        }

        if (
          line === "uciok" &&
          phase === "boot"
        ) {
          phase = "waiting-ready";

          engine.postMessage(
            "setoption name MultiPV value 3"
          );

          engine.postMessage(
            "isready"
          );

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
    })
      .catch(error => {
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
   ENGINE SCORE
   ========================================================= */

function parseScore(tokens) {
  const i =
    tokens.indexOf("score");

  if (i < 0) {
    return null;
  }

  const kind =
    tokens[i + 1];

  const value =
    Number(tokens[i + 2]);

  if (
    !kind ||
    Number.isNaN(value)
  ) {
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
  if (!score) {
    return null;
  }

  if (score.type === "cp") {
    return (
      (
        turn === "w"
          ? score.raw
          : -score.raw
      ) / 100
    );
  }

  const sign =
    score.raw > 0
      ? 1
      : -1;

  return (
    turn === "w"
      ? sign * 100
      : -sign * 100
  );
}

function formatScore(value) {
  if (
    value === null ||
    value === undefined ||
    Number.isNaN(value)
  ) {
    return "—";
  }

  if (
    Math.abs(value) >= 99
  ) {
    return value > 0
      ? "+M"
      : "−M";
  }

  return `${
    value >= 0
      ? "+"
      : "−"
  }${Math.abs(value).toFixed(1)}`;
}

function scoreLabel(value) {
  const a =
    Math.abs(value ?? 0);

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


/* =========================================================
   UCI → SAN
   ========================================================= */

function uciToSan(fen, uci) {
  try {
    const c =
      new Chess(fen);

    const move =
      c.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4]
      });

    return move
      ? move.san
      : uci;
  } catch {
    return uci;
  }
}


/* =========================================================
   CANCEL ENGINE
   ========================================================= */

function cancelCurrentAnalysis() {
  if (!currentAnalysis) {
    return;
  }

  const old =
    currentAnalysis;

  currentAnalysis = null;

  clearTimeout(
    old.timeout
  );

  old.reject?.(
    new Error(
      "이전 분석이 취소되었습니다."
    )
  );

  if (
    engineReady &&
    engine
  ) {
    engine.postMessage(
      "stop"
    );
  }
}


/* =========================================================
   ANALYZE FEN
   ========================================================= */

function analyzeFen(
  fen,
  depth = 10
) {
  if (
    analysisCache.has(fen)
  ) {
    return Promise.resolve(
      analysisCache.get(fen)
    );
  }

  if (
    !engineReady ||
    !engine
  ) {
    return Promise.reject(
      new Error(
        "Stockfish가 아직 준비되지 않았습니다."
      )
    );
  }

  cancelCurrentAnalysis();

  return new Promise(
    (resolve, reject) => {
      const token =
        ++analysisToken;

      const turn =
        fen.split(" ")[1];

      const result = {
        fen,
        turn,
        lines: new Map(),
        depth: 0
      };

      const timeout =
        setTimeout(() => {
          if (
            currentAnalysis?.token !==
            token
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
            currentAnalysis?.token !==
            token
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
              tokens.indexOf(
                "depth"
              );

            const multiPvIndex =
              tokens.indexOf(
                "multipv"
              );

            const pvIndex =
              tokens.indexOf(
                "pv"
              );

            const d =
              depthIndex >= 0
                ? Number(
                    tokens[
                      depthIndex + 1
                    ]
                  )
                : 0;

            const multiPv =
              multiPvIndex >= 0
                ? Number(
                    tokens[
                      multiPvIndex + 1
                    ]
                  )
                : 1;

            const score =
              whiteScore(
                parseScore(
                  tokens
                ),
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
            line.startsWith(
              "bestmove"
            )
          ) {
            clearTimeout(
              timeout
            );

            currentAnalysis =
              null;

            result.lines =
              [
                ...result.lines.entries()
              ]
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
    }
  );
}


/* =========================================================
   POSITION LIST
   ========================================================= */

function buildPositions(chess) {
  const list = [];

  let c =
    new Chess();

  list.push({
    ply: 0,
    fen: c.fen(),
    san: null,
    uci: null
  });

  chess
    .history({
      verbose: true
    })
    .forEach(
      (move, index) => {
        const made =
          c.move(
            move.san
          );

        list.push({
          ply: index + 1,
          fen: c.fen(),
          san: made.san,
          uci:
            `${made.from}${made.to}${
              made.promotion || ""
            }`
        });
      }
    );

  return list;
}


/* =========================================================
   BOARD
   ========================================================= */

function renderBoard(fen) {
  const c =
    new Chess(fen);

  const board =
    c.board();

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

  els.board.innerHTML =
    "";

  board.forEach(
    (row, ri) => {
      row.forEach(
        (piece, ci) => {
          const square =
            document.createElement(
              "div"
            );

          square.className =
            `sq ${
              (ri + ci) % 2 === 0
                ? "light"
                : "dark"
            }`;

          if (piece) {
            square.textContent =
              piece.color === "w"
                ? white[
                    piece.type
                  ]
                : black[
                    piece.type
                  ];
          }

          els.board.appendChild(
            square
          );
        }
      );
    }
  );
}


/* =========================================================
   MOVE LIST
   ========================================================= */

function renderMoves() {
  els.moveList.innerHTML =
    "";

  positions.forEach(
    (position, index) => {
      if (index === 0) {
        return;
      }

      const button =
        document.createElement(
          "button"
        );

      button.className =
        `moveItem ${
          index === currentPly
            ? "active"
            : ""
        }`;

      button.textContent =
        `${Math.ceil(index / 2)}${
          index % 2
            ? "."
            : "…"
        } ${position.san}`;

      button.onclick =
        () =>
          selectPly(index);

      els.moveList.appendChild(
        button
      );
    }
  );
}


/* =========================================================
   POSITION SNAPSHOT
   ========================================================= */

const COLOR_NAMES = {
  w: "백",
  b: "흑"
};

const PIECE_VALUES = {
  p: 1,
  n: 3.2,
  b: 3.3,
  r: 5,
  q: 9,
  k: 0
};


/* =========================================================
   FIND PIECES
   ========================================================= */

function findPieces(
  board,
  color,
  type
) {
  const result = [];

  board.forEach(
    (row, ri) => {
      row.forEach(
        (piece, ci) => {
          if (
            piece &&
            piece.color === color &&
            piece.type === type
          ) {
            const file =
              String.fromCharCode(
                97 + ci
              );

            const rank =
              8 - ri;

            result.push({
              piece,
              square:
                `${file}${rank}`
            });
          }
        }
      );
    }
  );

  return result;
}

function countPieces(
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


/* =========================================================
   GAME PHASE
   ========================================================= */

function getGamePhase(chess) {
  const moveCount =
    chess.history().length;

  const queens =
    countPieces(
      chess,
      "w",
      "q"
    ) +
    countPieces(
      chess,
      "b",
      "q"
    );

  const rooks =
    countPieces(
      chess,
      "w",
      "r"
    ) +
    countPieces(
      chess,
      "b",
      "r"
    );

  const minorPieces =
    countPieces(
      chess,
      "w",
      "b"
    ) +
    countPieces(
      chess,
      "b",
      "b"
    ) +
    countPieces(
      chess,
      "w",
      "n"
    ) +
    countPieces(
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
    minorPieces >= 6
  ) {
    return "opening";
  }

  /*
   * 엔드게임
   */
  if (
    queens === 0 ||
    (
      rooks <= 2 &&
      minorPieces <= 2
    )
  ) {
    return "endgame";
  }

  /*
   * 그 외
   */
  return "middlegame";
}

function getPhaseName(
  phase
) {
  if (
    phase === "opening"
  ) {
    return "오프닝";
  }

  if (
    phase === "endgame"
  ) {
    return "엔드게임";
  }

  return "미들게임";
}


/* =========================================================
   MATERIAL
   ========================================================= */

function analyzeMaterial(chess) {
  const result = {
    white: {
      pieces: {},
      total: 0
    },

    black: {
      pieces: {},
      total: 0
    },

    difference: 0,

    type: "equal",

    relevance: "low"
  };

  for (
    const color of [
      "w",
      "b"
    ]
  ) {
    const side =
      color === "w"
        ? result.white
        : result.black;

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
        countPieces(
          chess,
          color,
          type
        );

      side.pieces[type] =
        count;

      side.total +=
        count *
        PIECE_VALUES[type];
    }
  }

  result.difference =
    Number(
      (
        result.white.total -
        result.black.total
      ).toFixed(1)
    );

  const d =
    result.difference;

  if (
    Math.abs(d) < 0.3
  ) {
    result.type =
      "equal";
  } else if (
    Math.abs(d) < 1.5
  ) {
    result.type =
      "pawn_advantage";
  } else if (
    Math.abs(d) < 3.5
  ) {
    result.type =
      "minor_piece_advantage";
  } else if (
    Math.abs(d) < 5.5
  ) {
    result.type =
      "exchange_or_multiple_pawns";
  } else {
    result.type =
      "major_material_advantage";
  }

  result.relevance =
    Math.abs(d) >= 1.5
      ? "medium"
      : "low";

  return result;
}


/* =========================================================
   POSITION SNAPSHOT
   ========================================================= */

function createPositionSnapshot(
  chess
) {
  const phase =
    getGamePhase(chess);

  return {
    fen:
      chess.fen(),

    turn:
      chess.turn(),

    moveNumber:
      chess.moveNumber(),

    phase,

    /*
     * 현재 실제 분석 모듈
     */
    material:
      analyzeMaterial(chess),

    /*
     * 앞으로 추가될 전략 모듈
     */
    minorPieces:
      null,

    pawnStructure:
      null,

    weakSquares:
      null,

    space:
      null,

    center:
      null,

    openFiles:
      null,

    development:
      null,

    initiative:
      null,

    king:
      null,

    /*
     * 상위 사고 단계
     */
    dominantImbalance:
      null,

    sideOfBoard:
      null,

    counterplay:
      null,

    preventivePlan:
      null,

    fantasyPosition:
      null,

    candidates:
      []
  };
}


/* =========================================================
   HUMAN FACTORS
   ========================================================= */

function materialText(
  material
) {
  const d =
    material.difference;

  if (
    Math.abs(d) < 0.3
  ) {
    return "현재 기물 가치의 차이는 거의 없습니다.";
  }

  if (d > 0) {
    return `백이 약 ${Math.abs(d).toFixed(1)}점의 물질적 우세를 가지고 있습니다.`;
  }

  return `흑이 약 ${Math.abs(d).toFixed(1)}점의 물질적 우세를 가지고 있습니다.`;
}

function buildInitialStrategyText(
  snapshot
) {
  const phaseName =
    getPhaseName(
      snapshot.phase
    );

  /*
   * 아직 모든 불균형을 분석하지 않았기 때문에
   * 여기에서 성급하게 "가장 중요한 불균형"을 결정하지 않는다.
   */
  return `현재는 ${phaseName}으로 분류됩니다. 전략 분석은 기물의 개수부터 시작해 이후 활동성, 폰 구조, 공간, 킹 안전 등의 불균형을 차례대로 비교하게 됩니다.`;
}

function renderFactorsFromSnapshot(
  snapshot
) {
  const phaseName =
    getPhaseName(
      snapshot.phase
    );

  const items = [
    [
      "게임 단계",
      `현재 ${phaseName}입니다.`
    ],

    [
      "기물의 개수",
      materialText(
        snapshot.material
      )
    ],

    [
      "기물의 활동성",
      "다음 단계에서 실제 기물의 이동 범위와 좋은 배치 가능성을 분석합니다."
    ],

    [
      "폰 구조",
      "다음 단계에서 고립폰, 더블폰, 후방폰, 통과폰, 폰 브레이크 등을 분석합니다."
    ],

    [
      "공간",
      "다음 단계에서 각 진영의 실제 활동 공간과 상대 기물에 대한 제한을 분석합니다."
    ],

    [
      "킹의 안전",
      "다음 단계에서 킹 주변의 공격 가능성과 게임 단계에 따른 킹의 역할을 분석합니다."
    ],

    [
      "현재의 생각",
      buildInitialStrategyText(
        snapshot
      )
    ]
  ];

  els.humanFactors.innerHTML =
    items
      .map(
        ([title, text]) =>
          `<div class="factor">
            <b>${title}</b>
            <span>${text}</span>
          </div>`
      )
      .join("");
}


/* =========================================================
   ENGINE RESULT
   ========================================================= */

function renderAnalysis(
  result
) {
  const position =
    positions[currentPly];

  const evaluation =
    result.lines[0]?.score ??
    null;

  els.evalValue.textContent =
    formatScore(
      evaluation
    );

  els.positionInsight.textContent =
    scoreLabel(
      evaluation
    );

  els.depthValue.textContent =
    result.depth || "—";

  els.progressBar.style.width =
    "100%";

  els.candidateList.innerHTML =
    "";

  /*
   * 지금은 엔진 후보를 그대로 보여준다.
   * 이후 Candidate Engine에서
   *
   * Engine Best
   * Strategic Alternative
   * Practical Move
   * Different Plan
   *
   * 으로 재분류한다.
   */
  const labels = [
    "엔진 최선",
    "전략 분석 대기",
    "전략 분석 대기"
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

        const description =
          index === 0
            ? "현재 단계에서는 엔진이 계산한 최선의 수를 표시합니다. 전략적 후보 분류는 이후 단계에서 추가합니다."
            : "아직 전략 엔진의 후보 분류 단계가 구현되지 않았습니다.";

        els.candidateList.insertAdjacentHTML(
          "beforeend",
          `<div class="candidate">
            <div class="candidateTop">
              <span class="candidateName">
                ${index + 1}. ${san} · ${labels[index]}
              </span>

              <span class="candidateScore">
                ${formatScore(
                  line.score
                )}
              </span>
            </div>

            <div class="candidateDesc">
              ${description}
            </div>
          </div>`
        );
      }
    );

  /*
   * 현재 포지션의 Snapshot 생성
   */
  const chess =
    new Chess(
      position.fen
    );

  const snapshot =
    createPositionSnapshot(
      chess
    );

  renderFactorsFromSnapshot(
    snapshot
  );
}


/* =========================================================
   SELECT PLY
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

  const position =
    positions[currentPly];

  renderBoard(
    position.fen
  );

  renderMoves();

  els.moveLabel.textContent =
    `${currentPly} / ${
      positions.length - 1
    }`;

  els.positionLabel.textContent =
    currentPly === 0
      ? "시작 포지션"
      : `${Math.ceil(
          currentPly / 2
        )}${
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

  renderProgress(
    0,
    0
  );

  els.evalValue.textContent =
    "분석 중…";

  els.candidateList.innerHTML =
    "";

  /*
   * 엔진 분석 전에
   * Snapshot을 먼저 계산한다.
   */
  const snapshot =
    createPositionSnapshot(
      new Chess(
        position.fen
      )
    );

  renderFactorsFromSnapshot(
    snapshot
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


/* =========================================================
   START GAME
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

  currentPly =
    0;

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
    cancelCurrentAnalysis();

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
   START
   ========================================================= */

initEngine().catch(
  () => {}
);
