import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

/*
 * Human Chess Insight
 * STEP 2 — Minor Pieces / Bishop
 *
 * 사고 구조
 *
 * POSITION
 * → GAME PHASE
 * → MATERIAL
 * → MINOR PIECES
 *    → BISHOP
 *       → Good Bishop
 *       → Bad Bishop
 *       → Active Bishop
 *       → Improvement Plan
 *
 * 이후 단계
 * → KNIGHT
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


/* =========================================================
   BASIC
   ========================================================= */

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


/* =========================================================
   EXAMPLE
   ========================================================= */

const EXAMPLE = `[Event "Human Chess Insight Demo"]
[Site "Local"]
[Date "2026.01.01"]
[Round "1"]
[White "White"]
[Black "Black"]
[Result "*"]

1. e4 e5
2. Nf3 Nc6
3. Bb5 a6
4. Ba4 Nf6
5. O-O Be7
6. Re1 b5
7. Bb3 d6
8. c3 O-O
9. h3 *`;


/* =========================================================
   STOCKFISH
   ========================================================= */

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
   UI / ENGINE STATUS
   ========================================================= */

function setStatus(
  text,
  type = "loading"
) {
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

function renderProgress(
  percent,
  depth = 0
) {
  els.progressBar.style.width =
    `${Math.max(
      0,
      Math.min(100, percent)
    )}%`;

  els.depthValue.textContent =
    depth
      ? String(depth)
      : "—";
}


/* =========================================================
   STOCKFISH INITIALIZATION
   ========================================================= */

function initEngine() {
  if (engineInitPromise) {
    return engineInitPromise;
  }

  engineInitPromise =
    new Promise(
      (resolve, reject) => {
        setStatus(
          "Stockfish 로딩 중…",
          "loading"
        );

        try {
          engine =
            new Worker(
              ENGINE_PATH
            );
        } catch (e) {
          reject(e);
          return;
        }

        let phase = "boot";

        const timer =
          setTimeout(
            () => {
              reject(
                new Error(
                  "Stockfish 로딩 시간이 초과되었습니다."
                )
              );
            },
            30000
          );

        engine.onerror =
          event => {
            clearTimeout(timer);

            reject(
              new Error(
                event?.message ||
                "Stockfish Worker 오류"
              )
            );
          };

        engine.onmessage =
          event => {
            const line =
              typeof event.data ===
              "string"
                ? event.data.trim()
                : "";

            if (!line) {
              return;
            }

            if (
              line === "uciok" &&
              phase === "boot"
            ) {
              phase =
                "waiting-ready";

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
              phase ===
                "waiting-ready"
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
              currentAnalysis.onLine(
                line
              );
            }
          };

        engine.postMessage(
          "uci"
        );
      }
    )
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
    Number(
      tokens[i + 2]
    );

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

function whiteScore(
  score,
  turn
) {
  if (!score) {
    return null;
  }

  if (
    score.type === "cp"
  ) {
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

function uciToSan(
  fen,
  uci
) {
  try {
    const c =
      new Chess(fen);

    const move =
      c.move({
        from:
          uci.slice(0, 2),
        to:
          uci.slice(2, 4),
        promotion:
          uci[4]
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
        setTimeout(
          () => {
            if (
              currentAnalysis?.token !==
              token
            ) {
              return;
            }

            currentAnalysis =
              null;

            reject(
              new Error(
                "엔진 분석 시간이 초과되었습니다."
              )
            );
          },
          30000
        );

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

function buildPositions(
  chess
) {
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

function renderBoard(
  fen
) {
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
   PIECE / BOARD HELPERS
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
                `${file}${rank}`,
              row: ri,
              col: ci
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

function squareToCoords(
  square
) {
  return {
    col:
      square.charCodeAt(0) - 97,

    row:
      8 - Number(
        square[1]
      )
  };
}

function coordsToSquare(
  row,
  col
) {
  if (
    row < 0 ||
    row > 7 ||
    col < 0 ||
    col > 7
  ) {
    return null;
  }

  return (
    String.fromCharCode(
      97 + col
    ) +
    String(
      8 - row
    )
  );
}

function isInsideBoard(
  row,
  col
) {
  return (
    row >= 0 &&
    row < 8 &&
    col >= 0 &&
    col < 8
  );
}


/* =========================================================
   GAME PHASE
   ========================================================= */

function getGamePhase(
  chess
) {
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

  if (
    moveCount <= 12 &&
    queens >= 2 &&
    rooks >= 4 &&
    minorPieces >= 6
  ) {
    return "opening";
  }

  if (
    queens === 0 ||
    (
      rooks <= 2 &&
      minorPieces <= 2
    )
  ) {
    return "endgame";
  }

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

function analyzeMaterial(
  chess
) {
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
   BISHOP ANALYSIS
   ========================================================= */

/*
 * 한 비숍에서 실제로 확인하는 것:
 *
 * 1. 현재 위치에서 각 대각선이 어디까지 열려 있는가
 * 2. 자기 폰이 실제로 활동을 막고 있는가
 * 3. 상대 기물/폰과의 상호작용이 있는가
 * 4. 열린 대각선이 있는가
 * 5. 현재 위치가 단순히 "나쁘게 생긴 것"인지
 *    아니면 실제로 활동이 제한된 것인지
 *
 * 중요한 점:
 * "한 방향이 막혀 있다"
 * ≠
 * "Bad Bishop"
 *
 * 실제 활동 가능한 대각선이 남아 있다면
 * 그 사실을 반영한다.
 */


/* ---------------------------------------------------------
   Bishop rays
   --------------------------------------------------------- */

function getBishopRays(
  chess,
  square
) {
  const board =
    chess.board();

  const start =
    squareToCoords(
      square
    );

  const directions = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1]
  ];

  const rays = [];

  directions.forEach(
    ([dr, dc]) => {
      const ray = [];

      let row =
        start.row + dr;

      let col =
        start.col + dc;

      while (
        isInsideBoard(
          row,
          col
        )
      ) {
        const target =
          board[row][col];

        const targetSquare =
          coordsToSquare(
            row,
            col
          );

        ray.push({
          square:
            targetSquare,

          piece:
            target || null,

          occupied:
            Boolean(target),

          own:
            Boolean(
              target &&
              target.color ===
                chess.get(
                  square
                )?.color
            ),

          enemy:
            Boolean(
              target &&
              target.color !==
                chess.get(
                  square
                )?.color
            )
        });

        if (target) {
          break;
        }

        row += dr;
        col += dc;
      }

      rays.push(ray);
    }
  );

  return rays;
}


/* ---------------------------------------------------------
   Bishop accessible squares
   --------------------------------------------------------- */

function getBishopAccessibleSquares(
  chess,
  square
) {
  const piece =
    chess.get(square);

  if (
    !piece ||
    piece.type !== "b"
  ) {
    return [];
  }

  const board =
    chess.board();

  const start =
    squareToCoords(
      square
    );

  const directions = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1]
  ];

  const accessible = [];

  directions.forEach(
    ([dr, dc]) => {
      let row =
        start.row + dr;

      let col =
        start.col + dc;

      while (
        isInsideBoard(
          row,
          col
        )
      ) {
        const target =
          board[row][col];

        const squareName =
          coordsToSquare(
            row,
            col
          );

        if (!target) {
          accessible.push(
            squareName
          );
        } else {
          if (
            target.color !==
            piece.color
          ) {
            accessible.push(
              squareName
            );
          }

          break;
        }

        row += dr;
        col += dc;
      }
    }
  );

  return accessible;
}


/* ---------------------------------------------------------
   Bishop direction information
   --------------------------------------------------------- */

function bishopRayInfo(
  chess,
  square
) {
  const piece =
    chess.get(square);

  if (
    !piece ||
    piece.type !== "b"
  ) {
    return null;
  }

  const board =
    chess.board();

  const start =
    squareToCoords(
      square
    );

  const directions = [
    {
      name: "위-왼쪽",
      dr: -1,
      dc: -1
    },
    {
      name: "위-오른쪽",
      dr: -1,
      dc: 1
    },
    {
      name: "아래-왼쪽",
      dr: 1,
      dc: -1
    },
    {
      name: "아래-오른쪽",
      dr: 1,
      dc: 1
    }
  ];

  return directions.map(
    direction => {
      let row =
        start.row +
        direction.dr;

      let col =
        start.col +
        direction.dc;

      const squares = [];

      let blocker = null;

      while (
        isInsideBoard(
          row,
          col
        )
      ) {
        const target =
          board[row][col];

        const targetSquare =
          coordsToSquare(
            row,
            col
          );

        if (!target) {
          squares.push(
            targetSquare
          );
        } else {
          blocker = {
            square:
              targetSquare,

            color:
              target.color,

            type:
              target.type
          };

          break;
        }

        row +=
          direction.dr;

        col +=
          direction.dc;
      }

      return {
        name:
          direction.name,

        squares,

        blocker
      };
    }
  );
}


/* ---------------------------------------------------------
   Central pawn test
   --------------------------------------------------------- */

function isCentralPawnSquare(
  square
) {
  if (!square) {
    return false;
  }

  const file =
    square.charCodeAt(0) -
    97;

  const rank =
    Number(square[1]);

  /*
   * 중앙 파일:
   * c,d,e,f
   *
   * 중앙 폰 판단은
   * 단순히 중앙에 있는 모든 폰을
   * 나쁜 것으로 취급하지 않는다.
   */
  return (
    file >= 2 &&
    file <= 5 &&
    rank >= 3 &&
    rank <= 6
  );
}


/* ---------------------------------------------------------
   Find meaningful bishop blockers
   --------------------------------------------------------- */

function analyzeBishopBlockers(
  chess,
  square
) {
  const piece =
    chess.get(square);

  if (
    !piece ||
    piece.type !== "b"
  ) {
    return {
      blockers: [],
      centralBlockers: [],
      pawnBlockers: []
    };
  }

  const rays =
    bishopRayInfo(
      chess,
      square
    );

  const blockers = [];
  const centralBlockers = [];
  const pawnBlockers = [];

  rays.forEach(
    ray => {
      if (!ray.blocker) {
        return;
      }

      const blocker =
        ray.blocker;

      blockers.push({
        ...blocker,
        direction:
          ray.name
      });

      if (
        blocker.color ===
        piece.color &&
        blocker.type === "p"
      ) {
        pawnBlockers.push({
          ...blocker,
          direction:
            ray.name
        });

        if (
          isCentralPawnSquare(
            blocker.square
          )
        ) {
          centralBlockers.push({
            ...blocker,
            direction:
              ray.name
          });
        }
      }
    }
  );

  return {
    blockers,
    centralBlockers,
    pawnBlockers
  };
}


/* ---------------------------------------------------------
   Bishop activity
   --------------------------------------------------------- */

function analyzeBishopActivity(
  chess,
  square
) {
  const piece =
    chess.get(square);

  if (
    !piece ||
    piece.type !== "b"
  ) {
    return null;
  }

  const accessible =
    getBishopAccessibleSquares(
      chess,
      square
    );

  const rays =
    bishopRayInfo(
      chess,
      square
    );

  const blockers =
    analyzeBishopBlockers(
      chess,
      square
    );

  let enemyTargets = 0;

  rays.forEach(
    ray => {
      if (
        ray.blocker &&
        ray.blocker.color !==
          piece.color
      ) {
        enemyTargets++;
      }
    }
  );

  const openDirections =
    rays.filter(
      ray =>
        !ray.blocker
    ).length;

  const activeDirections =
    rays.filter(
      ray =>
        ray.squares.length >= 2
    ).length;

  /*
   * 활동성은 단순 이동 칸 숫자가 아니라
   * 실제 열린 대각선과 상대와의 접촉을 함께 본다.
   */
  const activityScore =
    (
      accessible.length * 0.45
    ) +
    (
      openDirections * 1.5
    ) +
    (
      activeDirections * 1.0
    ) +
    (
      enemyTargets * 1.5
    );

  return {
    accessibleSquares:
      accessible,

    accessibleCount:
      accessible.length,

    openDirections,

    activeDirections,

    enemyTargets,

    activityScore,

    blockers
  };
}


/* ---------------------------------------------------------
   Bishop color complex
   --------------------------------------------------------- */

function getSquareColor(
  square
) {
  const { row, col } =
    squareToCoords(
      square
    );

  return (
    (row + col) % 2 === 0
      ? "light"
      : "dark"
  );
}


/* ---------------------------------------------------------
   Bishop type
   --------------------------------------------------------- */

function classifyBishop(
  chess,
  square
) {
  const piece =
    chess.get(square);

  if (
    !piece ||
    piece.type !== "b"
  ) {
    return null;
  }

  const activity =
    analyzeBishopActivity(
      chess,
      square
    );

  const blockers =
    activity.blockers;

  const centralPawnBlockers =
    blockers.centralBlockers.length;

  const totalPawnBlockers =
    blockers.pawnBlockers.length;

  const accessible =
    activity.accessibleCount;

  const openDirections =
    activity.openDirections;

  const enemyTargets =
    activity.enemyTargets;

  /*
   * 실제 활동성이 충분하고
   * 중앙 폰에 의한 지속적 제한이 약하다면
   * Active / Good 쪽으로 본다.
   */
  if (
    enemyTargets >= 1 &&
    accessible >= 5 &&
    centralPawnBlockers === 0
  ) {
    return {
      type: "active",
      label: "활동적인 비숍"
    };
  }

  /*
   * 중앙 폰이 실제 대각선 활동을 막고 있고
   * 다른 대각선의 활동성도 낮다면
   * Bad Bishop 쪽으로 분류한다.
   */
  if (
    centralPawnBlockers >= 1 &&
    accessible <= 4 &&
    openDirections <= 2
  ) {
    return {
      type: "bad",
      label: "나쁜 비숍"
    };
  }

  /*
   * 구조적으로 중앙 폰과 같은 색에 놓여 있어도
   * 실제 활동할 공간이 충분하면
   * 무조건 Bad Bishop으로 판정하지 않는다.
   */
  if (
    accessible >= 6 &&
    openDirections >= 2
  ) {
    return {
      type: "good",
      label: "좋은 비숍"
    };
  }

  /*
   * 실제 공격 대상이 없더라도
   * 열린 대각선이 충분하면 활동적인 상태로 본다.
   */
  if (
    accessible >= 5 &&
    openDirections >= 1
  ) {
    return {
      type: "active",
      label: "활동적인 비숍"
    };
  }

  /*
   * 애매한 경우
   * Bad이라고 과잉 판정하지 않는다.
   */
  return {
    type: "neutral",
    label: "활동 여지가 있는 비숍"
  };
}


/* ---------------------------------------------------------
   Bishop improvement plans
   --------------------------------------------------------- */

function bishopCanMoveTo(
  chess,
  from,
  to
) {
  try {
    const moves =
      chess.moves({
        square: from,
        verbose: true
      });

    return moves.some(
      move =>
        move.to === to
    );
  } catch {
    return false;
  }
}

function getBishopImprovementPlans(
  chess,
  bishop
) {
  const plans = [];

  const {
    square,
    color
  } = bishop;

  /*
   * -------------------------------------------------------
   * 직접적인 비숍 이동
   * -------------------------------------------------------
   */

  const directMoves =
    getBishopAccessibleSquares(
      chess,
      square
    );

  /*
   * 실제로 갈 수 있는 대표적인 개선 칸을 찾는다.
   *
   * 모든 이동을 "추천 수"라고 부르지 않고,
   * 후보 계획으로만 저장한다.
   */

  const preferredSquares =
    color === "b"
      ? [
          "d7",
          "e6",
          "f5",
          "g4",
          "h3",
          "b7",
          "a6"
        ]
      : [
          "d2",
          "e3",
          "f4",
          "g5",
          "h6",
          "b2",
          "a3"
        ];

  preferredSquares.forEach(
    target => {
      if (
        directMoves.includes(
          target
        )
      ) {
        plans.push({
          kind:
            "direct",
          move:
            `${square}-${target}`,
          text:
            `현재 비숍에서 ${target}로 이동할 수 있어 활동 범위를 개선할 여지가 있습니다.`
        });
      }
    }
  );

  /*
   * -------------------------------------------------------
   * ...Bd7 / Bd2 계열
   * -------------------------------------------------------
   */

  const naturalDevelopment =
    color === "b"
      ? "d7"
      : "d2";

  if (
    directMoves.includes(
      naturalDevelopment
    )
  ) {
    plans.push({
      kind:
        "natural_development",
      move:
        naturalDevelopment,
      text:
        `${naturalDevelopment} 방향이 실제로 열려 있으므로 비숍을 그쪽으로 개선할 수 있습니다.`
    });
  }

  /*
   * -------------------------------------------------------
   * ...b6 → ...Bb7
   *
   * 현재 비숍이 c8에 있고
   * b7이 비어 있으며
   * b6가 합법적인 전진이라면
   * "가능한 개선 계획"으로만 제시한다.
   * -------------------------------------------------------
   */

  if (
    color === "b" &&
    square === "c8"
  ) {
    const b7 =
      chess.get("b7");

    const b6 =
      chess.get("b6");

    const bPawn =
      chess.get("b7");

    if (
      bPawn &&
      bPawn.color === "b" &&
      bPawn.type === "p"
    ) {
      const b6Moves =
        chess.moves({
          square: "b7",
          verbose: true
        });

      const canB6 =
        b6Moves.some(
          move =>
            move.to === "b6"
        );

      if (canB6) {
        plans.push({
          kind:
            "fianchetto_plan",
          move:
            "...b6 → ...Bb7",
          text:
            "현재 c8 비숍의 활동을 장기적으로 넓히는 한 가지 계획으로 ...b6 뒤 ...Bb7을 고려할 수 있습니다."
        });
      }
    }
  }

  /*
   * -------------------------------------------------------
   * ...g6 → ...Bg7
   *
   * g7 폰이 있고 g6가 가능하며
   * Bg7로 이어질 수 있는 구조인지 확인한다.
   * -------------------------------------------------------
   */

  if (
    color === "b" &&
    square === "f8"
  ) {
    const g7 =
      chess.get("g7");

    if (
      g7 &&
      g7.color === "b" &&
      g7.type === "p"
    ) {
      const g6Moves =
        chess.moves({
          square: "g7",
          verbose: true
        });

      const canG6 =
        g6Moves.some(
          move =>
            move.to === "g6"
        );

      if (canG6) {
        plans.push({
          kind:
            "fianchetto_plan",
          move:
            "...g6 → ...Bg7",
          text:
            "현재 구조에서 ...g6 이후 ...Bg7로 비숍의 대각선을 넓히는 계획이 가능한지 검토할 수 있습니다."
        });
      }
    }
  }

  return plans;
}


/* ---------------------------------------------------------
   Full bishop side analysis
   --------------------------------------------------------- */

function analyzeBishopsForColor(
  chess,
  color
) {
  const bishops =
    findPieces(
      chess.board(),
      color,
      "b"
    );

  return bishops.map(
    bishop => {
      const classification =
        classifyBishop(
          chess,
          bishop.square
        );

      const activity =
        analyzeBishopActivity(
          chess,
          bishop.square
        );

      const plans =
        getBishopImprovementPlans(
          chess,
          {
            square:
              bishop.square,
            color
          }
        );

      return {
        square:
          bishop.square,

        color,

        squareColor:
          getSquareColor(
            bishop.square
          ),

        classification,

        activity,

        plans
      };
    }
  );
}


/* ---------------------------------------------------------
   Minor piece analysis
   --------------------------------------------------------- */

function analyzeMinorPieces(
  chess
) {
  const whiteBishops =
    analyzeBishopsForColor(
      chess,
      "w"
    );

  const blackBishops =
    analyzeBishopsForColor(
      chess,
      "b"
    );

  return {
    bishops: {
      w: whiteBishops,
      b: blackBishops
    },

    /*
     * Knight 분석은 다음 단계에서 추가한다.
     */
    knights: {
      w: [],
      b: []
    }
  };
}


/* =========================================================
   BISHOP HUMAN TEXT
   ========================================================= */

function bishopDescription(
  chess,
  bishop
) {
  const side =
    COLOR_NAMES[
      bishop.color
    ];

  const square =
    bishop.square;

  const classification =
    bishop.classification;

  const activity =
    bishop.activity;

  const blockers =
    activity.blockers;

  const centralBlockers =
    blockers.centralBlockers;

  const pawnBlockers =
    blockers.pawnBlockers;

  const plans =
    bishop.plans;

  if (
    classification.type ===
    "bad"
  ) {
    if (
      centralBlockers.length
    ) {
      const squares =
        centralBlockers
          .map(
            x =>
              x.square
          )
          .join(", ");

      return `${side}의 ${square} 비숍은 현재 자기 중앙 폰(${squares})에 의해 대각선 활동이 실제로 제한되어 있습니다. PDF의 비숍 관점에서 보면 이런 경우 비숍의 활동성을 개선할 방법을 찾는 것이 중요합니다.`;
    }

    return `${side}의 ${square} 비숍은 현재 활동 범위가 제한되어 있어 개선 계획이 필요한 상태입니다.`;
  }

  if (
    classification.type ===
    "active"
  ) {
    if (
      activity.enemyTargets
    ) {
      return `${side}의 ${square} 비숍은 열린 대각선을 통해 상대 기물이나 폰과 실제로 접촉하고 있어 활동적인 비숍으로 볼 수 있습니다.`;
    }

    return `${side}의 ${square} 비숍은 여러 대각선이 열려 있고 활동할 수 있는 공간이 충분합니다.`;
  }

  if (
    classification.type ===
    "good"
  ) {
    return `${side}의 ${square} 비숍은 자기 폰에 의해 실질적으로 묶여 있지 않고 여러 대각선에서 활동할 수 있어 좋은 비숍 쪽에 가깝습니다.`;
  }

  /*
   * neutral
   */
  if (
    pawnBlockers.length
  ) {
    return `${side}의 ${square} 비숍에는 자기 폰에 의한 제한이 있지만, 현재 위치만으로 나쁜 비숍이라고 단정할 정도는 아닙니다. 실제 활동 경로를 함께 봐야 합니다.`;
  }

  return `${side}의 ${square} 비숍은 현재 뚜렷한 활동성 우위나 구조적 제한이 확정되지 않습니다.`;
}


/* ---------------------------------------------------------
   Bishop plan text
   --------------------------------------------------------- */

function bishopPlanText(
  bishop
) {
  if (
    !bishop.plans.length
  ) {
    return "";
  }

  const plans =
    bishop.plans
      .slice(0, 2)
      .map(
        plan =>
          plan.text
      );

  return plans.join(" ");
}


/* ---------------------------------------------------------
   Render bishop factor
   --------------------------------------------------------- */

function renderBishopFactor(
  chess,
  minorPieces
) {
  const all =
    [
      ...minorPieces.bishops.w,
      ...minorPieces.bishops.b
    ];

  if (!all.length) {
    return "현재 포지션에는 비숍이 없습니다.";
  }

  const descriptions =
    all.map(
      bishop => {
        const main =
          bishopDescription(
            chess,
            bishop
          );

        const plan =
          bishopPlanText(
            bishop
          );

        return `
          <div class="factor">
            <strong>
              ${COLOR_NAMES[bishop.color]}
              ${bishop.square}
              ·
              ${bishop.classification.label}
            </strong>

            <p>
              ${main}
            </p>

            ${
              plan
                ? `<p>${plan}</p>`
                : ""
            }
          </div>
        `;
      }
    );

  return descriptions.join("");
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

    material:
      analyzeMaterial(
        chess
      ),

    /*
     * STEP 2
     */
    minorPieces:
      analyzeMinorPieces(
        chess
      ),

    /*
     * 이후 단계
     */
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
   MATERIAL TEXT
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
    return `백이 약 ${Math.abs(
      d
    ).toFixed(
      1
    )}점의 물질적 우세를 가지고 있습니다.`;
  }

  return `흑이 약 ${Math.abs(
    d
  ).toFixed(
    1
  )}점의 물질적 우세를 가지고 있습니다.`;
}


/* =========================================================
   HUMAN STRATEGY TEXT
   ========================================================= */

function buildInitialStrategyText(
  snapshot
) {
  const phaseName =
    getPhaseName(
      snapshot.phase
    );

  return `현재는 ${phaseName}으로 분류됩니다. 이제 물질적 차이뿐 아니라 비숍의 실제 활동성과 자기 폰에 의한 제한 여부까지 함께 비교합니다.`;
}


/* =========================================================
   RENDER HUMAN FACTORS
   ========================================================= */

function renderFactorsFromSnapshot(
  snapshot
) {
  const phaseName =
    getPhaseName(
      snapshot.phase
    );

  const chess =
    new Chess(
      snapshot.fen
    );

  const bishopHtml =
    renderBishopFactor(
      chess,
      snapshot.minorPieces
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
      bishopHtml
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
            <strong>${title}</strong>
            <div>${text}</div>
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
    positions[
      currentPly
    ];

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
            <strong>
              ${index + 1}. ${san}
            </strong>

            <span>
              ${labels[index]} ·
              ${formatScore(
                line.score
              )}
            </span>

            <p>
              ${description}
            </p>
          </div>`
        );
      }
    );

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
    positions[
      currentPly
    ];

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
