// ============ ESTADO GERAL / NAVEGAÇÃO ============
const socket = io();
let myName = null;
let myToken = null;
let myPin = null;
let myTeam = null;
let currentRoom = null;

// sempre que o socket (re)conecta — seja no arranque, seja depois de uma queda de rede,
// separador em segundo plano, ou a página a voltar da back-forward cache do browser —
// reenvia o nosso nome+PIN para o servidor. Sem isto, depois de uma reconexão o browser
// continua a "achar" que está autenticado mas o servidor já não sabe quem somos, e ações
// como criar sala ficam silenciosamente sem efeito.
socket.on('connect', () => {
  hideConnectionBanner();
  if(myName && myPin){
    socket.emit('set_name', { name: myName, pin: myPin, token: myToken });
  }
});

// feedback de ligação: mostra um aviso discreto sempre que O NOSSO PRÓPRIO socket
// cai ou está a tentar reconectar-se (diferente do 'opponent_disconnected', que é
// sobre o adversário). Isto dá-nos logo perceção de que algo caiu, em vez de o jogo
// parecer simplesmente "pendurado".
socket.on('disconnect', () => {
  showConnectionBanner('Ligação perdida — a tentar reconectar…');
});
socket.on('reconnect_attempt', () => {
  showConnectionBanner('A tentar reconectar…');
});
socket.on('reconnect', () => {
  showConnectionBanner('Ligado de novo!');
  setTimeout(hideConnectionBanner, 1500);
});
socket.on('reconnect_failed', () => {
  showConnectionBanner('Não foi possível reconectar. Verifica a tua ligação e recarrega a página.');
});
function showConnectionBanner(text){
  const el = document.getElementById('connectionBanner');
  if(!el) return;
  el.textContent = text;
  el.style.display = 'block';
}
function hideConnectionBanner(){
  const el = document.getElementById('connectionBanner');
  if(el) el.style.display = 'none';
}

// se a página for restaurada a partir da back-forward cache do browser (o aviso que viste
// na consola), o socket.io por vezes fica com uma ligação "zombie" que nunca recupera.
// Forçar um reload garante que fica tudo limpo e a funcionar.
window.addEventListener('pageshow', (e) => {
  if(e.persisted){
    window.location.reload();
  }
});

// ---- registo seguro de listeners ----
// um único id em falta no HTML costumava rebentar TODO o script a partir desse ponto
// (o erro "Cannot read properties of null" interrompe a execução do ficheiro), o que
// impedia até o botão de nome/PIN de funcionar. Com este helper, um id em falta dá
// apenas um aviso na consola e o resto do jogo continua a funcionar normalmente.
function on(id, event, handler){
  const el = document.getElementById(id);
  if(!el){
    console.warn(`[futsal] elemento #${id} não encontrado no HTML — listener de '${event}' não registado.`);
    return;
  }
  el.addEventListener(event, handler);
}
function byId(id){ return document.getElementById(id); }

function showScreen(id){
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function saveSession(){
  sessionStorage.setItem('fg_name', myName || '');
  sessionStorage.setItem('fg_token', myToken || '');
  sessionStorage.setItem('fg_pin', myPin || '');
  if(currentRoom){
    sessionStorage.setItem('fg_room', currentRoom.id);
    sessionStorage.setItem('fg_team', myTeam || '');
  }
}
function clearRoomSession(){
  sessionStorage.removeItem('fg_room');
  sessionStorage.removeItem('fg_team');
}
function clamp(v, min, max){ return Math.min(Math.max(v, min), max); }

// ---- modo local (dois jogadores no mesmo aparelho, sem sala online) ----
// não há socket nem "myTeam" envolvidos — o próprio cliente é sempre a autoridade
// da física (ver isPhysicsAuthority()) e resolve faltas/golos/livres de 10 metros
// de imediato, sem passar pelo servidor. Os dois jogadores revezam-se no mesmo ecrã.
//
// NOTA: o teu HTML atual ainda não tem o ecrã/botões do modo local (#btnStartLocal,
// #localNameAInput, #localNameBInput, #localBestOfInput). O código abaixo fica
// pronto e não rebenta nada (graças ao helper 'on'), mas só fica acessível quando
// adicionares esse bocado de HTML. Podes ignorar esta secção por agora.
let localMode = false;
let localNameA = 'Vermelho', localNameB = 'Azul';
let localBestOf = 5;
let localFouls = { A: 0, B: 0 };
let localMatchFinished = false;
let localPendingKeeperChoice = null;

function startLocalMatch(nameA, nameB, bestOf){
  localMode = true;
  localMatchFinished = false;
  currentRoom = null;
  myTeam = null;
  clearRoomSession();

  localNameA = nameA || 'Vermelho';
  localNameB = nameB || 'Azul';
  localBestOf = bestOf;
  localFouls = { A: 0, B: 0 };
  localPendingKeeperChoice = null;

  byId('waitingBanner').style.display = 'none';
  byId('labelA').textContent = localNameA;
  byId('labelB').textContent = localNameB;
  scoreA = 0; scoreB = 0; turn = 'A';
  byId('scoreA').textContent = 0;
  byId('scoreB').textContent = 0;
  updateTurnBadge();
  updateFoulsBadge(localFouls);
  celebrating = false; foulFlash = false; awaitingFoulResult = false; inPenalty = false;
  penaltyKickActive = false;
  hidePenaltyOverlay();
  resetPositions();
  showScreen('screen-game');
}

on('btnStartLocal', 'click', () => {
  const nameA = byId('localNameAInput').value.trim() || 'Vermelho';
  const nameB = byId('localNameBInput').value.trim() || 'Azul';
  const bestOf = Math.min(Math.max(parseInt(byId('localBestOfInput').value) || 5, 1), 21);
  startLocalMatch(nameA, nameB, bestOf);
});

// ---- ecrã nome + PIN ----
function showNameError(msg){
  const el = byId('nameError');
  el.textContent = msg;
  el.style.display = 'block';
}
function hideNameError(){
  byId('nameError').style.display = 'none';
}

on('btnSetName', 'click', () => submitName());
on('nameInput', 'keydown', e => { if(e.key==='Enter') byId('pinInput').focus(); });
on('pinInput', 'keydown', e => { if(e.key==='Enter') submitName(); });

function submitName(){
  const v = byId('nameInput').value.trim();
  const pin = byId('pinInput').value.trim();
  if(!v){ showNameError('Escreve um nome para continuar.'); return; }
  if(!/^\d{4,6}$/.test(pin)){ showNameError('O PIN tem de ter entre 4 e 6 números.'); return; }
  hideNameError();
  myToken = sessionStorage.getItem('fg_token') || null;
  myPin = pin;
  socket.emit('set_name', { name: v, pin, token: myToken });
}

socket.on('set_name_failed', ({ reason }) => {
  let msg = 'Não foi possível entrar. Tenta novamente.';
  if(reason === 'wrong_pin') msg = 'Esse nome já está registado com outro PIN. Confirma o teu PIN ou escolhe outro nome.';
  if(reason === 'invalid_pin') msg = 'O PIN tem de ter entre 4 e 6 números.';
  if(reason === 'no_name') msg = 'Escreve um nome para continuar.';
  showNameError(msg);
  // se o PIN guardado estava errado, apaga-o para não voltar a tentar sozinho no próximo refresh
  sessionStorage.removeItem('fg_pin');
});

socket.on('name_ok', ({ name, token }) => {
  myName = name;
  myToken = token;
  saveSession();
  byId('lobbyName').textContent = name;

  // tenta reentrar automaticamente numa sala se veio de um refresh a meio de um jogo
  const savedRoom = sessionStorage.getItem('fg_room');
  if(savedRoom){
    socket.emit('rejoin_room', { roomId: savedRoom, token: myToken });
  } else {
    showScreen('screen-lobby');
  }
});

// ---- reconexão automática ao carregar a página ----
window.addEventListener('load', () => {
  const savedName = sessionStorage.getItem('fg_name');
  const savedToken = sessionStorage.getItem('fg_token');
  const savedPin = sessionStorage.getItem('fg_pin');
  if(savedName && savedToken && savedPin){
    byId('nameInput').value = savedName;
    byId('pinInput').value = savedPin;
    myToken = savedToken;
    myPin = savedPin;
    socket.emit('set_name', { name: savedName, pin: savedPin, token: savedToken });
  }
});

socket.on('rejoin_ok', ({ room, myTeam: team, players, scoreA: a, scoreB: b, turn: t }) => {
  currentRoom = room;
  myTeam = team;
  saveSession();
  const pa = players.find(p => p.team === 'A');
  const pb = players.find(p => p.team === 'B');
  byId('labelA').textContent = pa.name;
  byId('labelB').textContent = pb.name;
  scoreA = a; scoreB = b; turn = t;
  byId('scoreA').textContent = a;
  byId('scoreB').textContent = b;
  updateTurnBadge();
  celebrating = false; foulFlash = false; awaitingFoulResult = false; inPenalty = false;
  hidePenaltyOverlay();
  resetPositions(); // recomeça este ponto a meio-campo (o placar mantém-se)
  hideReconnectBanner();
  showScreen('screen-game');
});
socket.on('rejoin_failed', () => {
  clearRoomSession();
  showScreen('screen-lobby');
});

// ---- lobby ----
on('btnCreateRoom', 'click', () => {
  const roomName = byId('roomNameInput').value.trim() || (myName + ' — sala');
  const bestOf = byId('bestOfInput').value || 5;
  socket.emit('create_room', { roomName, bestOf });
});

socket.on('rooms', (list) => {
  const el = byId('roomList');
  if(!list.length){ el.innerHTML = '<p class="hint">Nenhuma sala aberta. Cria a primeira!</p>'; return; }
  el.innerHTML = '';
  list.forEach(r => {
    const div = document.createElement('div');
    div.className = 'room-item';
    const full = r.players.length >= 2;
    div.innerHTML = `
      <div>
        <div>${escapeHtml(r.name)}</div>
        <div class="meta">${r.players.map(escapeHtml).join(' vs ') || 'vazia'} · até ${r.bestOf} golos</div>
      </div>
      ${full ? '<span class="meta">A jogar</span>' : '<button data-id="'+r.id+'">Entrar</button>'}
    `;
    if(!full){
      div.querySelector('button').addEventListener('click', () => {
        socket.emit('join_room', { roomId: r.id });
      });
    }
    el.appendChild(div);
  });
});

socket.on('join_failed', (msg) => alert(msg));

on('btnShowRanking', 'click', () => {
  socket.emit('get_rankings');
  showScreen('screen-ranking');
});
on('btnCloseRanking', 'click', () => showScreen('screen-lobby'));

socket.on('rankings', (list) => {
  const tbody = document.querySelector('#rankingTable tbody');
  tbody.innerHTML = '';
  if(!list.length){
    tbody.innerHTML = '<tr><td colspan="9" class="hint">Ainda sem jogos registados.</td></tr>';
    return;
  }
  list.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i+1}</td><td>${escapeHtml(r.name)}</td><td>${r.wins}</td><td>${r.draws}</td><td>${r.losses}</td><td>${r.golosMarcados}</td><td>${r.golosSofridos}</td><td>${r.saldo}</td><td>${r.points}</td>`;
    tbody.appendChild(tr);
  });
});

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---- chat público ----
socket.on('chat_history', (history) => {
  const box = byId('chatMessages');
  box.innerHTML = '';
  history.forEach(addChatMessage);
});
socket.on('chat_message', (msg) => addChatMessage(msg));

function addChatMessage(msg){
  const box = byId('chatMessages');
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<span class="name">${escapeHtml(msg.name)}:</span> <span class="txt">${escapeHtml(msg.text)}</span>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function sendChat(){
  const input = byId('chatInput');
  const v = input.value.trim();
  if(!v || !myName) return;
  socket.emit('chat_message', v);
  input.value = '';
}
on('btnChatSend', 'click', sendChat);
on('chatInput', 'keydown', e => { if(e.key==='Enter') sendChat(); });

// ---- sala de espera (banner, não bloqueia o lobby) ----
socket.on('room_joined', ({ room, myTeam: team }) => {
  currentRoom = room;
  myTeam = team;
  saveSession();
  byId('waitRoomInfo').textContent = `À espera de adversário em "${room.name}" — até ${room.bestOf} golos`;
  byId('waitingBanner').style.display = 'flex';
  showScreen('screen-lobby');
});
on('btnCancelWait', 'click', () => {
  socket.emit('leave_room');
  byId('waitingBanner').style.display = 'none';
  clearRoomSession();
  currentRoom = null;
});

// ---- início de partida ----
socket.on('match_start', ({ room, players, scoreA: a, scoreB: b, turn: t }) => {
  currentRoom = room;
  saveSession();
  byId('waitingBanner').style.display = 'none';
  const pa = players.find(p => p.team === 'A');
  const pb = players.find(p => p.team === 'B');
  byId('labelA').textContent = pa.name;
  byId('labelB').textContent = pb.name;
  scoreA = a; scoreB = b; turn = t;
  byId('scoreA').textContent = a;
  byId('scoreB').textContent = b;
  updateTurnBadge();
  updateFoulsBadge({ A: 0, B: 0 });
  celebrating = false; foulFlash = false; awaitingFoulResult = false; inPenalty = false;
  hidePenaltyOverlay();
  resetPositions();
  showScreen('screen-game');
});

socket.on('opponent_left', () => {
  alert('O adversário saiu da sala.');
  clearRoomSession();
  currentRoom = null;
  socket.emit('get_rankings');
  showScreen('screen-lobby');
});

function showReconnectBanner(){ byId('reconnectBanner').style.display = 'block'; }
function hideReconnectBanner(){ byId('reconnectBanner').style.display = 'none'; }
socket.on('opponent_disconnected', showReconnectBanner);
socket.on('opponent_reconnected', hideReconnectBanner);

on('btnLeaveGame', 'click', () => {
  if(localMode){
    localMode = false;
    celebrating = false; foulFlash = false; awaitingFoulResult = false; inPenalty = false;
    hidePenaltyOverlay();
    showScreen('screen-lobby');
    return;
  }
  socket.emit('leave_room');
  clearRoomSession();
  currentRoom = null;
  showScreen('screen-lobby');
});

socket.on('turn_update', ({ turn: t }) => { turn = t; updateTurnBadge(); });

socket.on('opponent_shot', ({ discId, vx, vy }) => {
  const d = findDiscById(discId);
  if(d){
    d.vx = vx; d.vy = vy;
    activeShotDiscId = discId; activeShotTeam = d.team; activeShotTouchedBall = false;
  }
});

// --- faltas ---
function updateFoulsBadge(fouls){
  const el = byId('foulsBadge');
  if(el) el.textContent = `Faltas: Vermelho ${fouls.A||0} — Azul ${fouls.B||0}`;
}
socket.on('fouls_update', ({ fouls }) => updateFoulsBadge(fouls));

socket.on('foul_called', (data) => {
  awaitingFoulResult = false;
  activeShotDiscId = null;

  if(data.isTenMeter){
    startTenMeterKick(data.offendingTeam, data.fouledTeam);
    return;
  }

  // livre normal: a bola fica onde ocorreu a falta; quem sofreu a falta fica com a posse,
  // um pouco afastado da bola para poder correr e rematar; quem cometeu a falta é empurrado
  // para uma distância mínima da bola, como a barreira de um livre
  ball.x = data.x; ball.y = data.y; ball.vx = 0; ball.vy = 0; ball.spin = 0; ball.angVel = 0;
  turn = data.fouledTeam;
  updateTurnBadge();

  const victim = findDiscById(data.victimDiscId);
  if(victim){
    const backOff = victim.team === 'A' ? -1 : 1; // A ataca a baliza direita, por isso recua para a esquerda
    victim.x = clamp(ball.x + backOff*FREE_KICK_RUNUP, FIELD_LEFT+victim.r, FIELD_RIGHT-victim.r);
    victim.y = clamp(ball.y, FIELD_TOP+victim.r, FIELD_BOTTOM-victim.r);
    victim.vx = 0; victim.vy = 0;
  }
  const offender = findDiscById(data.offenderDiscId);
  if(offender){
    const dx = offender.x - ball.x, dy = offender.y - ball.y;
    const dist = Math.hypot(dx,dy) || 1;
    if(dist < FREE_KICK_WALL_DIST){
      offender.x = clamp(ball.x + (dx/dist)*FREE_KICK_WALL_DIST, FIELD_LEFT+offender.r, FIELD_RIGHT-offender.r);
      offender.y = clamp(ball.y + (dy/dist)*FREE_KICK_WALL_DIST, FIELD_TOP+offender.r, FIELD_BOTTOM-offender.r);
      offender.vx = 0; offender.vy = 0;
    }
  }

  foulFlashText = 'FALTA!';
  foulFlash = true;
  foulFlashStart = performance.now();
});

// o score_update é a fonte única de verdade para o início da celebração de golo —
// assim os dois lados (quem marcou e o adversário) ficam sempre sincronizados,
// mesmo que o cliente que marcou já tenha "congelado" localmente um pouco antes
socket.on('score_update', ({ scoreA: a, scoreB: b, turn: t, scoringTeam }) => {
  scoreA = a; scoreB = b; turn = t;
  byId('scoreA').textContent = scoreA;
  byId('scoreB').textContent = scoreB;
  updateTurnBadge();
  if(!celebrating){
    celebrating = true;
    celebrationStart = performance.now();
    celebrationTeam = scoringTeam;
  }
});

socket.on('match_over', ({ winner, scoreA: a, scoreB: b }) => {
  clearRoomSession();
  currentRoom = null;
  const title = winner === 'draw' ? 'EMPATE!' : (winner === myTeam ? 'VITÓRIA!' : 'DERROTA');
  byId('overTitle').textContent = title;
  byId('overScore').textContent = `Resultado final: ${a} — ${b}`;
  showScreen('screen-over');
});
on('btnBackToLobby', 'click', () => {
  socket.emit('get_rankings');
  showScreen('screen-lobby');
});

// ============ MOTOR DE JOGO ============
const canvas = byId('pitch');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const GOAL_W = 120;
const isMobile = window.matchMedia('(pointer: coarse)').matches || ('ontouchstart' in window);

const DISC_FRICTION = 0.983;
// atrito da bola: quanto mais perto de 1, mais tempo/distância a bola desliza antes de parar
const BALL_FRICTION = 0.992;
const MIN_SPEED = 0.02;
const MAX_SPEED_DISC = 7;
const MAX_SPEED_BALL = 13;

const FIELD_TOP = 6, FIELD_BOTTOM = H - 6;
const FIELD_LEFT = 34, FIELD_RIGHT = W - 34;
const GOAL_TOP_Y = H/2 - GOAL_W/2, GOAL_BOTTOM_Y = H/2 + GOAL_W/2;
const BOX_W = 70, BOX_H = 140;

const DISC_MASS = 3;
const BALL_MASS = 1;
const RESTITUTION_BALL = 0.92;
const RESTITUTION_DISC = 0.75;

const SPIN_TRANSFER = 0.85;
const SPIN_DECAY = 0.988;
const MAX_SPIN_VEL = 0.75;

const MAX_PULL_SPEED = 7;
const MIN_PULL_TO_AIM = 6;
const AIM_LENGTH = isMobile ? 70 : 42;
const AIM_LINE_WIDTH = isMobile ? 5 : 2.5;
const AIM_HEAD_SIZE = isMobile ? 15 : 7;
const SWIPE_POWER = 0.9;
const MAX_SWIPE_SPEED = 9;

// livre normal: distância a que fica quem sofreu a falta (para correr) e a "barreira" mínima do faltoso
const FREE_KICK_RUNUP = 45;
const FREE_KICK_WALL_DIST = 70;

// livre de 10 metros: posição da bola em frente à baliza, fora da grande área
const TEN_METER_GAP = 20;
const TEN_METER_SHOOTER_OFFSET = 45;
const TEN_METER_KEEPER_LINE = 12;
const KEEPER_DASH_SPEED = 9;
// nº de faltas acumuladas da mesma equipa a partir do qual passa a ser livre de 10 metros
// (só usado em modo local; em modo online quem decide isto é o server.js)
const LOCAL_FOULS_FOR_TEN_METER = 6;

let scoreA = 0, scoreB = 0, turn = 'A';
let celebrating = false, celebrationStart = 0, celebrationTeam = null;
const CELEBRATION_MS = 1500;

// --- deteção de faltas em jogo aberto ---
let activeShotDiscId = null, activeShotTeam = null, activeShotTouchedBall = false;
let awaitingFoulResult = false;
let foulFlash = false, foulFlashStart = 0, foulFlashText = '';
const FOUL_FLASH_MS = 1200;

// --- livre de 10 metros (guarda-redes escolhe primeiro, remate decide) ---
let inPenalty = false;
let penaltyRole = null; // 'shooter' | 'keeper' | null
let penaltyCommitted = false;
let penaltyKeeperReady = false;
let penaltyOffendingTeam = null, penaltyFouledTeam = null;
let penaltyShooterDisc = null, penaltyKeeperDisc = null;
let penaltyKickActive = false;

function makeDisc(x,y,team,num){
  return { x,y, vx:0, vy:0, r:15, team, num, mass:DISC_MASS, id: team+num };
}
let ball, discsA, discsB;

function resetPositions(){
  ball = { x:W/2, y:H/2, vx:0, vy:0, r:9, mass:BALL_MASS, spin:0, angVel:0 };
  discsA = [
    makeDisc(90, H/2, 'A', 1), makeDisc(170, H/2-90, 'A', 2), makeDisc(170, H/2+90, 'A', 3),
    makeDisc(260, H/2-40, 'A', 4), makeDisc(260, H/2+40, 'A', 5),
  ];
  discsB = [
    makeDisc(W-90, H/2, 'B', 1), makeDisc(W-170, H/2-90, 'B', 2), makeDisc(W-170, H/2+90, 'B', 3),
    makeDisc(W-260, H/2-40, 'B', 4), makeDisc(W-260, H/2+40, 'B', 5),
  ];
  activeShotDiscId = null; activeShotTouchedBall = false;
  selectedDisc = null;
}
function allDiscs(){ return [...discsA, ...discsB]; }
function findDiscById(id){ return allDiscs().find(d => d.id === id); }
function everythingStopped(){ return [...allDiscs(), ball].every(o => Math.hypot(o.vx,o.vy) < MIN_SPEED); }

function updateTurnBadge(){
  const badge = byId('turnBadge');
  badge.textContent = 'VEZ: ' + (turn === 'A' ? 'VERMELHO' : 'AZUL');
  badge.className = 'turn ' + turn.toLowerCase();
}

// ---- desenho do campo / baliza ----
function drawGoal(isLeft){
  const boxX = isLeft ? 0 : FIELD_RIGHT;
  const boxW = isLeft ? FIELD_LEFT : (W - FIELD_RIGHT);
  ctx.save();
  ctx.beginPath(); ctx.rect(boxX, GOAL_TOP_Y, boxW, GOAL_W); ctx.clip();
  const backX = isLeft ? boxX : boxX+boxW;
  // fundo da rede em tom escuro neutro (combina com o piso em madeira)
  const grad = ctx.createLinearGradient(backX, 0, isLeft ? boxX+boxW : boxX, 0);
  grad.addColorStop(0, '#161210'); grad.addColorStop(1, '#332720');
  ctx.fillStyle = grad; ctx.fillRect(boxX, GOAL_TOP_Y, boxW, GOAL_W);

  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
  const step = 11;
  const diagCount = Math.ceil((boxW+GOAL_W)/step)+2;
  for(let i=-diagCount;i<diagCount;i++){
    const off = i*step;
    ctx.beginPath(); ctx.moveTo(boxX+off, GOAL_TOP_Y); ctx.lineTo(boxX+off+GOAL_W, GOAL_BOTTOM_Y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(boxX+off, GOAL_BOTTOM_Y); ctx.lineTo(boxX+off+GOAL_W, GOAL_TOP_Y); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for(let i=-diagCount;i<diagCount;i++){
    for(let j=0;j<=GOAL_W/step;j++){
      const px = boxX + i*step + j*step, py = GOAL_TOP_Y + j*step;
      if(px > boxX-2 && px < boxX+boxW+2){ ctx.beginPath(); ctx.arc(px,py,0.9,0,Math.PI*2); ctx.fill(); }
    }
  }
  ctx.restore();
  ctx.strokeStyle = '#f5f5f0'; ctx.lineWidth = 4;
  ctx.strokeRect(boxX+2, GOAL_TOP_Y, boxW-2, GOAL_W);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(backX,GOAL_TOP_Y); ctx.lineTo(backX,GOAL_BOTTOM_Y); ctx.stroke();
}

function drawPitch(){
  // piso tipo pavilhão de futsal (tacos de madeira), em vez de relva
  const stripeCount = 12, stripeW = W/stripeCount;
  for(let i=0;i<stripeCount;i++){
    ctx.fillStyle = i%2===0 ? '#c9975b' : '#bd8a4c';
    ctx.fillRect(i*stripeW,0,stripeW,H);
  }
  // veio de madeira subtil sobre as faixas
  ctx.strokeStyle = 'rgba(90,58,26,0.15)'; ctx.lineWidth = 1;
  for(let i=1;i<stripeCount;i++){
    ctx.beginPath(); ctx.moveTo(i*stripeW,0); ctx.lineTo(i*stripeW,H); ctx.stroke();
  }
  drawGoal(true); drawGoal(false);
  ctx.strokeStyle = '#eef0e6'; ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(FIELD_LEFT,FIELD_TOP); ctx.lineTo(FIELD_RIGHT,FIELD_TOP);
  ctx.moveTo(FIELD_LEFT,FIELD_BOTTOM); ctx.lineTo(FIELD_RIGHT,FIELD_BOTTOM);
  ctx.moveTo(FIELD_LEFT,FIELD_TOP); ctx.lineTo(FIELD_LEFT,GOAL_TOP_Y);
  ctx.moveTo(FIELD_LEFT,GOAL_BOTTOM_Y); ctx.lineTo(FIELD_LEFT,FIELD_BOTTOM);
  ctx.moveTo(FIELD_RIGHT,FIELD_TOP); ctx.lineTo(FIELD_RIGHT,GOAL_TOP_Y);
  ctx.moveTo(FIELD_RIGHT,GOAL_BOTTOM_Y); ctx.lineTo(FIELD_RIGHT,FIELD_BOTTOM);
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W/2,FIELD_TOP); ctx.lineTo(W/2,FIELD_BOTTOM); ctx.stroke();
  ctx.beginPath(); ctx.arc(W/2,H/2,50,0,Math.PI*2); ctx.stroke();
  ctx.beginPath(); ctx.arc(W/2,H/2,3,0,Math.PI*2); ctx.fillStyle='#eef0e6'; ctx.fill();
  ctx.strokeRect(FIELD_LEFT,H/2-BOX_H/2,BOX_W,BOX_H);
  ctx.strokeRect(FIELD_RIGHT-BOX_W,H/2-BOX_H/2,BOX_W,BOX_H);
}

// boneco: fica sempre virado para a bola (ombros, cabeça e pés vistos de cima)
function drawDisc(d){
  const r = d.r;
  const color = d.team === 'A' ? '#c0392b' : '#1f5fa8';
  const dark = d.team === 'A' ? '#7e1c14' : '#123a68';
  const facing = Math.atan2(ball.y - d.y, ball.x - d.x);

  ctx.beginPath();
  ctx.ellipse(d.x+2, d.y+3, r+3, r+1.5, 0, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fill();

  ctx.save();
  ctx.translate(d.x, d.y);
  ctx.rotate(facing);

  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath(); ctx.ellipse(-r*0.55, -r*0.4, r*0.32, r*0.55, 0, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-r*0.55,  r*0.4, r*0.32, r*0.55, 0, 0, Math.PI*2); ctx.fill();

  const shoulderGrad = ctx.createLinearGradient(-r*0.6,0, r*0.5,0);
  shoulderGrad.addColorStop(0, dark); shoulderGrad.addColorStop(1, color);
  ctx.beginPath();
  ctx.ellipse(-r*0.05, 0, r*0.72, r*1.02, 0, 0, Math.PI*2);
  ctx.fillStyle = shoulderGrad; ctx.fill();
  ctx.lineWidth = 1.3; ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.stroke();

  ctx.beginPath(); ctx.arc(r*0.58, 0, r*0.4, 0, Math.PI*2);
  ctx.fillStyle = '#d9a066'; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();

  ctx.rotate(-facing);
  ctx.fillStyle = '#f2efe4'; ctx.font = 'bold 9px "Space Mono", monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(d.num, 0, 1);
  ctx.restore();

  if(selectedDisc === d){
    ctx.save();
    ctx.strokeStyle = 'rgba(212,175,55,0.95)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(d.x, d.y, r+7, 0, Math.PI*2); ctx.stroke();
    ctx.restore();
  }
}

function drawPentagon(cx,cy,size,rot){
  ctx.beginPath();
  for(let i=0;i<5;i++){
    const a = rot + i*(Math.PI*2/5) - Math.PI/2;
    const px = cx+Math.cos(a)*size, py = cy+Math.sin(a)*size;
    if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
  }
  ctx.closePath(); ctx.fill();
}
function drawBall(){
  const r = ball.r;
  ctx.save();
  ctx.translate(ball.x, ball.y);
  ctx.rotate(ball.spin);
  ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2);
  const base = ctx.createRadialGradient(-3,-3,1,0,0,r);
  base.addColorStop(0,'#ffffff'); base.addColorStop(1,'#d8d3c4');
  ctx.fillStyle = base; ctx.fill();

  ctx.save();
  ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.clip();
  ctx.fillStyle = '#20201f';
  drawPentagon(0,-r*0.08,r*0.4,0);
  for(let i=0;i<5;i++){
    const a = i*(Math.PI*2/5) - Math.PI/2;
    drawPentagon(Math.cos(a)*r*0.85, Math.sin(a)*r*0.85 - r*0.08, r*0.32, a+Math.PI);
  }
  ctx.restore();
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2); ctx.stroke();
  ctx.restore();
}

// ---- controlo tátil ----
// desktop: arrasta diretamente o boneco para apontar e larga para rematar.
// mobile: toca no boneco para o SELECIONAR e depois aponta a partir de qualquer parte do ecrã
// (não é preciso manter o dedo em cima do boneco, evita tapar a seta com o próprio dedo).
const activePointers = new Map();
let dragging = null, dragStart = null, maxFingers = 1, posBuffer = [], mouse = {x:0,y:0};
let selectedDisc = null;

function getMousePos(e){
  const rect = canvas.getBoundingClientRect();
  return { x:(e.clientX-rect.left)*(W/rect.width), y:(e.clientY-rect.top)*(H/rect.height) };
}
function findDiscAt(pos, generous){
  const list = turn === 'A' ? discsA : discsB;
  const pad = generous ? 22 : 8;
  return list.find(d => Math.hypot(d.x-pos.x,d.y-pos.y) < d.r+pad);
}
function canIPlay(){
  return currentRoom && myTeam === turn && !celebrating && !foulFlash && !inPenalty && !awaitingFoulResult;
}

canvas.addEventListener('pointerdown', (e)=>{
  const pos = getMousePos(e);
  activePointers.set(e.pointerId, {x:pos.x,y:pos.y,t:performance.now()});

  if(inPenalty){
    if(activePointers.size !== 1) return;
    if(penaltyRole !== 'shooter' || penaltyCommitted || !penaltyKeeperReady) return;

    // no telemóvel usamos o mesmo esquema em duas fases do resto do jogo:
    // 1º toque no jogador para o selecionar, 2º toque em qualquer lado do ecrã para apontar.
    // Isto evita ter de acertar sempre em cima do disco com o dedo (que também tapa a mira).
    if(isMobile){
      if(selectedDisc === penaltyShooterDisc){
        dragging = penaltyShooterDisc; dragStart = { x: dragging.x, y: dragging.y };
        maxFingers = 1; posBuffer = [{x:pos.x,y:pos.y,t:performance.now()}]; mouse = pos;
        return;
      }
      if(Math.hypot(penaltyShooterDisc.x-pos.x, penaltyShooterDisc.y-pos.y) < penaltyShooterDisc.r+22){
        selectedDisc = penaltyShooterDisc;
      }
      return;
    }

    if(Math.hypot(penaltyShooterDisc.x-pos.x, penaltyShooterDisc.y-pos.y) < penaltyShooterDisc.r+8){
      dragging = penaltyShooterDisc; dragStart = { x: dragging.x, y: dragging.y };
      maxFingers = 1; posBuffer = [{x:pos.x,y:pos.y,t:performance.now()}]; mouse = pos;
    }
    return;
  }

  if(isMobile){
    if(activePointers.size !== 1) return;
    if(selectedDisc){
      // 2ª fase: já há um jogador selecionado — este toque, seja onde for, começa a apontar
      dragging = selectedDisc;
      dragStart = { x: selectedDisc.x, y: selectedDisc.y };
      maxFingers = 1; posBuffer = [{x:pos.x,y:pos.y,t:performance.now()}]; mouse = pos;
      return;
    }
    if(!everythingStopped() || !canIPlay()) return;
    const d = findDiscAt(pos, true);
    if(d) selectedDisc = d;
    return;
  }

  if(activePointers.size === 1){
    if(!everythingStopped() || !canIPlay()) return;
    const d = findDiscAt(pos);
    if(d){ dragging=d; dragStart={x:d.x,y:d.y}; maxFingers=1; posBuffer=[{x:pos.x,y:pos.y,t:performance.now()}]; mouse=pos; }
  } else if(activePointers.size >= 2 && dragging){
    maxFingers = 2;
    posBuffer = [{x:pos.x,y:pos.y,t:performance.now()}];
  }
});
canvas.addEventListener('pointermove', (e)=>{
  if(!activePointers.has(e.pointerId)) return;
  const pos = getMousePos(e);
  activePointers.set(e.pointerId, {x:pos.x,y:pos.y,t:performance.now()});
  if(!dragging) return;
  mouse = pos;
  posBuffer.push({x:pos.x,y:pos.y,t:performance.now()});
  if(posBuffer.length > 8) posBuffer.shift();
});
canvas.addEventListener('pointerup', (e)=>{
  activePointers.delete(e.pointerId);
  if(!dragging) return;
  if(activePointers.size > 0) return;

  let vx = 0, vy = 0;
  if(maxFingers >= 2 && posBuffer.length >= 2){
    const first = posBuffer[0], last = posBuffer[posBuffer.length-1];
    const dt = Math.max(last.t-first.t, 16);
    let dvx = (last.x-first.x)/dt*16, dvy = (last.y-first.y)/dt*16;
    const speed = Math.hypot(dvx,dvy);
    const capped = Math.min(speed*SWIPE_POWER, MAX_SWIPE_SPEED);
    if(speed > 0){ vx = dvx/speed*capped; vy = dvy/speed*capped; }
  } else {
    let aimX = mouse.x-dragStart.x, aimY = mouse.y-dragStart.y;
    const aimDist = Math.hypot(aimX,aimY);
    if(aimDist >= MIN_PULL_TO_AIM){
      const powerPct = parseInt(byId('powerSlider').value)/100;
      const speed = powerPct * MAX_PULL_SPEED;
      vx = (aimX/aimDist)*speed;
      vy = (aimY/aimDist)*speed;
    }
  }

  if(inPenalty && dragging === penaltyShooterDisc){
    if(vx !== 0 || vy !== 0){
      penaltyCommitted = true;
      byId('penaltyShooterHint').style.display = 'none';
      byId('penaltyWaiting').style.display = 'block';
      socket.emit('penalty_shot', { roomId: currentRoom.id, vx, vy });
    }
    dragging = null; posBuffer = []; selectedDisc = null;
    return;
  }

  if(vx !== 0 || vy !== 0){
    dragging.vx = vx; dragging.vy = vy;
    socket.emit('shot', { roomId: currentRoom.id, discId: dragging.id, vx, vy });
    activeShotDiscId = dragging.id; activeShotTeam = dragging.team; activeShotTouchedBall = false;
  }
  dragging = null; posBuffer = []; selectedDisc = null;
});

on('powerSlider', 'input', (e)=>{
  byId('powerVal').textContent = e.target.value + '%';
});

function drawAim(){
  if(!dragging || maxFingers >= 2) return;
  const dx = mouse.x-dragStart.x, dy = mouse.y-dragStart.y;
  const dist = Math.hypot(dx,dy);
  if(dist < MIN_PULL_TO_AIM) return;
  const ux = dx/dist, uy = dy/dist;

  const startX = dragging.x + ux*dragging.r*1.3;
  const startY = dragging.y + uy*dragging.r*1.3;
  const endX = dragging.x + ux*(dragging.r*1.3+AIM_LENGTH);
  const endY = dragging.y + uy*(dragging.r*1.3+AIM_LENGTH);

  ctx.strokeStyle = 'rgba(212,175,55,0.9)';
  ctx.lineWidth = AIM_LINE_WIDTH;
  ctx.beginPath(); ctx.moveTo(startX,startY); ctx.lineTo(endX,endY); ctx.stroke();

  const headSize = AIM_HEAD_SIZE;
  const angle = Math.atan2(uy,ux);
  ctx.beginPath();
  ctx.moveTo(endX,endY);
  ctx.lineTo(endX - headSize*Math.cos(angle-0.4), endY - headSize*Math.sin(angle-0.4));
  ctx.lineTo(endX - headSize*Math.cos(angle+0.4), endY - headSize*Math.sin(angle+0.4));
  ctx.closePath();
  ctx.fillStyle = 'rgba(212,175,55,0.9)';
  ctx.fill();
}

// ---- física ----
function resolveCollision(a,b){
  const dx=b.x-a.x, dy=b.y-a.y, dist=Math.hypot(dx,dy), minDist=a.r+b.r;
  if(dist===0 || dist>=minDist) return false;
  const nx=dx/dist, ny=dy/dist, overlap=minDist-dist, totalMass=a.mass+b.mass;
  a.x -= nx*overlap*(b.mass/totalMass); a.y -= ny*overlap*(b.mass/totalMass);
  b.x += nx*overlap*(a.mass/totalMass); b.y += ny*overlap*(a.mass/totalMass);
  const rvx=b.vx-a.vx, rvy=b.vy-a.vy, rel=rvx*nx+rvy*ny;
  if(rel>0) return false;
  const involvesBall = (a===ball||b===ball);
  const restitution = involvesBall ? RESTITUTION_BALL : RESTITUTION_DISC;
  const impulse = -(1+restitution)*rel/(1/a.mass+1/b.mass);
  a.vx -= (impulse/a.mass)*nx; a.vy -= (impulse/a.mass)*ny;
  b.vx += (impulse/b.mass)*nx; b.vy += (impulse/b.mass)*ny;

  // toque de raspão: a componente tangencial do impacto vira rotação real da bola,
  // com a fórmula do torque real (r × F) no ponto de contacto — toques de lados
  // opostos produzem sempre rotações opostas
  if(involvesBall){
    const tx=-ny, ty=nx, relT=rvx*tx+rvy*ty, spinKick=relT*SPIN_TRANSFER;
    if(a===ball) a.angVel -= spinKick/a.r;
    if(b===ball) b.angVel -= spinKick/b.r;
  }
  return true;
}

function physicsStep(){
  const objs = [...allDiscs(), ball];
  for(const o of objs){
    const isBall = (o===ball);
    const maxSpeed = isBall ? MAX_SPEED_BALL : MAX_SPEED_DISC;
    let speed = Math.hypot(o.vx,o.vy);
    if(speed > maxSpeed){ o.vx=o.vx/speed*maxSpeed; o.vy=o.vy/speed*maxSpeed; }
    o.x += o.vx; o.y += o.vy;
    const fr = isBall ? BALL_FRICTION : DISC_FRICTION;
    o.vx *= fr; o.vy *= fr;
    if(Math.hypot(o.vx,o.vy) < MIN_SPEED){ o.vx=0; o.vy=0; }

    if(o.y-o.r < FIELD_TOP){ o.y=FIELD_TOP+o.r; o.vy*=-0.7; }
    if(o.y+o.r > FIELD_BOTTOM){ o.y=FIELD_BOTTOM-o.r; o.vy*=-0.7; }

    const inGoalY = o.y > GOAL_TOP_Y+o.r*0.4 && o.y < GOAL_BOTTOM_Y-o.r*0.4;
    if(isBall && inGoalY){
      if(o.x-o.r < 2){ o.x=2+o.r; o.vx*=-0.5; }
      if(o.x+o.r > W-2){ o.x=W-2-o.r; o.vx*=-0.5; }
    } else {
      if(o.x-o.r < FIELD_LEFT){ o.x=FIELD_LEFT+o.r; o.vx*=-0.7; }
      if(o.x+o.r > FIELD_RIGHT){ o.x=FIELD_RIGHT-o.r; o.vx*=-0.7; }
    }
  }

  const rollSpin = Math.hypot(ball.vx,ball.vy)/ball.r;
  ball.spin += rollSpin + ball.angVel;
  ball.angVel *= SPIN_DECAY;
  ball.angVel = Math.max(-MAX_SPIN_VEL, Math.min(MAX_SPIN_VEL, ball.angVel));

  let frameContacts = [];
  for(let i=0;i<objs.length;i++) for(let j=i+1;j<objs.length;j++){
    if(resolveCollision(objs[i],objs[j])) frameContacts.push([objs[i],objs[j]]);
  }

  // deteção de falta: o disco que foi lançado nesta jogada só pode tocar em discos
  // adversários DEPOIS de ter tocado na bola — se tocar antes, é falta
  if(myTeam === 'A' && currentRoom && !celebrating && !inPenalty && activeShotDiscId){
    const shooterDisc = findDiscById(activeShotDiscId);
    if(!shooterDisc){
      activeShotDiscId = null;
    } else {
      for(const [oa, ob] of frameContacts){
        if(oa !== shooterDisc && ob !== shooterDisc) continue;
        const other = oa === shooterDisc ? ob : oa;
        if(other === ball){
          activeShotTouchedBall = true;
          activeShotDiscId = null;
        } else if(other.team !== activeShotTeam){
          if(!activeShotTouchedBall){
            const fx = (shooterDisc.x + other.x)/2, fy = (shooterDisc.y + other.y)/2;
            triggerFoul(activeShotTeam, fx, fy, shooterDisc.id, other.id);
          }
          activeShotDiscId = null;
        }
        break;
      }
    }
  }

  // golo: só conta quando a bola PASSOU TODA a linha (o bordo de trás da bola já
  // está para lá da linha), e não apenas quando o centro a cruza. Assim que isso
  // acontece é reportado de imediato e a física congela nesse mesmo frame — impede
  // que a bola bata na rede e volte a sair para o campo antes de ser validado o golo
  if(myTeam === 'A' && currentRoom && !celebrating){
    if(ball.x + ball.r < FIELD_LEFT){ reportGoal('B'); }
    else if(ball.x - ball.r > FIELD_RIGHT){ reportGoal('A'); }
  }
}

function triggerFoul(offendingTeam, x, y, offenderDiscId, victimDiscId){
  if(!currentRoom) return;
  awaitingFoulResult = true;
  socket.emit('foul', { roomId: currentRoom.id, offendingTeam, x, y, offenderDiscId, victimDiscId });
}

function reportGoal(team){
  celebrating = true;
  celebrationStart = performance.now();
  celebrationTeam = team;
  ball.vx = 0; ball.vy = 0;
  activeShotDiscId = null;
  penaltyKickActive = false;
  socket.emit('goal', { roomId: currentRoom.id, team });
}

function drawGoalCelebration(elapsed){
  const t = Math.min(elapsed/CELEBRATION_MS,1);
  ctx.fillStyle = `rgba(212,175,55,${0.22*(1-t)})`; ctx.fillRect(0,0,W,H);
  const popIn = Math.min(elapsed/220,1);
  const scale = 0.4+Math.sin(popIn*Math.PI/2)*0.75;
  const fadeOut = elapsed > CELEBRATION_MS-350 ? Math.max(0,(CELEBRATION_MS-elapsed)/350) : 1;
  ctx.save(); ctx.globalAlpha=fadeOut; ctx.translate(W/2,H/2); ctx.scale(scale,scale);
  ctx.font='900 66px "Anton", sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.lineWidth=5; ctx.strokeStyle='#f5f5f0'; ctx.strokeText('GOLO!',0,0);
  ctx.fillStyle = celebrationTeam==='A' ? '#e0473b' : '#3a86d6'; ctx.fillText('GOLO!',0,0);
  ctx.restore();
  ctx.save(); ctx.globalAlpha=fadeOut; ctx.font='bold 15px "Space Mono", monospace'; ctx.textAlign='center';
  ctx.fillStyle='#f2efe4'; ctx.fillText(celebrationTeam==='A'?'VERMELHO MARCOU':'AZUL MARCOU', W/2, H/2+52);
  ctx.restore();
}

function drawFoulFlash(elapsed){
  const t = Math.min(elapsed/FOUL_FLASH_MS,1);
  ctx.fillStyle = `rgba(224,71,59,${0.18*(1-t)})`; ctx.fillRect(0,0,W,H);
  const popIn = Math.min(elapsed/200,1);
  const scale = 0.5+Math.sin(popIn*Math.PI/2)*0.6;
  const fadeOut = elapsed > FOUL_FLASH_MS-300 ? Math.max(0,(FOUL_FLASH_MS-elapsed)/300) : 1;
  ctx.save(); ctx.globalAlpha=fadeOut; ctx.translate(W/2,H/2); ctx.scale(scale,scale);
  ctx.font='900 50px "Anton", sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.lineWidth=4; ctx.strokeStyle='#f5f5f0'; ctx.strokeText(foulFlashText,0,0);
  ctx.fillStyle = '#e0473b'; ctx.fillText(foulFlashText,0,0);
  ctx.restore();
}

function render(){
  ctx.clearRect(0,0,W,H);
  drawPitch();
  discsA.forEach(drawDisc); discsB.forEach(drawDisc);
  drawBall(); drawAim();
}

function loop(){
  if(byId('screen-game').classList.contains('active')){
    if(celebrating){
      const elapsed = performance.now()-celebrationStart;
      render(); drawGoalCelebration(elapsed);
      if(elapsed >= CELEBRATION_MS){
        celebrating = false;
        penaltyKickActive = false;
        resetPositions(); // bola e discos voltam à formação inicial no centro do campo
      }
    } else if(foulFlash){
      const elapsed = performance.now()-foulFlashStart;
      render(); drawFoulFlash(elapsed);
      if(elapsed >= FOUL_FLASH_MS){ foulFlash = false; }
    } else if(awaitingFoulResult){
      render();
    } else if(inPenalty){
      render();
    } else {
      physicsStep();
      applyStateSyncSmoothing(); // lado B: aproxima-se suavemente do último estado recebido do servidor
      render();
      if(myTeam === 'A' && activeShotDiscId && everythingStopped()){
        activeShotDiscId = null;
      }
      if(myTeam === 'A' && penaltyKickActive && currentRoom && everythingStopped()){
        penaltyKickActive = false;
        socket.emit('penalty_missed', { roomId: currentRoom.id });
      }
    }
  }
  requestAnimationFrame(loop);
}

// a equipa A (vermelho) é a autoridade da física — envia o estado real várias
// vezes por segundo; a equipa B (azul) corrige-se por esse estado, evitando
// que a bola vá divergindo entre os dois ecrãs por pequenas diferenças de tempo.
// Em vez de "saltar" instantaneamente para a posição recebida, o lado B interpola
// suavemente até lá (ver applyStateSync / smoothing no loop de física), o que
// disfarça bem os atrasos de rede e evita que o jogo pareça aos solavancos.
setInterval(() => {
  if(myTeam === 'A' && currentRoom && byId('screen-game').classList.contains('active') && !celebrating && !foulFlash && !awaitingFoulResult){
    socket.emit('state_sync', {
      roomId: currentRoom.id,
      ball: { x:ball.x, y:ball.y, vx:ball.vx, vy:ball.vy, spin:ball.spin, angVel:ball.angVel },
      discs: allDiscs().map(d => ({ id:d.id, x:d.x, y:d.y, vx:d.vx, vy:d.vy }))
    });
  }
}, 90);

// alvo de interpolação para o lado B: guardamos a última posição recebida do
// servidor e vamos "perseguindo-a" a cada frame em vez de saltar para ela de
// imediato — isto disfarça o jitter da rede sem inventar física nova
let syncTargetBall = null;
let syncTargetDiscs = null;
const SYNC_LERP = 0.35;

socket.on('state_sync', (state) => {
  if(myTeam === 'A') return;
  if(celebrating || foulFlash) return; // cada lado usa a formação local determinística nestas fases
  if(state.ball) syncTargetBall = state.ball;
  if(state.discs) syncTargetDiscs = state.discs;
});

function applyStateSyncSmoothing(){
  if(myTeam === 'A') return;
  if(syncTargetBall){
    ball.x += (syncTargetBall.x - ball.x) * SYNC_LERP;
    ball.y += (syncTargetBall.y - ball.y) * SYNC_LERP;
    ball.vx = syncTargetBall.vx; ball.vy = syncTargetBall.vy;
    ball.spin = syncTargetBall.spin; ball.angVel = syncTargetBall.angVel;
  }
  if(syncTargetDiscs){
    syncTargetDiscs.forEach(sd => {
      const d = findDiscById(sd.id);
      if(d){
        d.x += (sd.x - d.x) * SYNC_LERP;
        d.y += (sd.y - d.y) * SYNC_LERP;
        d.vx = sd.vx; d.vy = sd.vy;
      }
    });
  }
}

// a equipa A é a autoridade da física (deteta golos, faltas e fim do livre de 10 metros),
// mas isso corre dentro do loop() que depende de requestAnimationFrame — e os browsers
// travam quase por completo o requestAnimationFrame de janelas/separadores que não estão
// em primeiro plano (ex: a testar os dois jogadores no mesmo PC em duas janelas, e uma
// delas fica em segundo plano). Sem isto, o jogo "encravava" à espera de um evento que
// o cliente da equipa A deixava de conseguir reportar. Este tique de reserva usa
// setInterval (muito menos travado do que o requestAnimationFrame em segundo plano) e só
// atua quando a janela está mesmo escondida, para não fazer duplo trabalho com o loop normal.
setInterval(() => {
  if(!document.hidden) return;
  if(myTeam !== 'A' || !currentRoom) return;
  if(!byId('screen-game').classList.contains('active')) return;

  if(celebrating){
    if(performance.now() - celebrationStart >= CELEBRATION_MS){
      celebrating = false;
      penaltyKickActive = false;
      resetPositions();
    }
    return;
  }
  if(foulFlash){
    if(performance.now() - foulFlashStart >= FOUL_FLASH_MS) foulFlash = false;
    return;
  }
  if(awaitingFoulResult || inPenalty) return;

  physicsStep();
  if(activeShotDiscId && everythingStopped()) activeShotDiscId = null;
  if(penaltyKickActive && everythingStopped()){
    penaltyKickActive = false;
    socket.emit('penalty_missed', { roomId: currentRoom.id });
  }
}, 120);

// para o lado B (não-autoridade), também vale a pena continuar a interpolar mesmo
// em segundo plano, senão a bola "salta" de repente quando a aba volta ao ecrã
setInterval(() => {
  if(!document.hidden) return;
  if(myTeam === 'A') return;
  applyStateSyncSmoothing();
}, 120);

// ============ LIVRE DE 10 METROS ============
function startTenMeterKick(offendingTeam, fouledTeam){
  inPenalty = true;
  penaltyCommitted = false;
  penaltyKeeperReady = false;
  penaltyOffendingTeam = offendingTeam;
  penaltyFouledTeam = fouledTeam;
  penaltyKickActive = true;
  activeShotDiscId = null;
  selectedDisc = null;

  const shootingRight = fouledTeam === 'A'; // A ataca a baliza direita (de B)
  const spotX = shootingRight ? FIELD_RIGHT - BOX_W - TEN_METER_GAP : FIELD_LEFT + BOX_W + TEN_METER_GAP;
  const shooterX = shootingRight ? spotX - TEN_METER_SHOOTER_OFFSET : spotX + TEN_METER_SHOOTER_OFFSET;
  const keeperX = shootingRight ? FIELD_RIGHT - TEN_METER_KEEPER_LINE : FIELD_LEFT + TEN_METER_KEEPER_LINE;

  ball.x = spotX; ball.y = H/2; ball.vx = 0; ball.vy = 0; ball.spin = 0; ball.angVel = 0;

  const shooterList = fouledTeam === 'A' ? discsA : discsB;
  const keeperList = offendingTeam === 'A' ? discsA : discsB;
  penaltyShooterDisc = shooterList[0];
  penaltyKeeperDisc = keeperList[0];
  penaltyShooterDisc.x = shooterX; penaltyShooterDisc.y = H/2; penaltyShooterDisc.vx=0; penaltyShooterDisc.vy=0;
  penaltyKeeperDisc.x = keeperX; penaltyKeeperDisc.y = H/2; penaltyKeeperDisc.vx=0; penaltyKeeperDisc.vy=0;

  // afasta os restantes jogadores para não atrapalharem o lance
  let i = 0;
  allDiscs().forEach(d => {
    if(d === penaltyShooterDisc || d === penaltyKeeperDisc) return;
    d.x = 50 + i*24; d.y = FIELD_TOP + 16;
    d.vx = 0; d.vy = 0;
    i++;
  });

  penaltyRole = (myTeam === offendingTeam) ? 'keeper' : (myTeam === fouledTeam ? 'shooter' : null);
  showPenaltyOverlay();
}

// CORREÇÃO PRINCIPAL DO BUG DO LIVRE DE 10 METROS:
// o #penaltyOverlay é "position:absolute; inset:0" e cobre o campo inteiro. Enquanto
// só está a mostrar texto (ex: "Já podes rematar!") continuava, mesmo assim, a
// intercetar todos os toques/cliques — por isso o jogador nunca conseguia arrastar
// o disco no canvas por baixo, e ficava "preso" na mensagem. A correção é simples:
// só deixamos o overlay bloquear toques quando ele TEM de facto algo clicável
// (os botões do guarda-redes). Nos restantes estados (à espera, ou "podes rematar"),
// o overlay passa a "pointer-events:none" e os toques atravessam-no até ao canvas.
function showPenaltyOverlay(){
  const overlay = byId('penaltyOverlay');
  overlay.style.display = 'flex';

  const isKeeperChoosing = penaltyRole === 'keeper' && !penaltyCommitted;
  byId('penaltyKeeperControls').style.display = isKeeperChoosing ? 'block' : 'none';
  byId('penaltyShooterWait').style.display = (penaltyRole === 'shooter' && !penaltyKeeperReady) ? 'block' : 'none';
  byId('penaltyShooterHint').style.display = (penaltyRole === 'shooter' && penaltyKeeperReady && !penaltyCommitted) ? 'block' : 'none';
  byId('penaltyWaiting').style.display = 'none';

  // só bloqueia cliques quando há botões para carregar (guarda-redes a escolher);
  // em todos os outros casos deixa passar para o canvas por baixo
  overlay.style.pointerEvents = isKeeperChoosing ? 'auto' : 'none';
}
function hidePenaltyOverlay(){
  const overlay = byId('penaltyOverlay');
  overlay.style.display = 'none';
  overlay.style.pointerEvents = 'auto';
}

document.querySelectorAll('#penaltyKeeperControls button').forEach(btn => {
  btn.addEventListener('click', () => {
    if(!inPenalty || penaltyRole !== 'keeper' || penaltyCommitted) return;
    penaltyCommitted = true;
    byId('penaltyKeeperControls').style.display = 'none';
    byId('penaltyWaiting').style.display = 'block';
    byId('penaltyOverlay').style.pointerEvents = 'none';
    socket.emit('penalty_keeper_choice', { roomId: currentRoom.id, side: btn.dataset.side });
  });
});

socket.on('penalty_keeper_ready', () => {
  penaltyKeeperReady = true;
  if(penaltyRole === 'shooter'){
    byId('penaltyShooterWait').style.display = 'none';
    byId('penaltyShooterHint').style.display = 'block';
    // agora é a vez do remate — o overlay deixa de bloquear o canvas
    byId('penaltyOverlay').style.pointerEvents = 'none';
  }
});

// só chega quando AMBOS já escolheram — o remate e o mergulho do guarda-redes
// arrancam exatamente ao mesmo tempo nos dois ecrãs
socket.on('penalty_ready', ({ keeperChoice, shot }) => {
  hidePenaltyOverlay();
  penaltyRole = null;
  penaltyCommitted = false;
  selectedDisc = null;

  ball.vx = shot.vx; ball.vy = shot.vy;

  const targetY = keeperChoice === 'top' ? GOAL_TOP_Y + 15 : keeperChoice === 'bottom' ? GOAL_BOTTOM_Y - 15 : H/2;
  const dy = targetY - penaltyKeeperDisc.y;
  const dist = Math.max(Math.abs(dy), 1);
  penaltyKeeperDisc.vy = (dy/dist) * KEEPER_DASH_SPEED;
  penaltyKeeperDisc.vx = 0;

  inPenalty = false; // a física normal do motor de jogo passa a resolver a jogada (golo, defesa ou fora)
});

socket.on('penalty_over', ({ turn: t }) => {
  penaltyRole = null; penaltyCommitted = false; penaltyKeeperReady = false;
  hidePenaltyOverlay();
  turn = t;
  updateTurnBadge();
  resetPositions();
});

if(isMobile){
  const hint = document.querySelector('#screen-game .footer .hint');
  if(hint) hint.textContent = 'Toca no teu jogador para o selecionares e depois toca em qualquer parte do ecrã para apontares e largares o remate.';
}

resetPositions();
loop();
