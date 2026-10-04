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
function showError(text) { els.errorBox.textContent = text; els.errorBox.hidden = false; }
function clearError() { els.errorBox.hidden = true; els.errorBox.textContent = ""; }
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
    const timer = setTimeout(() => reject(new Error("Stockfish 로딩 시간이 초과되었습니다.")), 30000);

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
  if (score.type === "cp") return (turn === "w" ? score.raw : -score.raw) / 100;
  const sign = score.raw > 0 ? 1 : -1;
  return turn === "w" ? sign * 100 : -sign * 100;
}

function formatScore(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (Math.abs(value) >= 99) return value > 0 ? "+M" : "−M";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}`;
}

function scoreLabel(value) {
  const a = Math.abs(value ?? 0);
  if (a < 0.25) return "균형에 가까운 포지션입니다.";
  if (a < 0.8) return value > 0 ? "백이 조금 더 편한 포지션입니다." : "흑이 조금 더 편한 포지션입니다.";
  if (a < 1.8) return value > 0 ? "백에게 뚜렷한 실전적 우세가 있습니다." : "흑에게 뚜렷한 실전적 우세가 있습니다.";
  if (a < 3.5) return value > 0 ? "백의 우세가 상당합니다." : "흑의 우세가 상당합니다.";
  return value > 0 ? "백 쪽으로 크게 기울었습니다." : "흑 쪽으로 크게 기울었습니다.";
}

function uciToSan(fen, uci) {
  try {
    const c = new Chess(fen);
    const move = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
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
  if (engineReady && engine) engine.postMessage("stop");
}

function analyzeFen(fen, depth = 10) {
  if (analysisCache.has(fen)) return Promise.resolve(analysisCache.get(fen));
  if (!engineReady || !engine) return Promise.reject(new Error("Stockfish가 아직 준비되지 않았습니다."));

  cancelCurrentAnalysis();

  return new Promise((resolve, reject) => {
    const token = ++analysisToken;
    const turn = fen.split(" ")[1];
    const result = { fen, turn, lines: new Map(), depth: 0 };
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
          const d = depthIndex >= 0 ? Number(tokens[depthIndex + 1]) : 0;
          const multiPv = multiPvIndex >= 0 ? Number(tokens[multiPvIndex + 1]) : 1;
          const score = whiteScore(parseScore(tokens), turn);
          const pv = pvIndex >= 0 ? tokens.slice(pvIndex + 1) : [];

          result.depth = Math.max(result.depth, d);
          if (score !== null && pv.length) result.lines.set(multiPv, { score, pv });
          if (d > 0) renderProgress(Math.min(95, (d / depth) * 100), d);
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
  list.push({ ply: 0, fen: c.fen(), san: null, uci: null });
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
  const white = { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕", k: "♔" };
  const black = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" };
  els.board.innerHTML = "";
  board.forEach((row, ri) => row.forEach((piece, ci) => {
    const square = document.createElement("div");
    square.className = `sq ${(ri + ci) % 2 === 0 ? "light" : "dark"}`;
    if (piece) square.textContent = piece.color === "w" ? white[piece.type] : black[piece.type];
    els.board.appendChild(square);
  }));
}

function renderMoves() {
  els.moveList.innerHTML = "";
  positions.forEach((position, index) => {
    if (index === 0) return;
    const button = document.createElement("button");
    button.className = `moveItem ${index === currentPly ? "active" : ""}`;
    button.textContent = `${Math.ceil(index / 2)}${index % 2 ? "." : "…"} ${position.san}`;
    button.onclick = () => selectPly(index);
    els.moveList.appendChild(button);
  });
}

function renderFactors(fen) {
  const c = new Chess(fen);
  const board = c.board();
  let material = 0;
  const values = { p: 1, n: 3.2, b: 3.3, r: 5, q: 9, k: 0 };
  board.flat().forEach(piece => {
    if (piece) material += (piece.color === "w" ? 1 : -1) * values[piece.type];
  });
  const side = c.turn() === "w" ? "백" : "흑";
  els.humanFactors.innerHTML = [
    ["물질", Math.abs(material) < 0.3 ? "기물 가치가 거의 동일합니다." : "기물 가치 차이가 있습니다."],
    ["기물 활동", `${side} 차례에서 활동성이 낮은 기물을 먼저 찾아보세요.`],
    ["킹 안전", c.isCheck() ? "현재 체크 상태입니다." : "킹 주변의 안전과 상대의 공격 가능성을 확인하세요."],
    ["계획", `현재 ${side}의 차례입니다. 내 계획과 함께 상대의 다음 위협을 확인하세요.`]
  ].map(([title, text]) => `<div class="factor"><b>${title}</b><span>${text}</span></div>`).join("");
}

function renderAnalysis(result) {
  const position = positions[currentPly];
  const evaluation = result.lines[0]?.score ?? null;
  els.evalValue.textContent = formatScore(evaluation);
  els.positionInsight.textContent = scoreLabel(evaluation);
  els.depthValue.textContent = result.depth || "—";
  els.progressBar.style.width = "100%";
  els.candidateList.innerHTML = "";

  const labels = ["엔진 최선", "전략적 후보", "실전적 후보"];
  const descriptions = [
    "현재 포지션에서 엔진 평가를 가장 잘 유지하는 수입니다.",
    "최선과 평가 차이가 작을 때 계획 선택지로 볼 수 있습니다.",
    "평가를 크게 훼손하지 않으면서 실전에서 이해하기 쉬운 선택지입니다."
  ];

  result.lines.slice(0, 3).forEach((line, index) => {
    const san = uciToSan(position.fen, line.pv[0] || "");
    els.candidateList.insertAdjacentHTML("beforeend",
      `<div class="candidate"><div class="candidateTop"><span class="candidateName">${index + 1}. ${san} · ${labels[index]}</span><span class="candidateScore">${formatScore(line.score)}</span></div><div class="candidateDesc">${descriptions[index]}</div></div>`
    );
  });

  renderFactors(position.fen);
}

async function selectPly(ply) {
  currentPly = Math.max(0, Math.min(positions.length - 1, ply));
  const position = positions[currentPly];
  renderBoard(position.fen);
  renderMoves();
  els.moveLabel.textContent = `${currentPly} / ${positions.length - 1}`;
  els.positionLabel.textContent = currentPly === 0
    ? "시작 포지션"
    : `${Math.ceil(currentPly / 2)}${currentPly % 2 ? ". " : "… "}${position.san}`;
  els.firstBtn.disabled = currentPly === 0;
  els.prevBtn.disabled = currentPly === 0;
  els.nextBtn.disabled = currentPly === positions.length - 1;
  els.lastBtn.disabled = currentPly === positions.length - 1;
  clearError();
  renderProgress(0, 0);
  els.evalValue.textContent = "분석 중…";
  els.candidateList.innerHTML = "";
  renderFactors(position.fen);

  try {
    const result = await analyzeFen(position.fen, 10);
    if (ply === currentPly) renderAnalysis(result);
  } catch (error) {
    if (error.message !== "이전 분석이 취소되었습니다." && ply === currentPly) showError(error.message || "분석에 실패했습니다.");
  }
}

async function startGame() {
  clearError();
  const text = els.pgnInput.value.trim();
  if (!text) {
    showError("PGN을 입력해주세요.");
    return;
  }

  let chess = new Chess();
  try {
    chess.loadPgn(text, { strict: false });
  } catch {
    showError("PGN을 읽을 수 없습니다. 수순 형식과 PGN 태그를 확인해주세요.");
    return;
  }

  positions = buildPositions(chess);
  currentPly = 0;
  analysisCache.clear();
  els.inputView.hidden = true;
  els.analysisView.hidden = false;
  els.gameMeta.textContent = `${positions.length - 1}수`;
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
  try { await startGame(); } finally { els.analyzeBtn.disabled = false; }
};
els.backBtn.onclick = () => {
  cancelCurrentAnalysis();
  els.analysisView.hidden = true;
  els.inputView.hidden = false;
};
els.firstBtn.onclick = () => selectPly(0);
els.prevBtn.onclick = () => selectPly(currentPly - 1);
els.nextBtn.onclick = () => selectPly(currentPly + 1);
els.lastBtn.onclick = () => selectPly(positions.length - 1);

initEngine().catch(() => {});
