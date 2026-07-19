// ============ ESTADO GERAL / NAVEGAÇÃO ============
const socket = io();
let myName = null;
let myTeam = null;
let currentRoom = null;

function showScreen(id){
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ---- ecrã nome ----
document.getElementById('btnSetName').addEventListener('click', submitName);
document.getElementById('nameInput').addEventListener('keydown', e => { if(e.key==='Enter') submitName(); });
function submitName(){
  const v = document.getElementById('nameInput').value.trim();
  if(!v) return;
  socket.emit('set_name', v);
}
socket.on('name_ok', (name) => {
  myName = name;
  document.getElementById('lobbyName').textContent = name;
  showScreen('screen-lobby');
});

// ---- lobby ----
document.getElementById('btnCreateRoom').addEventListener('click', () => {
  const roomName = document.getElementById('roomNameInput').value.trim() || (myName + ' — sala');
  const bestOf = document.getElementById('bestOfInput').value || 5;
  socket.emit('create_room', { roomName, bestOf });
});

socket.on('rooms', (list) => {
  const el = document.getElementById('roomList');
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

document.getElementById('btnShowRanking').addEventListener('click', () => {
  socket.emit('get_rankings');
  showScreen('screen-ranking');
});
document.getElementById('btnCloseRanking').addEventListener('click', () => showScreen('screen-lobby'));

socket.on('rankings', (list) => {
  const tbody = document.querySelector('#rankingTable tbody');
  tbody.innerHTML = '';
  if(!list.length){
    tbody.innerHTML = '<tr><td colspan="6" class="hint">Ainda sem jogos registados.</td></tr>';
    return;
  }
  list.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i+1}</td><td>${escapeHtml(r.name)}</td><td>${r.wins}</td><td>${r.draws}</td><td>${r.losses}</td><td>${r.points}</td>`;
    tbody.appendChild(tr);
  });
});

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---- sala de espera ----
socket.on('room_joined', ({ room, myTeam: team }) => {
  currentRoom = room;
  myTeam = team;
  document.getElementById('waitRoomInfo').textContent = `"${room.name}" — até ${room.bestOf} golos`;
  showScreen('screen-wait');
});
document.getElementById('btnCancelWait').addEventListener('click', () => {
  socket.emit('leave_room');
  showScreen('screen-lobby');
});

// ---- início de partida ----
socket.on('match_start', ({ room, players }) => {
  currentRoom = room;
  const a = players.find(p => p.team === 'A');
  const b = players.find(p => p.team === 'B');
  document.getElementById('labelA').textContent = a.name;
  document.getElementById('labelB').textContent = b.name;
  scoreA = 0; scoreB = 0; turn = 'A';
  document.getElementById('scoreA').textContent = 0;
  document.getElementById('scoreB').textContent = 0;
  updateTurnBadge();
  resetPositions();
  showScreen('screen-game');
});

socket.on('opponent_left', () => {
  alert('O adversário saiu da sala.');
  socket.emit('leave_room');
  showScreen('screen-lobby');
});

document.getElementById('btnLeaveGame').addEventListener('click', () => {
  socket.emit('leave_room');
  showScreen('screen-lobby');
});

socket.on('turn_update', ({ turn: t }) => { turn = t; updateTurnBadge(); });

socket.on('opponent_shot', ({ discId, vx, vy }) => {
  const d = findDiscById(discId);
  if(d){ d.vx = vx; d.vy = vy; }
});

socket.on('score_update', ({ scoreA: a, scoreB: b, turn: t }) => {
  scoreA = a; scoreB = b; turn = t;
  document.getElementById('scoreA').textContent = scoreA;
  document.getElementById('scoreB').textContent = scoreB;
  updateTurnBadge();
});

socket.on('match_over', ({ winner, scoreA: a, scoreB: b }) => {
  const title = winner === 'draw' ? 'EMPATE!' :
    (winner === myTeam ? 'VITÓRIA!' : 'DERROTA');
  document.getElementById('overTitle').textContent = title;
  document.getElementById('overScore').textContent = `Resultado final: ${a} — ${b}`;
  showScreen('screen-over');
});
document.getElementById('btnBackToLobby').addEventListener('click', () => {
  socket.emit('get_rankings');
  showScreen('screen-lobby');
});

// ============ MOTOR DE JOGO ============
const canvas = document.getElementById('pitch');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const GOAL_W = 120;

const DISC_FRICTION = 0.983;
const BALL_FRICTION = 0.986;     // desliza bastante mais antes de parar
const MIN_SPEED = 0.02;
const MAX_SPEED_DISC = 7;
const MAX_SPEED_BALL = 13;

const FIELD_TOP = 6, FIELD_BOTTOM = H - 6;
const FIELD_LEFT = 34, FIELD_RIGHT = W - 34;
const GOAL_TOP_Y = H/2 - GOAL_W/2, GOAL_BOTTOM_Y = H/2 + GOAL_W/2;

const DISC_MASS = 3;
const BALL_MASS = 1;
const RESTITUTION_BALL = 0.92;
const RESTITUTION_DISC = 0.75;

const SPIN_TRANSFER = 0.85;
const SPIN_DECAY = 0.988;
const MAX_SPIN_VEL = 0.75;

const MAX_PULL_SPEED = 7;        // força máxima do controlo por barra
const MIN_PULL_TO_AIM = 6;       // px mínimos de arrasto só para definir direção
const SWIPE_POWER = 0.9;
const MAX_SWIPE_SPEED = 9;

let scoreA = 0, scoreB = 0, turn = 'A';
let celebrating = false, celebrationStart = 0, celebrationTeam = null;
const CELEBRATION_MS = 1500;

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
}
function allDiscs(){ return [...discsA, ...discsB]; }
function findDiscById(id){ return allDiscs().find(d => d.id === id); }
function everythingStopped(){ return [...allDiscs(), ball].every(o => Math.hypot(o.vx,o.vy) < MIN_SPEED); }

function updateTurnBadge(){
  const badge = document.getElementById('turnBadge');
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
  const grad = ctx.createLinearGradient(backX, 0, isLeft ? boxX+boxW : boxX, 0);
  grad.addColorStop(0, '#0d2814'); grad.addColorStop(1, '#1c4a29');
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
  const stripeCount = 12, stripeW = W/stripeCount;
  for(let i=0;i<stripeCount;i++){
    ctx.fillStyle = i%2===0 ? '#1e4d2b' : '#245a33';
    ctx.fillRect(i*stripeW,0,stripeW,H);
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
  ctx.strokeRect(FIELD_LEFT,H/2-70,70,140);
  ctx.strokeRect(FIELD_RIGHT-70,H/2-70,70,140);
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
const activePointers = new Map();
let dragging = null, dragStart = null, maxFingers = 1, posBuffer = [], mouse = {x:0,y:0};

function getMousePos(e){
  const rect = canvas.getBoundingClientRect();
  return { x:(e.clientX-rect.left)*(W/rect.width), y:(e.clientY-rect.top)*(H/rect.height) };
}
function findDiscAt(pos){
  const list = turn === 'A' ? discsA : discsB;
  return list.find(d => Math.hypot(d.x-pos.x,d.y-pos.y) < d.r+8);
}
function canIPlay(){
  return currentRoom && myTeam === turn && !celebrating;
}

canvas.addEventListener('pointerdown', (e)=>{
  const pos = getMousePos(e);
  activePointers.set(e.pointerId, {x:pos.x,y:pos.y,t:performance.now()});
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
    // aponta-se na direção do remate — o boneco dispara para onde apontares
    let aimX = mouse.x-dragStart.x, aimY = mouse.y-dragStart.y;
    const aimDist = Math.hypot(aimX,aimY);
    if(aimDist >= MIN_PULL_TO_AIM){
      const powerPct = parseInt(document.getElementById('powerSlider').value)/100;
      const speed = powerPct * MAX_PULL_SPEED;
      vx = (aimX/aimDist)*speed;
      vy = (aimY/aimDist)*speed;
    }
  }

  if(vx !== 0 || vy !== 0){
    dragging.vx = vx; dragging.vy = vy;
    socket.emit('shot', { roomId: currentRoom.id, discId: dragging.id, vx, vy });
  }
  dragging = null; posBuffer = [];
});

document.getElementById('powerSlider').addEventListener('input', (e)=>{
  document.getElementById('powerVal').textContent = e.target.value + '%';
});

const AIM_LENGTH = 42; // comprimento fixo da mira — curto de propósito

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
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(startX,startY); ctx.lineTo(endX,endY); ctx.stroke();

  const headSize = 7;
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

  for(let i=0;i<objs.length;i++) for(let j=i+1;j<objs.length;j++) resolveCollision(objs[i],objs[j]);

  if(myTeam === 'A' && currentRoom){
    if(ball.x+ball.r < FIELD_LEFT){ reportGoal('B'); }
    else if(ball.x-ball.r > FIELD_RIGHT){ reportGoal('A'); }
  }
}

function reportGoal(team){
  celebrating = true; celebrationStart = performance.now(); celebrationTeam = team;
  socket.emit('goal', { roomId: currentRoom.id, team });
}

function resolveCollision(a,b){
  const dx=b.x-a.x, dy=b.y-a.y, dist=Math.hypot(dx,dy), minDist=a.r+b.r;
  if(dist===0 || dist>=minDist) return;
  const nx=dx/dist, ny=dy/dist, overlap=minDist-dist, totalMass=a.mass+b.mass;
  a.x -= nx*overlap*(b.mass/totalMass); a.y -= ny*overlap*(b.mass/totalMass);
  b.x += nx*overlap*(a.mass/totalMass); b.y += ny*overlap*(a.mass/totalMass);
  const rvx=b.vx-a.vx, rvy=b.vy-a.vy, rel=rvx*nx+rvy*ny;
  if(rel>0) return;
  const involvesBall = (a===ball||b===ball);
  const restitution = involvesBall ? RESTITUTION_BALL : RESTITUTION_DISC;
  const impulse = -(1+restitution)*rel/(1/a.mass+1/b.mass);
  a.vx -= (impulse/a.mass)*nx; a.vy -= (impulse/a.mass)*ny;
  b.vx += (impulse/b.mass)*nx; b.vy += (impulse/b.mass)*ny;
  if(involvesBall){
    const tx=-ny, ty=nx, relT=rvx*tx+rvy*ty, spinKick=relT*SPIN_TRANSFER;
    if(a===ball) a.angVel -= spinKick/a.r;
    if(b===ball) b.angVel += spinKick/b.r;
  }
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

function render(){
  ctx.clearRect(0,0,W,H);
  drawPitch();
  discsA.forEach(drawDisc); discsB.forEach(drawDisc);
  drawBall(); drawAim();
}

function loop(){
  if(document.getElementById('screen-game').classList.contains('active')){
    if(celebrating){
      const elapsed = performance.now()-celebrationStart;
      render(); drawGoalCelebration(elapsed);
      if(elapsed >= CELEBRATION_MS){ celebrating=false; }
    } else {
      physicsStep();
      render();
    }
  }
  requestAnimationFrame(loop);
}

resetPositions();
loop();
