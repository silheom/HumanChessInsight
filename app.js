import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

/* =========================================================
   Human Chess Insight
   Complete app.js
   ========================================================= */

const STOCKFISH_PATH = "./stockfish-19-lite-single.js";

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

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = [1, 2, 3, 4, 5, 6, 7, 8];

const PIECE_VALUES = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0
};

const STARTING_SQUARES = {
  w: {
    k: ["e1"],
    q: ["d1"],
    r: ["a1", "h1"],
    b: ["c1", "f1"],
    n: ["b1", "g1"],
    p: []
  },
  b: {
    k: ["e8"],
    q: ["d8"],
    r: ["a8", "h8"],
    b: ["c8", "f8"],
    n: ["b8", "g8"],
    p: []
  }
};

const CENTER_SQUARES = ["d4", "e4", "d5", "e5"];

const state = {
  game: null,
  headers: {},
  history: [],
  positions: [],
  currentPly: 0,

  analysisToken: 0,

  snapshotCache: new Map(),
  engineCache: new Map(),

  currentAnalysis: null,

  engine: null,
  engineReady: false,
  engineReadyPromise: null,
  engineReadyResolve: null,
  engineReadyReject: null,

  activeEngineRequest: null,
  engineRequestId: 0,

  criticalResults: null,
  criticalRunning: false
};


/* =========================================================
   DOM
   ========================================================= */

const $ = (id) => document.getElementById(id);

const inputView = $("inputView");
const analysisView = $("analysisView");

const pgnInput = $("pgnInput");
const analyzeBtn = $("analyzeBtn");
const exampleBtn = $("exampleBtn");
const errorBox = $("errorBox");

const engineStatus = $("engineStatus");

const board = $("board");
const positionLabel = $("positionLabel");
const moveLabel = $("moveLabel");
const gameMeta = $("gameMeta");
const moveList = $("moveList");

const firstBtn = $("firstBtn");
const prevBtn = $("prevBtn");
const nextBtn = $("nextBtn");
const lastBtn = $("lastBtn");
const backBtn = $("backBtn");

const evalValue = $("evalValue");
const depthValue = $("depthValue");
const progressBar = $("progressBar");
const positionInsight = $("positionInsight");
const candidateList = $("candidateList");
const humanFactors = $("humanFactors");


/* =========================================================
   Basic helpers
   ========================================================= */

function opposite(color) {
  return color === "w" ? "b" : "w";
}

function sideName(color) {
  return color === "w" ? "백" : "흑";
}

function pieceName(type) {
  const names = {
    p: "폰",
    n: "나이트",
    b: "비숍",
    r: "룩",
    q: "퀸",
    k: "킹"
  };

  return names[type] || type;
}

function squareFile(square) {
  return square.charCodeAt(0) - 97;
}

function squareRank(square) {
  return Number(square[1]);
}

function makeSquare(file, rank) {
  if (file < 0 || file > 7 || rank < 1 || rank > 8) {
    return null;
  }

  return `${FILES[file]}${rank}`;
}

function fileName(fileIndex) {
  return FILES[fileIndex] || "?";
}

function formatNumber(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function moveToUci(move) {
  if (!move) return "";
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function uciToObject(uci) {
  if (!uci || uci.length < 4) return null;

  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci.length >= 5 ? { promotion: uci[4] } : {})
  };
}

function getPiece(chess, square) {
  return chess.get(square);
}

function getAllPieces(chess, color = null) {
  const result = [];

  for (const rank of RANKS) {
    for (const file of FILES) {
      const square = `${file}${rank}`;
      const piece = chess.get(square);

      if (!piece) continue;
      if (color && piece.color !== color) continue;

      result.push({
        square,
        ...piece
      });
    }
  }

  return result;
}

function getPiecesByType(chess, color, type) {
  return getAllPieces(chess, color).filter((p) => p.type === type);
}

function getKingSquare(chess, color) {
  const king = getPiecesByType(chess, color, "k")[0];
  return king ? king.square : null;
}

function getPawnSquares(chess, color) {
  return getPiecesByType(chess, color, "p").map((p) => p.square);
}

function sideScoreFromWhitePerspective(value, color) {
  return color === "w" ? value : -value;
}


/* =========================================================
   FEN / arbitrary side helpers
   ========================================================= */

function fenWithSideToMove(fen, color) {
  const parts = fen.split(/\s+/);

  if (parts.length < 6) {
    return fen;
  }

  parts[1] = color;
  return parts.join(" ");
}

function cloneForSide(chess, color) {
  return new Chess(fenWithSideToMove(chess.fen(), color));
}

function getLegalMovesForSide(chess, color) {
  try {
    const clone = cloneForSide(chess, color);
    return clone.moves({ verbose: true });
  } catch {
    return [];
  }
}

function getLegalMovesForPiece(chess, color, square) {
  try {
    const clone = cloneForSide(chess, color);
    return clone.moves({
      square,
      verbose: true
    });
  } catch {
    return [];
  }
}


/* =========================================================
   Attack map
   ========================================================= */

function isSquareAttackedByPawn(chess, targetSquare, byColor) {
  const file = squareFile(targetSquare);
  const rank = squareRank(targetSquare);

  const sourceRank = byColor === "w"
    ? rank - 1
    : rank + 1;

  if (sourceRank < 1 || sourceRank > 8) {
    return false;
  }

  for (const df of [-1, 1]) {
    const sourceFile = file + df;

    if (sourceFile < 0 || sourceFile > 7) {
      continue;
    }

    const source = makeSquare(sourceFile, sourceRank);
    const piece = source ? chess.get(source) : null;

    if (
      piece &&
      piece.color === byColor &&
      piece.type === "p"
    ) {
      return true;
    }
  }

  return false;
}

function isSquareAttackedByKnight(chess, targetSquare, byColor) {
  const file = squareFile(targetSquare);
  const rank = squareRank(targetSquare);

  const offsets = [
    [1, 2],
    [2, 1],
    [2, -1],
    [1, -2],
    [-1, -2],
    [-2, -1],
    [-2, 1],
    [-1, 2]
  ];

  for (const [df, dr] of offsets) {
    const source = makeSquare(file + df, rank + dr);
    if (!source) continue;

    const piece = chess.get(source);

    if (
      piece &&
      piece.color === byColor &&
      piece.type === "n"
    ) {
      return true;
    }
  }

  return false;
}

function isSquareAttackedByKing(chess, targetSquare, byColor) {
  const file = squareFile(targetSquare);
  const rank = squareRank(targetSquare);

  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;

      const source = makeSquare(file + df, rank + dr);
      if (!source) continue;

      const piece = chess.get(source);

      if (
        piece &&
        piece.color === byColor &&
        piece.type === "k"
      ) {
        return true;
      }
    }
  }

  return false;
}

function scanSliderAttack(
  chess,
  targetSquare,
  byColor,
  directions,
  allowedTypes
) {
  const file = squareFile(targetSquare);
  const rank = squareRank(targetSquare);

  for (const [df, dr] of directions) {
    let f = file + df;
    let r = rank + dr;

    while (f >= 0 && f <= 7 && r >= 1 && r <= 8) {
      const square = makeSquare(f, r);
      const piece = chess.get(square);

      if (piece) {
        if (
          piece.color === byColor &&
          allowedTypes.includes(piece.type)
        ) {
          return true;
        }

        break;
      }

      f += df;
      r += dr;
    }
  }

  return false;
}

function isSquareAttackedBySide(chess, square, color) {
  if (isSquareAttackedByPawn(chess, square, color)) {
    return true;
  }

  if (isSquareAttackedByKnight(chess, square, color)) {
    return true;
  }

  if (isSquareAttackedByKing(chess, square, color)) {
    return true;
  }

  if (
    scanSliderAttack(
      chess,
      square,
      color,
      [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1]
      ],
      ["b", "q"]
    )
  ) {
    return true;
  }

  if (
    scanSliderAttack(
      chess,
      square,
      color,
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1]
      ],
      ["r", "q"]
    )
  ) {
    return true;
  }

  return false;
}

function countAttacksBySide(chess, square, color) {
  let count = 0;

  if (isSquareAttackedByPawn(chess, square, color)) count++;
  if (isSquareAttackedByKnight(chess, square, color)) count++;
  if (isSquareAttackedByKing(chess, square, color)) count++;

  if (
    scanSliderAttack(
      chess,
      square,
      color,
      [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1]
      ],
      ["b", "q"]
    )
  ) {
    count++;
  }

  if (
    scanSliderAttack(
      chess,
      square,
      color,
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1]
      ],
      ["r", "q"]
    )
  ) {
    count++;
  }

  return count;
}


/* =========================================================
   Outpost / support
   ========================================================= */

function isSquareInOpponentHalf(square, color) {
  const rank = squareRank(square);

  if (color === "w") {
    return rank >= 5;
  }

  return rank <= 4;
}

function isSupportedBySide(chess, square, color) {
  return isSquareAttackedBySide(chess, square, color);
}

function isStableOutpost(chess, square, color) {
  if (!isSquareInOpponentHalf(square, color)) {
    return false;
  }

  const piece = chess.get(square);

  if (piece && piece.color !== color) {
    return false;
  }

  const enemy = opposite(color);

  if (isSquareAttackedByPawn(chess, square, enemy)) {
    return false;
  }

  if (!isSupportedBySide(chess, square, color)) {
    return false;
  }

  return true;
}

function findKnightOutpostCandidates(chess, color, square = null) {
  const knights = square
    ? getPiecesByType(chess, color, "n").filter((p) => p.square === square)
    : getPiecesByType(chess, color, "n");

  const candidates = [];

  for (const knight of knights) {
    const moves = getLegalMovesForPiece(
      chess,
      color,
      knight.square
    );

    for (const move of moves) {
      const targetPiece = chess.get(move.to);

      if (targetPiece) {
        continue;
      }

      if (
        isStableOutpost(
          chess,
          move.to,
          color
        )
      ) {
        candidates.push(move.to);
      }
    }
  }

  return [...new Set(candidates)];
}


/* =========================================================
   Bishop analysis
   ========================================================= */

function getBishopInfo(chess, square, color) {
  const file = squareFile(square);
  const rank = squareRank(square);

  const directions = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
  ];

  let mobility = 0;
  let maxRay = 0;

  const friendlyBlockers = [];
  const enemyBlockers = [];
  const enemyTargets = [];

  for (const [df, dr] of directions) {
    let f = file + df;
    let r = rank + dr;
    let ray = 0;

    while (f >= 0 && f <= 7 && r >= 1 && r <= 8) {
      const target = makeSquare(f, r);
      const piece = chess.get(target);

      if (!piece) {
        mobility++;
        ray++;
      } else {
        if (piece.color === color) {
          friendlyBlockers.push(target);
        } else {
          enemyBlockers.push(target);
          enemyTargets.push(target);
          mobility++;
          ray++;
        }

        break;
      }

      f += df;
      r += dr;
    }

    maxRay = Math.max(maxRay, ray);
  }

  return {
    mobility,
    maxRay,
    friendlyBlockers,
    enemyBlockers,
    enemyTargets
  };
}

function isBishopOnLightSquare(square) {
  return (
    (squareFile(square) + squareRank(square)) % 2 === 0
  );
}

function countSameColorCentralPawns(chess, color, bishopSquare) {
  const bishopColor = isBishopOnLightSquare(bishopSquare);
  let count = 0;

  for (const pawn of getPiecesByType(chess, color, "p")) {
    const pawnColor = isBishopOnLightSquare(pawn.square);

    if (pawnColor !== bishopColor) continue;

    const file = squareFile(pawn.square);
    const rank = squareRank(pawn.square);

    if (file >= 2 && file <= 5 && rank >= 2 && rank <= 7) {
      count++;
    }
  }

  return count;
}


/* =========================================================
   Knight analysis
   ========================================================= */

function getKnightInfo(chess, square, color) {
  const moves = getLegalMovesForPiece(chess, color, square);

  let captures = 0;

  for (const move of moves) {
    if (move.captured) {
      captures++;
    }
  }

  const outposts = findKnightOutpostCandidates(
    chess,
    color,
    square
  );

  const currentlyStable =
    isStableOutpost(chess, square, color);

  return {
    mobility: moves.length,
    captures,
    outposts,
    currentlyStable
  };
}


/* =========================================================
   Minor piece analysis
   ========================================================= */

function analyzeMinorPieces(chess, phase) {
  const pieces = [];
  const activity = {
    w: 0,
    b: 0
  };

  for (const color of ["w", "b"]) {
    const minors = getAllPieces(chess, color)
      .filter((p) => p.type === "b" || p.type === "n");

    for (const piece of minors) {
      let label = "";
      let description = "";
      let score = 0;

      if (piece.type === "b") {
        const info = getBishopInfo(
          chess,
          piece.square,
          color
        );

        const centralOwnPawns =
          countSameColorCentralPawns(
            chess,
            color,
            piece.square
          );

        const trulyBad =
          phase !== "opening" &&
          centralOwnPawns >= 2 &&
          info.mobility <= 4 &&
          info.enemyTargets.length === 0;

        if (trulyBad) {
          label = "나쁜 비숍";
        } else if (
          info.mobility <= 2 ||
          info.friendlyBlockers.length >= 2
        ) {
          label = "활동이 제한된 비숍";
        } else if (
          info.mobility >= 6 ||
          info.enemyTargets.length >= 1
        ) {
          label = "활동적인 비숍";
        } else {
          label = "활동을 개선할 필요가 있는 비숍";
        }

        const friendlyText =
          info.friendlyBlockers.length
            ? `${info.friendlyBlockers.join(", ")}의 자기 기물`
            : null;

        const enemyText =
          info.enemyBlockers.length
            ? `${info.enemyBlockers.join(", ")}의 상대 기물`
            : null;

        if (friendlyText) {
          description +=
            `${sideName(color)}의 ${piece.square} 비숍은 ` +
            `${friendlyText} 때문에 일부 대각선이 제한됩니다. `;
        }

        if (enemyText) {
          description +=
            `반대쪽으로는 ${enemyText}가 대각선의 진행을 막고 있습니다. `;
        }

        if (!description) {
          description =
            `${sideName(color)}의 ${piece.square} 비숍은 ` +
            `현재 여러 대각선에서 활동할 수 있습니다. `;
        }

        if (info.enemyTargets.length) {
          description +=
            `실제로 영향을 줄 수 있는 상대 기물이나 폰도 ` +
            `${info.enemyTargets.join(", ")}에 있습니다. `;
        }

        if (info.mobility <= 2) {
          description +=
            `현재 활동 범위가 좁으므로 더 좋은 대각선을 확보하는 것이 과제입니다.`;
        } else {
          description +=
            `현재 ${info.mobility}개의 합법적인 이동이 있어 ` +
            `활동을 유지하거나 더 좋은 대각선을 찾을 수 있습니다.`;
        }

        score =
          info.mobility +
          info.enemyTargets.length * 2 +
          Math.min(info.maxRay, 5);

      } else {
        const info = getKnightInfo(
          chess,
          piece.square,
          color
        );

        if (info.currentlyStable) {
          label = "안정적인 전초기지의 나이트";
        } else if (info.mobility >= 5) {
          label = "활동적인 나이트";
        } else if (info.outposts.length) {
          label = "전초기지를 찾을 수 있는 나이트";
        } else if (info.mobility <= 2) {
          label = "활동 범위가 제한된 나이트";
        } else {
          label = "활동을 개선할 필요가 있는 나이트";
        }

        description =
          `${sideName(color)}의 ${piece.square} 나이트는 ` +
          `현재 ${info.mobility}개의 합법적인 이동을 가지고 있습니다. `;

        if (info.currentlyStable) {
          description +=
            `현재 위치가 상대 폰으로 쉽게 쫓겨나지 않고 ` +
            `기물의 지원도 받을 수 있는 안정적인 전초기지에 가깝습니다.`;
        } else if (info.outposts.length) {
          description +=
            `${info.outposts.slice(0, 3).join(", ")} 같은 칸은 ` +
            `상대 폰의 추격을 받지 않으면서 활용할 가능성이 있습니다. ` +
            `단순히 이동 수가 많은 칸보다 실제로 유지할 수 있는 칸을 우선합니다.`;
        } else if (info.mobility <= 2) {
          description +=
            `현재 이동 범위가 제한되어 있으므로 ` +
            `좋은 지원점이나 개선 경로를 찾는 것이 중요합니다.`;
        } else {
          description +=
            `단순히 이동 수를 늘리는 것보다 ` +
            `실제로 유지할 수 있고 상대 진영에 부담을 주는 칸을 찾는 것이 중요합니다.`;
        }

        score =
          info.mobility +
          info.outposts.length * 4 +
          info.captures;
      }

      activity[color] += score;

      pieces.push({
        color,
        square: piece.square,
        type: piece.type,
        label,
        description,
        score
      });
    }
  }

  return {
    pieces,
    activity,
    diff: activity.w - activity.b
  };
}


/* =========================================================
   Material
   ========================================================= */

function analyzeMaterial(chess) {
  const score = {
    w: 0,
    b: 0
  };

  const counts = {
    w: {
      p: 0,
      n: 0,
      b: 0,
      r: 0,
      q: 0
    },
    b: {
      p: 0,
      n: 0,
      b: 0,
      r: 0,
      q: 0
    }
  };

  for (const piece of getAllPieces(chess)) {
    if (piece.type === "k") continue;

    score[piece.color] +=
      PIECE_VALUES[piece.type];

    counts[piece.color][piece.type]++;
  }

  const diff = score.w - score.b;

  return {
    score,
    counts,
    diff,
    advantage:
      Math.abs(diff) < 0.15
        ? null
        : diff > 0
          ? "w"
          : "b"
  };
}


/* =========================================================
   Pawn structure
   ========================================================= */

function analyzePawnStructure(chess, color) {
  const pawns = getPiecesByType(chess, color, "p");

  const files = {};

  for (const file of FILES) {
    files[file] = [];
  }

  for (const pawn of pawns) {
    files[pawn.square[0]].push(pawn.square);
  }

  const doubledFiles = Object.entries(files)
    .filter(([, squares]) => squares.length >= 2)
    .map(([file]) => file);

  const isolated = [];
  const passed = [];
  const backward = [];

  for (const pawn of pawns) {
    const file = squareFile(pawn.square);
    const rank = squareRank(pawn.square);
    const direction = color === "w" ? 1 : -1;

    const adjacentFriendly = [];

    for (const adjacentFile of [file - 1, file + 1]) {
      if (adjacentFile < 0 || adjacentFile > 7) continue;

      const list =
        files[FILES[adjacentFile]] || [];

      for (const sq of list) {
        adjacentFriendly.push(sq);
      }
    }

    if (adjacentFriendly.length === 0) {
      isolated.push(pawn.square);
    }

    let enemyPawnAhead = false;

    for (const enemyPawn of getPawnSquares(
      chess,
      opposite(color)
    )) {
      const ef = squareFile(enemyPawn);
      const er = squareRank(enemyPawn);

      if (Math.abs(ef - file) > 1) {
        continue;
      }

      if (
        color === "w" &&
        er > rank
      ) {
        enemyPawnAhead = true;
        break;
      }

      if (
        color === "b" &&
        er < rank
      ) {
        enemyPawnAhead = true;
        break;
      }
    }

    if (!enemyPawnAhead) {
      passed.push(pawn.square);
    }

    /*
      뒤처진 폰은 매우 보수적으로 판정한다.
      단순히 뒤에 있다는 이유만으로 backward pawn으로 부르지 않는다.
    */

    const friendlyAhead =
      adjacentFriendly.some((sq) => {
        const r = squareRank(sq);

        return color === "w"
          ? r > rank
          : r < rank;
      });

    const frontSquare =
      makeSquare(
        file,
        rank + direction
      );

    if (
      friendlyAhead &&
      frontSquare
    ) {
      const frontOccupied =
        chess.get(frontSquare);

      const enemyControlsFront =
        isSquareAttackedByPawn(
          chess,
          frontSquare,
          opposite(color)
        );

      const friendlySupportsFront =
        isSquareAttackedByPawn(
          chess,
          frontSquare,
          color
        );

      if (
        !frontOccupied &&
        enemyControlsFront &&
        !friendlySupportsFront
      ) {
        backward.push(pawn.square);
      }
    }
  }

  const doubledCount =
    doubledFiles.reduce(
      (sum, file) =>
        sum + Math.max(0, files[file].length - 1),
      0
    );

  const quality =
    passed.length * 1.5
    - isolated.length * 0.9
    - backward.length * 1.0
    - doubledCount * 0.45;

  return {
    pawns,
    files,
    doubledFiles,
    isolated,
    passed,
    backward,
    doubledCount,
    quality
  };
}

function analyzePawnStructures(chess) {
  const white = analyzePawnStructure(chess, "w");
  const black = analyzePawnStructure(chess, "b");

  return {
    w: white,
    b: black,
    diff: white.quality - black.quality
  };
}


/* =========================================================
   Weak squares
   ========================================================= */

function enemyKnightCanReach(chess, square, enemyColor) {
  const knights = getPiecesByType(
    chess,
    enemyColor,
    "n"
  );

  for (const knight of knights) {
    const moves = getLegalMovesForPiece(
      chess,
      enemyColor,
      knight.square
    );

    if (
      moves.some(
        (move) => move.to === square
      )
    ) {
      return true;
    }
  }

  return false;
}

function findWeakSquares(chess, color) {
  const enemy = opposite(color);
  const result = [];

  for (let rank = 3; rank <= 6; rank++) {
    for (let file = 0; file < 8; file++) {
      const square = makeSquare(file, rank);
      if (!square) continue;

      const piece = chess.get(square);

      if (
        piece &&
        piece.color === color
      ) {
        continue;
      }

      /*
        약한 칸의 핵심은
        "내 폰으로 그 칸을 쫓아낼 수 없는가"이다.
      */

      if (
        isSquareAttackedByPawn(
          chess,
          square,
          color
        )
      ) {
        continue;
      }

      if (
        !enemyKnightCanReach(
          chess,
          square,
          enemy
        )
      ) {
        continue;
      }

      let score = 0;

      if (CENTER_SQUARES.includes(square)) {
        score += 5;
      }

      if (
        isSquareInOpponentHalf(
          square,
          enemy
        )
      ) {
        score += 3;
      }

      if (
        isSupportedBySide(
          chess,
          square,
          enemy
        )
      ) {
        score += 2;
      }

      result.push({
        square,
        score
      });
    }
  }

  result.sort(
    (a, b) => b.score - a.score
  );

  return result
    .slice(0, 5)
    .map((item) => item.square);
}

function analyzeWeakSquares(chess) {
  const white = findWeakSquares(chess, "w");
  const black = findWeakSquares(chess, "b");

  return {
    w: white,
    b: black,
    difference: black.length - white.length
  };
}


/* =========================================================
   Space
   ========================================================= */

function analyzeSpaceForSide(chess, color) {
  const enemyHalf = color === "w"
    ? (rank) => rank >= 5
    : (rank) => rank <= 4;

  const territory = new Set();

  for (const pawn of getPiecesByType(
    chess,
    color,
    "p"
  )) {
    const file = squareFile(pawn.square);
    const rank = squareRank(pawn.square);

    const pawnDirection =
      color === "w" ? 1 : -1;

    for (const df of [-1, 1]) {
      const target =
        makeSquare(
          file + df,
          rank + pawnDirection
        );

      if (!target) continue;

      if (
        enemyHalf(
          squareRank(target)
        )
      ) {
        territory.add(target);
      }
    }
  }

  let pieceMobility = 0;

  for (const piece of getAllPieces(chess, color)) {
    if (piece.type === "p" || piece.type === "k") {
      continue;
    }

    const moves =
      getLegalMovesForPiece(
        chess,
        color,
        piece.square
      );

    for (const move of moves) {
      if (
        enemyHalf(
          squareRank(move.to)
        )
      ) {
        pieceMobility++;
      }
    }
  }

  let advancedPawns = 0;

  for (const pawn of getPiecesByType(
    chess,
    color,
    "p"
  )) {
    const rank =
      squareRank(pawn.square);

    if (
      color === "w" &&
      rank >= 4
    ) {
      advancedPawns++;
    }

    if (
      color === "b" &&
      rank <= 5
    ) {
      advancedPawns++;
    }
  }

  return (
    territory.size +
    pieceMobility * 0.25 +
    advancedPawns * 0.5
  );
}

function analyzeSpace(chess) {
  const w =
    analyzeSpaceForSide(chess, "w");

  const b =
    analyzeSpaceForSide(chess, "b");

  return {
    w,
    b,
    diff: w - b
  };
}


/* =========================================================
   Center
   ========================================================= */

function centerInfluence(chess, color) {
  let score = 0;

  for (const square of CENTER_SQUARES) {
    const piece = chess.get(square);

    if (
      piece &&
      piece.color === color
    ) {
      score +=
        piece.type === "p"
          ? 2
          : 1;
    }

    if (
      isSquareAttackedBySide(
        chess,
        square,
        color
      )
    ) {
      score += 1;
    }
  }

  return score;
}

function analyzeCenter(chess) {
  const w = centerInfluence(chess, "w");
  const b = centerInfluence(chess, "b");

  const occupied = CENTER_SQUARES
    .map((square) => {
      const piece = chess.get(square);

      if (!piece) return null;

      return `${square}:${sideName(piece.color)} ${pieceName(piece.type)}`;
    })
    .filter(Boolean);

  return {
    w,
    b,
    diff: w - b,
    occupied
  };
}


/* =========================================================
   Open / semi-open files
   ========================================================= */

function analyzeOpenFiles(chess) {
  const files = [];
  let penetration = {
    w: 0,
    b: 0
  };

  for (const file of FILES) {
    const whitePawns =
      getPiecesByType(chess, "w", "p")
        .filter((p) => p.square[0] === file);

    const blackPawns =
      getPiecesByType(chess, "b", "p")
        .filter((p) => p.square[0] === file);

    const rooks =
      getAllPieces(chess)
        .filter(
          (p) =>
            p.square[0] === file &&
            (p.type === "r" || p.type === "q")
        );

    const open =
      whitePawns.length === 0 &&
      blackPawns.length === 0;

    const semiOpenWhite =
      whitePawns.length === 0 &&
      blackPawns.length > 0;

    const semiOpenBlack =
      blackPawns.length === 0 &&
      whitePawns.length > 0;

    if (
      open ||
      semiOpenWhite ||
      semiOpenBlack
    ) {
      files.push({
        file,
        open,
        semiOpenWhite,
        semiOpenBlack,
        rooks
      });

      for (const piece of rooks) {
        penetration[piece.color] +=
          open ? 2 : 1;
      }
    }
  }

  return {
    files,
    penetration,
    diff:
      penetration.w -
      penetration.b
  };
}


/* =========================================================
   Development
   ========================================================= */

function isPieceOnStartingSquare(
  piece
) {
  const starts =
    STARTING_SQUARES[
      piece.color
    ][piece.type] || [];

  return starts.includes(
    piece.square
  );
}

function developmentScore(
  chess,
  color
) {
  let score = 0;

  for (const type of ["n", "b"]) {
    for (
      const piece of getPiecesByType(
        chess,
        color,
        type
      )
    ) {
      if (
        !isPieceOnStartingSquare(
          piece
        )
      ) {
        score++;
      }
    }
  }

  const kingSquare =
    getKingSquare(
      chess,
      color
    );

  if (
    kingSquare &&
    (
      kingSquare ===
        (color === "w"
          ? "g1"
          : "g8") ||
      kingSquare ===
        (color === "w"
          ? "c1"
          : "c8")
    )
  ) {
    score += 0.5;
  }

  return score;
}

function analyzeDevelopment(chess) {
  const w =
    developmentScore(
      chess,
      "w"
    );

  const b =
    developmentScore(
      chess,
      "b"
    );

  return {
    w,
    b,
    diff: w - b
  };
}


/* =========================================================
   King safety
   ========================================================= */

function pawnShieldScore(
  chess,
  color,
  kingSquare
) {
  if (!kingSquare) {
    return 0;
  }

  const kingFile =
    squareFile(kingSquare);

  const kingRank =
    squareRank(kingSquare);

  const direction =
    color === "w"
      ? 1
      : -1;

  let shield = 0;

  for (const df of [-1, 0, 1]) {
    const file =
      kingFile + df;

    for (const distance of [1, 2]) {
      const rank =
        kingRank +
        direction * distance;

      const square =
        makeSquare(
          file,
          rank
        );

      if (!square) continue;

      const piece =
        chess.get(square);

      if (
        piece &&
        piece.color === color &&
        piece.type === "p"
      ) {
        shield++;
      }
    }
  }

  return shield;
}

function enemyHeavyPieceNearKing(
  chess,
  color,
  kingSquare
) {
  if (!kingSquare) return 0;

  const enemy =
    opposite(color);

  const kf =
    squareFile(kingSquare);

  const kr =
    squareRank(kingSquare);

  let score = 0;

  for (
    const piece of getAllPieces(
      chess,
      enemy
    )
  ) {
    if (
      piece.type !== "q" &&
      piece.type !== "r"
    ) {
      continue;
    }

    const df =
      Math.abs(
        squareFile(
          piece.square
        ) - kf
      );

    const dr =
      Math.abs(
        squareRank(
          piece.square
        ) - kr
      );

    if (
      df <= 3 &&
      dr <= 3
    ) {
      score++;
    }
  }

  return score;
}

function analyzeKingSafetyForSide(
  chess,
  color
) {
  const kingSquare =
    getKingSquare(
      chess,
      color
    );

  if (!kingSquare) {
    return 10;
  }

  const enemy =
    opposite(color);

  let danger = 0;

  if (
    isSquareAttackedBySide(
      chess,
      kingSquare,
      enemy
    )
  ) {
    danger += 4;
  }

  let nearbyPressure = 0;

  const kf =
    squareFile(kingSquare);

  const kr =
    squareRank(kingSquare);

  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (
        df === 0 &&
        dr === 0
      ) {
        continue;
      }

      const square =
        makeSquare(
          kf + df,
          kr + dr
        );

      if (!square) continue;

      if (
        isSquareAttackedBySide(
          chess,
          square,
          enemy
        )
      ) {
        nearbyPressure++;
      }
    }
  }

  danger +=
    nearbyPressure * 0.6;

  const shield =
    pawnShieldScore(
      chess,
      color,
      kingSquare
    );

  danger +=
    Math.max(
      0,
      2 - shield
    ) * 0.8;

  danger +=
    enemyHeavyPieceNearKing(
      chess,
      color,
      kingSquare
    ) * 0.35;

  const castled =
    (
      kingSquare ===
        (color === "w"
          ? "g1"
          : "g8") ||
      kingSquare ===
        (color === "w"
          ? "c1"
          : "c8")
    );

  if (castled) {
    danger -= 0.8;
  }

  return Math.max(
    0,
    danger
  );
}

function analyzeKingSafety(chess) {
  const w =
    analyzeKingSafetyForSide(
      chess,
      "w"
    );

  const b =
    analyzeKingSafetyForSide(
      chess,
      "b"
    );

  return {
    w,
    b,
    diff:
      b - w,
    safer:
      Math.abs(w - b) < 0.75
        ? null
        : w < b
          ? "w"
          : "b"
  };
}


/* =========================================================
   Initiative
   ========================================================= */

function analyzeInitiativeForSide(
  chess,
  color
) {
  const moves =
    getLegalMovesForSide(
      chess,
      color
    );

  let checks = 0;
  let captures = 0;
  let pawnBreaks = 0;

  for (const move of moves) {
    if (
      move.san?.includes("+") ||
      move.san?.includes("#")
    ) {
      checks++;
    }

    if (move.captured) {
      captures++;
    }

    if (
      move.piece === "p"
    ) {
      const fromFile =
        squareFile(move.from);

      const toFile =
        squareFile(move.to);

      const toRank =
        squareRank(move.to);

      if (
        move.captured === "p" ||
        Math.abs(
          toFile - fromFile
        ) === 1 ||
        toRank === 4 ||
        toRank === 5
      ) {
        pawnBreaks++;
      }
    }
  }

  return (
    checks * 3 +
    captures * 0.8 +
    pawnBreaks * 0.6
  );
}

function analyzeInitiative(chess) {
  const w =
    analyzeInitiativeForSide(
      chess,
      "w"
    );

  const b =
    analyzeInitiativeForSide(
      chess,
      "b"
    );

  return {
    w,
    b,
    diff: w - b
  };
}


/* =========================================================
   Game phase
   ========================================================= */

function getGamePhase(chess) {
  const fen =
    chess.fen();

  const parts =
    fen.split(" ");

  const fullmove =
    Number(parts[5] || 1);

  const nonPawnPieces =
    getAllPieces(chess)
      .filter(
        (p) =>
          p.type !== "p" &&
          p.type !== "k"
      );

  const queens =
    getPiecesByType(
      chess,
      "w",
      "q"
    ).length +
    getPiecesByType(
      chess,
      "b",
      "q"
    ).length;

  if (
    fullmove <= 12 &&
    nonPawnPieces.length >= 10
  ) {
    return "opening";
  }

  if (
    queens === 0 &&
    nonPawnPieces.length <= 6
  ) {
    return "endgame";
  }

  return "middlegame";
}

function phaseName(phase) {
  return {
    opening: "오프닝",
    middlegame: "미들게임",
    endgame: "엔드게임"
  }[phase] || "미들게임";
}


/* =========================================================
   Counterplay
   ========================================================= */

function findCounterplay(
  chess,
  color
) {
  const moves =
    getLegalMovesForSide(
      chess,
      color
    );

  const forcing = [];
  const pawnBreaks = [];

  for (const move of moves) {
    if (
      move.san?.includes("+") ||
      move.san?.includes("#")
    ) {
      forcing.push({
        move,
        priority: 5
      });

      continue;
    }

    if (
      move.captured &&
      PIECE_VALUES[
        move.captured
      ] >= 3
    ) {
      forcing.push({
        move,
        priority:
          PIECE_VALUES[
            move.captured
          ]
      });

      continue;
    }

    if (
      move.piece === "p"
    ) {
      const fromFile =
        squareFile(move.from);

      const toFile =
        squareFile(move.to);

      const toRank =
        squareRank(move.to);

      if (
        move.captured === "p" ||
        Math.abs(
          toFile - fromFile
        ) === 1 ||
        toRank === 4 ||
        toRank === 5
      ) {
        pawnBreaks.push(move);
      }
    }
  }

  forcing.sort(
    (a, b) =>
      b.priority -
      a.priority
  );

  return {
    color,
    forcing:
      forcing
        .slice(0, 4)
        .map(
          (item) =>
            item.move.san
        ),
    pawnBreaks:
      pawnBreaks
        .slice(0, 4)
        .map(
          (move) =>
            move.san
        )
  };
}


/* =========================================================
   Dominant imbalance
   ========================================================= */

function determineDominantImbalance(
  snapshot
) {
  const {
    phase,
    material,
    minor,
    pawn,
    weak,
    space,
    center,
    development,
    kingSafety,
    initiative,
    files
  } = snapshot;

  const candidates = [];

  if (
    Math.abs(material.diff) >= 1.5
  ) {
    candidates.push({
      key: "material",
      strength:
        Math.abs(material.diff),
      side:
        material.diff > 0
          ? "w"
          : "b",
      reason:
        `물질적 차이가 ${Math.abs(material.diff).toFixed(1)}점으로 ` +
        `다른 요소보다 직접적인 영향이 큽니다.`
    });
  }

  const activityDiff =
    minor.diff;

  if (
    Math.abs(activityDiff) >= 2
  ) {
    candidates.push({
      key: "activity",
      strength:
        Math.abs(activityDiff) / 2,
      side:
        activityDiff > 0
          ? "w"
          : "b",
      reason:
        `경량 기물의 실제 활동 범위에서 ` +
        `상대적인 차이가 확인됩니다.`
    });
  }

  const pawnDiff =
    pawn.diff;

  if (
    phase === "endgame" &&
    Math.abs(pawnDiff) >= 0.8
  ) {
    candidates.push({
      key: "pawn",
      strength:
        Math.abs(pawnDiff),
      side:
        pawnDiff > 0
          ? "w"
          : "b",
      reason:
        `엔드게임에서는 현재의 폰 구조와 ` +
        `패스드 폰 가능성이 오래 남는 요소가 됩니다.`
    });
  }

  const spaceDiff =
    space.diff;

  if (
    Math.abs(spaceDiff) >= 2.5
  ) {
    candidates.push({
      key: "space",
      strength:
        Math.abs(spaceDiff) / 2,
      side:
        spaceDiff > 0
          ? "w"
          : "b",
      reason:
        `공간 차이가 실제 기물의 이동 범위와 ` +
        `계획 선택에 영향을 줄 정도입니다.`
    });
  }

  const kingDiff =
    kingSafety.diff;

  if (
    Math.abs(kingDiff) >= 1.5
  ) {
    candidates.push({
      key: "kingSafety",
      strength:
        Math.abs(kingDiff),
      side:
        kingDiff > 0
          ? "w"
          : "b",
      reason:
        `킹 주변의 위험도 차이가 있어 ` +
        `다른 계획보다 킹의 안전을 먼저 고려해야 합니다.`
    });
  }

  const devDiff =
    development.diff;

  if (
    phase === "opening" &&
    Math.abs(devDiff) >= 1
  ) {
    candidates.push({
      key: "development",
      strength:
        Math.abs(devDiff) * 1.2,
      side:
        devDiff > 0
          ? "w"
          : "b",
      reason:
        `개발 차이가 존재하고 아직 포지션이 열려 있어 ` +
        `그 우세를 사용할 시간이 제한적입니다.`
    });
  }

  const initiativeDiff =
    initiative.diff;

  if (
    Math.abs(initiativeDiff) >= 2
  ) {
    candidates.push({
      key: "initiative",
      strength:
        Math.abs(initiativeDiff) / 2,
      side:
        initiativeDiff > 0
          ? "w"
          : "b",
      reason:
        `강제 수와 폰 브레이크 가능성에서 ` +
        `한쪽이 상대에게 더 많은 대응을 요구합니다.`
    });
  }

  const centerDiff =
    center.diff;

  if (
    Math.abs(centerDiff) >= 2
  ) {
    candidates.push({
      key: "center",
      strength:
        Math.abs(centerDiff) / 2,
      side:
        centerDiff > 0
          ? "w"
          : "b",
      reason:
        `중앙 통제력 차이가 상대 기물의 활동 범위에 ` +
        `직접 연결될 가능성이 있습니다.`
    });
  }

  const weakDiff =
    weak.difference;

  if (
    Math.abs(weakDiff) >= 2
  ) {
    candidates.push({
      key: "weakSquare",
      strength:
        Math.abs(weakDiff),
      side:
        weakDiff > 0
          ? "w"
          : "b",
      reason:
        `상대가 이용할 수 있는 안정적인 약한 칸의 차이가 있습니다.`
    });
  }

  const fileDiff =
    files.diff;

  if (
    Math.abs(fileDiff) >= 1
  ) {
    candidates.push({
      key: "openFile",
      strength:
        Math.abs(fileDiff),
      side:
        fileDiff > 0
          ? "w"
          : "b",
      reason:
        `오픈 또는 반오픈 파일에서 실제 룩·퀸의 침투 가능성이 차이를 만듭니다.`
    });
  }

  /*
    우선순위는 고정된 가중치 합산이 아니다.
    포지션의 성격에 따라 먼저 확인해야 할 요소를 결정한다.
  */

  if (
    Math.abs(material.diff) >= 2
  ) {
    const candidate =
      candidates.find(
        (c) =>
          c.key === "material"
      );

    if (candidate) {
      return candidate;
    }
  }

  if (
    Math.abs(kingDiff) >= 2.5
  ) {
    const candidate =
      candidates.find(
        (c) =>
          c.key === "kingSafety"
      );

    if (candidate) {
      return candidate;
    }
  }

  if (
    phase === "opening" &&
    Math.abs(devDiff) >= 1.5
  ) {
    const candidate =
      candidates.find(
        (c) =>
          c.key === "development"
      );

    if (candidate) {
      return candidate;
    }
  }

  if (
    Math.abs(initiativeDiff) >= 3 &&
    (
      Math.abs(kingDiff) >= 1 ||
      phase !== "endgame"
    )
  ) {
    const candidate =
      candidates.find(
        (c) =>
          c.key === "initiative"
      );

    if (candidate) {
      return candidate;
    }
  }

  if (
    phase === "endgame" &&
    Math.abs(pawnDiff) >= 1
  ) {
    const candidate =
      candidates.find(
        (c) =>
          c.key === "pawn"
      );

    if (candidate) {
      return candidate;
    }
  }

  if (
    Math.abs(spaceDiff) >= 3 &&
    (
      phase !== "opening" ||
      snapshot.isClosed
    )
  ) {
    const candidate =
      candidates.find(
        (c) =>
          c.key === "space"
      );

    if (candidate) {
      return candidate;
    }
  }

  if (
    Math.abs(activityDiff) >= 2
  ) {
    const candidate =
      candidates.find(
        (c) =>
          c.key === "activity"
      );

    if (candidate) {
      return candidate;
    }
  }

  if (
    candidates.length
  ) {
    return [...candidates]
      .sort(
        (a, b) =>
          b.strength -
          a.strength
      )[0];
  }

  return {
    key: "activity",
    strength: 0,
    side: null,
    reason:
      "물질·킹 안전·공간·구조 중 하나가 결정적으로 앞서지 않으므로 기물 활동성과 개선 경로를 우선 확인합니다."
  };
}


/* =========================================================
   Static / dynamic
   ========================================================= */

function determineStaticDynamic(
  snapshot
) {
  const staticScore =
    Math.abs(
      snapshot.material.diff
    ) +
    Math.abs(
      snapshot.pawn.diff
    ) +
    Math.abs(
      snapshot.space.diff
    ) * 0.4 +
    snapshot.weak.w.length +
    snapshot.weak.b.length;

  const dynamicScore =
    Math.abs(
      snapshot.development.diff
    ) +
    Math.abs(
      snapshot.initiative.diff
    ) +
    Math.abs(
      snapshot.kingSafety.diff
    ) +
    Math.abs(
      snapshot.center.diff
    ) * 0.4;

  if (
    dynamicScore >
    staticScore * 1.2
  ) {
    return {
      type: "dynamic",
      text:
        "현재 우세의 성격이 동적인 요소에 더 가깝습니다.",
      detail:
        "개발·주도권·킹 안전처럼 시간이 지나면 사라질 수 있는 요소가 중요합니다."
    };
  }

  if (
    staticScore >
    dynamicScore * 1.2
  ) {
    return {
      type: "static",
      text:
        "현재 우세의 성격이 정적인 요소에 더 가깝습니다.",
      detail:
        "폰 구조·물질·약한 칸·지속적인 기물 우위처럼 오래 남는 요소가 중요합니다."
    };
  }

  return {
    type: "mixed",
    text:
      "현재 우세는 정적 요소와 동적 요소가 함께 작용합니다.",
    detail:
      "당장의 활동을 유지하면서 그것을 더 오래가는 우세로 바꿀 수 있는지 확인합니다."
  };
}


/* =========================================================
   Closed position
   ========================================================= */

function isPositionClosed(
  chess
) {
  const centerPawns =
    CENTER_SQUARES.filter(
      (square) => {
        const piece =
          chess.get(square);

        return (
          piece &&
          piece.type === "p"
        );
      }
    ).length;

  const openFiles =
    analyzeOpenFiles(
      chess
    ).files.filter(
      (f) => f.open
    ).length;

  return (
    centerPawns >= 3 &&
    openFiles <= 1
  );
}


/* =========================================================
   Full position snapshot
   ========================================================= */

function buildPositionSnapshot(
  fen
) {
  if (
    state.snapshotCache.has(
      fen
    )
  ) {
    return state.snapshotCache.get(
      fen
    );
  }

  const chess =
    new Chess(fen);

  const phase =
    getGamePhase(chess);

  const material =
    analyzeMaterial(chess);

  const minor =
    analyzeMinorPieces(
      chess,
      phase
    );

  const pawn =
    analyzePawnStructures(
      chess
    );

  const weak =
    analyzeWeakSquares(
      chess
    );

  const space =
    analyzeSpace(chess);

  const center =
    analyzeCenter(chess);

  const files =
    analyzeOpenFiles(chess);

  const development =
    analyzeDevelopment(chess);

  const kingSafety =
    analyzeKingSafety(chess);

  const initiative =
    analyzeInitiative(chess);

  const isClosed =
    isPositionClosed(
      chess
    );

  const snapshot = {
    fen,
    turn: chess.turn(),
    phase,
    material,
    minor,
    pawn,
    weak,
    space,
    center,
    files,
    development,
    kingSafety,
    initiative,
    isClosed
  };

  snapshot.dominant =
    determineDominantImbalance(
      snapshot
    );

  snapshot.staticDynamic =
    determineStaticDynamic(
      snapshot
    );

  const currentSide =
    chess.turn();

  const opponent =
    opposite(currentSide);

  snapshot.counterplay =
    findCounterplay(
      chess,
      opponent
    );

  if (
    state.snapshotCache.size > 300
  ) {
    const firstKey =
      state.snapshotCache.keys()
        .next().value;

    if (firstKey) {
      state.snapshotCache.delete(
        firstKey
      );
    }
  }

  state.snapshotCache.set(
    fen,
    snapshot
  );

  return snapshot;
}


/* =========================================================
   Strategic text
   ========================================================= */

function describePawnStructure(
  snapshot
) {
  const lines = [];

  for (const color of ["w", "b"]) {
    const side =
      snapshot.pawn[color];

    const name =
      sideName(color);

    const details = [];

    if (
      side.doubledFiles.length
    ) {
      details.push(
        `중복 폰 ${side.doubledFiles.join(", ")}파일`
      );
    }

    if (
      side.isolated.length
    ) {
      details.push(
        `고립 폰 ${side.isolated.join(", ")}`
      );
    }

    if (
      side.backward.length
    ) {
      details.push(
        `뒤처진 폰 ${side.backward.join(", ")}`
      );
    }

    if (
      side.passed.length
    ) {
      details.push(
        `패스드 폰 ${side.passed.join(", ")}`
      );
    }

    if (details.length) {
      lines.push(
        `${name}: ${details.join(" · ")}`
      );
    } else {
      lines.push(
        `${name}의 폰 구조에서 현재 뚜렷하게 고정된 구조적 약점은 많지 않습니다.`
      );
    }
  }

  return lines.join("<br>");
}

function describeWeakSquares(
  snapshot
) {
  const w =
    snapshot.weak.w.length
      ? snapshot.weak.w.join(", ")
      : "뚜렷하지 않음";

  const b =
    snapshot.weak.b.length
      ? snapshot.weak.b.join(", ")
      : "뚜렷하지 않음";

  return (
    `백이 약한 칸: ${w}<br>` +
    `흑이 약한 칸: ${b}`
  );
}

function describeSpace(
  snapshot
) {
  const diff =
    snapshot.space.diff;

  if (
    Math.abs(diff) < 2
  ) {
    return (
      "공간의 차이가 현재 결정적이지 않습니다. " +
      "공간은 단순히 전진한 폰의 수가 아니라 실제 기물의 활동 범위를 얼마나 넓히는지 함께 봅니다."
    );
  }

  const side =
    diff > 0 ? "w" : "b";

  const other =
    opposite(side);

  return (
    `${sideName(side)}이 더 많은 공간을 확보하고 있습니다. ` +
    `${sideName(side)}은 넓어진 활동 범위를 활용하는 반면, ` +
    `${sideName(other)}은 유리한 교환이나 폰 브레이크로 공간의 압박을 줄이는 방법을 찾는 것이 중요합니다.`
  );
}

function describeCenter(
  snapshot
) {
  if (
    !snapshot.center.occupied.length
  ) {
    return (
      "현재 중앙 네 칸에 직접 놓인 폰이나 기물이 많지 않습니다. " +
      "중앙 통제와 기물의 접근 경로를 함께 봅니다."
    );
  }

  return (
    `중앙에는 ${snapshot.center.occupied.join(", ")}이 있습니다. ` +
    "중앙의 가치는 단순히 점유하고 있는지보다 상대 기물의 활동을 실제로 제한하는지로 판단합니다."
  );
}

function describeOpenFiles(
  snapshot
) {
  if (
    !snapshot.files.files.length
  ) {
    return "완전 오픈 파일이 없습니다.";
  }

  const texts =
    snapshot.files.files.map(
      (item) => {
        if (item.open) {
          if (item.rooks.length) {
            return `${item.file}파일은 오픈되어 있고 룩·퀸의 실제 침투 가능성이 있습니다.`;
          }

          return `${item.file}파일은 오픈되어 있지만 아직 실제 침투가 확인되지는 않습니다.`;
        }

        if (
          item.semiOpenWhite
        ) {
          return `${item.file}파일은 백에게 반오픈되어 있습니다.`;
        }

        if (
          item.semiOpenBlack
        ) {
          return `${item.file}파일은 흑에게 반오픈되어 있습니다.`;
        }

        return null;
      }
    )
    .filter(Boolean);

  return texts.join("<br>");
}

function describeDevelopment(
  snapshot
) {
  const diff =
    snapshot.development.diff;

  if (
    Math.abs(diff) < 0.8
  ) {
    return (
      "양쪽의 개발 차이가 현재 크지 않습니다. " +
      "개발한 기물의 위치가 실제 활동과 계획에 연결되는지를 봅니다."
    );
  }

  const side =
    diff > 0 ? "w" : "b";

  return (
    `${sideName(side)}이 더 많은 경량 기물을 실제 게임에 투입했습니다. ` +
    "다만 개발 우세는 일시적인 요소이므로 그 시간을 이용해 실제 이득이나 더 오래가는 우세로 바꾸는 것이 중요합니다."
  );
}

function describeKingSafety(
  snapshot
) {
  const diff =
    snapshot.kingSafety.diff;

  if (
    Math.abs(diff) < 1
  ) {
    return (
      "양쪽 킹의 안전 차이가 현재 결정적이지 않습니다."
    );
  }

  const safer =
    diff > 0 ? "w" : "b";

  const dangerous =
    opposite(safer);

  return (
    `${sideName(safer)}의 킹이 상대적으로 더 안전합니다. ` +
    `${sideName(dangerous)}은 상대의 체크·침투·희생 가능성을 먼저 확인해야 합니다.`
  );
}

function describeInitiative(
  snapshot
) {
  const diff =
    snapshot.initiative.diff;

  if (
    Math.abs(diff) < 1.5
  ) {
    return (
      "주도권의 차이가 현재 뚜렷하지 않습니다."
    );
  }

  const side =
    diff > 0 ? "w" : "b";

  return (
    `${sideName(side)}이 더 많은 강제 수와 폰 브레이크 가능성을 가지고 있어 ` +
    "상대에게 대응을 요구할 수 있습니다."
  );
}

function buildPreventiveText(
  snapshot
) {
  const counter =
    snapshot.counterplay;

  if (
    counter.forcing.length
  ) {
    return (
      `${sideName(counter.color)}에게 ` +
      `강제적으로 확인해야 할 수 ${counter.forcing.join(", ")}가 있습니다. ` +
      "자신의 계획을 실행하기 전에 이 전술적 반격을 먼저 확인합니다."
    );
  }

  if (
    counter.pawnBreaks.length
  ) {
    return (
      `${sideName(counter.color)}에게 ` +
      `중앙 또는 폰 브레이크 ${counter.pawnBreaks.join(", ")}가 가능합니다. ` +
      "내 계획이 상대의 구조 변화를 허용하는지 먼저 확인합니다."
    );
  }

  return (
    "현재 즉각적인 강제 반격은 크지 않습니다. " +
    "상대의 다음 계획을 막아야 하는지 확인한 뒤 자신의 우세를 개선할 수 있습니다."
  );
}

function buildIdealPosition(
  snapshot
) {
  const dominant =
    snapshot.dominant;

  if (!dominant) {
    return "현재 포지션의 가장 중요한 우세를 안정적으로 유지하는 포지션을 목표로 합니다.";
  }

  switch (dominant.key) {
    case "material":
      return (
        "추가 물질을 활용해 계획을 만들거나, " +
        "상대의 활동을 없애면서 교환해 우세를 안정화하는 포지션을 목표로 합니다."
      );

    case "activity":
      return (
        `${sideName(dominant.side || snapshot.turn)}의 활동적인 기물을 유지하면서 ` +
        "제한된 기물을 개선하고 상대의 좋은 기물을 수동적으로 만드는 포지션을 목표로 합니다."
      );

    case "pawn":
      return (
        "구조적 약점을 고정하고 패스드 폰이나 더 좋은 폰 구조가 실제 승부 요소가 되는 포지션을 목표로 합니다."
      );

    case "space":
      return (
        `${sideName(dominant.side || snapshot.turn)}의 공간 우세를 유지하면서 ` +
        "상대의 폰 브레이크와 유리한 교환을 허용하지 않는 포지션을 목표로 합니다."
      );

    case "kingSafety":
      return (
        "위험한 공격선을 닫고 킹의 안전을 확보한 뒤 다른 우세를 사용할 수 있는 포지션을 목표로 합니다."
      );

    case "development":
      return (
        "개발 우세가 사라지기 전에 상대보다 먼저 활동적인 수를 만들어 대응을 강요하는 포지션을 목표로 합니다."
      );

    case "initiative":
      return (
        "상대가 자신의 계획을 실행할 시간을 주지 않고 계속 대응하게 만드는 포지션을 목표로 합니다."
      );

    case "weakSquare":
      return (
        "상대의 약한 칸에 기물을 고정하고 그 기물을 이용해 다른 약점까지 만들어내는 포지션을 목표로 합니다."
      );

    case "center":
      return (
        "중앙 통제력을 유지하면서 상대 기물의 활동 범위를 제한하고 적절한 시점에 구조를 바꾸는 포지션을 목표로 합니다."
      );

    case "openFile":
      return (
        "오픈 파일에 기물을 실제 침투시키고 그 파일의 끝에서 상대의 약점을 공격할 수 있는 포지션을 목표로 합니다."
      );

    default:
      return (
        "현재 가장 중요한 불균형을 유지하면서 상대의 반격을 줄이는 포지션을 목표로 합니다."
      );
  }
}

function buildThinkingSequence() {
  return (
    "불균형을 찾고 → 상대의 반격을 확인하고 → " +
    "원하는 포지션을 그린 뒤 → 후보 수를 만들고 → " +
    "계산한 뒤 → 엔진으로 검증합니다."
  );
}


/* =========================================================
   Evaluation language
   ========================================================= */

function describeEvaluation(
  scoreWhite
) {
  if (
    !Number.isFinite(scoreWhite)
  ) {
    return "평가를 계산할 수 없습니다.";
  }

  const abs =
    Math.abs(scoreWhite);

  if (abs < 0.15) {
    return "현재 포지션은 대체로 균형입니다.";
  }

  const side =
    scoreWhite > 0
      ? "백"
      : "흑";

  if (abs < 0.5) {
    return `${side}이 약간 더 편안한 포지션입니다.`;
  }

  if (abs < 1.0) {
    return `${side}이 분명히 더 편안한 포지션입니다.`;
  }

  if (abs < 2.0) {
    return `${side}이 상당한 우세를 가지고 있습니다.`;
  }

  return `${side} 쪽으로 평가가 크게 기울어져 있습니다.`;
}

function describeStrategicPriority(
  snapshot,
  scoreWhite
) {
  const dominant =
    snapshot.dominant;

  if (
    !dominant ||
    !dominant.side
  ) {
    return (
      `${describeEvaluation(scoreWhite)} ` +
      "현재는 여러 요소 중 기물 활동성과 개선 경로를 우선 확인합니다."
    );
  }

  const evalSide =
    Math.abs(scoreWhite) < 0.15
      ? null
      : scoreWhite > 0
        ? "w"
        : "b";

  const dominantSide =
    dominant.side;

  let text =
    `${describeEvaluation(scoreWhite)} ` +
    `현재 가장 중요한 불균형은 ${dominantLabel(dominant.key)}입니다. ` +
    `${sideName(dominantSide)} 쪽의 차이가 실제 계획에 직접 연결됩니다.`;

  if (
    evalSide &&
    evalSide !== dominantSide
  ) {
    text +=
      ` 엔진 평가의 우세 쪽과 전략적 우세가 일치하지 않으므로, ` +
      `${sideName(evalSide)}은 상대의 활동 우세를 먼저 제한하는 것이 중요합니다.`;
  }

  return text;
}

function dominantLabel(
  key
) {
  const labels = {
    material: "기물의 개수",
    activity: "기물 활동성",
    pawn: "폰 구조",
    space: "공간",
    kingSafety: "킹 안전",
    development: "개발",
    initiative: "주도권",
    weakSquare: "약한 칸",
    center: "중앙",
    openFile: "오픈 파일"
  };

  return labels[key] || "기물 활동성";
}


/* =========================================================
   Engine
   ========================================================= */

function setEngineStatus(
  text,
  type = "loading"
) {
  if (!engineStatus) return;

  engineStatus.textContent =
    text;

  engineStatus.className =
    `status ${type}`;
}

function ensureEngine() {
  if (
    state.engine &&
    state.engineReady
  ) {
    return Promise.resolve();
  }

  if (
    state.engineReadyPromise
  ) {
    return state.engineReadyPromise;
  }

  state.engineReadyPromise =
    new Promise(
      (resolve, reject) => {
        state.engineReadyResolve =
          resolve;

        state.engineReadyReject =
          reject;

        try {
          setEngineStatus(
            "Stockfish 준비 중…",
            "loading"
          );

          state.engine =
            new Worker(
              STOCKFISH_PATH
            );

          state.engine.onmessage =
            handleEngineMessage;

          state.engine.onerror =
            (error) => {
              state.engineReady = false;

              setEngineStatus(
                "Stockfish 오류",
                "error"
              );

              if (
                state.engineReadyReject
              ) {
                state.engineReadyReject(
                  error
                );
              }
            };

          state.engine.postMessage(
            "uci"
          );
        } catch (error) {
          setEngineStatus(
            "Stockfish 오류",
            "error"
          );

          reject(error);
        }
      }
    );

  return state.engineReadyPromise;
}

function parseEngineInfo(
  line,
  fen
) {
  const tokens =
    line.trim().split(/\s+/);

  if (
    !tokens.includes("score")
  ) {
    return null;
  }

  const depthIndex =
    tokens.indexOf("depth");

  const multipvIndex =
    tokens.indexOf("multipv");

  const scoreIndex =
    tokens.indexOf("score");

  const pvIndex =
    tokens.indexOf("pv");

  const depth =
    depthIndex >= 0
      ? Number(
          tokens[depthIndex + 1]
        )
      : 0;

  const multipv =
    multipvIndex >= 0
      ? Number(
          tokens[multipvIndex + 1]
        )
      : 1;

  const scoreType =
    tokens[scoreIndex + 1];

  const scoreValue =
    Number(
      tokens[scoreIndex + 2]
    );

  if (
    !Number.isFinite(
      scoreValue
    )
  ) {
    return null;
  }

  const turn =
    fen.split(/\s+/)[1] || "w";

  let scoreWhite = 0;

  if (
    scoreType === "cp"
  ) {
    const cp =
      scoreValue / 100;

    scoreWhite =
      turn === "w"
        ? cp
        : -cp;
  } else if (
    scoreType === "mate"
  ) {
    const mate =
      scoreValue;

    scoreWhite =
      turn === "w"
        ? mate > 0
          ? 100 - Math.min(
              Math.abs(mate) * 0.1,
              9
            )
          : -100 + Math.min(
              Math.abs(mate) * 0.1,
              9
            )
        : mate > 0
          ? -100 + Math.min(
              Math.abs(mate) * 0.1,
              9
            )
          : 100 - Math.min(
              Math.abs(mate) * 0.1,
              9
            );
  } else {
    return null;
  }

  const pv =
    pvIndex >= 0
      ? tokens.slice(
          pvIndex + 1
        )
      : [];

  return {
    multipv,
    depth,
    scoreType,
    scoreValue,
    scoreWhite,
    pv
  };
}

function handleEngineMessage(
  event
) {
  const line =
    String(
      event.data ?? ""
    ).trim();

  if (!line) return;

  if (
    line === "uciok"
  ) {
    try {
      state.engine.postMessage(
        "isready"
      );
    } catch {
      // ignore
    }

    return;
  }

  if (
    line === "readyok"
  ) {
    state.engineReady = true;

    setEngineStatus(
      "Stockfish 준비 완료",
      "ready"
    );

    if (
      state.engineReadyResolve
    ) {
      state.engineReadyResolve();
      state.engineReadyResolve =
        null;
    }

    return;
  }

  const request =
    state.activeEngineRequest;

  if (!request) {
    return;
  }

  if (
    line.startsWith("info ")
  ) {
    const parsed =
      parseEngineInfo(
        line,
        request.fen
      );

    if (parsed) {
      request.lines.set(
        parsed.multipv,
        parsed
      );
    }

    return;
  }

  if (
    line.startsWith("bestmove")
  ) {
    const result =
      [...request.lines.values()]
        .sort(
          (a, b) =>
            a.multipv -
            b.multipv
        );

    state.activeEngineRequest =
      null;

    request.resolve(
      request.cancelled
        ? []
        : result
    );

    for (
      const waiter of
      request.stopWaiters
    ) {
      waiter();
    }
  }
}

async function stopActiveEngine() {
  const request =
    state.activeEngineRequest;

  if (!request) {
    return;
  }

  await new Promise(
    (resolve) => {
      request.cancelled = true;
      request.stopWaiters.push(
        resolve
      );

      try {
        state.engine.postMessage(
          "stop"
        );
      } catch {
        resolve();
      }
    }
  );
}

async function runEngine(
  fen,
  depth = 10,
  multiPV = 1
) {
  const cacheKey =
    `${depth}|${multiPV}|${fen}`;

  if (
    state.engineCache.has(
      cacheKey
    )
  ) {
    return state.engineCache.get(
      cacheKey
    );
  }

  await ensureEngine();

  if (
    state.activeEngineRequest
  ) {
    await stopActiveEngine();
  }

  const result =
    await new Promise(
      (resolve) => {
        const id =
          ++state.engineRequestId;

        const request = {
          id,
          fen,
          depth,
          multiPV,
          lines: new Map(),
          resolve,
          cancelled: false,
          stopWaiters: []
        };

        state.activeEngineRequest =
          request;

        try {
          state.engine.postMessage(
            `setoption name MultiPV value ${multiPV}`
          );

          state.engine.postMessage(
            `position fen ${fen}`
          );

          state.engine.postMessage(
            `go depth ${depth}`
          );
        } catch {
          state.activeEngineRequest =
            null;

          resolve([]);
        }
      }
    );

  if (
    result.length
  ) {
    if (
      state.engineCache.size > 500
    ) {
      const firstKey =
        state.engineCache.keys()
          .next().value;

      if (firstKey) {
        state.engineCache.delete(
          firstKey
        );
      }
    }

    state.engineCache.set(
      cacheKey,
      result
    );
  }

  return result;
}

function formatEngineScore(
  line
) {
  if (!line) {
    return "—";
  }

  if (
    line.scoreType === "mate"
  ) {
    const mate =
      line.scoreValue;

    if (mate > 0) {
      return `#${mate}`;
    }

    return `#-${Math.abs(mate)}`;
  }

  const score =
    line.scoreWhite;

  if (
    Math.abs(score) < 0.005
  ) {
    return "0.00";
  }

  return score > 0
    ? `+${score.toFixed(2)}`
    : score.toFixed(2);
}

function evaluationNumber(
  line
) {
  if (!line) return 0;

  if (
    line.scoreType === "mate"
  ) {
    const mate =
      line.scoreValue;

    if (mate > 0) {
      return (
        100 -
        Math.min(
          Math.abs(mate) * 0.1,
          9
        )
      );
    }

    return (
      -100 +
      Math.min(
        Math.abs(mate) * 0.1,
        9
      )
    );
  }

  return line.scoreWhite;
}


/* =========================================================
   SAN conversion
   ========================================================= */

function uciLineToSan(
  fen,
  pv
) {
  if (
    !pv ||
    !pv.length
  ) {
    return "";
  }

  let chess;

  try {
    chess = new Chess(fen);
  } catch {
    return "";
  }

  const san = [];

  for (
    const uci of pv
  ) {
    const move =
      uciToObject(uci);

    if (!move) break;

    try {
      const result =
        chess.move(move);

      if (!result) break;

      san.push(
        result.san
      );
    } catch {
      break;
    }
  }

  return san.join(" ");
}

function getSanForUci(
  fen,
  uci
) {
  if (!uci) return "";

  try {
    const chess =
      new Chess(fen);

    const move =
      uciToObject(uci);

    if (!move) return "";

    const result =
      chess.move(move);

    return result?.san || "";
  } catch {
    return "";
  }
}


/* =========================================================
   Quick strategic move scoring
   ========================================================= */

function moveIsCastle(
  move
) {
  return (
    move.flags?.includes("k") ||
    move.flags?.includes("q")
  );
}

function moveIsDevelopment(
  chess,
  move,
  color
) {
  if (
    move.piece !== "n" &&
    move.piece !== "b"
  ) {
    return false;
  }

  const starts =
    STARTING_SQUARES[
      color
    ][move.piece] || [];

  return starts.includes(
    move.from
  );
}

function moveIsPawnBreak(
  move
) {
  if (
    move.piece !== "p"
  ) {
    return false;
  }

  const fromFile =
    squareFile(move.from);

  const toFile =
    squareFile(move.to);

  const toRank =
    squareRank(move.to);

  return (
    move.captured === "p" ||
    Math.abs(
      fromFile - toFile
    ) === 1 ||
    toRank === 4 ||
    toRank === 5
  );
}

function moveTargetsWeakSquare(
  chess,
  move,
  color
) {
  if (
    move.piece === "p" ||
    move.piece === "k"
  ) {
    return false;
  }

  const enemy =
    opposite(color);

  const weak =
    findWeakSquares(
      chess,
      enemy
    );

  return weak.includes(
    move.to
  );
}

function moveCreatesOutpost(
  chess,
  move,
  color
) {
  if (
    move.piece !== "n"
  ) {
    return false;
  }

  const target =
    chess.get(move.to);

  if (target) {
    return false;
  }

  return isStableOutpost(
    chess,
    move.to,
    color
  );
}

function quickStrategicScore(
  chess,
  move,
  snapshot
) {
  const color =
    chess.turn();

  let score = 0;

  const capturedValue =
    move.captured
      ? PIECE_VALUES[
          move.captured
        ] || 0
      : 0;

  if (
    move.captured
  ) {
    score +=
      capturedValue * 1.2;
  }

  if (
    move.san?.includes("#")
  ) {
    score += 20;
  } else if (
    move.san?.includes("+")
  ) {
    score += 6;
  }

  if (
    moveIsCastle(move)
  ) {
    score += 4;
  }

  if (
    moveIsDevelopment(
      chess,
      move,
      color
    )
  ) {
    score +=
      snapshot.phase === "opening"
        ? 4
        : 1.5;
  }

  if (
    moveCreatesOutpost(
      chess,
      move,
      color
    )
  ) {
    score += 5;
  }

  if (
    moveTargetsWeakSquare(
      chess,
      move,
      color
    )
  ) {
    score += 3;
  }

  if (
    moveIsPawnBreak(move)
  ) {
    if (
      snapshot.isClosed
    ) {
      score += 3;
    } else {
      score += 1;
    }
  }

  if (
    move.piece === "r"
  ) {
    const targetFile =
      move.to[0];

    const fileInfo =
      snapshot.files.files
        .find(
          (f) =>
            f.file ===
            targetFile
        );

    if (
      fileInfo &&
      (
        fileInfo.open ||
        fileInfo.semiOpenWhite ||
        fileInfo.semiOpenBlack
      )
    ) {
      score += 3;
    }
  }

  if (
    move.piece === "n"
  ) {
    const targetRank =
      squareRank(move.to);

    if (
      color === "w" &&
      targetRank >= 5
    ) {
      score += 1;
    }

    if (
      color === "b" &&
      targetRank <= 4
    ) {
      score += 1;
    }
  }

  /*
    킹 앞 폰을 무작정 움직이는 수는
    특별한 이유가 없다면 후보 우선순위를 조금 낮춘다.
  */

  if (
    move.piece === "p" &&
    (
      move.from[1] ===
        (color === "w" ? "2" : "7")
    ) &&
    (
      move.to[0] === "g" ||
      move.to[0] === "f"
    )
  ) {
    score -= 0.5;
  }

  return score;
}

function generateStrategicMovePool(
  chess,
  snapshot,
  engineLines
) {
  const color =
    chess.turn();

  const engineUcis =
    new Set(
      engineLines
        .map(
          (line) =>
            line.pv?.[0]
        )
        .filter(Boolean)
    );

  const moves =
    getLegalMovesForSide(
      chess,
      color
    );

  const scored =
    moves
      .filter(
        (move) =>
          !engineUcis.has(
            moveToUci(move)
          )
      )
      .map(
        (move) => ({
          move,
          score:
            quickStrategicScore(
              chess,
              move,
              snapshot
            )
        })
      )
      .sort(
        (a, b) =>
          b.score -
          a.score
      );

  return scored
    .slice(0, 5)
    .map(
      (item) =>
        item.move
    );
}


/* =========================================================
   Candidate comparison
   ========================================================= */

function moverPerspectiveScore(
  scoreWhite,
  mover
) {
  return mover === "w"
    ? scoreWhite
    : -scoreWhite;
}

function candidateLoss(
  bestLine,
  candidateLine,
  mover
) {
  const best =
    moverPerspectiveScore(
      evaluationNumber(
        bestLine
      ),
      mover
    );

  const candidate =
    moverPerspectiveScore(
      evaluationNumber(
        candidateLine
      ),
      mover
    );

  return Math.max(
    0,
    best - candidate
  );
}

function featureForSide(
  snapshot,
  key,
  color
) {
  switch (key) {
    case "material":
      return color === "w"
        ? snapshot.material.diff
        : -snapshot.material.diff;

    case "activity":
      return color === "w"
        ? snapshot.minor.diff
        : -snapshot.minor.diff;

    case "pawn":
      return color === "w"
        ? snapshot.pawn.diff
        : -snapshot.pawn.diff;

    case "space":
      return color === "w"
        ? snapshot.space.diff
        : -snapshot.space.diff;

    case "kingSafety":
      return color === "w"
        ? snapshot.kingSafety.diff
        : -snapshot.kingSafety.diff;

    case "development":
      return color === "w"
        ? snapshot.development.diff
        : -snapshot.development.diff;

    case "initiative":
      return color === "w"
        ? snapshot.initiative.diff
        : -snapshot.initiative.diff;

    case "center":
      return color === "w"
        ? snapshot.center.diff
        : -snapshot.center.diff;

    case "weakSquare":
      return color === "w"
        ? snapshot.weak.difference
        : -snapshot.weak.difference;

    case "openFile":
      return color === "w"
        ? snapshot.files.diff
        : -snapshot.files.diff;

    default:
      return 0;
  }
}

function strategicGain(
  before,
  after,
  color
) {
  const key =
    before.dominant?.key ||
    "activity";

  return (
    featureForSide(
      after,
      key,
      color
    ) -
    featureForSide(
      before,
      key,
      color
    )
  );
}

function candidateReason(
  before,
  after,
  move,
  color
) {
  const reasons = [];

  const key =
    before.dominant?.key ||
    "activity";

  const gain =
    strategicGain(
      before,
      after,
      color
    );

  if (
    gain > 0.5
  ) {
    reasons.push(
      `${dominantLabel(key)}을 직접 개선합니다`
    );
  }

  if (
    moveIsCastle(move)
  ) {
    reasons.push(
      "킹 안전과 룩의 연결을 동시에 정리합니다"
    );
  }

  if (
    moveIsDevelopment(
      before,
      move,
      color
    )
  ) {
    reasons.push(
      "미개발 기물을 실제 활동이 가능한 위치로 꺼냅니다"
    );
  }

  if (
    moveCreatesOutpost(
      new Chess(before.fen),
      move,
      color
    )
  ) {
    reasons.push(
      `${move.to}를 안정적인 지원점으로 사용할 가능성을 만듭니다`
    );
  }

  if (
    moveIsPawnBreak(move)
  ) {
    reasons.push(
      "폰 구조를 직접 바꾸는 브레이크입니다"
    );
  }

  if (
    move.captured
  ) {
    reasons.push(
      `${pieceName(move.captured)}와의 교환을 통해 구조나 활동의 변화를 만듭니다`
    );
  }

  const beforeCounter =
    before.counterplay;

  const afterCounter =
    after.counterplay;

  if (
    beforeCounter.forcing.length &&
    afterCounter.forcing.length <
      beforeCounter.forcing.length
  ) {
    reasons.push(
      "상대의 즉각적인 반격 수를 줄입니다"
    );
  }

  if (!reasons.length) {
    reasons.push(
      `현재 ${dominantLabel(key)}에 맞춰 계획을 진행하는 수입니다`
    );
  }

  return reasons
    .slice(0, 2)
    .join(" · ");
}

async function buildCandidates(
  fen,
  snapshot,
  engineLines
) {
  if (
    !engineLines.length
  ) {
    return [];
  }

  const chess =
    new Chess(fen);

  const mover =
    chess.turn();

  const best =
    engineLines[0];

  const candidates = [];

  /*
    1. 엔진 후보
  */

  for (
    const line of engineLines
  ) {
    const uci =
      line.pv?.[0];

    if (!uci) continue;

    const san =
      getSanForUci(
        fen,
        uci
      );

    if (!san) continue;

    candidates.push({
      uci,
      san,
      line,
      source: "engine",
      strategicGain: 0,
      afterSnapshot: null
    });
  }

  /*
    2. 전략적 후보 생성
  */

  const strategicMoves =
    generateStrategicMovePool(
      chess,
      snapshot,
      engineLines
    );

  /*
    너무 많은 엔진 계산을 하지 않기 위해
    실제로 전략적 의미가 있는 후보만 최대 3개 검증한다.
  */

  const strategicCandidates =
    strategicMoves.slice(0, 3);

  for (
    const move of strategicCandidates
  ) {
    const uci =
      moveToUci(move);

    let after;

    try {
      const clone =
        new Chess(fen);

      clone.move({
        from: move.from,
        to: move.to,
        ...(move.promotion
          ? {
              promotion:
                move.promotion
            }
          }
          : {})
      });

      after =
        buildPositionSnapshot(
          clone.fen()
        );
    } catch {
      continue;
    }

    const afterFen =
      after.fen;

    const extraLines =
      await runEngine(
        afterFen,
        8,
        1
      );

    if (
      !extraLines.length
    ) {
      continue;
    }

    const line =
      extraLines[0];

    const loss =
      candidateLoss(
        best,
        line,
        mover
      );

    /*
      여기서부터는 엔진 검증을 통과한
      전략적 후보만 유지한다.
    */

    if (
      loss > 0.85
    ) {
      continue;
    }

    candidates.push({
      uci,
      san: move.san,
      line: {
        ...line,
        pv: [
          uci,
          ...(line.pv || [])
        ]
      },
      source: "strategic",
      strategicGain:
        strategicGain(
          snapshot,
          after,
          mover
        ),
      afterSnapshot:
        after
    });
  }

  /*
    중복 제거
  */

  const unique =
    new Map();

  for (
    const candidate of
    candidates
  ) {
    if (
      !unique.has(
        candidate.uci
      )
    ) {
      unique.set(
        candidate.uci,
        candidate
      );
    }
  }

  const merged =
    [...unique.values()];

  /*
    후보 분류
  */

  const classified = [];

  for (
    const candidate of
    merged
  ) {
    const loss =
      candidateLoss(
        best,
        candidate.line,
        mover
      );

    const strategicGain =
      candidate.strategicGain || 0;

    let category = "";

    if (
      candidate.uci ===
      best.pv?.[0]
    ) {
      category =
        "엔진 최선";
    } else if (
      loss <= 0.35 &&
      (
        strategicGain >= 0.3 ||
        candidate.source === "engine"
      )
    ) {
      category =
        "전략적 대안";
    } else if (
      loss <= 0.60
    ) {
      category =
        "실전적 대안";
    } else if (
      loss <= 0.85 &&
      strategicGain >= 0.3
    ) {
      category =
        "다른 계획";
    } else {
      /*
        명백히 나쁜 수는 화면에서 제거.
      */
      continue;
    }

    let afterSnapshot =
      candidate.afterSnapshot;

    if (!afterSnapshot) {
      try {
        const clone =
          new Chess(fen);

        const move =
          uciToObject(
            candidate.uci
          );

        clone.move(move);

        afterSnapshot =
          buildPositionSnapshot(
            clone.fen()
          );
      } catch {
        afterSnapshot =
          null;
      }
    }

    const sanLine =
      uciLineToSan(
        fen,
        candidate.line.pv || []
      );

    let reason = "";

    if (
      category === "엔진 최선"
    ) {
      reason =
        "현재 포지션에서 엔진이 가장 강하게 추천하는 수입니다.";
    } else if (
      afterSnapshot
    ) {
      const move =
        getLegalMovesForSide(
          new Chess(fen),
          mover
        ).find(
          (m) =>
            moveToUci(m) ===
            candidate.uci
        );

      if (move) {
        reason =
          candidateReason(
            snapshot,
            afterSnapshot,
            move,
            mover
          );
      } else {
        reason =
          "현재 핵심 불균형을 다른 방식으로 다루는 후보입니다.";
      }
    } else {
      reason =
        "현재 핵심 불균형을 다른 방식으로 다루는 후보입니다.";
    }

    classified.push({
      ...candidate,
      category,
      loss,
      sanLine,
      reason
    });
  }

  /*
    엔진 최선은 항상 첫 번째.
    나머지는 평가 손실이 작은 순서.
  */

  classified.sort(
    (a, b) => {
      if (
        a.category === "엔진 최선"
      ) {
        return -1;
      }

      if (
        b.category === "엔진 최선"
      ) {
        return 1;
      }

      return a.loss - b.loss;
    }
  );

  /*
    최대 3개.
    단, 엔진 최선 + 의미 있는 대안.
  */

  return classified.slice(0, 3);
}


/* =========================================================
   Candidate rendering
   ========================================================= */

function renderCandidates(
  candidates
) {
  if (!candidateList) {
    return;
  }

  candidateList.innerHTML = "";

  if (
    !candidates.length
  ) {
    candidateList.innerHTML =
      `<div class="candidate">
        <div class="candidatePv">
          현재 비교할 만한 후보 수를 충분히 확보하지 못했습니다.
        </div>
      </div>`;

    return;
  }

  for (
    let i = 0;
    i < candidates.length;
    i++
  ) {
    const candidate =
      candidates[i];

    const wrapper =
      document.createElement(
        "div"
      );

    wrapper.className =
      "candidate";

    const head =
      document.createElement(
        "div"
      );

    head.className =
      "candidateHead";

    const title =
      document.createElement(
        "strong"
      );

    title.textContent =
      `${i + 1}. ${candidate.san} · ${candidate.category}`;

    const score =
      document.createElement(
        "span"
      );

    score.className =
      "candidateEval";

    score.textContent =
      formatEngineScore(
        candidate.line
      );

    head.appendChild(
      title
    );

    head.appendChild(
      score
    );

    const pv =
      document.createElement(
        "div"
      );

    pv.className =
      "candidatePv";

    pv.textContent =
      candidate.sanLine ||
      candidate.san;

    const reason =
      document.createElement(
        "div"
      );

    reason.className =
      "candidateReason";

    reason.textContent =
      candidate.reason;

    wrapper.appendChild(
      head
    );

    wrapper.appendChild(
      pv
    );

    wrapper.appendChild(
      reason
    );

    candidateList.appendChild(
      wrapper
    );
  }
}


/* =========================================================
   Factor rendering
   ========================================================= */

function factorHtml(
  title,
  text
) {
  return `
    <div class="factor">
      <strong>${escapeHtml(title)}</strong>
      <div>${text}</div>
    </div>
  `;
}

function renderHumanFactors(
  snapshot,
  moveReview = null
) {
  const factors = [];

  factors.push(
    factorHtml(
      "게임 단계",
      `현재 ${phaseName(snapshot.phase)}입니다.`
    )
  );

  const materialText =
    Math.abs(
      snapshot.material.diff
    ) < 0.15
      ? "물질적으로 균형이 맞습니다."
      : `${sideName(
          snapshot.material.advantage
        )}이 약 ${Math.abs(
          snapshot.material.diff
        ).toFixed(1)}점의 물질 우세를 가지고 있습니다.`;

  factors.push(
    factorHtml(
      "기물의 개수",
      materialText
    )
  );

  factors.push(
    factorHtml(
      "현재 가장 중요한 불균형",
      `${dominantLabel(
        snapshot.dominant.key
      )} · ${snapshot.dominant.reason}`
    )
  );

  for (
    const piece of
    snapshot.minor.pieces
  ) {
    factors.push(
      factorHtml(
        `${sideName(piece.color)} ${piece.square} · ${piece.label}`,
        escapeHtml(
          piece.description
        )
      )
    );
  }

  factors.push(
    factorHtml(
      "폰 구조",
      describePawnStructure(
        snapshot
      )
    )
  );

  factors.push(
    factorHtml(
      "약한 칸",
      describeWeakSquares(
        snapshot
      )
    )
  );

  factors.push(
    factorHtml(
      "공간",
      describeSpace(
        snapshot
      )
    )
  );

  factors.push(
    factorHtml(
      "중앙",
      describeCenter(
        snapshot
      )
    )
  );

  factors.push(
    factorHtml(
      "오픈 파일",
      describeOpenFiles(
        snapshot
      )
    )
  );

  factors.push(
    factorHtml(
      "개발",
      describeDevelopment(
        snapshot
      )
    )
  );

  factors.push(
    factorHtml(
      "킹 안전",
      describeKingSafety(
        snapshot
      )
    )
  );

  factors.push(
    factorHtml(
      "주도권",
      describeInitiative(
        snapshot
      )
    )
  );

  factors.push(
    factorHtml(
      "정적 / 동적",
      `<strong>${escapeHtml(
        snapshot.staticDynamic.text
      )}</strong><br>${escapeHtml(
        snapshot.staticDynamic.detail
      )}`
    )
  );

  if (
    snapshot.staticDynamic.type ===
    "dynamic"
  ) {
    factors.push(
      factorHtml(
        "우세를 사용하는 방법",
        "현재 우세가 개발·주도권·킹 안전 같은 동적인 요소에 더 가깝습니다. " +
        "이런 우세는 시간을 주면 사라질 수 있으므로 실제 이득이나 더 오래가는 우세로 바꾸는 수를 우선 확인합니다."
      )
    );
  } else if (
    snapshot.staticDynamic.type ===
    "static"
  ) {
    factors.push(
      factorHtml(
        "우세를 사용하는 방법",
        "현재 우세가 폰 구조·물질·약한 칸처럼 오래 남는 요소에 더 가깝습니다. " +
        "불필요하게 구조적 우세를 훼손하지 않고 그것을 실제 승부 요소로 만드는 방법을 찾습니다."
      )
    );
  } else {
    factors.push(
      factorHtml(
        "우세를 사용하는 방법",
        "정적인 우세와 동적인 활동이 함께 존재합니다. " +
        "당장의 활동을 유지하면서 그것을 더 오래가는 우세로 바꿀 수 있는지 확인합니다."
      )
    );
  }

  const counter =
    snapshot.counterplay;

  let counterText =
    "즉각적인 강제 반격은 크지 않습니다.";

  if (
    counter.forcing.length
  ) {
    counterText =
      `${sideName(counter.color)}에게 전술적인 ` +
      `잡기·체크 ${counter.forcing.join(", ")}가 있어 ` +
      "먼저 상대의 강제 수를 확인해야 합니다.";
  } else if (
    counter.pawnBreaks.length
  ) {
    counterText =
      `${sideName(counter.color)}에게 ` +
      `폰 브레이크 ${counter.pawnBreaks.join(", ")}가 있어 ` +
      "내 계획이 구조 변화를 허용하는지 확인해야 합니다.";
  }

  factors.push(
    factorHtml(
      "상대의 반격",
      counterText
    )
  );

  factors.push(
    factorHtml(
      "예방적 사고",
      buildPreventiveText(
        snapshot
      )
    )
  );

  factors.push(
    factorHtml(
      "이상적인 포지션",
      buildIdealPosition(
        snapshot
      )
    )
  );

  factors.push(
    factorHtml(
      "생각의 순서",
      buildThinkingSequence()
    )
  );

  if (moveReview) {
    factors.push(
      factorHtml(
        `이번 수에 대한 복기 · ${moveReview.title}`,
        moveReview.text
      )
    );

    factors.push(
      factorHtml(
        "다음에 생각할 것",
        moveReview.next
      )
    );
  }

  factors.push(`
    <div class="factor">
      <strong>중요한 순간</strong>
      <div>
        게임 전체에서 평가가 크게 변한 순간을 별도로 찾아봅니다.
      </div>
      <button
        id="criticalBtn"
        class="secondary small"
        style="margin-top:10px"
        ${state.criticalRunning ? "disabled" : ""}
      >
        ${state.criticalRunning
          ? "중요한 순간 분석 중…"
          : "중요한 순간 찾기"}
      </button>
      <div id="criticalResults"></div>
    </div>
  `);

  humanFactors.innerHTML =
    factors.join("");

  const criticalBtn =
    $("criticalBtn");

  if (criticalBtn) {
    criticalBtn.onclick =
      () => {
        analyzeCriticalMoments(
          state.analysisToken
        );
      };
  }

  if (
    state.criticalResults
  ) {
    renderCriticalResults(
      state.criticalResults
    );
  }
}


/* =========================================================
   Move review
   ========================================================= */

function buildChangeDescription(
  before,
  after,
  mover
) {
  const changes = [];

  const materialChange =
    featureForSide(
      after,
      "material",
      mover
    ) -
    featureForSide(
      before,
      "material",
      mover
    );

  if (
    Math.abs(materialChange) >= 0.5
  ) {
    if (
      materialChange > 0
    ) {
      changes.push(
        "물질적 이득을 얻었습니다."
      );
    } else {
      changes.push(
        "물질적으로 양보한 부분이 있습니다."
      );
    }
  }

  const activityChange =
    featureForSide(
      after,
      "activity",
      mover
    ) -
    featureForSide(
      before,
      "activity",
      mover
    );

  if (
    Math.abs(activityChange) >= 1.5
  ) {
    changes.push(
      activityChange > 0
        ? "기물의 활동 범위가 넓어졌습니다."
        : "기물의 활동 범위가 좁아졌습니다."
    );
  }

  const spaceChange =
    featureForSide(
      after,
      "space",
      mover
    ) -
    featureForSide(
      before,
      "space",
      mover
    );

  if (
    Math.abs(spaceChange) >= 1.5
  ) {
    changes.push(
      spaceChange > 0
        ? "공간을 더 확보했습니다."
        : "공간을 일부 내주었습니다."
    );
  }

  const kingChange =
    featureForSide(
      after,
      "kingSafety",
      mover
    ) -
    featureForSide(
      before,
      "kingSafety",
      mover
    );

  if (
    Math.abs(kingChange) >= 1
  ) {
    changes.push(
      kingChange > 0
        ? "킹의 안전이 좋아졌습니다."
        : "킹 주변의 위험이 커졌습니다."
    );
  }

  const pawnChange =
    featureForSide(
      after,
      "pawn",
      mover
    ) -
    featureForSide(
      before,
      "pawn",
      mover
    );

  if (
    Math.abs(pawnChange) >= 0.8
  ) {
    changes.push(
      pawnChange > 0
        ? "폰 구조가 더 유리한 방향으로 바뀌었습니다."
        : "폰 구조에 새로운 약점이 생겼을 가능성이 있습니다."
    );
  }

  if (
    before.dominant.key !==
    after.dominant.key
  ) {
    changes.push(
      `중요한 불균형이 ${dominantLabel(
        before.dominant.key
      )}에서 ${dominantLabel(
        after.dominant.key
      )} 쪽으로 바뀌었습니다.`
    );
  }

  if (!changes.length) {
    changes.push(
      "큰 물질 변화 없이 포지션의 계획과 활동 관계를 유지하는 수였습니다."
    );
  }

  return changes
    .slice(0, 3)
    .join(" ");
}

async function buildMoveReview(
  ply,
  currentSnapshot,
  currentLine
) {
  if (
    ply <= 0 ||
    !state.history[ply - 1]
  ) {
    return null;
  }

  const move =
    state.history[ply - 1];

  const beforeFen =
    state.positions[ply - 1];

  const beforeSnapshot =
    buildPositionSnapshot(
      beforeFen
    );

  const beforeLines =
    await runEngine(
      beforeFen,
      8,
      1
    );

  if (
    !beforeLines.length
  ) {
    return null;
  }

  const beforeLine =
    beforeLines[0];

  const beforeScore =
    evaluationNumber(
      beforeLine
    );

  const afterScore =
    evaluationNumber(
      currentLine
    );

  const delta =
    move.color === "w"
      ? afterScore - beforeScore
      : beforeScore - afterScore;

  let title = "";

  if (
    delta >= 0.2
  ) {
    title =
      "좋은 수";
  } else if (
    delta >= -0.2
  ) {
    title =
      "평가 변화가 작은 수";
  } else if (
    delta >= -0.6
  ) {
    title =
      "작은 기회 손실";
  } else if (
    delta >= -1.2
  ) {
    title =
      "명확한 전략적 실수";
  } else {
    title =
      "큰 평가 하락";
  }

  const beforeBestUci =
    beforeLine.pv?.[0];

  const actualUci =
    moveToUci(move);

  const actualWasBest =
    beforeBestUci ===
    actualUci;

  const changeText =
    buildChangeDescription(
      beforeSnapshot,
      currentSnapshot,
      move.color
    );

  let text =
    `${move.san} · ` +
    `평가 ${formatSignedScore(
      beforeScore
    )} → ${formatSignedScore(
      afterScore
    )}. `;

  if (
    delta >= 0.2
  ) {
    text +=
      "현재 포지션의 중요한 요소를 좋은 방향으로 유지하거나 개선했습니다. ";
  } else if (
    delta >= -0.2
  ) {
    text +=
      "평가 변화가 크지 않아 이 수 자체가 포지션을 크게 망치지는 않았습니다. ";
  } else if (
    delta >= -0.6
  ) {
    text +=
      "더 정밀한 후보가 있었지만 아직 포지션의 큰 구조를 유지하고 있습니다. ";
  } else if (
    delta >= -1.2
  ) {
    text +=
      "이 수로 현재 포지션의 중요한 기회를 일부 놓쳤습니다. ";
  } else {
    text +=
      "이 수 이후 포지션의 가치가 크게 떨어졌습니다. ";
  }

  text += changeText;

  if (
    !actualWasBest &&
    beforeBestUci
  ) {
    const bestSan =
      getSanForUci(
        beforeFen,
        beforeBestUci
      );

    if (bestSan) {
      text +=
        ` 그 순간 엔진이 가장 먼저 확인한 수는 ${bestSan}이었습니다.`;
    }
  }

  let next = "";

  if (
    beforeSnapshot.counterplay
      .forcing.length
  ) {
    next =
      `다음에는 ${sideName(
        beforeSnapshot.counterplay.color
      )}의 ` +
      `체크·잡기 ${beforeSnapshot.counterplay.forcing.join(", ")}를 ` +
      "먼저 확인한 뒤 후보 수를 만들면 됩니다.";
  } else if (
    beforeSnapshot.counterplay
      .pawnBreaks.length
  ) {
    next =
      `다음에는 상대의 폰 브레이크 ` +
      `${beforeSnapshot.counterplay.pawnBreaks.join(", ")}가 ` +
      "내 계획을 방해하는지 먼저 확인합니다.";
  } else {
    next =
      `다음 수를 찾을 때는 먼저 ` +
      `${dominantLabel(
        beforeSnapshot.dominant.key
      )}이 실제로 누구에게 유리한지 확인하고, ` +
      "그 우세를 유지하거나 상대의 장점을 제한하는 후보를 만듭니다.";
  }

  return {
    title,
    text,
    next
  };
}

function formatSignedScore(
  score
) {
  if (
    !Number.isFinite(score)
  ) {
    return "—";
  }

  if (
    Math.abs(score) < 0.005
  ) {
    return "0.00";
  }

  return score > 0
    ? `+${score.toFixed(2)}`
    : score.toFixed(2);
}


/* =========================================================
   Board
   ========================================================= */

function renderBoard() {
  if (!board) return;

  board.innerHTML = "";

  if (
    !state.positions.length
  ) {
    return;
  }

  const fen =
    state.positions[
      state.currentPly
    ];

  let chess;

  try {
    chess =
      new Chess(fen);
  } catch {
    return;
  }

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
      const square =
        makeSquare(
          file,
          rank
        );

      const cell =
        document.createElement(
          "div"
        );

      cell.className =
        `sq ${
          (file + rank) % 2 === 0
            ? "light"
            : "dark"
        }`;

      const piece =
        chess.get(square);

      if (piece) {
        cell.textContent =
          PIECES[
            piece.color
          ][
            piece.type
          ];
      }

      cell.dataset.square =
        square;

      board.appendChild(
        cell
      );
    }
  }
}


/* =========================================================
   Move list
   ========================================================= */

function renderMoveList() {
  if (!moveList) return;

  moveList.innerHTML = "";

  for (
    let i = 0;
    i < state.history.length;
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
      "moveNo";

    number.textContent =
      `${Math.floor(i / 2) + 1}.`;

    row.appendChild(
      number
    );

    const whiteMove =
      state.history[i];

    if (whiteMove) {
      const button =
        createMoveButton(
          whiteMove,
          i + 1
        );

      row.appendChild(
        button
      );
    }

    const blackMove =
      state.history[i + 1];

    if (blackMove) {
      const button =
        createMoveButton(
          blackMove,
          i + 2
        );

      row.appendChild(
        button
      );
    }

    moveList.appendChild(
      row
    );
  }
}

function createMoveButton(
  move,
  ply
) {
  const button =
    document.createElement(
      "button"
    );

  button.type =
    "button";

  button.className =
    "moveButton";

  if (
    ply ===
    state.currentPly
  ) {
    button.classList.add(
      "active"
    );
  }

  button.textContent =
    move.san;

  button.onclick =
    () => {
      setCurrentPly(
        ply
      );
    };

  return button;
}

function renderPositionMeta() {
  const ply =
    state.currentPly;

  const total =
    state.history.length;

  moveLabel.textContent =
    `${ply} / ${total}`;

  if (ply === 0) {
    positionLabel.textContent =
      "시작 포지션";
  } else {
    const move =
      state.history[
        ply - 1
      ];

    positionLabel.textContent =
      `${Math.ceil(
        ply / 2
      )}${move.color === "w" ? "." : "…"}${move.san} 후`;
  }

  const white =
    state.headers.White ||
    "White";

  const black =
    state.headers.Black ||
    "Black";

  gameMeta.textContent =
    `${white} · ${black}`;
}


/* =========================================================
   Progress
   ========================================================= */

function setProgress(
  percent
) {
  if (!progressBar) return;

  progressBar.style.width =
    `${clamp(
      percent,
      0,
      100
    )}%`;
}


/* =========================================================
   Critical moments
   ========================================================= */

async function analyzeCriticalMoments(
  token
) {
  if (
    state.criticalRunning
  ) {
    return;
  }

  if (
    state.positions.length <= 1
  ) {
    return;
  }

  state.criticalRunning =
    true;

  state.criticalResults =
    null;

  renderHumanFactors(
    buildPositionSnapshot(
      state.positions[
        state.currentPly
      ]
    ),
    null
  );

  try {
    const total =
      state.positions.length - 1;

    /*
      너무 긴 게임은 우선 앞쪽 120플라이를 스캔한다.
      중요 순간 자체는 8개 이하로 압축한다.
    */

    const maxScan =
      Math.min(
        total,
        120
      );

    const evaluations = [];

    for (
      let i = 0;
      i <= maxScan;
      i++
    ) {
      if (
        token !==
        state.analysisToken
      ) {
        return;
      }

      const lines =
        await runEngine(
          state.positions[i],
          5,
          1
        );

      evaluations[i] =
        lines[0] || null;

      setProgress(
        10 +
        (
          i /
          Math.max(
            1,
            maxScan
          )
        ) * 50
      );
    }

    const candidates = [];

    for (
      let i = 1;
      i <= maxScan;
      i++
    ) {
      const before =
        evaluations[i - 1];

      const after =
        evaluations[i];

      if (
        !before ||
        !after
      ) {
        continue;
      }

      const move =
        state.history[i - 1];

      if (!move) continue;

      const beforeScore =
        evaluationNumber(
          before
        );

      const afterScore =
        evaluationNumber(
          after
        );

      const delta =
        move.color === "w"
          ? afterScore -
            beforeScore
          : beforeScore -
            afterScore;

      if (
        Math.abs(delta) >= 0.55
      ) {
        candidates.push({
          ply: i,
          move,
          beforeScore,
          afterScore,
          delta
        });
      }
    }

    candidates.sort(
      (a, b) =>
        Math.abs(b.delta) -
        Math.abs(a.delta)
    );

    const selected =
      candidates.slice(0, 8);

    const deepResults = [];

    for (
      let i = 0;
      i < selected.length;
      i++
    ) {
      if (
        token !==
        state.analysisToken
      ) {
        return;
      }

      const item =
        selected[i];

      const lines =
        await runEngine(
          state.positions[
            item.ply - 1
          ],
          10,
          3
        );

      deepResults.push({
        ...item,
        lines
      });

      setProgress(
        60 +
        (
          (i + 1) /
          Math.max(
            1,
            selected.length
          )
        ) * 35
      );
    }

    state.criticalResults =
      deepResults;

    renderCriticalResults(
      deepResults
    );

    setProgress(100);
  } finally {
    state.criticalRunning =
      false;

    if (
      state.currentAnalysis
    ) {
      renderHumanFactors(
        state.currentAnalysis
          .snapshot,
        state.currentAnalysis
          .moveReview
      );
    }
  }
}

function renderCriticalResults(
  results
) {
  const container =
    $("criticalResults");

  if (!container) {
    return;
  }

  if (
    !results ||
    !results.length
  ) {
    container.innerHTML =
      `<div style="margin-top:10px">
        현재 기준으로 큰 평가 변화를 보인 순간이 뚜렷하지 않습니다.
      </div>`;

    return;
  }

  const html =
    results.map(
      (item, index) => {
        const actual =
          item.move.san;

        const best =
          item.lines?.[0];

        const bestSan =
          best?.pv?.[0]
            ? getSanForUci(
                state.positions[
                  item.ply - 1
                ],
                best.pv[0]
              )
            : "";

        const direction =
          item.delta >= 0
            ? "좋은 방향의 큰 변화"
            : "평가가 크게 나빠진 순간";

        const before =
          formatSignedScore(
            item.beforeScore
          );

        const after =
          formatSignedScore(
            item.afterScore
          );

        let reason =
          `${actual} 이후 평가가 ${before} → ${after}로 변했습니다.`;

        if (
          item.delta < -0.55
        ) {
          reason +=
            " 이 수를 두기 전 상대의 강제 응수와 현재 가장 중요한 불균형을 먼저 확인했어야 하는 순간입니다.";
        } else {
          reason +=
            " 이 순간에는 포지션의 중요한 변화가 실제 계획으로 연결된 순간입니다.";
        }

        const pv =
          best
            ? uciLineToSan(
                state.positions[
                  item.ply - 1
                ],
                best.pv || []
              )
            : "";

        return `
          <div class="factor" style="margin-top:10px">
            <strong>${index + 1}. ${Math.ceil(
              item.ply / 2
            )}${item.move.color === "w" ? "." : "…"}${escapeHtml(
              actual
            )} · ${escapeHtml(
              direction
            )}</strong>
            <div>
              ${escapeHtml(reason)}
              ${
                bestSan
                  ? `<br>그 순간 먼저 비교할 수 있었던 엔진 후보: <strong>${escapeHtml(
                      bestSan
                    )}</strong>`
                  : ""
              }
              ${
                pv
                  ? `<br>${escapeHtml(
                      pv
                    )}`
                  : ""
              }
            </div>
          </div>
        `;
      }
    ).join("");

  container.innerHTML =
    html;
}


/* =========================================================
   Main position analysis
   ========================================================= */

async function analyzeCurrentPosition() {
  if (
    !state.positions.length
  ) {
    return;
  }

  const token =
    ++state.analysisToken;

  const fen =
    state.positions[
      state.currentPly
    ];

  setProgress(5);

  const snapshot =
    buildPositionSnapshot(
      fen
    );

  setProgress(15);

  let lines = [];

  try {
    lines =
      await runEngine(
        fen,
        8,
        3
      );
  } catch {
    lines = [];
  }

  if (
    token !==
    state.analysisToken
  ) {
    return;
  }

  if (
    !lines.length
  ) {
    evalValue.textContent =
      "—";

    depthValue.textContent =
      "—";

    positionInsight.textContent =
      "엔진 분석 결과를 받지 못했습니다.";

    renderCandidates([]);

    renderHumanFactors(
      snapshot,
      null
    );

    return;
  }

  const currentLine =
    lines[0];

  /*
    화면 평가.
    초기 표시부터 빠르게 보여주고,
    이후 조금 더 깊은 분석을 한다.
  */

  evalValue.textContent =
    formatEngineScore(
      currentLine
    );

  depthValue.textContent =
    `d${currentLine.depth || 8}`;

  positionInsight.textContent =
    describeStrategicPriority(
      snapshot,
      currentLine.scoreWhite
    );

  setProgress(45);

  let deeperLines =
    lines;

  try {
    deeperLines =
      await runEngine(
        fen,
        12,
        3
      );
  } catch {
    deeperLines =
      lines;
  }

  if (
    token !==
    state.analysisToken
  ) {
    return;
  }

  const finalLine =
    deeperLines[0] ||
    currentLine;

  evalValue.textContent =
    formatEngineScore(
      finalLine
    );

  depthValue.textContent =
    `d${finalLine.depth || 12}`;

  positionInsight.textContent =
    describeStrategicPriority(
      snapshot,
      finalLine.scoreWhite
    );

  setProgress(55);

  const candidates =
    await buildCandidates(
      fen,
      snapshot,
      deeperLines
    );

  if (
    token !==
    state.analysisToken
  ) {
    return;
  }

  renderCandidates(
    candidates
  );

  setProgress(82);

  let moveReview = null;

  try {
    moveReview =
      await buildMoveReview(
        state.currentPly,
        snapshot,
        finalLine
      );
  } catch {
    moveReview = null;
  }

  if (
    token !==
    state.analysisToken
  ) {
    return;
  }

  state.currentAnalysis = {
    snapshot,
    lines: deeperLines,
    candidates,
    moveReview
  };

  renderHumanFactors(
    snapshot,
    moveReview
  );

  setProgress(100);
}


/* =========================================================
   Position navigation
   ========================================================= */

function setCurrentPly(
  ply
) {
  const next =
    clamp(
      ply,
      0,
      state.history.length
    );

  state.currentPly =
    next;

  state.criticalResults =
    null;

  renderBoard();
  renderMoveList();
  renderPositionMeta();

  analyzeCurrentPosition();
}


/* =========================================================
   PGN
   ========================================================= */

function getHeadersSafe(
  game
) {
  try {
    if (
      typeof game.getHeaders ===
      "function"
    ) {
      return game.getHeaders();
    }

    if (
      typeof game.header ===
      "function"
    ) {
      const headers =
        game.header();

      return headers || {};
    }
  } catch {
    // ignore
  }

  return {};
}

function parsePGN(
  pgn
) {
  const game =
    new Chess();

  try {
    game.loadPgn(
      pgn
    );
  } catch (error) {
    throw new Error(
      "PGN을 읽을 수 없습니다. 수순이나 헤더 형식을 확인해주세요."
    );
  }

  const headers =
    getHeadersSafe(
      game
    );

  const history =
    game.history({
      verbose: true
    });

  let startFen =
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  if (
    headers.SetUp === "1" &&
    headers.FEN
  ) {
    startFen =
      headers.FEN;
  }

  const positions =
    [startFen];

  const replay =
    new Chess(
      startFen
    );

  for (
    const move of history
  ) {
    try {
      replay.move({
        from: move.from,
        to: move.to,
        ...(move.promotion
          ? {
              promotion:
                move.promotion
            }
          }
          : {})
      });
    } catch {
      throw new Error(
        "수순을 재구성하는 중 오류가 발생했습니다."
      );
    }

    positions.push(
      replay.fen()
    );
  }

  return {
    game,
    headers,
    history,
    positions
  };
}

function startAnalysis(
  pgn
) {
  const parsed =
    parsePGN(
      pgn
    );

  state.game =
    parsed.game;

  state.headers =
    parsed.headers;

  state.history =
    parsed.history;

  state.positions =
    parsed.positions;

  state.currentPly =
    state.history.length;

  state.analysisToken = 0;

  state.currentAnalysis =
    null;

  state.criticalResults =
    null;

  inputView.hidden =
    true;

  analysisView.hidden =
    false;

  renderBoard();
  renderMoveList();
  renderPositionMeta();

  setProgress(0);

  analyzeCurrentPosition();
}


/* =========================================================
   Example PGN
   ========================================================= */

const EXAMPLE_PGN = `[Event "Ruy Lopez Example"]
[Site "?"]
[Date "2026.01.01"]
[Round "?"]
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
   UI events
   ========================================================= */

if (exampleBtn) {
  exampleBtn.onclick =
    () => {
      pgnInput.value =
        EXAMPLE_PGN;
    };
}

if (analyzeBtn) {
  analyzeBtn.onclick =
    () => {
      errorBox.hidden =
        true;

      const pgn =
        pgnInput.value.trim();

      if (!pgn) {
        errorBox.textContent =
          "PGN을 먼저 입력해주세요.";

        errorBox.hidden =
          false;

        return;
      }

      try {
        startAnalysis(
          pgn
        );
      } catch (error) {
        errorBox.textContent =
          error.message ||
          "PGN 분석을 시작할 수 없습니다.";

        errorBox.hidden =
          false;
      }
    };
}

if (firstBtn) {
  firstBtn.onclick =
    () => {
      setCurrentPly(0);
    };
}

if (prevBtn) {
  prevBtn.onclick =
    () => {
      setCurrentPly(
        state.currentPly - 1
      );
    };
}

if (nextBtn) {
  nextBtn.onclick =
    () => {
      setCurrentPly(
        state.currentPly + 1
      );
    };
}

if (lastBtn) {
  lastBtn.onclick =
    () => {
      setCurrentPly(
        state.history.length
      );
    };
}

if (backBtn) {
  backBtn.onclick =
    () => {
      state.analysisToken++;

      state.criticalResults =
        null;

      analysisView.hidden =
        true;

      inputView.hidden =
        false;

      setProgress(0);
    };
}


/* =========================================================
   Initial engine startup
   ========================================================= */

ensureEngine()
  .catch(
    () => {
      setEngineStatus(
        "Stockfish를 불러오지 못했습니다.",
        "error"
      );
    }
  );
