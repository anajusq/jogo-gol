const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const RACE_TAPS = 60;          // toques para cruzar a linha de chegada
const RACE_TIMEOUT = 45000;    // ms
const TAKEOFF_TIME = 20000;    // ms
const TAPS_PER_PLAYER = 55;    // meta do combustível = jogadores x isso
const LEAK_PER_PLAYER = 1.5;   // combustível que vaza por segundo, por jogador
const MAX_TAPS_PER_SEC = 14;
const COLORS = ['#FF6F0F','#2B2B2B','#FF9F1C','#8D8D8D','#E8590C','#FFB703','#5C5C5C','#D9480F','#F4A261','#A8A8A8','#BF4E00','#FFC971'];

const state = {
  phase: 'lobby',            // lobby | countdown | race | race_end | takeoff | takeoff_end
  next: null,
  round: 0,
  countdown: 0,
  raceStart: 0,
  ranking: [],               // ids na ordem de chegada
  takeoff: { fuel: 0, goal: 0, leak: 0, endsAt: 0, success: null },
};
const players = new Map();   // id -> player
const sockets = new Map();   // ws -> { id, host }
let colorIdx = 0;

const clean = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);

function connectedPlayers() { return [...players.values()].filter(p => p.connected); }

function publicState() {
  const list = [...players.values()].map(p => ({
    id: p.id, name: p.name, color: p.color, progress: p.progress,
    connected: p.connected, finished: p.finishedAt > 0, fuelTaps: p.fuelTaps,
  }));
  return {
    phase: state.phase,
    countdown: state.countdown,
    next: state.next,
    players: list,
    ranking: state.ranking,
    raceTaps: RACE_TAPS,
    takeoff: {
      fuel: state.takeoff.fuel, goal: state.takeoff.goal,
      timeLeft: state.phase === 'takeoff' ? Math.max(0, state.takeoff.endsAt - Date.now()) : 0,
      total: TAKEOFF_TIME, success: state.takeoff.success,
    },
  };
}

function broadcast() {
  const s = JSON.stringify({ t: 'state', s: publicState() });
  for (const ws of sockets.keys()) if (ws.readyState === 1) ws.send(s);
}

function resetRound() {
  state.round++;
  state.phase = 'lobby'; state.next = null; state.ranking = [];
  state.takeoff = { fuel: 0, goal: 0, leak: 0, endsAt: 0, success: null };
  for (const p of players.values()) { p.progress = 0; p.finishedAt = 0; p.taps = 0; p.fuelTaps = 0; }
}

function startCountdown(next) {
  if (state.phase === 'countdown' || state.phase === 'race' || state.phase === 'takeoff') return;
  if (connectedPlayers().length === 0) return;
  if (next === 'race') {
    state.ranking = [];
    for (const p of players.values()) { p.progress = 0; p.finishedAt = 0; p.taps = 0; }
  } else {
    const n = connectedPlayers().length;
    state.takeoff = { fuel: 0, goal: Math.max(60, n * TAPS_PER_PLAYER), leak: n * LEAK_PER_PLAYER, endsAt: 0, success: null };
    for (const p of players.values()) p.fuelTaps = 0;
  }
  const round = ++state.round;
  state.phase = 'countdown'; state.next = next; state.countdown = 3;
  const iv = setInterval(() => {
    state.countdown--;
    if (state.countdown <= 0) {
      clearInterval(iv);
      state.countdown = 0;
      if (next === 'race') {
        state.phase = 'race'; state.raceStart = Date.now();
        setTimeout(() => { if (state.phase === 'race' && state.round === round) endRace(); }, RACE_TIMEOUT);
      } else {
        state.phase = 'takeoff'; state.takeoff.endsAt = Date.now() + TAKEOFF_TIME;
        setTimeout(() => { if (state.phase === 'takeoff' && state.round === round) endTakeoff(false); }, TAKEOFF_TIME + 50);
      }
    }
    broadcast();
  }, 1000);
  broadcast();
}

function endRace() { state.phase = 'race_end'; broadcast(); }
function endTakeoff(ok) { state.phase = 'takeoff_end'; state.takeoff.success = ok; broadcast(); }

function onTap(p) {
  const now = Date.now();
  p.bucket = Math.min(MAX_TAPS_PER_SEC, p.bucket + (now - p.bucketAt) / 1000 * MAX_TAPS_PER_SEC);
  p.bucketAt = now;
  if (p.bucket < 1) return;
  p.bucket -= 1;

  if (state.phase === 'race' && !p.finishedAt) {
    p.taps++;
    p.progress = Math.min(100, (p.taps / RACE_TAPS) * 100);
    if (p.progress >= 100) {
      p.finishedAt = now; state.ranking.push(p.id);
      const active = connectedPlayers();
      if (active.every(q => q.finishedAt) ) endRace();
    }
  } else if (state.phase === 'takeoff') {
    p.fuelTaps++; state.takeoff.fuel++;
    if (state.takeoff.fuel >= state.takeoff.goal) endTakeoff(true);
  }
}

function handle(ws, msg) {
  const meta = sockets.get(ws);
  if (msg.t === 'host') { meta.host = true; ws.send(JSON.stringify({ t: 'state', s: publicState() })); return; }

  if (meta.host) {
    if (msg.t === 'start_race') startCountdown('race');
    if (msg.t === 'start_takeoff') startCountdown('takeoff');
    if (msg.t === 'reset') { resetRound(); broadcast(); }
    if (msg.t === 'clear') { players.clear(); sockets.forEach(m => { if (!m.host) m.id = null; }); resetRound(); broadcast(); }
    return;
  }

  if (msg.t === 'join') {
    const id = String(msg.id || '').slice(0, 40);
    if (!id) return;
    let p = players.get(id);
    if (!p) {
      p = { id, name: clean(msg.name) || 'Passageiro', color: COLORS[colorIdx++ % COLORS.length],
            progress: 0, finishedAt: 0, taps: 0, fuelTaps: 0, bucket: MAX_TAPS_PER_SEC, bucketAt: Date.now(), connected: true };
      players.set(id, p);
    } else { p.connected = true; if (msg.name) p.name = clean(msg.name) || p.name; }
    meta.id = id;
    ws.send(JSON.stringify({ t: 'you', id, color: p.color, name: p.name }));
    broadcast();
    return;
  }

  if (msg.t === 'tap' && meta.id) {
    const p = players.get(meta.id);
    if (p) onTap(p);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/qr.svg') {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const link = `${proto}://${req.headers.host}/`;
    const svg = await QRCode.toString(link, { type: 'svg', margin: 1, color: { dark: '#2B2B2B', light: '#FFFFFF' } });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(svg);
  }
  const map = { '/': 'jogar.html', '/telao': 'telao.html' };
  const file = map[url.pathname];
  if (!file) { res.writeHead(404); return res.end('Não encontrado'); }
  fs.readFile(path.join(__dirname, 'public', file), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Erro'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  sockets.set(ws, { id: null, host: false });
  ws.on('message', raw => { try { handle(ws, JSON.parse(raw)); } catch (e) {} });
  ws.on('close', () => {
    const m = sockets.get(ws); sockets.delete(ws);
    if (m && m.id && players.has(m.id)) {
      const stillThere = [...sockets.values()].some(x => x.id === m.id);
      if (!stillThere) players.get(m.id).connected = false;
    }
    broadcast();
  });
});

setInterval(() => {
  if (state.phase === 'takeoff') {
    state.takeoff.fuel = Math.max(0, state.takeoff.fuel - state.takeoff.leak * 0.1);
  }
  if (state.phase === 'race' || state.phase === 'takeoff') broadcast();
}, 100);
server.listen(PORT, () => console.log(`Jogo no ar na porta ${PORT} — telão em /telao`));
