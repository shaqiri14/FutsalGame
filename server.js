const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const RANKINGS_FILE = path.join(__dirname, 'data', 'rankings.json');
const RECONNECT_GRACE_MS = 10000; // tempo de tolerância para voltar depois de um refresh/queda de ligação
const PIN_REGEX = /^\d{4,6}$/;

// --- ranking persistido em ficheiro JSON (fácil de trocar por PostgreSQL depois) ---
function loadRankings(){
  try{ return JSON.parse(fs.readFileSync(RANKINGS_FILE, 'utf8')); }
  catch(e){ return {}; }
}
function saveRankings(data){
  fs.mkdirSync(path.dirname(RANKINGS_FILE), { recursive: true });
  fs.writeFileSync(RANKINGS_FILE, JSON.stringify(data, null, 2));
}
let rankings = loadRankings();
// cada entrada em "rankings" é indexada por chave normalizada (nome em minúsculas, sem espaços à volta):
// rankings[key] = { displayName, pinSalt, pinHash, wins, losses, draws, golosMarcados, golosSofridos }

function hashPin(pin, salt){
  return crypto.scryptSync(pin, salt, 64).toString('hex');
}
function verifyPin(pin, salt, hash){
  const test = Buffer.from(hashPin(pin, salt), 'hex');
  const real = Buffer.from(hash, 'hex');
  if(test.length !== real.length) return false;
  return crypto.timingSafeEqual(test, real);
}

function recordResult(keyA, keyB, scoreA, scoreB, winner){
  const a = rankings[keyA], b = rankings[keyB];
  if(!a || !b) return; // segurança: não deviam faltar, mas evita crash

  a.golosMarcados = (a.golosMarcados||0) + scoreA;
  a.golosSofridos = (a.golosSofridos||0) + scoreB;
  b.golosMarcados = (b.golosMarcados||0) + scoreB;
  b.golosSofridos = (b.golosSofridos||0) + scoreA;

  if(winner === 'draw'){
    a.draws++; b.draws++;
  } else if(winner === 'A'){
    a.wins++; b.losses++;
  } else {
    b.wins++; a.losses++;
  }
  saveRankings(rankings);
}

function rankingList(){
  return Object.values(rankings)
    .map(r => {
      const golosMarcados = r.golosMarcados || 0;
      const golosSofridos = r.golosSofridos || 0;
      return {
        name: r.displayName, wins: r.wins, losses: r.losses, draws: r.draws,
        golosMarcados, golosSofridos, saldo: golosMarcados - golosSofridos,
        points: r.wins*3 + r.draws, played: r.wins + r.losses + r.draws
      };
    })
    .sort((a,b) => b.points - a.points || b.saldo - a.saldo || b.golosMarcados - a.golosMarcados);
}

// --- chat público (histórico simples em memória) ---
const CHAT_HISTORY_LIMIT = 50;
let chatHistory = [];

// --- salas em memória ---
const rooms = new Map();
// room: { id, name, bestOf, players:[{id,token,name,rankKey,team,connected}], scoreA, scoreB, turn,
//         status: 'waiting'|'playing'|'finished', disconnectTimer }

function publicRoomList(){
  return [...rooms.values()]
    .filter(r => r.status !== 'finished')
    .map(r => ({
      id: r.id, name: r.name, bestOf: r.bestOf,
      players: r.players.map(p => p.name),
      status: r.status
    }));
}
function broadcastRooms(){ io.emit('rooms', publicRoomList()); }

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

io.on('connection', (socket) => {
  socket.data.name = null;
  socket.data.rankKey = null;
  socket.data.roomId = null;
  socket.data.token = null;

  // nome + PIN identificam a conta de ranking. Da primeira vez que um nome é usado,
  // o PIN fica associado a ele; nas vezes seguintes tem de bater certo com o mesmo
  // nome para continuar a somar vitórias/derrotas/golos a essa mesma conta.
  socket.on('set_name', ({ name, pin, token } = {}) => {
    const clean = String(name || '').trim().slice(0, 20);
    const cleanPin = String(pin || '').trim();

    if(!clean){
      socket.emit('set_name_failed', { reason: 'no_name' });
      return;
    }
    if(!PIN_REGEX.test(cleanPin)){
      socket.emit('set_name_failed', { reason: 'invalid_pin' });
      return;
    }

    const key = clean.toLowerCase();
    let entry = rankings[key];

    if(entry){
      if(!entry.pinHash){
        // conta antiga, criada antes de existir PIN — associa este PIN agora
        entry.pinSalt = crypto.randomBytes(16).toString('hex');
        entry.pinHash = hashPin(cleanPin, entry.pinSalt);
        entry.displayName = clean;
        saveRankings(rankings);
      } else if(!verifyPin(cleanPin, entry.pinSalt, entry.pinHash)){
        socket.emit('set_name_failed', { reason: 'wrong_pin' });
        return;
      }
    } else {
      entry = rankings[key] = {
        displayName: clean,
        pinSalt: crypto.randomBytes(16).toString('hex'),
        pinHash: '',
        wins: 0, losses: 0, draws: 0, golosMarcados: 0, golosSofridos: 0
      };
      entry.pinHash = hashPin(cleanPin, entry.pinSalt);
      saveRankings(rankings);
    }

    socket.data.name = entry.displayName;
    socket.data.rankKey = key;
    socket.data.token = token || crypto.randomBytes(8).toString('hex');

    socket.emit('name_ok', { name: socket.data.name, token: socket.data.token });
    socket.emit('rooms', publicRoomList());
    socket.emit('rankings', rankingList());
    socket.emit('chat_history', chatHistory);
  });

  socket.on('list_rooms', () => socket.emit('rooms', publicRoomList()));
  socket.on('get_rankings', () => socket.emit('rankings', rankingList()));

  // --- chat público ---
  socket.on('chat_message', (text) => {
    if(!socket.data.name) return;
    const clean = String(text || '').trim().slice(0, 300);
    if(!clean) return;
    const msg = { name: socket.data.name, text: clean, t: Date.now() };
    chatHistory.push(msg);
    if(chatHistory.length > CHAT_HISTORY_LIMIT) chatHistory.shift();
    io.emit('chat_message', msg);
  });

  // --- salas ---
  socket.on('create_room', ({ roomName, bestOf }) => {
    if(!socket.data.name) return;
    const id = Math.random().toString(36).slice(2, 8);
    const room = {
      id,
      name: String(roomName || 'Sala').trim().slice(0, 30) || 'Sala',
      bestOf: Math.min(Math.max(parseInt(bestOf) || 1, 1), 21),
      players: [{ id: socket.id, token: socket.data.token, name: socket.data.name, rankKey: socket.data.rankKey, team: 'A', connected: true }],
      scoreA: 0, scoreB: 0, turn: 'A', status: 'waiting',
      disconnectTimer: null
    };
    rooms.set(id, room);
    socket.join(id);
    socket.data.roomId = id;
    socket.emit('room_joined', { room, myTeam: 'A' });
    broadcastRooms();
  });

  socket.on('join_room', ({ roomId }) => {
    const room = rooms.get(roomId);
    if(!room || room.status !== 'waiting' || room.players.length >= 2) {
      socket.emit('join_failed', 'Sala indisponível.');
      return;
    }
    room.players.push({ id: socket.id, token: socket.data.token, name: socket.data.name, rankKey: socket.data.rankKey, team: 'B', connected: true });
    socket.join(roomId);
    socket.data.roomId = roomId;
    room.status = 'playing';

    socket.emit('room_joined', {
      room: { id: room.id, name: room.name, bestOf: room.bestOf },
      myTeam: 'B'
    });

    io.to(roomId).emit('match_start', {
      room: { id: room.id, name: room.name, bestOf: room.bestOf },
      players: room.players.map(p => ({ name: p.name, team: p.team })),
      scoreA: room.scoreA, scoreB: room.scoreB, turn: room.turn
    });
    broadcastRooms();
  });

  // --- reconexão (refresh de página / queda de ligação momentânea) ---
  socket.on('rejoin_room', ({ roomId, token }) => {
    const room = rooms.get(roomId);
    if(!room){ socket.emit('rejoin_failed'); return; }
    const player = room.players.find(p => p.token === token);
    if(!player){ socket.emit('rejoin_failed'); return; }

    if(room.disconnectTimer){ clearTimeout(room.disconnectTimer); room.disconnectTimer = null; }
    player.id = socket.id;
    player.connected = true;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.token = token;
    socket.data.rankKey = player.rankKey;
    socket.data.name = player.name;

    const opponent = room.players.find(p => p.token !== token);
    socket.emit('rejoin_ok', {
      room: { id: room.id, name: room.name, bestOf: room.bestOf },
      myTeam: player.team,
      players: room.players.map(p => ({ name: p.name, team: p.team })),
      scoreA: room.scoreA, scoreB: room.scoreB, turn: room.turn
    });
    if(opponent) io.to(opponent.id).emit('opponent_reconnected');
  });

  socket.on('shot', ({ roomId, discId, vx, vy }) => {
    const room = rooms.get(roomId);
    if(!room || room.status !== 'playing') return;
    const me = room.players.find(p => p.id === socket.id);
    if(!me || me.team !== room.turn) return;

    socket.to(roomId).emit('opponent_shot', { discId, vx, vy });
    room.turn = room.turn === 'A' ? 'B' : 'A';
    io.to(roomId).emit('turn_update', { turn: room.turn });
  });

  socket.on('state_sync', (payload) => {
    const room = rooms.get(payload.roomId);
    if(!room || room.status !== 'playing') return;
    const me = room.players.find(p => p.id === socket.id);
    if(!me || me.team !== 'A') return;
    socket.to(payload.roomId).emit('state_sync', payload);
  });

  // --- faltas ---
  // quem decide se é falta normal ou pénalti (consoante o local do choque, dentro
  // ou fora da grande área) é sempre a equipa A, autoridade da física — o servidor
  // só regista de quem passa a ser a vez e retransmite a decisão para o adversário.
  socket.on('foul', ({ roomId, fouledTeam, spot, isPenalty }) => {
    const room = rooms.get(roomId);
    if(!room || room.status !== 'playing') return;
    const me = room.players.find(p => p.id === socket.id);
    if(!me || me.team !== 'A') return;
    if(fouledTeam !== 'A' && fouledTeam !== 'B') return;

    room.turn = fouledTeam;
    socket.to(roomId).emit('foul_called', { fouledTeam, spot, isPenalty });
  });

  // o golo só é validado a partir da equipa A (autoridade da física); o número de
  // golos necessários para terminar o jogo é sempre o "bestOf" definido por quem
  // criou a sala (ex.: bestOf=5 -> o primeiro a chegar a 5 golos ganha)
  socket.on('goal', ({ roomId, team }) => {
    const room = rooms.get(roomId);
    if(!room || room.status === 'finished') return;
    const me = room.players.find(p => p.id === socket.id);
    if(!me || me.team !== 'A') return;

    if(team === 'A') room.scoreA++; else room.scoreB++;
    // quem SOFRE o golo é quem repõe a bola no meio-campo, não quem marcou
    room.turn = team === 'A' ? 'B' : 'A';

    const target = Math.ceil(room.bestOf);
    const finished = room.scoreA >= target || room.scoreB >= target;

    io.to(roomId).emit('score_update', {
      scoreA: room.scoreA, scoreB: room.scoreB, turn: room.turn, finished, scoringTeam: team
    });

    if(finished){
      room.status = 'finished';
      const playerA = room.players.find(p=>p.team==='A');
      const playerB = room.players.find(p=>p.team==='B');
      const winner = room.scoreA === room.scoreB ? 'draw' : (room.scoreA > room.scoreB ? 'A' : 'B');
      recordResult(playerA.rankKey, playerB.rankKey, room.scoreA, room.scoreB, winner);
      io.to(roomId).emit('match_over', { winner, scoreA: room.scoreA, scoreB: room.scoreB });
      io.emit('rankings', rankingList());
      rooms.delete(roomId);
      broadcastRooms();
    }
  });

  socket.on('leave_room', () => leaveCurrentRoomNow(socket));

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if(!roomId) return;
    const room = rooms.get(roomId);
    if(!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if(!player) return;

    player.connected = false;
    const opponent = room.players.find(p => p.id !== socket.id);
    if(opponent) io.to(opponent.id).emit('opponent_disconnected');

    room.disconnectTimer = setTimeout(() => {
      const opp = room.players.find(p => p.token !== player.token);
      if(opp) io.to(opp.id).emit('opponent_left');
      rooms.delete(roomId);
      broadcastRooms();
    }, RECONNECT_GRACE_MS);
  });

  function leaveCurrentRoomNow(socket){
    const roomId = socket.data.roomId;
    if(!roomId) return;
    const room = rooms.get(roomId);
    socket.data.roomId = null;
    if(!room) return;
    if(room.disconnectTimer) clearTimeout(room.disconnectTimer);
    socket.to(roomId).emit('opponent_left');
    rooms.delete(roomId);
    broadcastRooms();
  }
});

server.listen(PORT, () => {
  console.log(`Futsal Game a correr na porta ${PORT}`);
});
