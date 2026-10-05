import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

const STOCKFISH_PATH = "./stockfish/stockfish-19-lite-single.js";

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
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];

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


/* =========================================================
   기본 유틸
========================================================= */

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function oppositeColor(color) {
  return color === "w" ? "b" : "w";
}

function colorName(color) {
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

function squareColor(square) {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);

  return (file + rank) % 2 === 0 ? "light" : "dark";
}

function isCentralSquare(square) {
  return ["c3", "d3", "e3", "f3", "c4", "d4", "e4", "f4", "c5", "d5", "e5", "f5", "c6", "d6", "e6", "f6"].includes(square);
}

function isOpponentHalf(square, color) {
  const rank = Number(square[1]);

  if (color === "w") {
    return rank >= 5;
  }

  return rank <= 4;
}

function isPawnAttackedByOpponentPawn(chess, square, color) {
  const enemy = oppositeColor(color);

  for (const file of FILES) {
    for (let rank = 1; rank <= 8; rank++) {
      const from = `${file}${rank}`;
      const piece = chess.get(from);

      if (!piece || piece.color !== enemy || piece.type !== "p") {
        continue;
      }

      const fromFile = FILES.indexOf(file);
      const targetFile = FILES.indexOf(square[0]);
      const targetRank = Number(square[1]);

      if (enemy === "w") {
        if (
          targetRank === rank + 1 &&
          Math.abs(targetFile - fromFile) === 1
        ) {
          return true;
        }
      } else {
        if (
          targetRank === rank - 1 &&
          Math.abs(targetFile - fromFile) === 1
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

function hasFriendlySupport(chess, square, color) {
  const moves = chess.moves({
    square,
    verbose: true
  });

  return moves.some(move => {
    const targetPiece = chess.get(move.to);

    return (
      targetPiece &&
      targetPiece.color === color
    );
  });
}

function pieceSymbol(color, type) {
  return PIECES[color]?.[type] || "";
}


/* =========================================================
   예제 PGN
========================================================= */

const EXAMPLE_PGN = `[Event "Human Chess Insight Example"]
[Site "?"]
[Date "2026.10.05"]
[Round "1"]
[White "White"]
[Black "Black"]
[Result "*"]

1. c4 e5
2. g3 Nc6
3. Bg2 Bc5
4. e3 Nf6
5. Ne2 O-O
6. O-O d6
7. d4`;


/* =========================================================
   엔진
========================================================= */

function setEngineStatus(text, state = "") {
  els.engineStatus.textContent = text;
  els.engineStatus.className = `status ${state}`;
}

function initEngine() {
  try {
    engine = new Worker(STOCKFISH_PATH);

    engine.onmessage = handleEngineMessage;

    engine.onerror = () => {
      engineReady = false;
      engineBusy = false;
      setEngineStatus("엔진 오류", "error");
    };

    engine.postMessage("uci");
  } catch (error) {
    console.error(error);
    setEngineStatus("엔진을 불러오지 못했습니다.", "error");
  }
}

function handleEngineMessage(event) {
  const message = String(event.data || "");

  if (message === "uciok") {
    engine.postMessage("setoption name MultiPV value 3");
    engine.postMessage("isready");
    return;
  }

  if (message === "readyok") {
    engineReady = true;
    setEngineStatus("Stockfish 준비 완료", "ready");
    return;
  }

  if (message.startsWith("info")) {
    const depthMatch = message.match(/\bdepth\s+(\d+)/);
    const multipvMatch = message.match(/\bmultipv\s+(\d+)/);
    const scoreMatch = message.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
    const pvMatch = message.match(/\bpv\s+(.+)$/);

    const depth = depthMatch
      ? Number(depthMatch[1])
      : 0;

    const multiPv = multipvMatch
      ? Number(multipvMatch[1])
      : 1;

    let score = null;

    if (scoreMatch) {
      score = {
        type: scoreMatch[1],
        value: Number(scoreMatch[2])
      };
    }

    const pv = pvMatch
      ? pvMatch[1].trim().split(/\s+/)
      : [];

    engineLines[multiPv - 1] = {
      depth,
      score,
      pv
    };

    currentDepth = Math.max(currentDepth, depth);

    if (els.depthValue) {
      els.depthValue.textContent = currentDepth
        ? `d${currentDepth}`
        : "—";
    }

    return;
  }

  if (message.startsWith("bestmove")) {
    engineBusy = false;

    if (engineResolve) {
      const resolve = engineResolve;
      engineResolve = null;

      resolve(engineLines.filter(Boolean));
    }
  }
}

function analyzeWithEngine(fen, depth = 12) {
  return new Promise(resolve => {
    if (!engineReady || !engine) {
      resolve([]);
      return;
    }

    engineBusy = true;
    engineLines = [];
    currentDepth = 0;
    engineResolve = resolve;

    engine.postMessage("stop");
    engine.postMessage(`position fen ${fen}`);
    engine.postMessage(`go depth ${depth}`);
  });
}

function scoreToWhitePerspective(score) {
  if (!score) {
    return null;
  }

  if (score.type === "mate") {
    return score.value > 0
      ? 100000
      : -100000;
  }

  return score.value / 100;
}

function formatEvaluation(score) {
  if (!score) {
    return "—";
  }

  if (score.type === "mate") {
    return score.value > 0
      ? `#${score.value}`
      : `#-${Math.abs(score.value)}`;
  }

  const cp = score.value / 100;

  if (Math.abs(cp) < 0.05) {
    return "0.00";
  }

  return cp > 0
    ? `+${cp.toFixed(2)}`
    : cp.toFixed(2);
}


/* =========================================================
   게임 단계
========================================================= */

function countPieces(chess) {
  const counts = {
    w: {
      p: 0,
      n: 0,
      b: 0,
      r: 0,
      q: 0,
      k: 0
    },
    b: {
      p: 0,
      n: 0,
      b: 0,
      r: 0,
      q: 0,
      k: 0
    }
  };

  for (const file of FILES) {
    for (let rank = 1; rank <= 8; rank++) {
      const piece = chess.get(`${file}${rank}`);

      if (piece) {
        counts[piece.color][piece.type]++;
      }
    }
  }

  return counts;
}

function getGamePhase(chess, ply = 0) {
  const counts = countPieces(chess);

  const queens = counts.w.q + counts.b.q;
  const rooks = counts.w.r + counts.b.r;
  const minors =
    counts.w.n +
    counts.w.b +
    counts.b.n +
    counts.b.b;

  const nonPawnMaterial =
    counts.w.n * PIECE_VALUES.n +
    counts.w.b * PIECE_VALUES.b +
    counts.w.r * PIECE_VALUES.r +
    counts.w.q * PIECE_VALUES.q +
    counts.b.n * PIECE_VALUES.n +
    counts.b.b * PIECE_VALUES.b +
    counts.b.r * PIECE_VALUES.r +
    counts.b.q * PIECE_VALUES.q;

  /*
    퀸이 없다는 이유 하나만으로 엔드게임이라고 하지 않는다.
    실제 남은 기물의 양을 함께 본다.
  */

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
    (
      counts.w.q >= 1 ||
      counts.b.q >= 1
    )
  ) {
    return "오프닝";
  }

  if (
    queens >= 1 &&
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
   물질 분석
========================================================= */

function analyzeMaterial(chess) {
  const counts = countPieces(chess);

  const material = {
    w: 0,
    b: 0
  };

  for (const color of ["w", "b"]) {
    for (const type of ["p", "n", "b", "r", "q"]) {
      material[color] +=
        counts[color][type] *
        PIECE_VALUES[type];
    }
  }

  const difference =
    material.w - material.b;

  let text = "물질적으로 균형이 맞습니다.";

  if (difference > 0.2) {
    text =
      `백이 약 ${difference.toFixed(1)}점의 물질적 우세를 가지고 있습니다.`;
  } else if (difference < -0.2) {
    text =
      `흑이 약 ${Math.abs(difference).toFixed(1)}점의 물질적 우세를 가지고 있습니다.`;
  }

  return {
    counts,
    material,
    difference,
    text
  };
}


/* =========================================================
   비숍 분석
========================================================= */

function getBishopDiagonalInfo(chess, square, color) {
  const fileIndex = FILES.indexOf(square[0]);
  const rank = Number(square[1]);

  const directions = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1]
  ];

  const result = [];

  for (const [df, dr] of directions) {
    let file = fileIndex + df;
    let nextRank = rank + dr;

    const ray = [];
    let blocker = null;

    while (
      file >= 0 &&
      file < 8 &&
      nextRank >= 1 &&
      nextRank <= 8
    ) {
      const target = `${FILES[file]}${nextRank}`;
      ray.push(target);

      const piece = chess.get(target);

      if (piece) {
        blocker = {
          square: target,
          piece
        };
        break;
      }

      file += df;
      nextRank += dr;
    }

    result.push({
      direction: [df, dr],
      squares: ray,
      blocker
    });
  }

  return result;
}

function getCentralPawnBlockers(chess, square, color) {
  const info = getBishopDiagonalInfo(chess, square, color);

  const blockers = [];

  for (const diagonal of info) {
    if (!diagonal.blocker) {
      continue;
    }

    const blocker = diagonal.blocker;

    if (
      blocker.piece.color === color &&
      blocker.piece.type === "p" &&
      isCentralSquare(blocker.square)
    ) {
      blockers.push(blocker);
    }
  }

  return blockers;
}

function getBishopLegalMoves(chess, square) {
  try {
    return chess.moves({
      square,
      verbose: true
    });
  } catch {
    return [];
  }
}

function bishopContactsOpponent(chess, square, color) {
  const info = getBishopDiagonalInfo(chess, square, color);

  for (const diagonal of info) {
    if (!diagonal.blocker) {
      continue;
    }

    if (
      diagonal.blocker.piece.color === oppositeColor(color)
    ) {
      return true;
    }
  }

  return false;
}

function bishopActivityScore(chess, square, color) {
  const legalMoves = getBishopLegalMoves(chess, square);

  const emptyMoves = legalMoves.filter(move => {
    return !chess.get(move.to);
  });

  const captures = legalMoves.filter(move => {
    return move.captured;
  });

  const contacts = bishopContactsOpponent(
    chess,
    square,
    color
  );

  const centralPawnBlockers =
    getCentralPawnBlockers(
      chess,
      square,
      color
    );

  let score = 0;

  score += Math.min(emptyMoves.length, 7) * 0.7;
  score += captures.length * 1.2;

  if (contacts) {
    score += 2.0;
  }

  score -= centralPawnBlockers.length * 1.1;

  return {
    score,
    legalMoves,
    emptyMoves,
    captures,
    contacts,
    centralPawnBlockers
  };
}

function getBishopImprovementMoves(chess, square, color) {
  const moves = getBishopLegalMoves(chess, square);

  const scored = moves.map(move => {
    let score = 0;

    if (isCentralSquare(move.to)) {
      score += 1;
    }

    if (isOpponentHalf(move.to, color)) {
      score += 1;
    }

    if (move.captured) {
      score += 1.5;
    }

    return {
      move,
      score
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored
    .slice(0, 3)
    .map(item => item.move.to);
}

function describeBishop(chess, square, color) {
  const activity = bishopActivityScore(
    chess,
    square,
    color
  );

  const centralBlockers =
    activity.centralPawnBlockers;

  const legalMoves = activity.legalMoves;
  const moveCount = legalMoves.length;

  const contactsOpponent =
    activity.contacts;

  let label = "활동적인 비숍";
  let explanation = "";
  let improvement = "";

  /*
    강한 판정을 피한다.
    단순히 폰 하나가 대각선을 막았다고
    나쁜 비숍이라고 하지 않는다.
  */

  if (
    centralBlockers.length >= 2 &&
    moveCount <= 4 &&
    !contactsOpponent
  ) {
    label = "나쁜 비숍";

    explanation =
      `${colorName(color)}의 ${square} 비숍은 자기 중앙 폰들에 의해 여러 대각선의 활동이 제한되어 있습니다. 현재 구조에서는 비숍이 장기적으로 활동할 공간이 좁습니다.`;

    improvement =
      "비숍의 활동을 방해하는 폰 구조를 바꾸거나 더 좋은 대각선으로 이동할 방법을 찾는 것이 중요합니다.";
  } else if (
    centralBlockers.length >= 1 &&
    moveCount <= 6 &&
    !contactsOpponent
  ) {
    label = "활동이 제한된 비숍";

    const blockerSquares =
      centralBlockers
        .map(item => item.square)
        .join(", ");

    explanation =
      `${colorName(color)}의 ${square} 비숍은 ${blockerSquares}의 자기 폰 때문에 한쪽 이상의 주요 대각선 활동이 제한되어 있습니다. 다만 현재 위치에서 나갈 수 있는 길이 남아 있어 아직 나쁜 비숍이라고 단정할 정도는 아닙니다.`;

    improvement =
      "더 좋은 대각선을 확보하거나 현재 폰 구조가 비숍의 활동을 방해하지 않도록 배치하는 방법을 살펴볼 수 있습니다.";
  } else if (
    centralBlockers.length >= 1 &&
    contactsOpponent
  ) {
    label = "활동적인 비숍";

    explanation =
      `${colorName(color)}의 ${square} 비숍은 일부 대각선이 자기 폰에 의해 제한되어 있지만, 현재 다른 대각선을 통해 실제로 상대 기물이나 폰과 접촉하고 있어 활동성이 유지되고 있습니다.`;

    improvement =
      "현재의 활동을 유지하면서 더 영향력이 큰 대각선을 확보할 수 있는지 살펴보는 것이 좋습니다.";
  } else if (
    contactsOpponent ||
    activity.score >= 4
  ) {
    label = "활동적인 비숍";

    explanation =
      `${colorName(color)}의 ${square} 비숍은 열린 대각선을 통해 실제로 상대 기물이나 폰에 영향을 줄 수 있어 활동적인 상태입니다.`;

    improvement =
      "현재의 활동을 유지하면서 더 중요한 대상을 압박할 수 있는 대각선을 찾는 것이 좋습니다.";
  } else {
    label = "개선 여지가 있는 비숍";

    explanation =
      `${colorName(color)}의 ${square} 비숍은 현재 이동할 수 있는 대각선이 제한적입니다. 당장 나쁜 비숍이라고 할 정도는 아니지만 더 좋은 위치를 찾을 여지가 있습니다.`;

    improvement =
      "비숍이 더 넓은 대각선이나 중요한 대상을 바라볼 수 있도록 위치를 개선하는 방법을 찾아볼 수 있습니다.";
  }

  const improvementMoves =
    getBishopImprovementMoves(
      chess,
      square,
      color
    );

  if (
    improvementMoves.length > 0 &&
    label !== "활동적인 비숍"
  ) {
    improvement +=
      ` 현재 위치에서는 ${improvementMoves.join(", ")} 같은 경로를 검토할 수 있습니다.`;
  }

  return {
    square,
    color,
    type: "b",
    label,
    explanation,
    improvement,
    legalMoveCount: moveCount,
    centralBlockers,
    contactsOpponent,
    improvementMoves,
    activityScore: activity.score
  };
}


/* =========================================================
   나이트 분석
========================================================= */

function squareCanBeAttackedByEnemyPawn(chess, square, color) {
  return isPawnAttackedByOpponentPawn(
    chess,
    square,
    color
  );
}

function isKnightOutpostCandidate(chess, square, color) {
  if (!isOpponentHalf(square, color)) {
    return false;
  }

  if (squareCanBeAttackedByEnemyPawn(chess, square, color)) {
    return false;
  }

  const piece = chess.get(square);

  if (piece && piece.color !== color) {
    return false;
  }

  const supported =
    hasFriendlySupport(
      chess,
      square,
      color
    );

  return supported;
}

function findKnightOutposts(chess, color) {
  const candidates = [];

  for (const file of FILES) {
    for (let rank = 1; rank <= 8; rank++) {
      const square = `${file}${rank}`;

      if (
        isKnightOutpostCandidate(
          chess,
          square,
          color
        )
      ) {
        let score = 0;

        if (isCentralSquare(square)) {
          score += 2;
        }

        if (hasFriendlySupport(chess, square, color)) {
          score += 2;
        }

        if (
          !squareCanBeAttackedByEnemyPawn(
            chess,
            square,
            color
          )
        ) {
          score += 2;
        }

        candidates.push({
          square,
          score
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

function analyzeKnight(chess, square, color) {
  const moves = chess.moves({
    square,
    verbose: true
  });

  const legalMoves = moves.length;

  const usefulMoves = moves.filter(move => {
    return (
      isOpponentHalf(move.to, color) ||
      isCentralSquare(move.to) ||
      Boolean(move.captured)
    );
  });

  const outpostCandidates =
    findKnightOutposts(
      chess,
      color
    );

  let label = "기동 가능한 나이트";
  let explanation =
    `${colorName(color)}의 ${square} 나이트는 ${legalMoves}개의 합법적인 이동을 가지고 있습니다.`;

  let improvement = "";

  if (outpostCandidates.length > 0) {
    const best =
      outpostCandidates[0].square;

    label = "지원점을 찾을 수 있는 나이트";

    explanation +=
      ` 특히 ${best} 같은 안정적인 지원점을 확보할 가능성이 있습니다.`;

    improvement =
      "상대 폰에게 쉽게 쫓겨나지 않고 자기 기물이나 폰의 지원을 받을 수 있는 위치를 확보하는 것이 중요합니다.";
  } else if (usefulMoves.length >= 4) {
    label = "활동적인 나이트";

    explanation +=
      " 중앙이나 상대 진영으로 진입할 수 있는 선택지가 충분해 활동 범위가 괜찮습니다.";

    improvement =
      "단순히 전진하는 것보다 실제로 유지할 수 있고 상대에게 불편을 주는 위치를 찾는 것이 중요합니다.";
  } else {
    label = "개선 여지가 있는 나이트";

    explanation +=
      " 현재 유용하게 사용할 수 있는 이동이 많지 않아 더 좋은 위치를 찾을 필요가 있습니다.";

    improvement =
      "상대 폰에게 쉽게 쫓겨나지 않으면서 지원받을 수 있는 안정적인 위치를 찾는 것이 좋습니다.";
  }

  return {
    square,
    color,
    type: "n",
    label,
    explanation,
    improvement,
    legalMoveCount: legalMoves,
    usefulMoveCount: usefulMoves.length,
    outpostCandidates,
    activityScore:
      usefulMoves.length +
      outpostCandidates.length * 2
  };
}


/* =========================================================
   전체 기물 활동성
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
    all: [],
    summary: "",
    dominantSide: null
  };

  for (const color of ["w", "b"]) {
    for (const file of FILES) {
      for (let rank = 1; rank <= 8; rank++) {
        const square = `${file}${rank}`;
        const piece = chess.get(square);

        if (!piece || piece.color !== color) {
          continue;
        }

        if (piece.type === "b") {
          const bishop =
            describeBishop(
              chess,
              square,
              color
            );

          result[color].bishops.push(bishop);
          result.all.push(bishop);
        }

        if (piece.type === "n") {
          const knight =
            analyzeKnight(
              chess,
              square,
              color
            );

          result[color].knights.push(knight);
          result.all.push(knight);
        }
      }
    }
  }

  const whiteScore =
    result.w.bishops.reduce(
      (sum, item) => sum + item.activityScore,
      0
    ) +
    result.w.knights.reduce(
      (sum, item) => sum + item.activityScore,
      0
    );

  const blackScore =
    result.b.bishops.reduce(
      (sum, item) => sum + item.activityScore,
      0
    ) +
    result.b.knights.reduce(
      (sum, item) => sum + item.activityScore,
      0
    );

  if (whiteScore > blackScore + 2) {
    result.dominantSide = "w";
  } else if (blackScore > whiteScore + 2) {
    result.dominantSide = "b";
  }

  if (result.dominantSide) {
    result.summary =
      `${colorName(result.dominantSide)}의 기물이 현재 더 넓은 활동 범위와 선택지를 가지고 있습니다.`;
  } else {
    result.summary =
      "양쪽 기물의 활동성에 뚜렷한 차이가 크지 않습니다.";
  }

  return result;
}


/* =========================================================
   포지션 스냅샷
========================================================= */

function createPositionSnapshot(chess, ply) {
  const material = analyzeMaterial(chess);
  const minorPieces =
    analyzeMinorPieces(chess);

  const phase =
    getGamePhase(
      chess,
      ply
    );

  return {
    phase,
    material,
    minorPieces,

    /*
      다음 단계에서 채울 영역.
    */
    pawnStructure: null,
    weakSquares: null,
    space: null,
    openFiles: null,
    development: null,
    initiative: null,
    kingSafety: null,

    dominantImbalance: null,
    sideOfBoard: null,
    counterplay: null,
    preventivePlan: null,
    fantasyPosition: null,
    candidates: []
  };
}


/* =========================================================
   포지션 생성
========================================================= */

function buildPositions(chess) {
  const history = chess.history({
    verbose: true
  });

  const replay = new Chess();

  const result = [];

  result.push({
    ply: 0,
    fen: replay.fen(),
    move: null,
    san: null
  });

  for (let i = 0; i < history.length; i++) {
    const move = history[i];

    replay.move({
      from: move.from,
      to: move.to,
      promotion: move.promotion
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
   보드
========================================================= */

function renderBoard(fen) {
  const position = new Chess(fen);
  const board = position.board();

  els.board.innerHTML = "";

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const square = `${FILES[col]}${8 - row}`;
      const piece = board[row][col];

      const cell = document.createElement("div");

      cell.className =
        `sq ${squareColor(square)}`;

      cell.dataset.square = square;

      if (piece) {
        cell.textContent =
          pieceSymbol(
            piece.color,
            piece.type
          );
      }

      els.board.appendChild(cell);
    }
  }
}


/* =========================================================
   수순 목록
========================================================= */

function renderMoveList() {
  els.moveList.innerHTML = "";

  const movePositions =
    positions.slice(1);

  for (let i = 0; i < movePositions.length; i += 2) {
    const white = movePositions[i];
    const black = movePositions[i + 1];

    const row = document.createElement("div");

    row.className = "moveRow";

    const number = document.createElement("span");
    number.className = "moveNumber";
    number.textContent = `${Math.floor(i / 2) + 1}.`;

    row.appendChild(number);

    const whiteBtn = document.createElement("button");
    whiteBtn.className = "moveButton";
    whiteBtn.textContent = white?.san || "";

    if (white) {
      whiteBtn.dataset.ply = white.ply;
    }

    const blackBtn = document.createElement("button");
    blackBtn.className = "moveButton";
    blackBtn.textContent = black?.san || "";

    if (black) {
      blackBtn.dataset.ply = black.ply;
    }

    row.appendChild(whiteBtn);
    row.appendChild(blackBtn);

    els.moveList.appendChild(row);
  }

  els.moveList
    .querySelectorAll(".moveButton")
    .forEach(button => {
      button.addEventListener("click", () => {
        const ply = Number(button.dataset.ply);

        if (!Number.isNaN(ply)) {
          goToPly(ply);
        }
      });
    });
}


/* =========================================================
   평가
========================================================= */

function setProgress(value) {
  if (!els.progressBar) {
    return;
  }

  els.progressBar.style.width =
    `${clamp(value, 0, 100)}%`;
}

function renderEvaluation(lines) {
  if (!lines || lines.length === 0) {
    els.evalValue.textContent = "—";
    els.depthValue.textContent = "—";
    return;
  }

  const best = lines[0];

  els.evalValue.textContent =
    formatEvaluation(best.score);

  els.depthValue.textContent =
    best.depth
      ? `d${best.depth}`
      : "—";
}

function evaluationLanguage(lines) {
  if (!lines || !lines[0]) {
    return "현재 포지션을 평가하고 있습니다.";
  }

  const score =
    scoreToWhitePerspective(
      lines[0].score
    );

  if (score === null) {
    return "현재 포지션을 평가하고 있습니다.";
  }

  const abs = Math.abs(score);

  if (abs < 0.3) {
    return "현재 포지션은 대체로 균형에 가깝습니다. 작은 차이보다 어떤 불균형을 활용할지가 중요합니다.";
  }

  if (abs < 1) {
    return score > 0
      ? "백이 약간 더 편안한 포지션입니다. 작은 우세를 어떻게 유지하고 키울지가 중요합니다."
      : "흑이 약간 더 편안한 포지션입니다. 작은 우세를 어떻게 유지하고 키울지가 중요합니다.";
  }

  if (abs < 2) {
    return score > 0
      ? "백에게 분명한 우세가 있습니다. 우세의 원인이 무엇인지 확인하고 상대의 반격을 줄이는 것이 중요합니다."
      : "흑에게 분명한 우세가 있습니다. 우세의 원인이 무엇인지 확인하고 상대의 반격을 줄이는 것이 중요합니다.";
  }

  if (abs < 4) {
    return score > 0
      ? "백이 상당한 우세를 가지고 있습니다. 가장 중요한 불균형을 활용하면서 상대의 반격을 허용하지 않는 것이 중요합니다."
      : "흑이 상당한 우세를 가지고 있습니다. 가장 중요한 불균형을 활용하면서 상대의 반격을 허용하지 않는 것이 중요합니다.";
  }

  return score > 0
    ? "백 쪽으로 평가가 크게 기울어 있습니다."
    : "흑 쪽으로 평가가 크게 기울어 있습니다.";
}


/* =========================================================
   후보 수
========================================================= */

function pvToText(pv) {
  if (!pv || pv.length === 0) {
    return "—";
  }

  return pv
    .slice(0, 5)
    .join(" ");
}

function renderCandidates(lines) {
  els.candidateList.innerHTML = "";

  if (!lines || lines.length === 0) {
    els.candidateList.innerHTML =
      `<div class="candidate">
        <strong>분석 중</strong>
        <span>엔진이 후보 수를 계산하고 있습니다.</span>
      </div>`;

    return;
  }

  lines.slice(0, 3).forEach((line, index) => {
    const item = document.createElement("div");

    item.className = "candidate";

    const title =
      index === 0
        ? "엔진 추천"
        : `후보 ${index + 1}`;

    const score =
      formatEvaluation(line.score);

    item.innerHTML = `
      <div>
        <strong>${title}</strong>
        <span>${pvToText(line.pv)}</span>
      </div>
      <b>${score}</b>
    `;

    els.candidateList.appendChild(item);
  });
}


/* =========================================================
   사람의 관점
========================================================= */

function renderFactors(snapshot) {
  const material = snapshot.material;
  const minor = snapshot.minorPieces;

  const items = [];

  items.push({
    title: "게임 단계",
    text:
      `현재 ${snapshot.phase}입니다.`
  });

  items.push({
    title: "기물의 개수",
    text:
      material.text
  });

  /*
    이번 단계의 핵심.
  */
  for (const color of ["w", "b"]) {
    const bishops =
      minor[color].bishops;

    const knights =
      minor[color].knights;

    for (const bishop of bishops) {
      items.push({
        title:
          `${colorName(color)} ${bishop.square} · ${bishop.label}`,
        text:
          `${bishop.explanation} ${bishop.improvement}`
      });
    }

    for (const knight of knights) {
      items.push({
        title:
          `${colorName(color)} ${knight.square} · ${knight.label}`,
        text:
          `${knight.explanation} ${knight.improvement}`
      });
    }
  }

  /*
    아직 구현하지 않은 항목은
    분석 완료라고 거짓말하지 않는다.
  */
  items.push({
    title: "폰 구조",
    text:
      "다음 단계에서 폰의 약점과 강점, 고립폰·더블폰·패스드폰 등을 분석합니다."
  });

  items.push({
    title: "공간",
    text:
      "다음 단계에서 어느 쪽이 더 많은 공간을 가지고 있는지와 그 공간이 실제로 어떤 의미를 가지는지 분석합니다."
  });

  items.push({
    title: "킹의 안전",
    text:
      "다음 단계에서 킹 주변의 안전성과 공격 가능성을 별도로 분석합니다."
  });

  if (minor.dominantSide) {
    items.push({
      title: "현재의 생각",
      text:
        minor.summary
    });
  } else {
    items.push({
      title: "현재의 생각",
      text:
        "현재 기물의 활동성만 놓고 보면 한쪽이 압도적으로 유리하다고 보기는 어렵습니다. 폰 구조와 공간을 함께 봐야 어느 불균형이 더 중요한지 판단할 수 있습니다."
    });
  }

  els.humanFactors.innerHTML = "";

  for (const item of items) {
    const factor = document.createElement("div");

    factor.className = "factor";

    factor.innerHTML = `
      <strong>${item.title}</strong>
      <p>${item.text}</p>
    `;

    els.humanFactors.appendChild(factor);
  }
}


/* =========================================================
   현재 포지션 분석
========================================================= */

async function analyzeCurrentPosition() {
  if (!positions[currentPly]) {
    return;
  }

  const position = positions[currentPly];

  const chess = new Chess(position.fen);

  currentSnapshot =
    createPositionSnapshot(
      chess,
      currentPly
    );

  renderBoard(position.fen);

  els.moveLabel.textContent =
    `${currentPly} / ${totalPlies}`;

  if (currentPly === 0) {
    els.positionLabel.textContent =
      "시작 포지션";
  } else {
    const moveNumber =
      Math.ceil(currentPly / 2);

    const side =
      currentPly % 2 === 1
        ? "백"
        : "흑";

    els.positionLabel.textContent =
      `${moveNumber}. ${side}의 수 이후`;
  }

  renderFactors(currentSnapshot);

  els.positionInsight.textContent =
    evaluationLanguage([]);

  setProgress(10);

  const lines =
    await analyzeWithEngine(
      position.fen,
      12
    );

  renderEvaluation(lines);
  renderCandidates(lines);

  els.positionInsight.textContent =
    evaluationLanguage(lines);

  setProgress(100);
}


/* =========================================================
   PGN 분석
========================================================= */

function showError(message) {
  els.errorBox.hidden = false;
  els.errorBox.textContent = message;
}

function clearError() {
  els.errorBox.hidden = true;
  els.errorBox.textContent = "";
}

function analyzePGN() {
  clearError();

  const pgn =
    els.pgnInput.value.trim();

  if (!pgn) {
    showError("PGN을 입력해주세요.");
    return;
  }

  const parsed =
    new Chess();

  try {
    parsed.loadPgn(pgn);
  } catch (error) {
    console.error(error);
    showError(
      "PGN을 읽지 못했습니다. 수순이나 PGN 형식을 확인해주세요."
    );
    return;
  }

  game = parsed;

  positions =
    buildPositions(game);

  totalPlies =
    positions.length - 1;

  currentPly = 0;

  els.inputView.hidden = true;
  els.analysisView.hidden = false;

  els.gameMeta.textContent =
    `${totalPlies}수`;

  renderMoveList();

  setProgress(5);

  analyzeCurrentPosition();
}


/* =========================================================
   이동
========================================================= */

function goToPly(ply) {
  const next =
    clamp(
      ply,
      0,
      totalPlies
    );

  currentPly = next;

  analyzeCurrentPosition();
}

function goFirst() {
  goToPly(0);
}

function goPrevious() {
  goToPly(currentPly - 1);
}

function goNext() {
  goToPly(currentPly + 1);
}

function goLast() {
  goToPly(totalPlies);
}


/* =========================================================
   이벤트
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
  goFirst
);

els.prevBtn.addEventListener(
  "click",
  goPrevious
);

els.nextBtn.addEventListener(
  "click",
  goNext
);

els.lastBtn.addEventListener(
  "click",
  goLast
);

els.backBtn.addEventListener(
  "click",
  () => {
    els.analysisView.hidden = true;
    els.inputView.hidden = false;
    clearError();
  }
);


/* =========================================================
   시작
========================================================= */

setEngineStatus(
  "엔진 준비 중…",
  "loading"
);

initEngine();
