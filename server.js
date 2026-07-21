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

function recordResult(nameA, nameB, winner){
  for (const n of [nameA, nameB]){
    if(!rankings[n]) rankings[n] = { wins: 0, losses: 0, draws: 0 };
  }
  if(winner === 'draw'){
    rankings[nameA].draws++; rankings[nameB].draws++;
  } else {
    const winnerName = winner === 'A' ? nameA : nameB;
    const loserName = winner === 'A' ? nameB : nameA;
    rankings[winnerName].wins++;
    rankings[loserName].losses++;
  }
  saveRankings(rankings);
}

function rankingList(){
  return Object.entries(rankings)
    .map(([name, r]) => ({
      name, wins: r.wins, losses: r.losses, draws: r.draws,
      points: r.wins*3 + r.draws, played: r.wins + r.losses + r.draws
    }))
    .sort((a,b) => b.points - a.points || b.wins - a.wins);
}

// --- chat público (histórico simples em memória) ---
const CHAT_HISTORY_LIMIT = 50;
let chatHistory = [];

// --- salas em memória ---
const rooms = new Map();
// room: { id, name, bestOf, players:[{id,token,name,team,connected}], scoreA, scoreB, turn, status, disconnectTimer }

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
  socket.data.roomId = null;
  socket.data.token = null;

  socket.on('set_name', ({ name, token } = {}) => {
    const clean = String(name || '').trim().slice(0, 20);
    socket.data.name = clean || 'Jogador';
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
      players: [{ id: socket.id, token: socket.data.token, name: socket.data.name, team: 'A', connected: true }],
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
    room.players.push({ id: socket.id, token: socket.data.token, name: socket.data.name, team: 'B', connected: true });
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

  socket.on('goal', ({ roomId, team }) => {
    const room = rooms.get(roomId);
    if(!room || room.status !== 'playing') return;
    const me = room.players.find(p => p.id === socket.id);
    if(!me || me.team !== 'A') return;

    if(team === 'A') room.scoreA++; else room.scoreB++;
    room.turn = 'A';

    const target = Math.ceil(room.bestOf);
    const finished = room.scoreA >= target || room.scoreB >= target;

    io.to(roomId).emit('score_update', { scoreA: room.scoreA, scoreB: room.scoreB, turn: room.turn, finished });

    if(finished){
      room.status = 'finished';
      const nameA = room.players.find(p=>p.team==='A').name;
      const nameB = room.players.find(p=>p.team==='B').name;
      const winner = room.scoreA === room.scoreB ? 'draw' : (room.scoreA > room.scoreB ? 'A' : 'B');
      recordResult(nameA, nameB, winner);
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
