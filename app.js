import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

const $ = id => document.getElementById(id);
const els = {
  inputView:$("inputView"), analysisView:$("analysisView"), pgnInput:$("pgnInput"),
  exampleBtn:$("exampleBtn"), analyzeBtn:$("analyzeBtn"), backBtn:$("backBtn"),
  errorBox:$("errorBox"), engineStatus:$("engineStatus"), board:$("board"),
  positionLabel:$("positionLabel"), moveLabel:$("moveLabel"), gameMeta:$("gameMeta"),
  moveList:$("moveList"), firstBtn:$("firstBtn"), prevBtn:$("prevBtn"),
  nextBtn:$("nextBtn"), lastBtn:$("lastBtn"), evalValue:$("evalValue"),
  depthValue:$("depthValue"), progressBar:$("progressBar"), positionInsight:$("positionInsight"),
  candidateList:$("candidateList"), humanFactors:$("humanFactors")
};

const ENGINE_PATH = new URL("stockfish-19-lite-single.js", import.meta.url).toString();
const EXAMPLE_PGN = `[Event "Human Chess Insight Example"]\n[Site "Local"]\n[Date "2026.10.05"]\n[Round "1"]\n[White "White"]\n[Black "Black"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 *`;
const FILES=["a","b","c","d","e","f","g","h"];
const PIECE={w:{p:"♙",n:"♘",b:"♗",r:"♖",q:"♕",k:"♔"},b:{p:"♟",n:"♞",b:"♝",r:"♜",q:"♛",k:"♚"}};
const VALUE={p:1,n:3.2,b:3.3,r:5,q:9,k:0};

let engine=null, engineReady=false, engineBoot=null, activeJob=null;
let positions=[], currentPly=0, currentToken=0, cache=new Map();

function status(t,c="loading"){els.engineStatus.textContent=t;els.engineStatus.className=`status ${c}`;}
function error(t){els.errorBox.textContent=t;els.errorBox.hidden=false;}
function clearError(){els.errorBox.hidden=true;els.errorBox.textContent="";}
function progress(p,d=0){els.progressBar.style.width=`${Math.max(0,Math.min(100,p))}%`;els.depthValue.textContent=d?`d${d}`:"—";}
function opposite(c){return c==="w"?"b":"w";}
function sideName(c){return c==="w"?"백":"흑";}
function sq(file,rank){return `${FILES[file]}${rank}`;}
function coords(s){return [FILES.indexOf(s[0]),Number(s[1])];}
function boardPiece(chess,s){const [f,r]=coords(s);return chess.board()[8-r][f];}
function allPieces(chess,color,type){const out=[];for(let r=8;r>=1;r--)for(let f=0;f<8;f++){const p=chess.get(sq(f,r));if(p&&p.color===color&&(!type||p.type===type))out.push({square:sq(f,r),piece:p});}return out;}
function pieceCount(chess,color,type){return allPieces(chess,color,type).length;}

function parseScore(tokens){const i=tokens.indexOf("score");if(i<0)return null;const type=tokens[i+1], raw=Number(tokens[i+2]);return Number.isFinite(raw)&&["cp","mate"].includes(type)?{type,raw}:null;}
function whiteScore(score,turn){if(!score)return null;if(score.type==="cp")return (turn==="w"?score.raw:-score.raw)/100;const sign=score.raw>=0?1:-1;return (turn==="w"?sign:-sign)*100;}
function formatScore(v){if(v==null||Number.isNaN(v))return "—";if(Math.abs(v)>=99)return v>0?"+M":"−M";return `${v>=0?"+":"−"}${Math.abs(v).toFixed(2)}`;}
function scoreLanguage(v){const a=Math.abs(v??0);if(a<.2)return "현재 포지션은 대체로 균형에 가깝습니다.";if(a<.8)return v>0?"백이 약간 더 편안한 포지션입니다.":"흑이 약간 더 편안한 포지션입니다.";if(a<1.8)return v>0?"백에게 분명한 실전적 우세가 있습니다.":"흑에게 분명한 실전적 우세가 있습니다.";if(a<3.5)return v>0?"백이 상당한 우세를 가지고 있습니다.":"흑이 상당한 우세를 가지고 있습니다.";return v>0?"백 쪽으로 평가가 크게 기울어 있습니다.":"흑 쪽으로 평가가 크게 기울어 있습니다.";}
function uciSan(fen,uci){try{const c=new Chess(fen);const m=c.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]});return m?.san||uci;}catch{return uci;}}
function pvSan(fen,pv){const c=new Chess(fen),out=[];for(const u of pv){try{const m=c.move({from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]});if(!m)break;out.push(m.san);}catch{break;}}return out.join(" ");}

function initEngine(){
  if(engineBoot)return engineBoot;
  engineBoot=new Promise((resolve,reject)=>{
    status("Stockfish 로딩 중…","loading");
    let worker;
    try{worker=new Worker(ENGINE_PATH);}catch(e){reject(e);return;}
    engine=worker;let phase="uci";
    const timer=setTimeout(()=>{if(!engineReady){try{worker.terminate();}catch{}reject(new Error("Stockfish 로딩 시간이 초과되었습니다."));}},30000);
    worker.onerror=e=>{clearTimeout(timer);engineReady=false;reject(new Error(e?.message||"Stockfish Worker 오류"));};
    worker.onmessage=e=>{
      const line=typeof e.data==="string"?e.data.trim():"";if(!line)return;
      if(line==="uciok"&&phase==="uci"){phase="ready";worker.postMessage("setoption name MultiPV value 3");worker.postMessage("isready");return;}
      if(line==="readyok"&&phase==="ready"){clearTimeout(timer);engineReady=true;status("Stockfish 준비 완료","ready");resolve();return;}
      if(activeJob) activeJob.onLine(line);
    };
    worker.postMessage("uci");
  }).catch(e=>{engineReady=false;status("엔진 오류","error");throw e;});
  return engineBoot;
}

function stopJob(){if(activeJob){const j=activeJob;activeJob=null;clearTimeout(j.timer);try{engine?.postMessage("stop");}catch{}j.reject?.(new Error("cancelled"));}}
function analyzeFen(fen,depth=11){
  const key=`${fen}|${depth}`;if(cache.has(key))return Promise.resolve(cache.get(key));
  if(!engineReady) return Promise.reject(new Error("Stockfish가 아직 준비되지 않았습니다."));
  stopJob();const turn=fen.split(" ")[1],token=++currentToken;
  return new Promise((resolve,reject)=>{
    const result={fen,turn,depth:0,lines:new Map()};
    const timer=setTimeout(()=>{if(activeJob?.token!==token)return;activeJob=null;reject(new Error("엔진 분석 시간이 초과되었습니다."));try{engine.postMessage("stop");}catch{}},30000);
    activeJob={token,timer,reject,onLine(line){
      if(activeJob?.token!==token)return;
      const t=line.split(/\s+/);
      if(line.startsWith("info ")&&line.includes(" pv ")){
        const di=t.indexOf("depth"),mi=t.indexOf("multipv"),pi=t.indexOf("pv");
        const d=di>=0?Number(t[di+1]):0, mp=mi>=0?Number(t[mi+1]):1, score=whiteScore(parseScore(t),turn),pv=pi>=0?t.slice(pi+1):[];
        result.depth=Math.max(result.depth,d);if(score!=null&&pv.length)result.lines.set(mp,{score,pv});
        if(d)progress(Math.min(96,d/depth*100),d);
      }
      if(line.startsWith("bestmove")){
        clearTimeout(timer);activeJob=null;result.lines=[...result.lines.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1]);cache.set(key,result);resolve(result);
      }
    }};
    engine.postMessage(`position fen ${fen}`);engine.postMessage(`go depth ${depth}`);
  });
}

function loadPositions(game){
  const c=new Chess(),out=[{ply:0,fen:c.fen(),san:null,uci:null}];
  game.history({verbose:true}).forEach((m,i)=>{const x=c.move(m.san);out.push({ply:i+1,fen:c.fen(),san:x.san,uci:`${x.from}${x.to}${x.promotion||""}`});});return out;
}
function renderBoard(fen){const c=new Chess(fen);els.board.innerHTML="";c.board().forEach((row,r)=>row.forEach((p,f)=>{const d=document.createElement("div");d.className=`sq ${(r+f)%2===0?"light":"dark"}`;if(p)d.textContent=PIECE[p.color][p.type];els.board.appendChild(d);}));}
function renderMoves(){els.moveList.innerHTML="";positions.slice(1).forEach((p,i)=>{const ply=i+1,b=document.createElement("button");b.className=`moveItem ${ply===currentPly?"active":""}`;b.textContent=`${Math.ceil(ply/2)}${ply%2?".":"…"} ${p.san}`;b.onclick=()=>selectPly(ply);els.moveList.appendChild(b);});}

function phase(chess){const moves=chess.history().length,q=pieceCount(chess,"w","q")+pieceCount(chess,"b","q"),minor=pieceCount(chess,"w","b")+pieceCount(chess,"b","b")+pieceCount(chess,"w","n")+pieceCount(chess,"b","n");if(q===0||minor<=2)return"endgame";if(moves<=14&&q===2)return"opening";return"middlegame";}
function material(chess){const r={w:0,b:0,counts:{w:{},b:{}}};for(const c of ["w","b"])for(const t of ["p","n","b","r","q"]){const n=pieceCount(chess,c,t);r.counts[c][t]=n;r[c]+=n*VALUE[t];}r.diff=+(r.w-r.b).toFixed(1);return r;}

function attacksSquare(chess,from,to){const p=chess.get(from);if(!p)return false;const [ff,fr]=coords(from),[tf,tr]=coords(to),df=tf-ff,dr=tr-fr;
  if(p.type==="p"){const dir=p.color==="w"?1:-1;return dr===dir&&Math.abs(df)===1;}
  if(p.type==="n")return (Math.abs(df)===1&&Math.abs(dr)===2)||(Math.abs(df)===2&&Math.abs(dr)===1);
  if(p.type==="k")return Math.max(Math.abs(df),Math.abs(dr))===1;
  const diag=Math.abs(df)===Math.abs(dr), straight=df===0||dr===0;if(p.type==="b"&&!diag||p.type==="r"&&!straight||p.type==="q"&&!(diag||straight))return false;
  const sf=Math.sign(df),sr=Math.sign(dr);let f=ff+sf,r=fr+sr;while(f!==tf||r!==tr){if(chess.get(sq(f,r)))return false;f+=sf;r+=sr;}return true;
}
function attackedBy(chess,target,color){for(const x of allPieces(chess,color))if(attacksSquare(chess,x.square,target))return true;return false;}
function supporters(chess,target,color){return allPieces(chess,color).filter(x=>attacksSquare(chess,x.square,target)).map(x=>x.square);}
function legalMovesFor(chess,color,from){try{const f=chess.fen().split(" ");f[1]=color;const c=new Chess(f.join(" "));return c.moves({square:from,verbose:true});}catch{return[];}}
function bishopInfo(chess,x){const moves=legalMovesFor(chess,x.piece.color,x.square), enemy=opposite(x.piece.color);const captures=moves.filter(m=>{const p=chess.get(m.to);return p&&p.color===enemy;});const useful=moves.filter(m=>{const p=chess.get(m.to);return p?.color===enemy||supporters(chess,m.to,x.piece.color).length>0||["d4","d5","e4","e5","c4","c5","f4","f5"].includes(m.to);});return {moves,captures,useful};}
function knightInfo(chess,x){const moves=legalMovesFor(chess,x.piece.color,x.square),out=[];for(const m of moves){const [f,r]=coords(m.to),advanced=x.piece.color==="w"?r>=5:r<=4;if(!advanced)continue;if(attackedBy(chess,m.to,opposite(x.piece.color)))continue;const sup=supporters(chess,m.to,x.piece.color);if(sup.length)out.push({square:m.to,support:sup});}return {moves,out};}

function pawnStructure(chess,color){const pawns=allPieces(chess,color,"p"),files={};for(const p of pawns){const f=p.square[0];(files[f]??=[]).push(p.square);}
  const doubled=Object.entries(files).filter(([,a])=>a.length>1).map(([f,a])=>`${f}-파일(${a.join(", ")})`);
  const isolated=[];for(const [f,a] of Object.entries(files))if(!files[FILES[FILES.indexOf(f)-1]]&&!files[FILES[FILES.indexOf(f)+1]])isolated.push(...a);
  const passed=[];for(const p of pawns){const fi=FILES.indexOf(p.square[0]),rank=Number(p.square[1]),dir=color==="w"?1:-1;let blocked=false;for(const ef of [fi-1,fi,fi+1]){if(ef<0||ef>7)continue;for(const ep of files[FILES[ef]]||[]){const er=Number(ep[1]);if((color==="w"&&er>rank)||(color==="b"&&er<rank))blocked=true;}}if(!blocked)passed.push(p.square);}
  return {doubled,isolated,passed};}
function spaceScore(chess,color){let score=0;for(const p of allPieces(chess,color,"p")){const r=Number(p.square[1]);score+=color==="w"?r-2:7-r;}return score;}
function openFiles(chess){const out=[];for(const f of FILES){const wp=allPieces(chess,"w","p").some(x=>x.square[0]===f),bp=allPieces(chess,"b","p").some(x=>x.square[0]===f);if(!wp&&!bp)out.push(f);else if(!wp||!bp)out.push(`${f}-세미오픈`);}return out;}
function kingSafety(chess,color){const k=allPieces(chess,color,"k")[0]?.square;if(!k)return 0;const enemy=opposite(color);let score=0;const [f,r]=coords(k);for(let df=-1;df<=1;df++)for(let dr=-1;dr<=1;dr++){if(!df&&!dr)continue;const s=(f+df>=0&&f+df<8&&r+dr>=1&&r+dr<=8)?sq(f+df,r+dr):null;if(s&&attackedBy(chess,s,enemy))score++;}return score;}
function development(chess,color){let score=0;for(const t of ["n","b"]){for(const x of allPieces(chess,color,t)){if((color==="w"&&["b1","g1","c1","f1"].includes(x.square))||(color==="b"&&["b8","g8","c8","f8"].includes(x.square)))continue;score++;}}return score;}
function initiativeMoves(chess,color){const c=new Chess(chess.fen().split(" ").map((x,i)=>i===1?color:x).join(" "));return c.moves({verbose:true}).filter(m=>m.san.includes("+")||m.captured||["Q","R"].includes(m.piece.toUpperCase())).length;}

function snapshot(chess){
  const ph=phase(chess),mat=material(chess), ps={w:pawnStructure(chess,"w"),b:pawnStructure(chess,"b")};
  const bishops={w:allPieces(chess,"w","b").map(x=>({...x,info:bishopInfo(chess,x)})),b:allPieces(chess,"b","b").map(x=>({...x,info:bishopInfo(chess,x)}))};
  const knights={w:allPieces(chess,"w","n").map(x=>({...x,info:knightInfo(chess,x)})),b:allPieces(chess,"b","n").map(x=>({...x,info:knightInfo(chess,x)}))};
  const sp={w:spaceScore(chess,"w"),b:spaceScore(chess,"b")};
  const dev={w:development(chess,"w"),b:development(chess,"b")};
  const init={w:initiativeMoves(chess,"w"),b:initiativeMoves(chess,"b")};
  const ks={w:kingSafety(chess,"w"),b:kingSafety(chess,"b")};
  const weak={w:[],b:[]};
  for(const color of ["w","b"]){for(let r=3;r<=6;r++)for(let f=0;f<8;f++){const s=sq(f,r);if(chess.get(s))continue;if(attackedBy(chess,s,opposite(color))||attackedBy(chess,s,color))continue;if(supporters(chess,s,color).length||legalMovesFor(chess,color,s).length)weak[color].push(s);}}
  let dominant={key:"activity",side:null,reason:"물질이 같고 즉각적인 킹 안전 차이가 크지 않다면 실제 기물의 활동과 개선 가능성을 우선 비교합니다."};
  if(Math.abs(mat.diff)>=1.5)dominant={key:"material",side:mat.diff>0?"w":"b",reason:`물질 차이가 약 ${Math.abs(mat.diff).toFixed(1)}점으로 다른 요소보다 직접적인 영향을 줍니다.`};
  else if(Math.abs(ks.w-ks.b)>=2)dominant={key:"king",side:ks.w<ks.b?"w":"b",reason:"한쪽 킹 주변에 더 많은 공격 압력이 형성되어 있어 다른 불균형보다 우선 확인할 가치가 있습니다."};
  else if(Math.abs(sp.w-sp.b)>=5)dominant={key:"space",side:sp.w>sp.b?"w":"b",reason:"한쪽의 폰 전진과 활동 공간 차이가 커서 기물 배치와 교환 판단에 직접 영향을 줍니다."};
  else if(Math.abs(dev.w-dev.b)>=2||Math.abs(init.w-init.b)>=2)dominant={key:"development",side:dev.w+init.w>dev.b+init.b?"w":"b",reason:"개발과 주도권의 차이가 있어 시간이 지나기 전에 이를 활용할 필요가 있습니다."};
  return {phase:ph,material:mat,pawns:ps,bishops,knights,space:sp,development:dev,initiative:init,king:ks,weak,dominant,openFiles:openFiles(chess)};
}

function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));}
function bishopText(side,x){const inf=x.info;if(inf.captures.length)return `${sideName(side)} ${x.square} · 활동적인 비숍 — 현재 실제로 상대 기물을 겨냥할 수 있는 대각선이 있습니다.`;if(inf.useful.length)return `${sideName(side)} ${x.square} · 활동을 개선할 수 있는 비숍 — ${inf.useful.slice(0,2).map(m=>m.to).join(", ")} 같은 실제 진출 후보를 확인할 가치가 있습니다.`;return `${sideName(side)} ${x.square} · 활동이 제한된 비숍 — 현재 열린 대각선과 유용한 진출 칸이 많지 않아 기물 구조를 함께 살펴볼 필요가 있습니다.`;}
function knightText(side,x){const inf=x.info;if(inf.out.length){const o=inf.out[0];return `${sideName(side)} ${x.square} · 유망한 진출점을 가진 나이트 — ${o.square}에 들어갈 수 있고 ${o.support.join(", ")}의 지지를 받을 수 있습니다.`;}if(inf.moves.length>=4)return `${sideName(side)} ${x.square} · 활동적인 나이트 — 현재 여러 진출점을 확보하고 있습니다.`;if(inf.moves.length<=1)return `${sideName(side)} ${x.square} · 활동 범위가 제한된 나이트 — 당장 이동 수를 늘리기보다 좋은 진출 경로를 만드는 것이 중요합니다.`;return `${sideName(side)} ${x.square} · 보통 수준의 활동성을 가진 나이트입니다.`;}
function factorHtml(s){const p=s.phase==="opening"?"오프닝":s.phase==="endgame"?"엔드게임":"미들게임",m=s.material;const parts=[`<div class="factor"><b>게임 단계</b><span>현재 ${p}입니다.</span></div>`,`<div class="factor"><b>기물의 개수</b><span>${Math.abs(m.diff)<.3?"물질적으로 균형이 맞습니다.":`${m.diff>0?"백":"흑"}이 약 ${Math.abs(m.diff).toFixed(1)}점 앞서 있습니다.`}</span></div>`];
  for(const side of ["w","b"]){for(const x of s.bishops[side])parts.push(`<div class="factor"><b>${escapeHtml(bishopText(side,x).split(" · ")[0])}</b><span>${escapeHtml(bishopText(side,x).split(" · ")[1])}</span></div>`);for(const x of s.knights[side]){const z=knightText(side,x).split(" · ");parts.push(`<div class="factor"><b>${escapeHtml(z[0])}</b><span>${escapeHtml(z.slice(1).join(" · "))}</span></div>`);}}
  const pw=s.pawns.w,pb=s.pawns.b;const pawnLine=(name,p)=>`${name}: ${p.doubled.length?`더블폰 ${p.doubled.join(", ")}. `:""}${p.isolated.length?`고립폰 ${p.isolated.join(", ")}. `:""}${p.passed.length?`통과폰 ${p.passed.join(", ")}.`:"뚜렷한 구조적 약점은 제한적입니다."}`;
  parts.push(`<div class="factor"><b>폰 구조</b><span>${escapeHtml(pawnLine("백",pw))} ${escapeHtml(pawnLine("흑",pb))}</span></div>`);
  const sp=s.space.w-s.space.b;parts.push(`<div class="factor"><b>공간</b><span>${sp===0?"양쪽의 공간 차이가 크지 않습니다.":`${sp>0?"백":"흑"}이 상대적으로 더 많은 공간을 확보하고 있습니다. 공간이 많은 쪽은 기동성을 활용하고, 공간이 적은 쪽은 유리한 교환이나 반격을 찾는 방향을 고려할 수 있습니다.`}</span></div>`);
  parts.push(`<div class="factor"><b>약한 칸</b><span>${s.weak.w.length?`백이 활용할 수 있는 후보 칸 ${s.weak.w.slice(0,5).join(", ")}`:"백의 뚜렷한 약한 칸은 현재 제한적입니다."}; ${s.weak.b.length?`흑 ${s.weak.b.slice(0,5).join(", ")}`:"흑의 뚜렷한 약한 칸은 현재 제한적입니다."}</span></div>`);
  parts.push(`<div class="factor"><b>오픈 파일</b><span>${s.openFiles.length?s.openFiles.join(", "):"완전 오픈 파일은 현재 없습니다."}</span></div>`);
  const dd=s.development.w-s.development.b;parts.push(`<div class="factor"><b>개발</b><span>${dd===0?"경량 기물의 개발 정도가 비슷합니다.":`${dd>0?"백":"흑"}이 경량 기물을 더 많이 활동적인 위치로 옮겼습니다. 다만 개발 우세는 일시적인 요소이므로 실제로 활용할 수 있는지 확인해야 합니다.`}</span></div>`);
  const kd=s.king.w-s.king.b;parts.push(`<div class="factor"><b>킹 안전</b><span>${kd===0?"양쪽 킹의 안전 차이가 현재 결정적이지 않습니다.":`${kd>0?"흑":"백"} 킹 주변에 상대 기물의 공격 압력이 더 많아 먼저 전술적 위협을 확인할 필요가 있습니다.`}</span></div>`);
  const ii=s.initiative.w-s.initiative.b;parts.push(`<div class="factor"><b>주도권</b><span>${ii===0?"강제적인 수의 차이가 뚜렷하지 않습니다.":`${ii>0?"백":"흑"}이 체크·잡기·강제적인 수를 더 많이 가지고 있어 현재 템포를 활용할 가능성이 있습니다.`}</span></div>`);
  const d=s.dominant;parts.push(`<div class="factor"><b>현재 가장 중요한 불균형</b><span>${d.key==="material"?"물질":d.key==="king"?"킹 안전":d.key==="space"?"공간":d.key==="development"?"개발과 주도권":"기물 활동성"} — ${escapeHtml(d.reason)}</span></div>`);
  const dynamic=["development","king"].includes(d.key)||d.key==="activity";parts.push(`<div class="factor"><b>정적 / 동적</b><span>${dynamic?"현재 중요한 요소에는 시간이 지나면 사라질 수 있는 동적인 성격이 포함되어 있습니다. 이를 실제 이득이나 오래가는 우세로 바꾸는지를 확인합니다.":"현재 중요한 요소가 폰 구조·물질처럼 비교적 오래 지속되는 성격에 가깝습니다."}</span></div>`);
  parts.push(`<div class="factor"><b>생각의 순서</b><span>불균형을 찾고 → 상대의 반격을 확인하고 → 원하는 포지션을 그린 뒤 → 후보 수를 만들고 → 엔진으로 검증합니다.</span></div>`);
  return parts.join("");}

function strategicCandidates(fen,engineLines,snap){
  const legal=new Chess(fen).moves({verbose:true});const pool=[];const seen=new Set(engineLines.map(x=>x.pv[0]));
  for(const m of legal){if(seen.has(m.from+m.to+(m.promotion||"")))continue;let tag="다른 계획",reason="현재의 핵심 불균형을 다른 방식으로 다루는 후보입니다.";if(snap.dominant.key==="activity"&&(m.piece==="n"||m.piece==="b"))tag="기물 개선";else if(snap.dominant.key==="space"&&m.piece==="p")tag="공간에 대한 계획";else if(m.captured)tag="교환/정리";pool.push({uci:m.from+m.to+(m.promotion||""),san:m.san,tag,reason});if(pool.length>=8)break;}
  return pool;}

async function renderAnalysis(result,token){if(token!==currentToken)return;const p=positions[currentPly],lines=result.lines||[];const best=lines[0];if(!best)return;els.evalValue.textContent=formatScore(best.score);els.positionInsight.textContent=scoreLanguage(best.score);progress(100,result.depth);const snap=snapshot(new Chess(p.fen));els.humanFactors.innerHTML=factorHtml(snap);
  const candidates=[];lines.slice(0,3).forEach((l,i)=>candidates.push({san:uciSan(p.fen,l.pv[0]),score:l.score,tag:i===0?"엔진 최선":"엔진 후보",pv:pvSan(p.fen,l.pv)}));
  const strategic=strategicCandidates(p.fen,lines,snap);for(const c of strategic.slice(0,3)){try{const r=await analyzeFen(p.fen,8);const same=r.lines.find(x=>x.pv[0]===c.uci);const sc=same?.score??best.score;if(Math.abs(sc-best.score)<=1.2)candidates.push({san:c.san,score:sc,tag:c.tag,pv:c.san,reason:c.reason});}catch{break;}}
  const uniq=[];const used=new Set();for(const c of candidates){if(!used.has(c.san)){used.add(c.san);uniq.push(c);}}els.candidateList.innerHTML=uniq.slice(0,5).map((c,i)=>`<div class="candidate"><div class="candidateTop"><span class="candidateName">${i+1}. ${escapeHtml(c.san)} · ${escapeHtml(c.tag)}</span><span class="candidateScore">${formatScore(c.score)}</span></div><div class="candidateDesc">${escapeHtml(c.reason|| (i===0?"현재 포지션에서 엔진이 가장 강하게 추천하는 수입니다.":"현재 포지션의 다른 후보로 검토할 수 있습니다."))}<br><span class="muted">${escapeHtml(c.pv)}</span></div></div>`).join("");}

async function selectPly(ply){currentPly=Math.max(0,Math.min(positions.length-1,ply));const p=positions[currentPly],token=++currentToken;renderBoard(p.fen);renderMoves();els.moveLabel.textContent=`${currentPly} / ${positions.length-1}`;els.positionLabel.textContent=currentPly?`${Math.ceil(currentPly/2)}${currentPly%2?". ":"… "}${p.san}`:"시작 포지션";els.firstBtn.disabled=els.prevBtn.disabled=currentPly===0;els.nextBtn.disabled=els.lastBtn.disabled=currentPly===positions.length-1;els.evalValue.textContent="분석 중…";els.candidateList.innerHTML="";progress(0,0);try{const r=await analyzeFen(p.fen,11);if(token===currentToken)await renderAnalysis(r,token);}catch(e){if(token===currentToken&&e.message!=="cancelled")error(e.message||"분석에 실패했습니다.");}}

async function startGame(){clearError();const text=els.pgnInput.value.trim();if(!text){error("PGN을 입력해주세요.");return;}let game=new Chess();try{game.loadPgn(text,{strict:false});}catch(e){error("PGN을 읽을 수 없습니다. 수순 형식을 확인해주세요.");return;}positions=loadPositions(game);if(!positions.length){error("기보에서 수순을 찾지 못했습니다.");return;}currentPly=0;cache.clear();els.inputView.hidden=true;els.analysisView.hidden=false;els.gameMeta.textContent=`${positions.length-1}수`;renderMoves();await initEngine();await selectPly(0);}

els.exampleBtn.onclick=()=>{els.pgnInput.value=EXAMPLE_PGN;clearError();};
els.analyzeBtn.onclick=async()=>{els.analyzeBtn.disabled=true;try{await startGame();}catch(e){error(e.message||"분석을 시작할 수 없습니다.");}finally{els.analyzeBtn.disabled=false;}};
els.backBtn.onclick=()=>{stopJob();els.analysisView.hidden=true;els.inputView.hidden=false;};
els.firstBtn.onclick=()=>selectPly(0);els.prevBtn.onclick=()=>selectPly(currentPly-1);els.nextBtn.onclick=()=>selectPly(currentPly+1);els.lastBtn.onclick=()=>selectPly(positions.length-1);

els.pgnInput.addEventListener("input",clearError);

// UI 이벤트를 먼저 연결한 뒤 엔진을 비동기로 준비한다.
initEngine().catch(()=>{});
