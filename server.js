const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const RANKINGS_FILE = path.join(__dirname, 'data', 'rankings.json');

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

// --- ranking persistido em ficheiro JSON (fácil de trocar por PostgreSQL depois) ---
function loadRankings(){
  try{
    return JSON.parse(fs.readFileSync(RANKINGS_FILE, 'utf8'));
  }catch(e){
    return {};
  }
}
function saveRankings(data){
  fs.mkdirSync(path.dirname(RANKINGS_FILE), { recursive: true });
  fs.writeFileSync(RANKINGS_FILE, JSON.stringify(data, null, 2));
}
let rankings = loadRankings();

function recordResult(nameA, nameB, winner){
  // winner: 'A' | 'B' | 'draw'
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
      name,
      wins: r.wins, losses: r.losses, draws: r.draws,
      points: r.wins*3 + r.draws,
      played: r.wins + r.losses + r.draws
    }))
    .sort((a,b) => b.points - a.points || b.wins - a.wins);
}

// --- salas em memória ---
const rooms = new Map();
// room: { id, name, bestOf, players:[{id,name,team}], scoreA, scoreB, turn, status, gamesA, gamesB }

function publicRoomList(){
  return [...rooms.values()]
    .filter(r => r.status !== 'finished')
    .map(r => ({
      id: r.id, name: r.name, bestOf: r.bestOf,
      players: r.players.map(p => p.name),
      status: r.status
    }));
}

function broadcastRooms(){
  io.emit('rooms', publicRoomList());
}

io.on('connection', (socket) => {
  socket.data.name = null;
  socket.data.roomId = null;

  socket.on('set_name', (name) => {
    const clean = String(name || '').trim().slice(0, 20);
    socket.data.name = clean || 'Jogador';
    socket.emit('name_ok', socket.data.name);
    socket.emit('rooms', publicRoomList());
    socket.emit('rankings', rankingList());
  });

  socket.on('list_rooms', () => socket.emit('rooms', publicRoomList()));
  socket.on('get_rankings', () => socket.emit('rankings', rankingList()));

  socket.on('create_room', ({ roomName, bestOf }) => {
    if(!socket.data.name) return;
    const id = Math.random().toString(36).slice(2, 8);
    const room = {
      id,
      name: String(roomName || 'Sala').trim().slice(0, 30) || 'Sala',
      bestOf: Math.min(Math.max(parseInt(bestOf) || 1, 1), 21),
      players: [{ id: socket.id, name: socket.data.name, team: 'A' }],
      scoreA: 0, scoreB: 0, turn: 'A', status: 'waiting'
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
    room.players.push({ id: socket.id, name: socket.data.name, team: 'B' });
    socket.join(roomId);
    socket.data.roomId = roomId;
    room.status = 'playing';

    socket.emit('room_joined', {
      room: { id: room.id, name: room.name, bestOf: room.bestOf },
      myTeam: 'B'
    });

    io.to(roomId).emit('match_start', {
      room: { id: room.id, name: room.name, bestOf: room.bestOf },
      players: room.players.map(p => ({ name: p.name, team: p.team }))
    });
    broadcastRooms();
  });

  socket.on('shot', ({ roomId, discId, vx, vy }) => {
    const room = rooms.get(roomId);
    if(!room || room.status !== 'playing') return;
    const me = room.players.find(p => p.id === socket.id);
    if(!me || me.team !== room.turn) return; // não é a tua vez

    socket.to(roomId).emit('opponent_shot', { discId, vx, vy });
    room.turn = room.turn === 'A' ? 'B' : 'A';
    io.to(roomId).emit('turn_update', { turn: room.turn });
  });

  // só o jogador da equipa A reporta o golo (evita contagem duplicada — ambos correm a mesma física)
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

  socket.on('leave_room', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => leaveCurrentRoom(socket));

  function leaveCurrentRoom(socket){
    const roomId = socket.data.roomId;
    if(!roomId) return;
    const room = rooms.get(roomId);
    socket.data.roomId = null;
    if(!room) return;
    socket.to(roomId).emit('opponent_left');
    rooms.delete(roomId);
    broadcastRooms();
  }
});

server.listen(PORT, () => {
  console.log(`Superboteo a correr na porta ${PORT}`);
});
