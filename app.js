import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

const STOCKFISH_PATH = "./stockfish/stockfish-19-lite-single.js";

const FILES = ["a","b","c","d","e","f","g","h"];
const RANKS = ["8","7","6","5","4","3","2","1"];

const PIECES = {
  w: { p:"♙", n:"♘", b:"♗", r:"♖", q:"♕", k:"♔" },
  b: { p:"♟", n:"♞", b:"♝", r:"♜", q:"♛", k:"♚" }
};

const PIECE_VALUES = {
  p: 1,
  n: 3.2,
  b: 3.3,
  r: 5,
  q: 9,
  k: 0
};

let engine = null;
let engineReady = false;
let engineBusy = false;
let engineResolve = null;
let engineLines = [];
let currentDepth = 0;
let analysisToken = 0;

let game = new Chess();
let positions = [];
let currentPly = 0;
let totalPlies = 0;
let currentSnapshot = null;

const els = {
  inputView: document.getElementById("inputView"),
  analysisView: document.getElementById("analysisView"),
  pgnInput: document.getElementById("pgnInput"),
  exampleBtn: document.getElementById("exampleBtn"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  errorBox: document.getElementById("errorBox"),
  engineStatus: document.getElementById("engineStatus"),
  board: document.getElementById("board"),
  positionLabel: document.getElementById("positionLabel"),
  moveLabel: document.getElementById("moveLabel"),
  gameMeta: document.getElementById("gameMeta"),
  moveList: document.getElementById("moveList"),
  firstBtn: document.getElementById("firstBtn"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  lastBtn: document.getElementById("lastBtn"),
  backBtn: document.getElementById("backBtn"),
  evalValue: document.getElementById("evalValue"),
  depthValue: document.getElementById("depthValue"),
  progressBar: document.getElementById("progressBar"),
  positionInsight: document.getElementById("positionInsight"),
  candidateList: document.getElementById("candidateList"),
  humanFactors: document.getElementById("humanFactors")
};

const EXAMPLE_PGN = `[Event "Human Chess Insight Example"]
[Site "?"]
[Date "2026.10.05"]
[Round "1"]
[White "White"]
[Black "Black"]
[Result "*"]

1. c4 e5 2. g3 Nc6 3. Bg2 Bc5 4. e3 Nf6 5. Ne2 O-O 6. O-O d6 7. d4`;



/* =========================================================
   BASIC UTILITIES
   ========================================================= */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function opposite(color) {
  return color === "w" ? "b" : "w";
}

function colorName(color) {
  return color === "w" ? "백" : "흑";
}

function pieceName(type) {
  return {
    p: "폰",
    n: "나이트",
    b: "비숍",
    r: "룩",
    q: "퀸",
    k: "킹"
  }[type] || type;
}

function pieceSymbol(color, type) {
  return PIECES[color]?.[type] || "";
}

function fileIndex(square) {
  return FILES.indexOf(square[0]);
}

function rankOf(square) {
  return Number(square[1]);
}

function allSquares() {
  const result = [];

  for (const file of FILES) {
    for (let rank = 1; rank <= 8; rank++) {
      result.push(`${file}${rank}`);
    }
  }

  return result;
}

function isCentral(square) {
  return [
    "c3","d3","e3","f3",
    "c4","d4","e4","f4",
    "c5","d5","e5","f5",
    "c6","d6","e6","f6"
  ].includes(square);
}

function isOpponentHalf(square, color) {
  const rank = rankOf(square);

  return color === "w"
    ? rank >= 5
    : rank <= 4;
}

function distToCenter(square) {
  const file = fileIndex(square);
  const rank = rankOf(square);

  return Math.abs(file - 3.5) + Math.abs(rank - 4.5);
}

function squareColor(square) {
  const file = fileIndex(square);
  const rank = rankOf(square);

  return (file + rank) % 2 === 0
    ? "light"
    : "dark";
}

function setProgress(value) {
  if (!els.progressBar) return;

  els.progressBar.style.width =
    `${clamp(value, 0, 100)}%`;
}



/* =========================================================
   POSITION / MATERIAL
   ========================================================= */

function countPieces(chess) {
  const result = {
    w: { p:0, n:0, b:0, r:0, q:0, k:0 },
    b: { p:0, n:0, b:0, r:0, q:0, k:0 }
  };

  for (const square of allSquares()) {
    const piece = chess.get(square);

    if (!piece) continue;

    result[piece.color][piece.type]++;
  }

  return result;
}

function materialValues(chess) {
  const counts = countPieces(chess);

  const values = {
    w: 0,
    b: 0
  };

  for (const color of ["w", "b"]) {
    for (const type of ["p","n","b","r","q"]) {
      values[color] +=
        counts[color][type] *
        PIECE_VALUES[type];
    }
  }

  return {
    counts,
    values,
    difference: values.w - values.b
  };
}

function analyzeMaterial(chess) {
  const result = materialValues(chess);

  let text = "물질적으로 균형이 맞습니다.";

  if (result.difference > 0.2) {
    text =
      `백이 약 ${result.difference.toFixed(1)}점의 물질적 우세를 가지고 있습니다.`;
  }

  if (result.difference < -0.2) {
    text =
      `흑이 약 ${Math.abs(result.difference).toFixed(1)}점의 물질적 우세를 가지고 있습니다.`;
  }

  return {
    counts: result.counts,
    material: result.values,
    difference: result.difference,
    text
  };
}



/* =========================================================
   PAWNS
   ========================================================= */

function pawnSquares(chess, color) {
  return allSquares().filter(square => {
    const piece = chess.get(square);

    return piece &&
      piece.color === color &&
      piece.type === "p";
  });
}

function filePawnExists(chess, color, file) {
  return pawnSquares(chess, color)
    .some(square => fileIndex(square) === file);
}

function pawnAttacksSquare(chess, from, target) {
  const pawn = chess.get(from);

  if (!pawn || pawn.type !== "p") {
    return false;
  }

  const df =
    Math.abs(
      fileIndex(from) -
      fileIndex(target)
    );

  const dr =
    rankOf(target) -
    rankOf(from);

  if (df !== 1) {
    return false;
  }

  return pawn.color === "w"
    ? dr === 1
    : dr === -1;
}

function isAttackedByPawn(chess, square, color) {
  return pawnSquares(chess, color)
    .some(pawn =>
      pawnAttacksSquare(
        chess,
        pawn,
        square
      )
    );
}



/* =========================================================
   ATTACK MAP
   ========================================================= */

function rayAttacks(chess, from, target) {
  const df =
    Math.sign(
      fileIndex(target) -
      fileIndex(from)
    );

  const dr =
    Math.sign(
      rankOf(target) -
      rankOf(from)
    );

  if (df === 0 && dr === 0) {
    return false;
  }

  let file =
    fileIndex(from) + df;

  let rank =
    rankOf(from) + dr;

  while (
    file >= 0 &&
    file < 8 &&
    rank >= 1 &&
    rank <= 8
  ) {
    const square =
      `${FILES[file]}${rank}`;

    if (square === target) {
      return true;
    }

    if (chess.get(square)) {
      return false;
    }

    file += df;
    rank += dr;
  }

  return false;
}

function isSquareAttackedBy(
  chess,
  target,
  attacker
) {
  for (const square of allSquares()) {
    const piece = chess.get(square);

    if (!piece || piece.color !== attacker) {
      continue;
    }

    const df =
      Math.abs(
        fileIndex(square) -
        fileIndex(target)
      );

    const dr =
      Math.abs(
        rankOf(square) -
        rankOf(target)
      );

    if (
      piece.type === "p" &&
      pawnAttacksSquare(
        chess,
        square,
        target
      )
    ) {
      return true;
    }

    if (
      piece.type === "n" &&
      (
        (df === 1 && dr === 2) ||
        (df === 2 && dr === 1)
      )
    ) {
      return true;
    }

    if (
      piece.type === "k" &&
      Math.max(df, dr) === 1
    ) {
      return true;
    }

    if (
      (piece.type === "b" ||
       piece.type === "q") &&
      df === dr &&
      rayAttacks(
        chess,
        square,
        target
      )
    ) {
      return true;
    }

    if (
      (piece.type === "r" ||
       piece.type === "q") &&
      (df === 0 || dr === 0) &&
      rayAttacks(
        chess,
        square,
        target
      )
    ) {
      return true;
    }
  }

  return false;
}



/* =========================================================
   LEGAL MOVES FOR ARBITRARY PIECE
   ========================================================= */

function getPieceMoves(chess, square) {
  const piece = chess.get(square);

  if (!piece) {
    return [];
  }

  try {
    const fenParts =
      chess.fen().split(" ");

    /*
     * chess.js generates legal moves for
     * the side to move.
     *
     * For strategic inspection of a piece
     * belonging to the other side, temporarily
     * switch active color.
     */

    fenParts[1] = piece.color;

    const temporary =
      new Chess(fenParts.join(" "));

    return temporary.moves({
      square,
      verbose: true
    });

  } catch {
    return [];
  }
}

function hasSupport(chess, square, color) {
  return isSquareAttackedBy(
    chess,
    square,
    color
  );
}



/* =========================================================
   GAME PHASE
   ========================================================= */

function getGamePhase(chess, ply = 0) {
  const pieces = countPieces(chess);

  const queens =
    pieces.w.q +
    pieces.b.q;

  const rooks =
    pieces.w.r +
    pieces.b.r;

  const minors =
    pieces.w.n +
    pieces.w.b +
    pieces.b.n +
    pieces.b.b;

  const nonPawnMaterial =
    pieces.w.n * 3.2 +
    pieces.w.b * 3.3 +
    pieces.w.r * 5 +
    pieces.w.q * 9 +
    pieces.b.n * 3.2 +
    pieces.b.b * 3.3 +
    pieces.b.r * 5 +
    pieces.b.q * 9;

  if (
    queens === 0 &&
    (
      rooks + minors <= 4 ||
      nonPawnMaterial <= 13
    )
  ) {
    return "엔드게임";
  }

  if (
    ply <= 20 &&
    queens > 0
  ) {
    return "오프닝";
  }

  if (
    queens > 0 &&
    (
      ply <= 24 ||
      rooks + minors >= 7
    )
  ) {
    return "미들게임";
  }

  if (rooks + minors <= 5) {
    return "엔드게임";
  }

  return "미들게임";
}



/* =========================================================
   BISHOP ANALYSIS
   ========================================================= */

function bishopInfo(chess, square, color) {
  const moves =
    getPieceMoves(
      chess,
      square
    );

  const centralBlockers = [];

  const directions = [
    [1,1],
    [1,-1],
    [-1,1],
    [-1,-1]
  ];

  const startFile =
    fileIndex(square);

  const startRank =
    rankOf(square);

  for (const [df, dr] of directions) {
    let file =
      startFile + df;

    let rank =
      startRank + dr;

    while (
      file >= 0 &&
      file < 8 &&
      rank >= 1 &&
      rank <= 8
    ) {
      const target =
        `${FILES[file]}${rank}`;

      const piece =
        chess.get(target);

      if (piece) {
        if (
          piece.color === color &&
          piece.type === "p" &&
          isCentral(target)
        ) {
          centralBlockers.push({
            square: target,
            piece
          });
        }

        break;
      }

      file += df;
      rank += dr;
    }
  }

  const captures =
    moves.filter(
      move => move.captured
    );

  const activityScore =
    Math.min(
      moves.length,
      8
    ) * 0.7 +
    captures.length * 1.2 -
    centralBlockers.length * 1.1;

  let label =
    "활동적인 비숍";

  let explanation = "";

  let improvement = "";

  if (
    centralBlockers.length >= 2 &&
    moves.length <= 4
  ) {
    label =
      "활동이 크게 제한된 비숍";

    explanation =
      `${colorName(color)}의 ${square} 비숍은 자기 중앙 폰들에 의해 주요 대각선의 활동이 크게 제한되어 있습니다.`;

    improvement =
      "비숍을 가로막는 구조를 바꾸거나 더 좋은 대각선을 확보할 방법을 찾아야 합니다.";
  }

  else if (
    centralBlockers.length >= 1 &&
    moves.length <= 6
  ) {
    label =
      "활동이 제한된 비숍";

    explanation =
      `${colorName(color)}의 ${square} 비숍은 자기 폰 때문에 주요 대각선 일부가 제한되어 있습니다. 다만 아직 개선할 길이 남아 있어 곧바로 나쁜 비숍이라고 단정할 수는 없습니다.`;

    improvement =
      "더 좋은 대각선을 확보하거나 비숍의 활동을 막는 폰 구조를 바꾸는 방법을 살펴보는 것이 좋습니다.";
  }

  else if (
    moves.length >= 6 ||
    captures.length > 0
  ) {
    label =
      "활동적인 비숍";

    explanation =
      `${colorName(color)}의 ${square} 비숍은 열린 대각선을 통해 상대 기물이나 폰에 실제로 영향을 줄 수 있어 활동성이 유지되고 있습니다.`;

    improvement =
      "현재의 활동을 유지하면서 더 중요한 대상이나 더 긴 대각선을 확보할 수 있는지 봅니다.";
  }

  else {
    label =
      "개선 여지가 있는 비숍";

    explanation =
      `${colorName(color)}의 ${square} 비숍은 현재 활동 범위가 넓지 않습니다.`;

    improvement =
      "더 넓은 대각선이나 중요한 대상을 바라볼 수 있는 위치를 찾는 것이 좋습니다.";
  }

  return {
    square,
    color,
    type: "b",
    label,
    explanation,
    improvement,
    legalMoveCount: moves.length,
    centralBlockers,
    activityScore
  };
}



/* =========================================================
   KNIGHT ANALYSIS
   ========================================================= */

function knightAnalysis(
  chess,
  square,
  color
) {
  const moves =
    getPieceMoves(
      chess,
      square
    );

  const usefulMoves =
    moves.filter(move =>
      isCentral(move.to) ||
      isOpponentHalf(
        move.to,
        color
      ) ||
      !!move.captured
    );

  const stableSquares =
    moves.filter(move => {

      if (
        isAttackedByPawn(
          chess,
          move.to,
          opposite(color)
        )
      ) {
        return false;
      }

      return (
        hasSupport(
          chess,
          move.to,
          color
        ) ||
        isCentral(move.to)
      );
    });

  let label =
    "기동 가능한 나이트";

  let explanation =
    `${colorName(color)}의 ${square} 나이트는 ${moves.length}개의 합법적인 이동을 가지고 있습니다.`;

  let improvement = "";

  if (stableSquares.length > 0) {
    label =
      "지원점을 찾을 수 있는 나이트";

    explanation +=
      ` ${stableSquares[0].to}처럼 상대 폰에게 쉽게 쫓겨나지 않고 활용할 수 있는 칸이 있습니다.`;

    improvement =
      "단순히 전진하기보다 실제로 유지할 수 있고 상대에게 부담을 주는 지원점을 우선 봅니다.";
  }

  else if (usefulMoves.length >= 4) {
    label =
      "활동적인 나이트";

    explanation +=
      " 중앙 또는 상대 진영으로 연결되는 선택지가 충분합니다.";

    improvement =
      "좋은 이동 수가 많은 것보다 장기적으로 유지할 수 있는 칸인지 확인합니다.";
  }

  else if (moves.length === 0) {
    label =
      "움직임이 제한된 나이트";

    explanation +=
      " 현재는 합법적인 이동이 없어 활동성이 매우 제한되어 있습니다.";

    improvement =
      "자기 폰이나 기물 때문에 막힌 경로를 해소하는 것이 우선입니다.";
  }

  else {
    label =
      "개선 여지가 있는 나이트";

    explanation +=
      " 유용한 이동 선택지가 많지 않아 더 좋은 위치를 찾을 필요가 있습니다.";

    improvement =
      "상대 폰의 공격을 피하면서 중앙이나 안정적인 지원점으로 연결되는 경로를 찾습니다.";
  }

  return {
    square,
    color,
    type: "n",
    label,
    explanation,
    improvement,
    legalMoveCount: moves.length,
    usefulMoveCount: usefulMoves.length,
    outpostCandidates:
      stableSquares
        .slice(0, 4)
        .map(move => move.to),
    activityScore:
      usefulMoves.length +
      stableSquares.length * 1.5
  };
}



/* =========================================================
   MINOR PIECES
   ========================================================= */

function analyzeMinorPieces(chess) {
  const result = {
    w: {
      bishops: [],
      knights: []
    },
    b: {
      bishops: [],
      knights: []
    },
    all: []
  };

  for (const color of ["w","b"]) {
    for (const square of allSquares()) {
      const piece =
        chess.get(square);

      if (
        !piece ||
        piece.color !== color
      ) {
        continue;
      }

      if (piece.type === "b") {
        const info =
          bishopInfo(
            chess,
            square,
            color
          );

        result[color].bishops.push(info);
        result.all.push(info);
      }

      if (piece.type === "n") {
        const info =
          knightAnalysis(
            chess,
            square,
            color
          );

        result[color].knights.push(info);
        result.all.push(info);
      }
    }
  }

  function activityScore(color) {
    return (
      result[color].bishops
        .reduce(
          (sum, item) =>
            sum + item.activityScore,
          0
        ) +
      result[color].knights
        .reduce(
          (sum, item) =>
            sum + item.activityScore,
          0
        )
    );
  }

  const whiteScore =
    activityScore("w");

  const blackScore =
    activityScore("b");

  result.scores = {
    w: whiteScore,
    b: blackScore
  };

  result.dominantSide =
    whiteScore > blackScore + 2
      ? "w"
      : blackScore > whiteScore + 2
        ? "b"
        : null;

  result.summary =
    result.dominantSide
      ? `${colorName(result.dominantSide)}의 기물들이 더 넓은 활동 범위와 선택지를 가지고 있습니다.`
      : "양쪽 기물의 활동성 차이가 현재 결정적이라고 보기는 어렵습니다.";

  return result;
}



/* =========================================================
   PAWN STRUCTURE
   ========================================================= */

function analyzePawnStructure(chess) {
  const result = {
    w: {
      doubled: [],
      isolated: [],
      backward: [],
      passed: []
    },
    b: {
      doubled: [],
      isolated: [],
      backward: [],
      passed: []
    }
  };

  for (const color of ["w","b"]) {
    const pawns =
      pawnSquares(
        chess,
        color
      );

    const byFile = {};

    for (const pawn of pawns) {
      const file =
        fileIndex(pawn);

      if (!byFile[file]) {
        byFile[file] = [];
      }

      byFile[file].push(pawn);
    }

    /*
     * Doubled pawns
     */

    for (const file of Object.keys(byFile)) {
      const pawnsOnFile =
        byFile[file];

      if (pawnsOnFile.length > 1) {
        result[color].doubled.push(
          ...pawnsOnFile
        );
      }
    }

    /*
     * Isolated / passed
     */

    for (const pawn of pawns) {
      const file =
        fileIndex(pawn);

      const rank =
        rankOf(pawn);

      const neighborFiles =
        [file - 1, file + 1]
          .filter(
            f => f >= 0 && f < 8
          );

      if (
        !neighborFiles.some(
          f =>
            filePawnExists(
              chess,
              color,
              f
            )
        )
      ) {
        result[color].isolated.push(
          pawn
        );
      }

      const enemy =
        opposite(color);

      let passed = true;

      for (
        const enemyPawn
        of pawnSquares(
          chess,
          enemy
        )
      ) {
        const enemyFile =
          fileIndex(enemyPawn);

        const enemyRank =
          rankOf(enemyPawn);

        if (
          Math.abs(
            enemyFile - file
          ) > 1
        ) {
          continue;
        }

        if (
          color === "w" &&
          enemyRank > rank
        ) {
          passed = false;
        }

        if (
          color === "b" &&
          enemyRank < rank
        ) {
          passed = false;
        }
      }

      if (passed) {
        result[color].passed.push(
          pawn
        );
      }
    }

    /*
     * Backward pawn heuristic
     */

    for (const pawn of pawns) {
      const file =
        fileIndex(pawn);

      const rank =
        rankOf(pawn);

      const adjacentEnemyPawn =
        pawnSquares(
          chess,
          opposite(color)
        ).some(enemyPawn =>
          Math.abs(
            fileIndex(enemyPawn) -
            file
          ) <= 1 &&
          (
            color === "w"
              ? rankOf(enemyPawn) >= rank
              : rankOf(enemyPawn) <= rank
          )
        );

      const friendlyAhead =
        pawnSquares(
          chess,
          color
        ).some(friendPawn =>
          fileIndex(friendPawn) === file &&
          (
            color === "w"
              ? rankOf(friendPawn) > rank
              : rankOf(friendPawn) < rank
          )
        );

      if (
        adjacentEnemyPawn &&
        !friendlyAhead
      ) {
        result[color].backward.push(
          pawn
        );
      }
    }
  }

  const text = [];

  for (const color of ["w","b"]) {
    if (
      result[color].doubled.length
    ) {
      text.push(
        `${colorName(color)}의 더블폰 ${result[color].doubled.join(", ")}`
      );
    }

    if (
      result[color].isolated.length
    ) {
      text.push(
        `${colorName(color)}의 고립폰 ${result[color].isolated.join(", ")}`
      );
    }

    if (
      result[color].backward.length
    ) {
      text.push(
        `${colorName(color)}의 뒤처진 폰 ${result[color].backward.join(", ")}`
      );
    }

    if (
      result[color].passed.length
    ) {
      text.push(
        `${colorName(color)}의 패스드 폰 ${result[color].passed.join(", ")}`
      );
    }
  }

  return {
    ...result,
    text:
      text.length
        ? text.join(" / ")
        : "뚜렷한 전형적 폰 약점이 많지는 않습니다."
  };
}



/* =========================================================
   WEAK SQUARES
   ========================================================= */

function analyzeWeakSquares(chess) {
  const result = {
    w: [],
    b: []
  };

  for (const color of ["w","b"]) {
    for (const square of allSquares()) {

      if (
        !isOpponentHalf(
          square,
          color
        ) &&
        !isCentral(square)
      ) {
        continue;
      }

      if (chess.get(square)) {
        continue;
      }

      /*
       * 상대 폰으로부터
       * 쉽게 공격받지 않는 칸
       */

      if (
        isAttackedByPawn(
          chess,
          square,
          opposite(color)
        )
      ) {
        continue;
      }

      const supported =
        hasSupport(
          chess,
          square,
          color
        );

      const useful =
        isCentral(square) ||
        supported;

      if (!useful) {
        continue;
      }

      /*
       * 상대 기물의 직접적인 공격
       */

      const attacked =
        isSquareAttackedBy(
          chess,
          square,
          opposite(color)
        );

      if (!attacked) {
        result[color].push(
          square
        );
      }
    }
  }

  return {
    ...result,
    summary:
      result.w.length ||
      result.b.length
        ? `활용 가능성이 있는 안정적인 칸: 백 ${result.w.slice(0,5).join(", ") || "없음"}, 흑 ${result.b.slice(0,5).join(", ") || "없음"}`
        : "뚜렷한 안정적 약한 칸이 많지는 않습니다."
  };
}



/* =========================================================
   SPACE
   ========================================================= */

function analyzeSpace(chess) {
  const score = {
    w: 0,
    b: 0
  };

  for (const square of allSquares()) {
    const piece =
      chess.get(square);

    if (!piece) continue;

    if (piece.type === "p") {
      if (
        piece.color === "w" &&
        rankOf(square) >= 4
      ) {
        score.w++;
      }

      if (
        piece.color === "b" &&
        rankOf(square) <= 5
      ) {
        score.b++;
      }
    }

    if (
      ["n","b","r","q"].includes(
        piece.type
      )
    ) {
      const moves =
        getPieceMoves(
          chess,
          square
        );

      const useful =
        moves.filter(
          move =>
            isOpponentHalf(
              move.to,
              piece.color
            ) ||
            isCentral(move.to)
        ).length;

      score[piece.color] +=
        useful * 0.15;
    }
  }

  const difference =
    score.w - score.b;

  return {
    ...score,
    difference,
    side:
      Math.abs(difference) < 1
        ? null
        : difference > 0
          ? "w"
          : "b",
    text:
      Math.abs(difference) < 1
        ? "공간의 차이가 현재 결정적이지 않습니다."
        : `${colorName(difference > 0 ? "w" : "b")}이 상대보다 더 넓은 공간과 전진한 영역을 가지고 있습니다.`
  };
}



/* =========================================================
   CENTER
   ========================================================= */

function analyzeCenter(chess) {
  const centralPawns = [];

  for (const square of [
    "c4","d4","e4","f4",
    "c5","d5","e5","f5"
  ]) {
    const piece =
      chess.get(square);

    if (
      piece &&
      piece.type === "p"
    ) {
      centralPawns.push({
        square,
        color: piece.color
      });
    }
  }

  let white = 0;
  let black = 0;

  for (const pawn of centralPawns) {
    if (pawn.color === "w") {
      white++;
    } else {
      black++;
    }
  }

  const difference =
    white - black;

  let text =
    "중앙의 직접적인 우세가 뚜렷하지 않습니다.";

  if (difference >= 2) {
    text =
      "백이 중앙에서 더 많은 폰 공간을 확보하고 있습니다.";
  }

  if (difference <= -2) {
    text =
      "흑이 중앙에서 더 많은 폰 공간을 확보하고 있습니다.";
  }

  return {
    centralPawns,
    white,
    black,
    difference,
    text
  };
}



/* =========================================================
   OPEN FILES
   ========================================================= */

function analyzeOpenFiles(chess) {
  const files = [];

  for (const file of FILES) {
    const whitePawns =
      pawnSquares(
        chess,
        "w"
      ).filter(
        square =>
          square[0] === file
      );

    const blackPawns =
      pawnSquares(
        chess,
        "b"
      ).filter(
        square =>
          square[0] === file
      );

    if (
      !whitePawns.length &&
      !blackPawns.length
    ) {
      const rooks =
        allSquares().filter(
          square => {
            const piece =
              chess.get(square);

            return (
              piece &&
              piece.type === "r" &&
              square[0] === file
            );
          }
        );

      files.push({
        file,
        rooks
      });
    }
  }

  return {
    files,
    summary:
      files.length
        ? `완전 오픈 파일: ${files.map(x => x.file).join(", ")}`
        : "완전 오픈 파일이 없습니다."
  };
}



/* =========================================================
   KING SAFETY
   ========================================================= */

function findKing(chess, color) {
  return allSquares().find(
    square => {
      const piece =
        chess.get(square);

      return (
        piece &&
        piece.color === color &&
        piece.type === "k"
      );
    }
  );
}

function analyzeKingSafety(chess) {
  const score = {
    w: 0,
    b: 0
  };

  for (const color of ["w","b"]) {
    const king =
      findKing(
        chess,
        color
      );

    if (!king) continue;

    const kingFile =
      fileIndex(king);

    const kingRank =
      rankOf(king);

    let shield = 0;
    let attacked = 0;

    for (
      let file =
        Math.max(
          0,
          kingFile - 1
        );

      file <=
      Math.min(
        7,
        kingFile + 1
      );

      file++
    ) {
      for (
        let rank =
          Math.max(
            1,
            kingRank - 1
          );

        rank <=
        Math.min(
          8,
          kingRank + 1
        );

        rank++
      ) {
        const square =
          `${FILES[file]}${rank}`;

        const piece =
          chess.get(square);

        if (
          piece &&
          piece.color === color &&
          piece.type === "p"
        ) {
          shield++;
        }

        if (
          isSquareAttackedBy(
            chess,
            square,
            opposite(color)
          )
        ) {
          attacked++;
        }
      }
    }

    score[color] =
      shield * 1.2 -
      attacked * 0.8;
  }

  const difference =
    score.w - score.b;

  return {
    ...score,
    difference,

    side:
      Math.abs(difference) < 1
        ? null
        : difference < 0
          ? "w"
          : "b",

    text:
      Math.abs(difference) < 1
        ? "킹 안전의 차이가 현재 뚜렷하지 않습니다."
        : `${colorName(difference < 0 ? "w" : "b")}의 킹 주변이 상대적으로 더 신경 써야 할 상태입니다.`
  };
}



/* =========================================================
   DEVELOPMENT
   ========================================================= */

function analyzeDevelopment(chess) {
  const home = {
    w: {
      n: ["b1","g1"],
      b: ["c1","f1"]
    },
    b: {
      n: ["b8","g8"],
      b: ["c8","f8"]
    }
  };

  const score = {
    w: 0,
    b: 0
  };

  for (const color of ["w","b"]) {
    for (const type of ["n","b"]) {
      for (
        const square
        of home[color][type]
      ) {
        const piece =
          chess.get(square);

        if (
          !piece ||
          piece.color !== color ||
          piece.type !== type
        ) {
          score[color]++;
        }
      }
    }
  }

  const difference =
    score.w - score.b;

  return {
    ...score,

    difference,

    side:
      Math.abs(difference) < 1
        ? null
        : difference > 0
          ? "w"
          : "b",

    text:
      Math.abs(difference) < 1
        ? "개발 차이가 크지 않습니다."
        : `${colorName(difference > 0 ? "w" : "b")}이 더 많은 경량 기물을 기본 위치에서 발전시켰습니다.`
  };
}



/* =========================================================
   INITIATIVE
   ========================================================= */

function analyzeInitiative(
  chess,
  minor,
  king,
  openFiles
) {
  const activityDifference =
    minor.scores.w -
    minor.scores.b;

  const kingDifference =
    king.difference;

  const initiative =
    activityDifference -
    kingDifference * 0.6 +
    (
      openFiles.files.length
        ? 0.3
        : 0
    );

  return {
    value: initiative,

    side:
      Math.abs(initiative) < 2
        ? null
        : initiative > 0
          ? "w"
          : "b",

    text:
      Math.abs(initiative) < 2
        ? "현재 주도권의 차이를 단정하기 어렵습니다."
        : `${colorName(initiative > 0 ? "w" : "b")}이 상대에게 대응을 요구할 수 있는 요소를 더 많이 가지고 있습니다.`
  };
}



/* =========================================================
   COUNTERPLAY
   ========================================================= */

function findCounterplay(
  chess,
  side
) {
  const enemy =
    opposite(side);

  const items = [];

  const enemyPawns =
    pawnSquares(
      chess,
      enemy
    );

  const possibleBreaks = [];

  for (
    const pawn
    of enemyPawns
  ) {
    const file =
      fileIndex(pawn);

    const rank =
      rankOf(pawn);

    const direction =
      enemy === "w"
        ? 1
        : -1;

    for (
      const df
      of [-1,0,1]
    ) {
      const targetFile =
        file + df;

      if (
        targetFile < 0 ||
        targetFile > 7
      ) {
        continue;
      }

      const targetRank =
        rank + direction;

      if (
        targetRank < 1 ||
        targetRank > 8
      ) {
        continue;
      }

      const target =
        `${FILES[targetFile]}${targetRank}`;

      if (
        !chess.get(target) &&
        isCentral(target)
      ) {
        possibleBreaks.push(
          target
        );
      }
    }
  }

  if (
    possibleBreaks.length
  ) {
    items.push(
      `${colorName(enemy)}의 중앙 또는 폰 브레이크 가능성`
    );
  }

  const king =
    findKing(
      chess,
      side
    );

  if (
    king &&
    isSquareAttackedBy(
      chess,
      king,
      enemy
    )
  ) {
    items.push(
      `${colorName(side)} 킹에 대한 직접적인 압박`
    );
  }

  return {
    items,

    text:
      items.length
        ? items.join("; ")
        : "현재 즉각적인 반격 요소가 두드러지지 않습니다."
  };
}



/* =========================================================
   DOMINANT IMBALANCE
   ========================================================= */

function dominantImbalance(
  snapshot
) {
  const candidates = [];

  const material =
    Math.abs(
      snapshot.material.difference
    );

  if (material > 0.8) {
    candidates.push({
      name: "물질",
      score: 3 + material
    });
  }

  const activity =
    Math.abs(
      snapshot.minorPieces.scores.w -
      snapshot.minorPieces.scores.b
    );

  if (activity > 2) {
    candidates.push({
      name: "기물 활동성",
      score: 2 + activity * 0.7
    });
  }

  const whiteWeakness =
    snapshot.pawnStructure.w.doubled.length +
    snapshot.pawnStructure.w.isolated.length +
    snapshot.pawnStructure.w.backward.length;

  const blackWeakness =
    snapshot.pawnStructure.b.doubled.length +
    snapshot.pawnStructure.b.isolated.length +
    snapshot.pawnStructure.b.backward.length;

  const pawnDifference =
    whiteWeakness -
    blackWeakness;

  if (
    Math.abs(pawnDifference) > 1
  ) {
    candidates.push({
      name: "폰 구조",
      score:
        2 +
        Math.abs(
          pawnDifference
        )
    });
  }

  const space =
    Math.abs(
      snapshot.space.difference
    );

  if (space > 1) {
    candidates.push({
      name: "공간",
      score: 2 + space
    });
  }

  const kingSafety =
    Math.abs(
      snapshot.kingSafety.difference
    );

  if (kingSafety > 1.5) {
    candidates.push({
      name: "킹 안전",
      score: 3 + kingSafety
    });
  }

  const development =
    Math.abs(
      snapshot.development.difference
    );

  if (development > 1) {
    candidates.push({
      name: "개발",
      score: 2 + development
    });
  }

  const initiative =
    Math.abs(
      snapshot.initiative.value
    );

  if (initiative > 2) {
    candidates.push({
      name: "주도권",
      score:
        2 +
        initiative * 0.5
    });
  }

  if (!candidates.length) {
    return {
      key: "균형",
      side: null,
      reason:
        "현재 한 가지 불균형이 압도적으로 중요한 상태라고 보기 어렵습니다."
    };
  }

  candidates.sort(
    (a,b) =>
      b.score - a.score
  );

  const top =
    candidates[0];

  let side = null;

  if (top.name === "물질") {
    side =
      snapshot.material.difference > 0
        ? "w"
        : "b";
  }

  if (
    top.name ===
    "기물 활동성"
  ) {
    side =
      snapshot.minorPieces.dominantSide;
  }

  if (
    top.name === "공간"
  ) {
    side =
      snapshot.space.side;
  }

  if (
    top.name ===
    "킹 안전"
  ) {
    side =
      snapshot.kingSafety.side;
  }

  if (
    top.name === "개발"
  ) {
    side =
      snapshot.development.side;
  }

  if (
    top.name === "주도권"
  ) {
    side =
      snapshot.initiative.side;
  }

  return {
    key: top.name,
    side,
    reason:
      `현재 여러 요소 중 ${top.name}이 상대적인 차이가 가장 크고 실제 계획에 직접 연결될 가능성이 높습니다.`
  };
}



/* =========================================================
   FANTASY POSITION / PLAN
   ========================================================= */

function fantasyPlan(
  snapshot,
  side
) {
  const color =
    colorName(
      side || "w"
    );

  switch (
    snapshot.dominantImbalance.key
  ) {

    case "물질":
      return `${color}의 우세를 유지하면서 상대의 활동과 반격을 줄이고 필요하면 교환을 유도하는 포지션`;

    case "기물 활동성":
      return `${color}의 더 활동적인 기물을 유지하고 상대 기물을 수동적으로 만든 포지션`;

    case "폰 구조":
      return `${color}에게 유리한 폰 구조를 유지하면서 상대의 약점을 고정하고 공격할 수 있는 포지션`;

    case "공간":
      return `${color}의 공간 우세를 유지하면서 상대의 반격 수단을 제한한 포지션`;

    case "킹 안전":
      return `${color}의 킹을 안전하게 유지하면서 상대 킹 주변의 압박을 키운 포지션`;

    case "개발":
      return `${color}의 개발 우세를 활용해 주도권을 정적인 우세로 바꾼 포지션`;

    case "주도권":
      return `${color}이 계속 상대에게 대응을 강요하면서 주도권을 유지하는 포지션`;

    default:
      return `${color}의 가장 좋은 요소를 유지하면서 상대의 반격을 줄인 포지션`;
  }
}



/* =========================================================
   STRATEGIC CANDIDATES
   ========================================================= */

function getPieceMovesForTurn(
  chess
) {
  try {
    return chess.moves({
      verbose: true
    });
  } catch {
    return [];
  }
}

function buildCandidates(
  chess,
  snapshot
) {
  const side =
    chess.turn();

  const moves =
    getPieceMovesForTurn(
      chess
    );

  const candidates = [];

  for (const move of moves) {
    const piece =
      chess.get(move.from);

    let score = 0;

    if (
      isCentral(move.to)
    ) {
      score += 0.8;
    }

    if (
      isOpponentHalf(
        move.to,
        side
      )
    ) {
      score += 0.5;
    }

    if (move.captured) {
      score += Math.min(
        2,
        PIECE_VALUES[
          move.captured
        ] - 1
      );
    }

    if (
      snapshot.dominantImbalance.side === side
    ) {
      score += 0.5;
    }

    if (
      snapshot.dominantImbalance.key ===
      "기물 활동성" &&
      ["n","b","r"].includes(
        piece.type
      )
    ) {
      score += 1;
    }

    if (
      snapshot.dominantImbalance.key ===
      "공간" &&
      piece.type === "p" &&
      isOpponentHalf(
        move.to,
        side
      )
    ) {
      score += 0.7;
    }

    if (
      snapshot.dominantImbalance.key ===
      "개발" &&
      ["n","b"].includes(
        piece.type
      )
    ) {
      score += 1;
    }

    if (
      snapshot.dominantImbalance.key ===
      "킹 안전" &&
      piece.type === "k"
    ) {
      score -= 0.3;
    }

    candidates.push({
      uci:
        `${move.from}${move.to}${move.promotion || ""}`,
      san: move.san,
      heuristic: score
    });
  }

  return candidates
    .sort(
      (a,b) =>
        b.heuristic -
        a.heuristic
    )
    .slice(0, 8);
}



/* =========================================================
   SNAPSHOT
   ========================================================= */

function createSnapshot(
  chess,
  ply
) {
  const material =
    analyzeMaterial(
      chess
    );

  const minorPieces =
    analyzeMinorPieces(
      chess
    );

  const pawnStructure =
    analyzePawnStructure(
      chess
    );

  const weakSquares =
    analyzeWeakSquares(
      chess
    );

  const space =
    analyzeSpace(
      chess
    );

  const center =
    analyzeCenter(
      chess
    );

  const openFiles =
    analyzeOpenFiles(
      chess
    );

  const kingSafety =
    analyzeKingSafety(
      chess
    );

  const development =
    analyzeDevelopment(
      chess
    );

  const initiative =
    analyzeInitiative(
      chess,
      minorPieces,
      kingSafety,
      openFiles
    );

  const snapshot = {
    phase:
      getGamePhase(
        chess,
        ply
      ),

    material,
    minorPieces,
    pawnStructure,
    weakSquares,
    space,
    center,
    openFiles,
    kingSafety,
    development,
    initiative,

    dominantImbalance: null,
    sideOfBoard: null,
    counterplay: null,
    preventivePlan: null,
    fantasyPosition: null,
    candidates: []
  };

  snapshot.dominantImbalance =
    dominantImbalance(
      snapshot
    );

  snapshot.sideOfBoard =
    snapshot.dominantImbalance.side;

  snapshot.counterplay =
    findCounterplay(
      chess,
      snapshot.sideOfBoard ||
      chess.turn()
    );

  snapshot.preventivePlan =
    snapshot.counterplay.text;

  snapshot.fantasyPosition =
    fantasyPlan(
      snapshot,
      snapshot.sideOfBoard ||
      chess.turn()
    );

  snapshot.candidates =
    buildCandidates(
      chess,
      snapshot
    );

  return snapshot;
}



/* =========================================================
   ENGINE
   ========================================================= */

function setEngineStatus(
  text,
  state = ""
) {
  els.engineStatus.textContent =
    text;

  els.engineStatus.className =
    `status ${state}`;
}

function initEngine() {
  try {
    engine =
      new Worker(
        STOCKFISH_PATH
      );

    engine.onmessage =
      handleEngineMessage;

    engine.onerror = () => {
      engineReady = false;
      engineBusy = false;

      setEngineStatus(
        "엔진 오류",
        "error"
      );
    };

    engine.postMessage(
      "uci"
    );

  } catch (error) {
    console.error(error);

    setEngineStatus(
      "엔진을 불러오지 못했습니다.",
      "error"
    );
  }
}

function handleEngineMessage(
  event
) {
  const message =
    String(
      event.data || ""
    );

  if (
    message === "uciok"
  ) {
    engine.postMessage(
      "setoption name MultiPV value 3"
    );

    engine.postMessage(
      "isready"
    );

    return;
  }

  if (
    message === "readyok"
  ) {
    engineReady = true;

    setEngineStatus(
      "Stockfish 준비 완료",
      "ready"
    );

    return;
  }

  if (
    message.startsWith("info")
  ) {
    const depthMatch =
      message.match(
        /\bdepth\s+(\d+)/
      );

    const multiPVMatch =
      message.match(
        /\bmultipv\s+(\d+)/
      );

    const scoreMatch =
      message.match(
        /\bscore\s+(cp|mate)\s+(-?\d+)/
      );

    const pvMatch =
      message.match(
        /\bpv\s+(.+)$/
      );

    const depth =
      depthMatch
        ? Number(
            depthMatch[1]
          )
        : 0;

    const index =
      multiPVMatch
        ? Number(
            multiPVMatch[1]
          )
        : 1;

    let score = null;

    if (scoreMatch) {
      score = {
        type:
          scoreMatch[1],

        value:
          Number(
            scoreMatch[2]
          )
      };
    }

    engineLines[index - 1] = {
      depth,
      score,
      pv:
        pvMatch
          ? pvMatch[1]
              .trim()
              .split(/\s+/)
          : []
    };

    currentDepth =
      Math.max(
        currentDepth,
        depth
      );

    if (els.depthValue) {
      els.depthValue.textContent =
        currentDepth
          ? `d${currentDepth}`
          : "—";
    }

    return;
  }

  if (
    message.startsWith(
      "bestmove"
    )
  ) {
    engineBusy = false;

    const resolver =
      engineResolve;

    engineResolve = null;

    if (resolver) {
      resolver(
        engineLines.filter(
          Boolean
        )
      );
    }
  }
}

function analyzeWithEngine(
  fen,
  depth = 12
) {
  return new Promise(
    resolve => {

      if (
        !engineReady ||
        !engine
      ) {
        resolve([]);
        return;
      }

      if (engineResolve) {
        const oldResolver =
          engineResolve;

        engineResolve = null;

        oldResolver([]);
      }

      engineBusy = true;
      engineLines = [];
      currentDepth = 0;
      engineResolve = resolve;

      engine.postMessage(
        "stop"
      );

      engine.postMessage(
        `position fen ${fen}`
      );

      engine.postMessage(
        `go depth ${depth}`
      );
    }
  );
}



/* =========================================================
   ENGINE SCORE
   ========================================================= */

function evaluateScore(
  score,
  fen
) {
  if (!score) {
    return null;
  }

  const sideToMove =
    fen.split(" ")[1];

  const sign =
    sideToMove === "w"
      ? 1
      : -1;

  if (
    score.type === "mate"
  ) {
    return (
      sign *
      (
        score.value > 0
          ? 100000
          : -100000
      )
    );
  }

  return (
    sign *
    (
      score.value / 100
    )
  );
}

function formatWhiteScore(
  score,
  fen
) {
  const value =
    evaluateScore(
      score,
      fen
    );

  if (value === null) {
    return "—";
  }

  if (
    Math.abs(value) >= 99999
  ) {
    return value > 0
      ? "#"
      : "#-";
  }

  if (
    Math.abs(value) < 0.005
  ) {
    return "0.00";
  }

  return value > 0
    ? `+${value.toFixed(2)}`
    : value.toFixed(2);
}



/* =========================================================
   EVALUATION LANGUAGE
   ========================================================= */

function evalLanguage(
  lines,
  fen,
  snapshot
) {
  if (
    !lines ||
    !lines.length
  ) {
    return "현재 포지션을 분석하고 있습니다.";
  }

  const score =
    evaluateScore(
      lines[0].score,
      fen
    );

  if (score === null) {
    return "현재 포지션을 분석하고 있습니다.";
  }

  const absolute =
    Math.abs(score);

  let text;

  if (absolute < 0.3) {
    text =
      "현재 포지션은 대체로 균형에 가깝습니다.";
  }

  else if (absolute < 1) {
    text =
      score > 0
        ? "백이 약간 더 편안한 포지션입니다."
        : "흑이 약간 더 편안한 포지션입니다.";
  }

  else if (absolute < 2) {
    text =
      score > 0
        ? "백에게 분명한 우세가 있습니다."
        : "흑에게 분명한 우세가 있습니다.";
  }

  else if (absolute < 4) {
    text =
      score > 0
        ? "백이 상당한 우세를 가지고 있습니다."
        : "흑이 상당한 우세를 가지고 있습니다.";
  }

  else {
    text =
      score > 0
        ? "백 쪽으로 평가가 크게 기울어 있습니다."
        : "흑 쪽으로 평가가 크게 기울어 있습니다.";
  }

  if (
    snapshot &&
    snapshot.dominantImbalance &&
    snapshot.dominantImbalance.key !== "균형"
  ) {
    text +=
      ` 현재 가장 중요한 요소는 ${snapshot.dominantImbalance.key}입니다.`;
  }

  return text;
}



/* =========================================================
   PV / CANDIDATES
   ========================================================= */

function pvText(pv) {
  return (
    pv &&
    pv.length
  )
    ? pv.slice(0,5).join(" ")
    : "—";
}

function classifyCandidates(
  lines,
  snapshot,
  fen
) {
  return lines
    .slice(0,3)
    .map(
      (line, index) => {

        let category =
          "전략적 대안";

        if (index === 0) {
          category =
            "엔진 최선";
        }

        else if (
          snapshot.dominantImbalance.key ===
          "킹 안전"
        ) {
          category =
            "실전적 대안";
        }

        else if (
          snapshot.dominantImbalance.key ===
          "균형" &&
          index === 2
        ) {
          category =
            "다른 계획";
        }

        return {
          ...line,
          category,
          scoreWhite:
            evaluateScore(
              line.score,
              fen
            ),
          first:
            line.pv?.[0] || ""
        };
      }
    );
}



/* =========================================================
   HUMAN FACTORS
   ========================================================= */

function factor(
  title,
  text
) {
  return {
    title,
    text
  };
}

function renderFactors(
  snapshot
) {
  const items = [];

  items.push(
    factor(
      "게임 단계",
      `현재 ${snapshot.phase}입니다.`
    )
  );

  items.push(
    factor(
      "기물의 개수",
      snapshot.material.text
    )
  );

  if (
    snapshot.dominantImbalance.key !==
    "균형"
  ) {
    items.push(
      factor(
        "현재 가장 중요한 불균형",
        `${snapshot.dominantImbalance.reason}${
          snapshot.dominantImbalance.side
            ? ` 현재는 ${colorName(snapshot.dominantImbalance.side)} 쪽의 장점으로 연결됩니다.`
            : ""
        }`
      )
    );
  }

  /*
   * Minor pieces
   */

  for (
    const color
    of ["w","b"]
  ) {
    for (
      const bishop
      of snapshot.minorPieces[color].bishops
    ) {
      items.push(
        factor(
          `${colorName(color)} ${bishop.square} · ${bishop.label}`,
          `${bishop.explanation} ${bishop.improvement}`
        )
      );
    }

    for (
      const knight
      of snapshot.minorPieces[color].knights
    ) {
      items.push(
        factor(
          `${colorName(color)} ${knight.square} · ${knight.label}`,
          `${knight.explanation} ${knight.improvement}`
        )
      );
    }
  }

  /*
   * Pawn structure
   */

  items.push(
    factor(
      "폰 구조",
      snapshot.pawnStructure.text
    )
  );

  /*
   * Weak squares
   */

  items.push(
    factor(
      "약한 칸",
      snapshot.weakSquares.summary
    )
  );

  /*
   * Space
   */

  items.push(
    factor(
      "공간",
      snapshot.space.text
    )
  );

  /*
   * Center
   */

  items.push(
    factor(
      "중앙",
      snapshot.center.text
    )
  );

  /*
   * Open files
   */

  items.push(
    factor(
      "오픈 파일",
      snapshot.openFiles.summary
    )
  );

  /*
   * Development
   */

  items.push(
    factor(
      "개발",
      snapshot.development.text
    )
  );

  /*
   * King safety
   */

  items.push(
    factor(
      "킹 안전",
      snapshot.kingSafety.text
    )
  );

  /*
   * Initiative
   */

  items.push(
    factor(
      "주도권",
      snapshot.initiative.text
    )
  );

  /*
   * Counterplay
   */

  items.push(
    factor(
      "상대의 반격",
      snapshot.counterplay.text
    )
  );

  /*
   * Preventive medicine
   */

  items.push(
    factor(
      "예방적 사고",
      `좋은 계획을 실행하기 전에 ${snapshot.counterplay.text}을 먼저 확인합니다.`
    )
  );

  /*
   * Fantasy position
   */

  items.push(
    factor(
      "이상적인 포지션",
      snapshot.fantasyPosition
    )
  );

  /*
   * Thinking technique
   */

  items.push(
    factor(
      "생각의 순서",
      "불균형을 찾고 → 상대의 반격을 확인하고 → 원하는 포지션을 그린 뒤 → 후보 수를 만들고 → 엔진으로 검증합니다."
    )
  );

  els.humanFactors.innerHTML = "";

  for (
    const item
    of items
  ) {
    const element =
      document.createElement(
        "div"
      );

    element.className =
      "factor";

    element.innerHTML =
      `<strong>${item.title}</strong>
       <p>${item.text}</p>`;

    els.humanFactors.appendChild(
      element
    );
  }
}



/* =========================================================
   BOARD
   ========================================================= */

function renderBoard(fen) {
  const chess =
    new Chess(fen);

  const board =
    chess.board();

  els.board.innerHTML = "";

  for (
    let row = 0;
    row < 8;
    row++
  ) {
    for (
      let column = 0;
      column < 8;
      column++
    ) {
      const square =
        `${FILES[column]}${8 - row}`;

      const piece =
        board[row][column];

      const element =
        document.createElement(
          "div"
        );

      element.className =
        `sq ${squareColor(square)}`;

      if (piece) {
        element.textContent =
          pieceSymbol(
            piece.color,
            piece.type
          );
      }

      els.board.appendChild(
        element
      );
    }
  }
}



/* =========================================================
   GAME POSITIONS
   ========================================================= */

function buildPositions(
  chess
) {
  const history =
    chess.history({
      verbose: true
    });

  const replay =
    new Chess();

  const result = [
    {
      ply: 0,
      fen: replay.fen(),
      move: null,
      san: null
    }
  ];

  for (
    let i = 0;
    i < history.length;
    i++
  ) {
    const move =
      history[i];

    replay.move({
      from: move.from,
      to: move.to,
      promotion:
        move.promotion
    });

    result.push({
      ply: i + 1,
      fen: replay.fen(),
      move,
      san: move.san
    });
  }

  return result;
}



/* =========================================================
   MOVE LIST
   ========================================================= */

function renderMoveList() {
  els.moveList.innerHTML = "";

  const moves =
    positions.slice(1);

  for (
    let i = 0;
    i < moves.length;
    i += 2
  ) {
    const row =
      document.createElement(
        "div"
      );

    row.className =
      "moveRow";

    const number =
      document.createElement(
        "span"
      );

    number.className =
      "moveNumber";

    number.textContent =
      `${Math.floor(i / 2) + 1}.`;

    row.appendChild(
      number
    );

    for (
      const position
      of [moves[i], moves[i + 1]]
    ) {
      const button =
        document.createElement(
          "button"
        );

      button.className =
        "moveButton";

      button.textContent =
        position?.san || "";

      if (position) {
        button.dataset.ply =
          position.ply;
      }

      row.appendChild(
        button
      );
    }

    els.moveList.appendChild(
      row
    );
  }

  els.moveList
    .querySelectorAll(
      ".moveButton"
    )
    .forEach(button => {

      button.addEventListener(
        "click",
        () => {
          goToPly(
            Number(
              button.dataset.ply
            )
          );
        }
      );

    });
}



/* =========================================================
   ANALYSIS
   ========================================================= */

async function analyzeCurrentPosition() {
  if (
    !positions[currentPly]
  ) {
    return;
  }

  const token =
    ++analysisToken;

  const position =
    positions[currentPly];

  const chess =
    new Chess(
      position.fen
    );

  currentSnapshot =
    createSnapshot(
      chess,
      currentPly
    );

  renderBoard(
    position.fen
  );

  els.moveLabel.textContent =
    `${currentPly} / ${totalPlies}`;

  els.positionLabel.textContent =
    currentPly === 0
      ? "시작 포지션"
      : `${Math.ceil(currentPly / 2)}. ${
          currentPly % 2
            ? "백"
            : "흑"
        }의 수 이후`;

  renderFactors(
    currentSnapshot
  );

  els.positionInsight.textContent =
    "현재 포지션을 분석하고 있습니다.";

  setProgress(10);

  const lines =
    await analyzeWithEngine(
      position.fen,
      12
    );

  /*
   * 오래 걸린 이전 분석 결과가
   * 새로운 포지션을 덮어쓰지 않게 한다.
   */

  if (
    token !== analysisToken
  ) {
    return;
  }

  renderEvaluation(
    lines,
    position.fen
  );

  renderCandidates(
    lines,
    position.fen,
    currentSnapshot
  );

  els.positionInsight.textContent =
    evalLanguage(
      lines,
      position.fen,
      currentSnapshot
    );

  setProgress(100);
}



/* =========================================================
   ENGINE RESULT RENDER
   ========================================================= */

function renderEvaluation(
  lines,
  fen
) {
  if (
    !lines.length
  ) {
    els.evalValue.textContent =
      "—";

    els.depthValue.textContent =
      "—";

    return;
  }

  els.evalValue.textContent =
    formatWhiteScore(
      lines[0].score,
      fen
    );

  els.depthValue.textContent =
    lines[0].depth
      ? `d${lines[0].depth}`
      : "—";
}

function renderCandidates(
  lines,
  fen,
  snapshot
) {
  els.candidateList.innerHTML =
    "";

  if (
    !lines.length
  ) {
    els.candidateList.innerHTML =
      `<div class="candidate">
        <strong>분석 중</strong>
        <span>엔진이 후보 수를 계산하고 있습니다.</span>
      </div>`;

    return;
  }

  const items =
    classifyCandidates(
      lines,
      snapshot,
      fen
    );

  items.forEach(
    item => {

      const element =
        document.createElement(
          "div"
        );

      element.className =
        "candidate";

      element.innerHTML =
        `<div>
          <strong>${item.category}</strong>
          <span>${pvText(item.pv)}</span>
        </div>
        <b>${formatWhiteScore(
          item.score,
          fen
        )}</b>`;

      els.candidateList.appendChild(
        element
      );
    }
  );
}



/* =========================================================
   ERROR
   ========================================================= */

function showError(
  message
) {
  els.errorBox.hidden =
    false;

  els.errorBox.textContent =
    message;
}

function clearError() {
  els.errorBox.hidden =
    true;

  els.errorBox.textContent =
    "";
}



/* =========================================================
   PGN
   ========================================================= */

function analyzePGN() {
  clearError();

  const pgn =
    els.pgnInput.value.trim();

  if (!pgn) {
    showError(
      "PGN을 입력해주세요."
    );

    return;
  }

  const parsed =
    new Chess();

  try {
    parsed.loadPgn(
      pgn
    );
  } catch (error) {
    console.error(error);

    showError(
      "PGN을 읽지 못했습니다. 수순이나 PGN 형식을 확인해주세요."
    );

    return;
  }

  game = parsed;

  positions =
    buildPositions(
      game
    );

  totalPlies =
    positions.length - 1;

  currentPly = 0;

  els.inputView.hidden =
    true;

  els.analysisView.hidden =
    false;

  els.gameMeta.textContent =
    `${totalPlies}수`;

  renderMoveList();

  analyzeCurrentPosition();
}



/* =========================================================
   NAVIGATION
   ========================================================= */

function goToPly(
  ply
) {
  currentPly =
    clamp(
      ply,
      0,
      totalPlies
    );

  analyzeCurrentPosition();
}



/* =========================================================
   EVENTS
   ========================================================= */

els.exampleBtn.addEventListener(
  "click",
  () => {
    els.pgnInput.value =
      EXAMPLE_PGN;

    clearError();
  }
);

els.analyzeBtn.addEventListener(
  "click",
  analyzePGN
);

els.firstBtn.addEventListener(
  "click",
  () =>
    goToPly(0)
);

els.prevBtn.addEventListener(
  "click",
  () =>
    goToPly(
      currentPly - 1
    )
);

els.nextBtn.addEventListener(
  "click",
  () =>
    goToPly(
      currentPly + 1
    )
);

els.lastBtn.addEventListener(
  "click",
  () =>
    goToPly(
      totalPlies
    )
);

els.backBtn.addEventListener(
  "click",
  () => {
    analysisToken++;

    els.analysisView.hidden =
      true;

    els.inputView.hidden =
      false;

    clearError();
  }
);



/* =========================================================
   START
   ========================================================= */

setEngineStatus(
  "엔진 준비 중…",
  "loading"
);

initEngine();
