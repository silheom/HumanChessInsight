import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

const $ = id => document.getElementById(id);

const E = {
  inputView: $("inputView"),
  analysisView: $("analysisView"),
  pgn: $("pgnInput"),
  example: $("exampleBtn"),
  analyze: $("analyzeBtn"),
  back: $("backBtn"),
  error: $("errorBox"),
  status: $("engineStatus"),
  board: $("board"),
  position: $("positionLabel"),
  move: $("moveLabel"),
  meta: $("gameMeta"),
  moves: $("moveList"),
  first: $("firstBtn"),
  prev: $("prevBtn"),
  next: $("nextBtn"),
  last: $("lastBtn"),
  eval: $("evalValue"),
  depth: $("depthValue"),
  bar: $("progressBar"),
  insight: $("positionInsight"),
  candidates: $("candidateList"),
  factors: $("humanFactors")
};

const ENGINE = new URL(
  "stockfish-19-lite-single.js",
  import.meta.url
).toString();

const EXAMPLE = `[Event "Human Chess Insight"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7
6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 *`;

const FILES = "abcdefgh";

const VALUE = {
  p: 1,
  n: 3.2,
  b: 3.3,
  r: 5,
  q: 9,
  k: 0
};

const PIECES = {
  w: {
    p: "♙",
    n: "♘",
    b: "♗",
    r: "♖",
    q: "♕",
    k: "♔"
  },
  b: {
    p: "♟",
    n: "♞",
    b: "♝",
    r: "♜",
    q: "♛",
    k: "♚"
  }
};

let worker = null;
let engineReady = false;
let enginePromise = null;
let activeJob = null;

let positions = [];
let ply = 0;
let game = null;

const cache = new Map();


/* =========================================================
   기본 UI
========================================================= */

function setStatus(text, className = "loading") {
  E.status.textContent = text;
  E.status.className = `status ${className}`;
}

function showError(text) {
  E.error.textContent = text;
  E.error.hidden = false;
}

function clearError() {
  E.error.hidden = true;
  E.error.textContent = "";
}

function setProgress(percent, depth = 0) {
  E.bar.style.width =
    `${Math.max(0, Math.min(100, percent))}%`;

  E.depth.textContent =
    depth ? `d${depth}` : "—";
}

function other(color) {
  return color === "w" ? "b" : "w";
}

function side(color) {
  return color === "w" ? "백" : "흑";
}

function square(file, rank) {
  return `${FILES[file]}${rank}`;
}

function xy(squareName) {
  return [
    FILES.indexOf(squareName[0]),
    Number(squareName[1])
  ];
}

function escape(text) {
  return String(text).replace(
    /[&<>"']/g,
    char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[char]
  );
}


/* =========================================================
   Stockfish 점수
========================================================= */

function parseScore(tokens) {
  const index = tokens.indexOf("score");

  if (index < 0) {
    return null;
  }

  const type = tokens[index + 1];
  const value = Number(tokens[index + 2]);

  if (
    !Number.isFinite(value) ||
    (type !== "cp" && type !== "mate")
  ) {
    return null;
  }

  return {
    type,
    value
  };
}

function whiteScore(score, turn) {
  if (!score) {
    return null;
  }

  if (score.type === "cp") {
    return (
      turn === "w"
        ? score.value
        : -score.value
    ) / 100;
  }

  const sign =
    score.value >= 0
      ? 1
      : -1;

  return (
    turn === "w"
      ? sign
      : -sign
  ) * 100;
}

function scoreText(value) {
  if (value == null) {
    return "—";
  }

  if (Math.abs(value) >= 99) {
    return value > 0
      ? "+M"
      : "−M";
  }

  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}`;
}

function scoreWords(value) {
  if (value == null) {
    return "포지션을 분석하고 있습니다.";
  }

  const abs =
    Math.abs(value);

  if (abs < 0.2) {
    return "대체로 균형에 가까운 포지션입니다.";
  }

  if (abs < 0.8) {
    return value > 0
      ? "백이 약간 더 편안한 포지션입니다."
      : "흑이 약간 더 편안한 포지션입니다.";
  }

  if (abs < 1.8) {
    return value > 0
      ? "백에게 분명한 실전적 우세가 있습니다."
      : "흑에게 분명한 실전적 우세가 있습니다.";
  }

  if (abs < 3.5) {
    return value > 0
      ? "백이 상당한 우세를 가지고 있습니다."
      : "흑이 상당한 우세를 가지고 있습니다.";
  }

  return value > 0
    ? "백 쪽으로 평가가 크게 기울어 있습니다."
    : "흑 쪽으로 평가가 크게 기울어 있습니다.";
}


/* =========================================================
   엔진 작업 취소
========================================================= */

function cancelEngineJob() {
  if (!activeJob) {
    return;
  }

  const current =
    activeJob;

  activeJob = null;

  clearTimeout(current.timer);

  try {
    worker?.postMessage("stop");
  } catch {}

  current.reject(
    new Error("cancelled")
  );
}


/* =========================================================
   Stockfish 시작
========================================================= */

function bootEngine() {
  if (enginePromise) {
    return enginePromise;
  }

  enginePromise = new Promise(
    (resolve, reject) => {
      setStatus("Stockfish 로딩 중…");

      try {
        worker =
          new Worker(
            ENGINE
          );
      } catch (error) {
        reject(error);
        return;
      }

      let uciReady = false;

      const timeout =
        setTimeout(() => {
          if (!engineReady) {
            try {
              worker.terminate();
            } catch {}

            worker = null;
            enginePromise = null;

            setStatus(
              "엔진 로딩 실패",
              "error"
            );

            reject(
              new Error(
                "Stockfish 로딩 시간이 초과되었습니다."
              )
            );
          }
        }, 20000);

      worker.onerror =
        event => {
          clearTimeout(timeout);

          engineReady = false;
          worker = null;
          enginePromise = null;

          setStatus(
            "엔진 오류",
            "error"
          );

          reject(
            new Error(
              event?.message ||
              "Stockfish 오류"
            )
          );
        };

      worker.onmessage =
        event => {
          const line =
            String(
              event.data || ""
            ).trim();

          if (!line) {
            return;
          }

          /*
           * UCI 시작
           */
          if (
            line === "uciok" &&
            !uciReady
          ) {
            uciReady = true;

            worker.postMessage(
              "setoption name MultiPV value 3"
            );

            worker.postMessage(
              "setoption name Threads value 1"
            );

            worker.postMessage(
              "setoption name Hash value 16"
            );

            worker.postMessage(
              "isready"
            );

            return;
          }

          /*
           * 엔진 준비 완료
           */
          if (
            line === "readyok" &&
            uciReady
          ) {
            clearTimeout(timeout);

            engineReady = true;

            setStatus(
              "Stockfish 준비 완료",
              "ready"
            );

            resolve();

            return;
          }

          /*
           * 현재 분석 작업에 전달
           */
          if (activeJob) {
            activeJob.handle(line);
          }
        };

      worker.postMessage("uci");
    }
  );

  return enginePromise.catch(
    error => {
      engineReady = false;
      setStatus(
        "엔진 오류",
        "error"
      );
      throw error;
    }
  );
}


/* =========================================================
   Stockfish 분석
========================================================= */

function analyzeFen(
  fen,
  depth = 8
) {
  const key =
    `${fen}|${depth}`;

  if (cache.has(key)) {
    return Promise.resolve(
      cache.get(key)
    );
  }

  if (!engineReady || !worker) {
    return Promise.reject(
      new Error(
        "Stockfish가 아직 준비되지 않았습니다."
      )
    );
  }

  /*
   * 이전 작업이 있다면 취소한다.
   */
  if (activeJob) {
    cancelEngineJob();
  }

  return new Promise(
    (resolve, reject) => {
      const turn =
        fen.split(" ")[1];

      const lines =
        new Map();

      let maxDepth = 0;

      const timeout =
        setTimeout(() => {
          if (
            activeJob === job
          ) {
            activeJob = null;

            try {
              worker.postMessage(
                "stop"
              );
            } catch {}

            reject(
              new Error(
                "엔진 분석 시간이 초과되었습니다."
              )
            );
          }
        }, 12000);

      const job = {
        timer: timeout,

        reject,

        handle(line) {
          /*
           * info pv
           */
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

            const score =
              whiteScore(
                parseScore(tokens),
                turn
              );

            const pvIndex =
              tokens.indexOf("pv");

            const currentDepth =
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

            const pv =
              pvIndex >= 0
                ? tokens.slice(
                    pvIndex + 1
                  )
                : [];

            if (
              currentDepth > maxDepth
            ) {
              maxDepth =
                currentDepth;

              setProgress(
                Math.min(
                  95,
                  currentDepth /
                    depth *
                    100
                ),
                currentDepth
              );
            }

            if (
              currentDepth > 0 &&
              score != null &&
              pv.length
            ) {
              const previous =
                lines.get(
                  multiPv
                );

              /*
               * 같은 MultiPV에서는
               * 가장 깊은 결과만 유지한다.
               */
              if (
                !previous ||
                currentDepth >=
                  previous.depth
              ) {
                lines.set(
                  multiPv,
                  {
                    score,
                    pv,
                    depth:
                      currentDepth
                  }
                );
              }
            }

            return;
          }

          /*
           * bestmove
           */
          if (
            line.startsWith(
              "bestmove"
            )
          ) {
            clearTimeout(
              timeout
            );

            if (
              activeJob !== job
            ) {
              return;
            }

            activeJob = null;

            const result = {
              fen,
              turn,
              depth: maxDepth,
              lines:
                [...lines.entries()]
                  .sort(
                    (a, b) =>
                      a[0] - b[0]
                  )
                  .map(
                    ([, value]) =>
                      value
                  )
            };

            cache.set(
              key,
              result
            );

            setProgress(
              100,
              maxDepth
            );

            resolve(result);
          }
        }
      };

      activeJob = job;

      try {
        worker.postMessage(
          `position fen ${fen}`
        );

        worker.postMessage(
          `go depth ${depth}`
        );
      } catch (error) {
        clearTimeout(timeout);

        if (
          activeJob === job
        ) {
          activeJob = null;
        }

        reject(error);
      }
    }
  );
}


/* =========================================================
   UCI → SAN
========================================================= */

function sanPv(
  fen,
  pv
) {
  const chess =
    new Chess(fen);

  const output = [];

  for (
    const uci of pv || []
  ) {
    try {
      const move =
        chess.move({
          from:
            uci.slice(0, 2),

          to:
            uci.slice(2, 4),

          promotion:
            uci[4]
        });

      if (!move) {
        break;
      }

      output.push(
        move.san
      );
    } catch {
      break;
    }
  }

  return output.join(" ");
}

function applyUci(
  fen,
  uci
) {
  try {
    const chess =
      new Chess(fen);

    const move =
      chess.move({
        from:
          uci.slice(0, 2),

        to:
          uci.slice(2, 4),

        promotion:
          uci[4]
      });

    if (!move) {
      return null;
    }

    return {
      fen:
        chess.fen(),

      san:
        move.san(),

      move
    };
  } catch {
    return null;
  }
}


/* =========================================================
   PGN
========================================================= */

function loadGame(text) {
  const chess =
    new Chess();

  chess.loadPgn(
    text,
    {
      strict: false
    }
  );

  return chess;
}

function buildPositions(chess) {
  const board =
    new Chess();

  const output = [
    {
      ply: 0,
      fen:
        board.fen(),

      san: null,
      uci: null
    }
  ];

  for (
    const move of chess.history({
      verbose: true
    })
  ) {
    const actual =
      board.move(
        move.san
      );

    output.push({
      ply:
        output.length,

      fen:
        board.fen(),

      san:
        actual.san,

      uci:
        `${actual.from}${actual.to}${actual.promotion || ""}`
    });
  }

  return output;
}


/* =========================================================
   체스판
========================================================= */

function renderBoard(fen) {
  const chess =
    new Chess(fen);

  E.board.innerHTML =
    "";

  for (
    let rank = 8;
    rank >= 1;
    rank--
  ) {
    for (
      let file = 0;
      file < 8;
      file++
    ) {
      const element =
        document.createElement(
          "div"
        );

      const piece =
        chess.get(
          square(
            file,
            rank
          )
        );

      element.className =
        `sq ${
          ((rank + file) % 2 === 0)
            ? "light"
            : "dark"
        }`;

      if (piece) {
        element.textContent =
          PIECES[
            piece.color
          ][
            piece.type
          ];
      }

      E.board.appendChild(
        element
      );
    }
  }
}

function renderMoves() {
  E.moves.innerHTML =
    "";

  positions
    .slice(1)
    .forEach(
      (position, index) => {
        const number =
          index + 1;

        const button =
          document.createElement(
            "button"
          );

        button.className =
          `moveItem ${
            number === ply
              ? "active"
              : ""
          }`;

        button.textContent =
          `${Math.ceil(
            number / 2
          )}${
            number % 2
              ? "."
              : "…"
          } ${position.san}`;

        button.onclick =
          () =>
            selectPly(
              number
            );

        E.moves.appendChild(
          button
        );
      }
    );
}


/* =========================================================
   기물
========================================================= */

function allPieces(
  chess,
  color,
  type = null
) {
  const output = [];

  for (
    let rank = 8;
    rank >= 1;
    rank--
  ) {
    for (
      let file = 0;
      file < 8;
      file++
    ) {
      const name =
        square(
          file,
          rank
        );

      const piece =
        chess.get(name);

      if (
        piece &&
        piece.color === color &&
        (!type ||
          piece.type === type)
      ) {
        output.push({
          square: name,
          piece
        });
      }
    }
  }

  return output;
}

function count(
  chess,
  color,
  type
) {
  return allPieces(
    chess,
    color,
    type
  ).length;
}

function material(chess) {
  const result = {
    w: 0,
    b: 0
  };

  for (
    const color of ["w", "b"]
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
      result[color] +=
        count(
          chess,
          color,
          type
        ) *
        VALUE[type];
    }
  }

  return {
    w: result.w,
    b: result.b,
    diff:
      +(
        result.w -
        result.b
      ).toFixed(1)
  };
}


/* =========================================================
   공격
========================================================= */

function attacks(
  chess,
  from,
  to
) {
  const piece =
    chess.get(from);

  if (!piece) {
    return false;
  }

  const [
    fromFile,
    fromRank
  ] = xy(from);

  const [
    toFile,
    toRank
  ] = xy(to);

  const df =
    toFile - fromFile;

  const dr =
    toRank - fromRank;

  if (piece.type === "p") {
    const direction =
      piece.color === "w"
        ? 1
        : -1;

    return (
      dr === direction &&
      Math.abs(df) === 1
    );
  }

  if (piece.type === "n") {
    return (
      (
        Math.abs(df) === 1 &&
        Math.abs(dr) === 2
      ) ||
      (
        Math.abs(df) === 2 &&
        Math.abs(dr) === 1
      )
    );
  }

  if (piece.type === "k") {
    return (
      Math.max(
        Math.abs(df),
        Math.abs(dr)
      ) === 1
    );
  }

  const diagonal =
    Math.abs(df) ===
    Math.abs(dr);

  const straight =
    df === 0 ||
    dr === 0;

  if (
    (
      piece.type === "b" &&
      !diagonal
    ) ||
    (
      piece.type === "r" &&
      !straight
    ) ||
    (
      piece.type === "q" &&
      !(diagonal || straight)
    )
  ) {
    return false;
  }

  let file =
    fromFile +
    Math.sign(df);

  let rank =
    fromRank +
    Math.sign(dr);

  while (
    file !== toFile ||
    rank !== toRank
  ) {
    if (
      chess.get(
        square(
          file,
          rank
        )
      )
    ) {
      return false;
    }

    file +=
      Math.sign(df);

    rank +=
      Math.sign(dr);
  }

  return true;
}

function attacked(
  chess,
  target,
  color
) {
  return allPieces(
    chess,
    color
  ).some(
    piece =>
      attacks(
        chess,
        piece.square,
        target
      )
  );
}

function defenders(
  chess,
  target,
  color
) {
  return allPieces(
    chess,
    color
  )
    .filter(
      piece =>
        attacks(
          chess,
          piece.square,
          target
        )
    )
    .map(
      piece =>
        piece.square
    );
}

function legalFrom(
  chess,
  color,
  from
) {
  try {
    const fields =
      chess
        .fen()
        .split(" ");

    fields[1] =
      color;

    const copy =
      new Chess(
        fields.join(" ")
      );

    return copy.moves({
      square: from,
      verbose: true
    });
  } catch {
    return [];
  }
}


/* =========================================================
   게임 단계
========================================================= */

function phase(chess) {
  const moves =
    chess.history().length;

  const queens =
    count(
      chess,
      "w",
      "q"
    ) +
    count(
      chess,
      "b",
      "q"
    );

  const minor =
    count(
      chess,
      "w",
      "n"
    ) +
    count(
      chess,
      "b",
      "n"
    ) +
    count(
      chess,
      "w",
      "b"
    ) +
    count(
      chess,
      "b",
      "b"
    );

  if (
    queens === 0 ||
    minor <= 2
  ) {
    return "endgame";
  }

  if (
    moves <= 16 &&
    queens === 2
  ) {
    return "opening";
  }

  return "middlegame";
}


/* =========================================================
   폰 구조
========================================================= */

function pawnInfo(
  chess,
  color
) {
  const pawns =
    allPieces(
      chess,
      color,
      "p"
    );

  const files = {};

  for (
    const pawn of pawns
  ) {
    const file =
      pawn.square[0];

    if (!files[file]) {
      files[file] = [];
    }

    files[file].push(
      pawn.square
    );
  }

  const doubled =
    Object.entries(files)
      .filter(
        ([, list]) =>
          list.length > 1
      )
      .map(
        ([file, list]) =>
          `${file}-파일(${list.join(", ")})`
      );

  const isolated = [];

  for (
    const [file, list]
    of Object.entries(files)
  ) {
    const index =
      FILES.indexOf(file);

    if (
      !files[
        FILES[index - 1]
      ] &&
      !files[
        FILES[index + 1]
      ]
    ) {
      isolated.push(
        ...list
      );
    }
  }

  const passed = [];

  for (
    const pawn of pawns
  ) {
    const file =
      FILES.indexOf(
        pawn.square[0]
      );

    const rank =
      Number(
        pawn.square[1]
      );

    const enemy =
      other(color);

    let blocked =
      false;

    for (
      const enemyFile
      of [
        file - 1,
        file,
        file + 1
      ]
    ) {
      if (
        enemyFile < 0 ||
        enemyFile > 7
      ) {
        continue;
      }

      const enemyPawns =
        allPieces(
          chess,
          enemy,
          "p"
        ).filter(
          piece =>
            piece.square[0] ===
            FILES[enemyFile]
        );

      for (
        const enemyPawn
        of enemyPawns
      ) {
        const enemyRank =
          Number(
            enemyPawn.square[1]
          );

        if (
          color === "w"
            ? enemyRank > rank
            : enemyRank < rank
        ) {
          blocked =
            true;
          break;
        }
      }

      if (blocked) {
        break;
      }
    }

    if (!blocked) {
      passed.push(
        pawn.square
      );
    }
  }

  /*
   * 후방폰은 매우 보수적으로 판단한다.
   * 단순히 "옆에 폰이 없다"는 이유만으로
   * 후방폰이라고 부르지 않는다.
   */
  const backward = [];

  for (
    const pawn of pawns
  ) {
    const file =
      FILES.indexOf(
        pawn.square[0]
      );

    const rank =
      Number(
        pawn.square[1]
      );

    const adjacentSupport =
      pawns.some(
        otherPawn => {
          const otherFile =
            FILES.indexOf(
              otherPawn.square[0]
            );

          const otherRank =
            Number(
              otherPawn.square[1]
            );

          return (
            Math.abs(
              otherFile -
              file
            ) === 1 &&
            (
              color === "w"
                ? otherRank >= rank
                : otherRank <= rank
            )
          );
        }
      );

    if (adjacentSupport) {
      continue;
    }

    const forwardRank =
      color === "w"
        ? rank + 1
        : rank - 1;

    if (
      forwardRank < 1 ||
      forwardRank > 8
    ) {
      continue;
    }

    const forwardSquare =
      square(
        file,
        forwardRank
      );

    if (
      chess.get(
        forwardSquare
      )
    ) {
      continue;
    }

    const enemy =
      other(color);

    /*
     * 실제로 전진 칸 또는 그 주변이
     * 상대 폰에게 압박받는 경우만 후보로 본다.
     */
    const enemyPawn =
      allPieces(
        chess,
        enemy,
        "p"
      ).some(
        enemyPiece =>
          attacks(
            chess,
            enemyPiece.square,
            forwardSquare
          )
      );

    if (enemyPawn) {
      backward.push(
        pawn.square
      );
    }
  }

  return {
    doubled,
    isolated,
    passed,
    backward
  };
}


/* =========================================================
   공간
========================================================= */

function space(
  chess,
  color
) {
  let score = 0;

  for (
    const pawn
    of allPieces(
      chess,
      color,
      "p"
    )
  ) {
    const rank =
      Number(
        pawn.square[1]
      );

    score +=
      color === "w"
        ? Math.max(
            0,
            rank - 2
          )
        : Math.max(
            0,
            7 - rank
          );
  }

  return score;
}


/* =========================================================
   오픈 파일
========================================================= */

function openFiles(chess) {
  const output = [];

  for (
    const file of FILES
  ) {
    const whitePawn =
      allPieces(
        chess,
        "w",
        "p"
      ).some(
        piece =>
          piece.square[0] ===
          file
      );

    const blackPawn =
      allPieces(
        chess,
        "b",
        "p"
      ).some(
        piece =>
          piece.square[0] ===
          file
      );

    if (
      !whitePawn &&
      !blackPawn
    ) {
      output.push(
        `${file}-파일`
      );
    } else if (
      !whitePawn ||
      !blackPawn
    ) {
      output.push(
        `${file}-세미오픈`
      );
    }
  }

  return output;
}


/* =========================================================
   비숍
========================================================= */

function bishopData(
  chess,
  piece
) {
  const moves =
    legalFrom(
      chess,
      piece.piece.color,
      piece.square
    );

  const enemy =
    other(
      piece.piece.color
    );

  const useful =
    moves.filter(
      move => {
        const target =
          chess.get(
            move.to
          );

        /*
         * 상대 기물을 잡을 수 있으면
         * 당연히 구체적인 선택지다.
         */
        if (
          target &&
          target.color === enemy
        ) {
          return true;
        }

        /*
         * 중앙 및 전진 대각선.
         */
        return [
          "c4",
          "c5",
          "d4",
          "d5",
          "e4",
          "e5",
          "f4",
          "f5",
          "g2",
          "g7",
          "b2",
          "b7"
        ].includes(
          move.to
        );
      }
    );

  return {
    moves,
    useful
  };
}


/* =========================================================
   나이트
========================================================= */

function knightData(
  chess,
  piece
) {
  const moves =
    legalFrom(
      chess,
      piece.piece.color,
      piece.square
    );

  const outposts = [];

  for (
    const move of moves
  ) {
    const [
      ,
      rank
    ] = xy(
      move.to
    );

    const advanced =
      piece.piece.color === "w"
        ? rank >= 5
        : rank <= 4;

    if (!advanced) {
      continue;
    }

    /*
     * 상대 폰에게 공격받지 않는지를
     * 우선 본다.
     */
    const enemy =
      other(
        piece.piece.color
      );

    const enemyPawnAttack =
      allPieces(
        chess,
        enemy,
        "p"
      ).some(
        pawn =>
          attacks(
            chess,
            pawn.square,
            move.to
          )
      );

    if (enemyPawnAttack) {
      continue;
    }

    const support =
      defenders(
        chess,
        move.to,
        piece.piece.color
      );

    if (
      support.length
    ) {
      outposts.push({
        square:
          move.to,
        support
      });
    }
  }

  return {
    moves,
    outposts
  };
}


/* =========================================================
   킹 압박
========================================================= */

function kingPressure(
  chess,
  color
) {
  const king =
    allPieces(
      chess,
      color,
      "k"
    )[0];

  if (!king) {
    return 0;
  }

  const [
    file,
    rank
  ] = xy(
    king.square
  );

  const enemy =
    other(color);

  let pressure = 0;

  for (
    let df = -1;
    df <= 1;
    df++
  ) {
    for (
      let dr = -1;
      dr <= 1;
      dr++
    ) {
      if (
        df === 0 &&
        dr === 0
      ) {
        continue;
      }

      const nextFile =
        file + df;

      const nextRank =
        rank + dr;

      if (
        nextFile >= 0 &&
        nextFile < 8 &&
        nextRank >= 1 &&
        nextRank <= 8
      ) {
        if (
          attacked(
            chess,
            square(
              nextFile,
              nextRank
            ),
            enemy
          )
        ) {
          pressure++;
        }
      }
    }
  }

  return pressure;
}


/* =========================================================
   개발
========================================================= */

function development(
  chess,
  color
) {
  const home =
    color === "w"
      ? [
          "b1",
          "g1",
          "c1",
          "f1"
        ]
      : [
          "b8",
          "g8",
          "c8",
          "f8"
        ];

  return allPieces(
    chess,
    color
  ).filter(
    piece => {
      if (
        piece.piece.type !== "n" &&
        piece.piece.type !== "b"
      ) {
        return false;
      }

      return !home.includes(
        piece.square
      );
    }
  ).length;
}


/* =========================================================
   강제수
========================================================= */

function forcingMoves(
  chess,
  color
) {
  try {
    const fields =
      chess.fen().split(" ");

    fields[1] =
      color;

    const copy =
      new Chess(
        fields.join(" ")
      );

    return copy
      .moves({
        verbose: true
      })
      .filter(
        move =>
          move.san.includes("+") ||
          move.captured
      )
      .length;
  } catch {
    return 0;
  }
}


/* =========================================================
   중앙
========================================================= */

function centerData(chess) {
  const center = [
    "d4",
    "e4",
    "d5",
    "e5"
  ];

  const output = [];

  for (
    const squareName
    of center
  ) {
    const piece =
      chess.get(
        squareName
      );

    if (piece) {
      output.push(
        `${squareName}:${side(piece.color)} ${piece.type}`
      );
    }
  }

  return output;
}


/* =========================================================
   전략 분석
========================================================= */

function analyzeStrategy(
  chess
) {
  const materialInfo =
    material(chess);

  const whitePawns =
    pawnInfo(
      chess,
      "w"
    );

  const blackPawns =
    pawnInfo(
      chess,
      "b"
    );

  const bishops = {
    w:
      allPieces(
        chess,
        "w",
        "b"
      ).map(
        piece => ({
          ...piece,
          info:
            bishopData(
              chess,
              piece
            )
        })
      ),

    b:
      allPieces(
        chess,
        "b",
        "b"
      ).map(
        piece => ({
          ...piece,
          info:
            bishopData(
              chess,
              piece
            )
        })
      )
  };

  const knights = {
    w:
      allPieces(
        chess,
        "w",
        "n"
      ).map(
        piece => ({
          ...piece,
          info:
            knightData(
              chess,
              piece
            )
        })
      ),

    b:
      allPieces(
        chess,
        "b",
        "n"
      ).map(
        piece => ({
          ...piece,
          info:
            knightData(
              chess,
              piece
            )
        })
      )
  };

  const spaceInfo = {
    w:
      space(
        chess,
        "w"
      ),

    b:
      space(
        chess,
        "b"
      )
  };

  const developmentInfo = {
    w:
      development(
        chess,
        "w"
      ),

    b:
      development(
        chess,
        "b"
      )
  };

  const initiativeInfo = {
    w:
      forcingMoves(
        chess,
        "w"
      ),

    b:
      forcingMoves(
        chess,
        "b"
      )
  };

  const kingInfo = {
    w:
      kingPressure(
        chess,
        "w"
      ),

    b:
      kingPressure(
        chess,
        "b"
      )
  };

  let dominant = {
    key:
      "activity",
    side:
      null
  };

  /*
   * 물질
   */
  if (
    Math.abs(
      materialInfo.diff
    ) >= 1.5
  ) {
    dominant = {
      key:
        "material",
      side:
        materialInfo.diff > 0
          ? "w"
          : "b"
    };
  }

  /*
   * 킹 안전
   */
  else if (
    Math.abs(
      kingInfo.w -
      kingInfo.b
    ) >= 2
  ) {
    dominant = {
      key:
        "king",
      side:
        kingInfo.w <
        kingInfo.b
          ? "w"
          : "b"
    };
  }

  /*
   * 공간
   */
  else if (
    Math.abs(
      spaceInfo.w -
      spaceInfo.b
    ) >= 5
  ) {
    dominant = {
      key:
        "space",
      side:
        spaceInfo.w >
        spaceInfo.b
          ? "w"
          : "b"
    };
  }

  /*
   * 개발 / 주도권
   */
  else if (
    Math.abs(
      developmentInfo.w -
      developmentInfo.b
    ) >= 2 ||
    Math.abs(
      initiativeInfo.w -
      initiativeInfo.b
    ) >= 2
  ) {
    dominant = {
      key:
        "initiative",

      side:
        developmentInfo.w +
          initiativeInfo.w >
        developmentInfo.b +
          initiativeInfo.b
          ? "w"
          : "b"
    };
  }

  /*
   * 폰 구조
   */
  else if (
    Math.abs(
      (
        whitePawns.isolated.length +
        whitePawns.doubled.length
      ) -
      (
        blackPawns.isolated.length +
        blackPawns.doubled.length
      )
    ) >= 2
  ) {
    dominant = {
      key:
        "structure",

      side:
        (
          whitePawns.isolated.length +
          whitePawns.doubled.length
        ) <
        (
          blackPawns.isolated.length +
          blackPawns.doubled.length
        )
          ? "w"
          : "b"
    };
  }

  return {
    phase:
      phase(chess),

    material:
      materialInfo,

    pawns: {
      w:
        whitePawns,
      b:
        blackPawns
    },

    bishops,

    knights,

    space:
      spaceInfo,

    development:
      developmentInfo,

    initiative:
      initiativeInfo,

    king:
      kingInfo,

    center:
      centerData(
        chess
      ),

    open:
      openFiles(
        chess
      ),

    dominant
  };
}


/* =========================================================
   전략 설명
========================================================= */

function strategicText(
  strategy
) {
  const dominant =
    strategy.dominant;

  const labels = {
    material:
      "물질",
    king:
      "킹 안전",
    space:
      "공간",
    initiative:
      "개발·주도권",
    structure:
      "폰 구조",
    activity:
      "기물 활동성"
  };

  const label =
    labels[
      dominant.key
    ];

  if (
    dominant.key ===
    "material"
  ) {
    return (
      `${label} — ` +
      `${side(dominant.side)}이 약 ` +
      `${Math.abs(
        strategy.material.diff
      ).toFixed(1)}점의 ` +
      `물질 우세를 가지고 있어 ` +
      `다른 요소보다 직접적인 영향이 큽니다.`
    );
  }

  if (
    dominant.key ===
    "king"
  ) {
    return (
      `${label} — ` +
      `${side(dominant.side)} 쪽 킹 주변에 ` +
      `상대의 압력이 더 집중되어 있습니다. ` +
      `계획보다 먼저 직접적인 전술 위협을 확인해야 합니다.`
    );
  }

  if (
    dominant.key ===
    "space"
  ) {
    return (
      `${label} — ` +
      `${side(dominant.side)}이 더 넓은 공간을 확보해 ` +
      `기물의 기동성과 상대의 반격 가능성에 영향을 주고 있습니다.`
    );
  }

  if (
    dominant.key ===
    "initiative"
  ) {
    return (
      `${label} — ` +
      `${side(dominant.side)}이 더 많은 강제적인 수와 ` +
      `개발상의 시간 우위를 가지고 있습니다. ` +
      `이 우세는 오래 기다리면 사라질 수 있습니다.`
    );
  }

  if (
    dominant.key ===
    "structure"
  ) {
    return (
      `${label} — ` +
      `폰 구조의 차이가 장기적인 약점과 ` +
      `기물의 활동 경로에 영향을 주고 있습니다.`
    );
  }

  return (
    `${label} — ` +
    `물질과 킹 안전의 차이가 결정적이지 않아 ` +
    `현재 기물의 활동성과 개선 가능성을 우선 비교합니다.`
  );
}


/* =========================================================
   사람의 관점
========================================================= */

function factorHTML(
  strategy
) {
  const output = [];

  output.push(`
    <div class="factor">
      <b>게임 단계</b>
      <span>
        ${
          strategy.phase ===
          "opening"
            ? "오프닝"
            : strategy.phase ===
              "endgame"
                ? "엔드게임"
                : "미들게임"
        }입니다.
      </span>
    </div>
  `);

  output.push(`
    <div class="factor">
      <b>기물의 개수</b>
      <span>
        ${
          Math.abs(
            strategy.material.diff
          ) < 0.3
            ? "물질적으로 균형이 맞습니다."
            : `${
                strategy.material.diff > 0
                  ? "백"
                  : "흑"
              }이 약 ${
                Math.abs(
                  strategy.material.diff
                ).toFixed(1)
              }점 앞서 있습니다.`
        }
      </span>
    </div>
  `);

  /*
   * 비숍
   */
  for (
    const color of ["w", "b"]
  ) {
    for (
      const piece
      of strategy.bishops[color]
    ) {
      const info =
        piece.info;

      if (
        info.useful.length
      ) {
        output.push(`
          <div class="factor">
            <b>
              ${side(color)}
              ${piece.square}
              · 활동을 개선할 수 있는 비숍
            </b>
            <span>
              현재
              ${info.useful
                .slice(0, 3)
                .map(
                  move =>
                    move.to
                )
                .join(", ")}
              같은 구체적인 진출 칸이 있습니다.
            </span>
          </div>
        `);
      } else {
        output.push(`
          <div class="factor">
            <b>
              ${side(color)}
              ${piece.square}
              · 활동이 제한된 비숍
            </b>
            <span>
              현재 눈에 띄는 진출 칸이 많지 않습니다.
              폰 구조를 바꾸거나 더 좋은 대각선을
              확보하는 계획을 검토할 필요가 있습니다.
            </span>
          </div>
        `);
      }
    }

    /*
     * 나이트
     */
    for (
      const piece
      of strategy.knights[color]
    ) {
      const info =
        piece.info;

      if (
        info.outposts.length
      ) {
        const outpost =
          info.outposts[0];

        output.push(`
          <div class="factor">
            <b>
              ${side(color)}
              ${piece.square}
              · 유망한 지원점을 가진 나이트
            </b>
            <span>
              ${outpost.square}에 들어갈 수 있고
              ${outpost.support.join(", ")}
              의 지지를 받을 수 있습니다.
            </span>
          </div>
        `);
      } else if (
        info.moves.length <= 1
      ) {
        output.push(`
          <div class="factor">
            <b>
              ${side(color)}
              ${piece.square}
              · 활동 범위가 제한된 나이트
            </b>
            <span>
              단순히 이동 수를 늘리기보다
              실제로 유지할 수 있는 좋은 칸과
              진출 경로를 찾는 것이 중요합니다.
            </span>
          </div>
        `);
      } else {
        output.push(`
          <div class="factor">
            <b>
              ${side(color)}
              ${piece.square}
              · 활동적인 나이트
            </b>
            <span>
              여러 진출점을 가지고 있습니다.
              다만 실제로 유지할 수 있는 좋은 칸인지도
              함께 확인해야 합니다.
            </span>
          </div>
        `);
      }
    }
  }

  function pawnText(
    name,
    pawn
  ) {
    const parts = [];

    if (
      pawn.doubled.length
    ) {
      parts.push(
        `더블폰 ${pawn.doubled.join(", ")}`
      );
    }

    if (
      pawn.isolated.length
    ) {
      parts.push(
        `고립폰 ${pawn.isolated.join(", ")}`
      );
    }

    if (
      pawn.backward.length
    ) {
      parts.push(
        `후방폰 후보 ${pawn.backward.join(", ")}`
      );
    }

    if (
      pawn.passed.length
    ) {
      parts.push(
        `통과폰 ${pawn.passed.join(", ")}`
      );
    }

    if (!parts.length) {
      return `${name}: 뚜렷한 구조적 약점은 제한적입니다.`;
    }

    return `${name}: ${parts.join(". ")}.`;
  }

  output.push(`
    <div class="factor">
      <b>폰 구조</b>
      <span>
        ${escape(
          pawnText(
            "백",
            strategy.pawns.w
          )
        )}
        ${escape(
          pawnText(
            "흑",
            strategy.pawns.b
          )
        )}
      </span>
    </div>
  `);

  /*
   * 공간
   */
  const spaceDifference =
    strategy.space.w -
    strategy.space.b;

  output.push(`
    <div class="factor">
      <b>공간</b>
      <span>
        ${
          Math.abs(
            spaceDifference
          ) < 2
            ? "양쪽의 공간 차이가 크지 않습니다."
            : `${
                spaceDifference > 0
                  ? "백"
                  : "흑"
              }이 더 많은 공간을 확보하고 있습니다.
              공간이 많은 쪽은 기동성을 활용하고,
              공간이 적은 쪽은 유리한 교환이나
              반격을 찾는 방향을 생각할 수 있습니다.`
        }
      </span>
    </div>
  `);

  /*
   * 중앙
   */
  output.push(`
    <div class="factor">
      <b>중앙</b>
      <span>
        ${
          strategy.center.length
            ? escape(
                strategy.center.join(", ")
              )
            : "중앙 네 칸에 직접 놓인 기물이 많지 않습니다."
        }.
        중앙의 가치는 단순히 차지하고 있는지보다
        상대 기물의 활동을 실제로 제한하는지를
        함께 봐야 합니다.
      </span>
    </div>
  `);

  /*
   * 오픈 파일
   */
  output.push(`
    <div class="factor">
      <b>오픈 파일</b>
      <span>
        ${
          strategy.open.length
            ? strategy.open.join(", ")
            : "완전 오픈 파일은 없습니다."
        }
        오픈 파일 자체보다 실제 침투 칸과
        공격 대상이 있는지가 중요합니다.
      </span>
    </div>
  `);

  /*
   * 개발 / 주도권
   */
  const developmentDifference =
    strategy.development.w -
    strategy.development.b;

  const initiativeDifference =
    strategy.initiative.w -
    strategy.initiative.b;

  output.push(`
    <div class="factor">
      <b>개발·주도권</b>
      <span>
        ${
          Math.abs(
            developmentDifference
          ) < 1
            ? "경량 기물의 개발 정도는 비슷합니다."
            : `${
                developmentDifference > 0
                  ? "백"
                  : "흑"
              }이 더 많은 경량 기물을
              기본 위치에서 벗어나 투입했습니다.`
        }

        ${
          initiativeDifference === 0
            ? " 강제적인 수의 차이도 뚜렷하지 않습니다."
            : ` ${
                initiativeDifference > 0
                  ? "백"
                  : "흑"
              }이 체크나 잡기 같은
              강제적인 수를 더 많이 가지고 있습니다.`
        }
      </span>
    </div>
  `);

  /*
   * 킹 안전
   */
  const kingDifference =
    strategy.king.w -
    strategy.king.b;

  output.push(`
    <div class="factor">
      <b>킹 안전</b>
      <span>
        ${
          Math.abs(
            kingDifference
          ) < 2
            ? "양쪽 킹의 안전 차이가 현재 결정적이지 않습니다."
            : `${
                kingDifference < 0
                  ? "백"
                  : "흑"
              } 킹 주변에 상대의 공격 압력이 더 큽니다.
              직접적인 전술 위협을 먼저 확인해야 합니다.`
        }
      </span>
    </div>
  `);

  /*
   * 핵심 불균형
   */
  output.push(`
    <div class="factor">
      <b>현재 가장 중요한 불균형</b>
      <span>
        ${escape(
          strategicText(
            strategy
          )
        )}
      </span>
    </div>
  `);

  /*
   * 정적 / 동적
   */
  const dynamic =
    [
      "initiative",
      "king"
    ].includes(
      strategy.dominant.key
    );

  output.push(`
    <div class="factor">
      <b>정적 / 동적</b>
      <span>
        ${
          dynamic
            ? "현재 중요한 요소에는 동적인 성격이 강합니다. 시간을 주면 사라질 수 있으므로 더 오래가는 우세나 구체적인 이득으로 바꾸는 것이 중요합니다."
            : "현재 중요한 요소는 물질이나 폰 구조처럼 비교적 오래 지속되는 정적 요소에 가깝습니다."
        }
      </span>
    </div>
  `);

  /*
   * 상대의 반격
   */
  output.push(`
    <div class="factor">
      <b>상대의 반격</b>
      <span>
        다음 수를 찾기 전에 상대가 체크·잡기·전진·돌파로
        즉시 상황을 바꿀 수 있는지를 먼저 확인해야 합니다.
      </span>
    </div>
  `);

  /*
   * 생각의 순서
   */
  output.push(`
    <div class="factor">
      <b>생각의 순서</b>
      <span>
        불균형을 찾고 →
        플레이할 쪽을 정하고 →
        상대의 반격을 확인하고 →
        원하는 포지션을 그린 뒤 →
        후보 수를 만들고 →
        엔진으로 검증합니다.
      </span>
    </div>
  `);

  return output.join("");
}


/* =========================================================
   후보 수 분류
========================================================= */

function moveTags(
  move,
  strategy
) {
  const tags = [];

  if (
    move.captured
  ) {
    tags.push(
      "교환/잡기"
    );
  }

  if (
    move.san.includes("+")
  ) {
    tags.push(
      "킹 압박"
    );
  }

  if (
    move.piece === "p" &&
    [
      "d4",
      "d5",
      "e4",
      "e5"
    ].includes(
      move.to
    )
  ) {
    tags.push(
      "중앙"
    );
  }

  if (
    move.piece === "p" &&
    Math.abs(
      Number(
        move.to[1]
      ) -
      Number(
        move.from[1]
      )
    ) >= 2
  ) {
    tags.push(
      "공간/돌파"
    );
  }

  if (
    move.piece === "n" ||
    move.piece === "b"
  ) {
    tags.push(
      "기물 개선"
    );
  }

  if (
    move.piece === "r"
  ) {
    tags.push(
      "룩 활용"
    );
  }

  if (
    strategy?.dominant?.key ===
      "space" &&
    move.piece === "p"
  ) {
    tags.push(
      "공간 계획"
    );
  }

  if (
    strategy?.dominant?.key ===
      "material" &&
    move.captured
  ) {
    tags.push(
      "물질 활용"
    );
  }

  if (
    strategy?.dominant?.key ===
      "king" &&
    move.san.includes("+")
  ) {
    tags.push(
      "킹 공격"
    );
  }

  if (
    strategy?.dominant?.key ===
      "initiative" &&
    move.piece !== "p"
  ) {
    tags.push(
      "주도권"
    );
  }

  if (!tags.length) {
    tags.push(
      "계획 수"
    );
  }

  return tags;
}


/* =========================================================
   후보 수 생성
========================================================= */

function buildCandidates(
  fen,
  analysis,
  strategy
) {
  const lines =
    analysis.lines || [];

  const output = [];

  /*
   * 엔진 최선
   */
  if (
    lines[0]
  ) {
    const move =
      applyUci(
        fen,
        lines[0].pv[0]
      );

    output.push({
      san:
        move?.san ||
        lines[0].pv[0],

      score:
        lines[0].score,

      pv:
        sanPv(
          fen,
          lines[0].pv
        ),

      tag:
        "엔진 최선",

      desc:
        "현재 포지션에서 엔진이 가장 강하게 추천하는 수입니다."
    });
  }

  /*
   * MultiPV 2~3.
   *
   * 이미 같은 포지션을 분석한 결과이므로
   * 다시 엔진을 호출하지 않는다.
   */
  for (
    let i = 1;
    i < lines.length &&
    output.length < 3;
    i++
  ) {
    const line =
      lines[i];

    const move =
      applyUci(
        fen,
        line.pv[0]
      );

    if (!move) {
      continue;
    }

    const tags =
      moveTags(
        move.move,
        strategy
      );

    const scoreDifference =
      Math.abs(
        (
          lines[0]?.score ?? 0
        ) -
        line.score
      );

    /*
     * 엔진 최선과 너무 큰 차이가 나는 수는
     * 좋은 전략적 대안이라고 포장하지 않는다.
     */
    if (
      scoreDifference > 1.2
    ) {
      continue;
    }

    let tag =
      "전략적 대안";

    if (
      tags.includes(
        "킹 압박"
      ) ||
      tags.includes(
        "교환/잡기"
      )
    ) {
      tag =
        "실전적 대안";
    }

    if (
      strategy.dominant.key ===
        "space" &&
      tags.includes(
        "공간 계획"
      )
    ) {
      tag =
        "전략적 대안";
    }

    output.push({
      san:
        move.san,

      score:
        line.score,

      pv:
        sanPv(
          fen,
          line.pv
        ),

      tag,

      desc:
        `현재의 핵심 불균형을 다른 방식으로 다루는 후보입니다. ${
          tags.join(" · ")
        }.`
    });
  }

  /*
   * MultiPV가 부족하면 실제 합법수 중에서
   * 단순한 계획 후보를 몇 개 보여준다.
   *
   * 여기서는 엔진을 다시 호출하지 않는다.
   */
  if (
    output.length < 3
  ) {
    const chess =
      new Chess(fen);

    const legal =
      chess.moves({
        verbose: true
      });

    const used =
      new Set(
        output.map(
          candidate =>
            candidate.san
        )
      );

    const extra =
      legal
        .filter(
          move =>
            !used.has(
              move.san
            )
        )
        .sort(
          (a, b) => {
            let pa = 0;
            let pb = 0;

            if (
              a.captured
            ) {
              pa += 3;
            }

            if (
              b.captured
            ) {
              pb += 3;
            }

            if (
              a.san.includes("+")
            ) {
              pa += 5;
            }

            if (
              b.san.includes("+")
            ) {
              pb += 5;
            }

            if (
              [
                "d4",
                "d5",
                "e4",
                "e5"
              ].includes(
                a.to
              )
            ) {
              pa += 2;
            }

            if (
              [
                "d4",
                "d5",
                "e4",
                "e5"
              ].includes(
                b.to
              )
            ) {
              pb += 2;
            }

            return pb - pa;
          }
        )
        .slice(
          0,
          5
        );

    for (
      const move of extra
    ) {
      if (
        output.length >= 3
      ) {
        break;
      }

      /*
       * 엔진 검증 없이
       * "전략적 대안"이라고 부르지 않는다.
       */
      output.push({
        san:
          move.san,

        score:
          null,

        pv:
          move.san,

        tag:
          "다른 계획",

        desc:
          `엔진 최선과 다른 계획입니다. ${
            moveTags(
              move,
              strategy
            ).join(" · ")
          }.`
      });
    }
  }

  return output;
}


/* =========================================================
   실제 둔 수 복기
========================================================= */

function reviewText(
  before,
  after,
  actualSan
) {
  if (
    before == null ||
    after == null
  ) {
    return {
      title:
        "복기 준비 중",

      text:
        "현재 수와 이전 포지션의 평가를 비교할 수 있는 정보가 아직 충분하지 않습니다."
    };
  }

  /*
   * 백 기준 평가.
   *
   * 실제로 둔 쪽을 고려해
   * 평가 변화의 방향을 해석한다.
   */
  const difference =
    +(
      after -
      before
    ).toFixed(2);

  if (
    Math.abs(
      difference
    ) < 0.15
  ) {
    return {
      title:
        "평가 유지",

      text:
        `${actualSan}은 평가를 거의 바꾸지 않았고 현재 포지션의 중요한 요소를 유지했습니다.`
    };
  }

  const mover =
    actualSan
      ? null
      : null;

  if (
    difference > 0
  ) {
    return {
      title:
        "백에게 유리하게 변화",

      text:
        `${actualSan} 이후 엔진 평가가 백 쪽으로 약 ${difference.toFixed(2)}만큼 이동했습니다.`
    };
  }

  return {
    title:
      "흑에게 유리하게 변화",

    text:
      `${actualSan} 이후 엔진 평가가 흑 쪽으로 약 ${Math.abs(difference).toFixed(2)}만큼 이동했습니다.`
  };
}


/* =========================================================
   현재 포지션 분석
========================================================= */

async function analyzeCurrent() {
  const position =
    positions[ply];

  if (!position) {
    return;
  }

  renderBoard(
    position.fen
  );

  renderMoves();

  E.move.textContent =
    `${ply} / ${positions.length - 1}`;

  E.position.textContent =
    ply
      ? `${Math.ceil(
          ply / 2
        )}${
          ply % 2
            ? ". "
            : "… "
        }${position.san}`
      : "시작 포지션";

  E.eval.textContent =
    "분석 중…";

  E.depth.textContent =
    "—";

  E.insight.textContent =
    "포지션을 분석하고 있습니다.";

  E.candidates.innerHTML =
    "";

  setProgress(
    0,
    0
  );

  /*
   * 전략 분석은 엔진과 독립적이다.
   */
  const chess =
    new Chess(
      position.fen
    );

  const strategy =
    analyzeStrategy(
      chess
    );

  E.factors.innerHTML =
    factorHTML(
      strategy
    );

  /*
   * 핵심:
   *
   * 현재 포지션은 Stockfish를
   * 딱 한 번 분석한다.
   *
   * MultiPV 3 결과를 한 번에 받는다.
   */
  let result;

  try {
    result =
      await analyzeFen(
        position.fen,
        8
      );
  } catch (error) {
    if (
      error.message ===
      "cancelled"
    ) {
      return;
    }

    E.eval.textContent =
      "분석 실패";

    E.depth.textContent =
      "—";

    E.insight.textContent =
      error.message ||
      "엔진 분석에 실패했습니다.";

    throw error;
  }

  const bestScore =
    result.lines[0]?.score;

  /*
   * 엔진 결과를 받았으면
   * 바로 화면에 표시한다.
   */
  E.eval.textContent =
    scoreText(
      bestScore
    );

  E.insight.textContent =
    scoreWords(
      bestScore
    );

  setProgress(
    100,
    result.depth
  );

  /*
   * 후보 수.
   *
   * 여기서는 다시 엔진을 돌리지 않는다.
   */
  const candidates =
    buildCandidates(
      position.fen,
      result,
      strategy
    );

  E.candidates.innerHTML =
    candidates
      .slice(
        0,
        3
      )
      .map(
        (candidate, index) => `
          <div class="candidate">

            <div class="candidateTop">

              <span class="candidateName">
                ${index + 1}.
                ${escape(
                  candidate.san
                )}
                ·
                ${escape(
                  candidate.tag
                )}
              </span>

              <span class="candidateScore">
                ${
                  candidate.score == null
                    ? "검증 필요"
                    : scoreText(
                        candidate.score
                      )
                }
              </span>

            </div>

            <div class="candidateDesc">

              ${escape(
                candidate.desc
              )}

              <br>

              <span class="muted">
                ${escape(
                  candidate.pv
                )}
              </span>

            </div>

          </div>
        `
      )
      .join("");

  /*
   * 이전 포지션이 캐시에 이미 있으면
   * 추가 엔진 호출 없이 실제 수를 복기한다.
   */
  if (
    ply > 0
  ) {
    const previous =
      positions[
        ply - 1
      ];

    const previousKey =
      `${previous.fen}|8`;

    const previousResult =
      cache.get(
        previousKey
      );

    if (
      previousResult &&
      previousResult.lines[0] &&
      bestScore != null
    ) {
      const review =
        reviewText(
          previousResult.lines[0].score,
          bestScore,
          position.san
        );

      E.insight.textContent =
        `${scoreWords(
          bestScore
        )} ${review.title}: ${review.text}`;
    }
  }
}


/* =========================================================
   수 선택
========================================================= */

async function selectPly(
  number
) {
  /*
   * 이전 분석 중지
   */
  if (activeJob) {
    cancelEngineJob();
  }

  ply =
    Math.max(
      0,
      Math.min(
        positions.length - 1,
        number
      )
    );

  E.first.disabled =
    E.prev.disabled =
      ply === 0;

  E.next.disabled =
    E.last.disabled =
      ply ===
      positions.length - 1;

  try {
    await analyzeCurrent();
  } catch (error) {
    if (
      error.message !==
      "cancelled"
    ) {
      showError(
        error.message ||
        "분석에 실패했습니다."
      );
    }
  }
}


/* =========================================================
   분석 시작
========================================================= */

async function start() {
  clearError();

  const text =
    E.pgn.value.trim();

  if (!text) {
    showError(
      "PGN을 입력해주세요."
    );
    return;
  }

  try {
    game =
      loadGame(
        text
      );
  } catch {
    showError(
      "PGN을 읽을 수 없습니다. 기보 형식을 확인해주세요."
    );
    return;
  }

  positions =
    buildPositions(
      game
    );

  if (
    positions.length < 2
  ) {
    showError(
      "기보에서 수순을 찾지 못했습니다."
    );
    return;
  }

  /*
   * 기존 분석 캐시 제거
   */
  cache.clear();

  /*
   * 기존 작업 취소
   */
  if (activeJob) {
    cancelEngineJob();
  }

  ply = 0;

  E.inputView.hidden =
    true;

  E.analysisView.hidden =
    false;

  E.meta.textContent =
    `${positions.length - 1}수`;

  renderMoves();

  /*
   * 엔진 준비
   */
  await bootEngine();

  /*
   * 첫 포지션 분석
   */
  await selectPly(0);
}


/* =========================================================
   이벤트
========================================================= */

E.example.onclick =
  () => {
    E.pgn.value =
      EXAMPLE;

    clearError();
  };


E.analyze.onclick =
  async () => {
    E.analyze.disabled =
      true;

    try {
      await start();
    } catch (error) {
      showError(
        error.message ||
        "분석을 시작할 수 없습니다."
      );
    } finally {
      E.analyze.disabled =
        false;
    }
  };


E.back.onclick =
  () => {
    if (activeJob) {
      cancelEngineJob();
    }

    E.analysisView.hidden =
      true;

    E.inputView.hidden =
      false;
  };


E.first.onclick =
  () =>
    selectPly(0);


E.prev.onclick =
  () =>
    selectPly(
      ply - 1
    );


E.next.onclick =
  () =>
    selectPly(
      ply + 1
    );


E.last.onclick =
  () =>
    selectPly(
      positions.length - 1
    );


E.pgn.addEventListener(
  "input",
  clearError
);


/* =========================================================
   초기 엔진 준비
========================================================= */

bootEngine().catch(
  () => {}
);
