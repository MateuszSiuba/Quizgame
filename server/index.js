'use strict';

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Questions with runtime vote tracking ─────────────────────────────────────
const QUESTIONS_FILE = path.join(__dirname, '..', 'data', 'questions.json');

function loadQuestions() {
  const raw = fs.readFileSync(QUESTIONS_FILE, 'utf8');
  return JSON.parse(raw).map(q => ({
    ...q,
    votes:    q.votes    ?? { up: 0, down: 0 },
    disabled: q.disabled ?? false,
  }));
}

function saveQuestions(arr) {
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(arr, null, 2));
}

let questions = loadQuestions();

// ── Constants ─────────────────────────────────────────────────────────────────
const ROUND_DURATION   = 25;
const REVEAL_DURATION  = 5;
const POINTS_FIRST     = 10;
const POINTS_MIN       = 2;
const COOLDOWN_GUESS   = 350;    // ms anti-spam for guesses
const COOLDOWN_CHAT    = 400;    // ms anti-spam for chat
const RECONNECT_WINDOW = 30000;  // 30 s to reconnect before slot expires
const MAX_PLAYERS      = 10;     // max concurrent players

// ── Categories ────────────────────────────────────────────────────────────────
const CATEGORIES = ['Wszystkie', ...new Set(questions.map(q => q.category))];

// ── Game State ────────────────────────────────────────────────────────────────
const gameState = {
  phase: 'lobby',      // lobby | countdown | playing | paused | reveal
  players: new Map(),  // playerId -> playerObj
  disconnected: new Map(), // token -> { player, timer }
  hostId: null,
  currentQuestion: null,
  questionQueue: [],
  roundTimer: null,
  revealTimer: null,
  timeLeft: 25,
  selectedCategories: new Set(),
  roundNumber: 0,
};

// ── Timer helpers ─────────────────────────────────────────────────────────────
function stopRoundTimer() {
  if (gameState.roundTimer) { clearInterval(gameState.roundTimer); gameState.roundTimer = null; }
}
function startRoundTimer() {
  stopRoundTimer();
  gameState.roundTimer = setInterval(() => {
    gameState.timeLeft -= 1;
    broadcast({ type: 'timer_tick', timeLeft: gameState.timeLeft });
    if (gameState.timeLeft <= 0) { stopRoundTimer(); endRound(); }
  }, 1000);
}

// ── Normalization ─────────────────────────────────────────────────────────────
function normalize(str) {
  if (!str) return '';
  const d = {
    'ą':'a','ć':'c','ę':'e','ł':'l','ń':'n','ó':'o','ś':'s','ź':'z','ż':'z',
    'Ą':'a','Ć':'c','Ę':'e','Ł':'l','Ń':'n','Ó':'o','Ś':'s','Ź':'z','Ż':'z',
  };
  return str.toLowerCase()
    .replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, ch => d[ch] || ch)
    .replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}
function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function broadcastExcept(excludeId, payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.playerId !== excludeId) ws.send(msg);
  });
}
function getPlayerWs(playerId) {
  for (const ws of wss.clients)
    if (ws.readyState === WebSocket.OPEN && ws.playerId === playerId) return ws;
  return null;
}

// ── Leaderboard & Lobby ───────────────────────────────────────────────────────
function getLeaderboard() {
  return [...gameState.players.values()]
    .sort((a, b) => b.score - a.score)
    .map(p => ({ id: p.id, name: p.name, score: p.score }));
}
function broadcastLeaderboard() {
  broadcast({ type: 'leaderboard', players: getLeaderboard() });
}
function getSelectedCategoryLabel() {
  const sel = gameState.selectedCategories;
  if (sel.size === 0 || sel.size >= CATEGORIES.length - 1) return 'Wszystkie';
  return [...sel].join(', ');
}
function broadcastLobbyState() {
  broadcast({
    type: 'lobby_state',
    players: getLeaderboard(),
    hostId: gameState.hostId,
    categories: CATEGORIES,
    selectedCategory: getSelectedCategoryLabel(),
  });
}

// ── Question Queue ────────────────────────────────────────────────────────────
function buildQueue() {
  const sel = gameState.selectedCategories;
  let pool = (sel.size === 0 || sel.size >= CATEGORIES.length - 1)
    ? [...questions]
    : questions.filter(q => sel.has(q.category));
  pool = pool.filter(q => !q.disabled);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

// ── Round Management ──────────────────────────────────────────────────────────
function startNextRound() {
  if (gameState.questionQueue.length === 0) { endGame(); return; }
  gameState.players.forEach(p => { p.hasGuessed = false; p.wrongGuesses = []; });
  gameState.currentQuestion = gameState.questionQueue.shift();
  gameState.roundNumber += 1;
  gameState.timeLeft = ROUND_DURATION;
  gameState.phase = 'playing';
  const q = gameState.currentQuestion;
  broadcast({
    type: 'round_start',
    roundNumber: gameState.roundNumber,
    questionType: q.type,
    imageUrl: q.type === 'image' ? q.image_url : null,
    questionText: q.question_text,
    timeLeft: ROUND_DURATION,
    category: q.category,
    questionId: q.id,
  });
  broadcastLeaderboard();
  startRoundTimer();
}

function checkAllGuessed() {
  const active = [...gameState.players.values()];
  return active.length > 0 && active.every(p => p.hasGuessed);
}

function endRound() {
  stopRoundTimer();
  gameState.phase = 'reveal';
  const q = gameState.currentQuestion;
  broadcast({
    type: 'round_end',
    answer: q.answers[0],
    questionId: q.id,
    votes: q.votes,
    leaderboard: getLeaderboard(),
    nextRoundIn: REVEAL_DURATION,
  });
  gameState.revealTimer = setTimeout(() => {
    gameState.questionQueue.length > 0 ? startNextRound() : endGame();
  }, REVEAL_DURATION * 1000);
}

function togglePause(player) {
  if (gameState.phase === 'playing') {
    gameState.phase = 'paused';
    stopRoundTimer();
    broadcast({ type: 'game_paused', by: player.name, timeLeft: gameState.timeLeft });
  } else if (gameState.phase === 'paused') {
    gameState.phase = 'playing';
    startRoundTimer();
    broadcast({ type: 'game_resumed', by: player.name, timeLeft: gameState.timeLeft });
  }
}

function endGame() {
  gameState.phase = 'lobby';
  gameState.currentQuestion = null;
  gameState.questionQueue = [];
  gameState.roundNumber = 0;
  broadcast({ type: 'game_over', leaderboard: getLeaderboard() });
  setTimeout(() => {
    gameState.players.forEach(p => { p.score = 0; });
    broadcastLobbyState();
  }, 8000);
}

// ── Reconnect helpers ─────────────────────────────────────────────────────────
function scheduleDisconnectExpiry(token) {
  const slot = gameState.disconnected.get(token);
  if (!slot) return;
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = setTimeout(() => {
    gameState.disconnected.delete(token);
    console.log(`[~] Slot dla gracza wygasł po ${RECONNECT_WINDOW/1000}s`);
  }, RECONNECT_WINDOW);
}

function buildReconnectPayload(playerId) {
  const player = gameState.players.get(playerId);
  const payload = {
    type: 'reconnected',
    playerId,
    isHost: player.id === gameState.hostId,
    gamePhase: gameState.phase,
    score: player.score,
    hasGuessed: player.hasGuessed,
    categories: CATEGORIES,
    selectedCategory: getSelectedCategoryLabel(),
    leaderboard: getLeaderboard(),
  };
  if ((gameState.phase === 'playing' || gameState.phase === 'paused') && gameState.currentQuestion) {
    const q = gameState.currentQuestion;
    payload.currentRound = {
      roundNumber: gameState.roundNumber,
      questionType: q.type,
      imageUrl: q.type === 'image' ? q.image_url : null,
      questionText: q.question_text,
      timeLeft: gameState.timeLeft,
      category: q.category,
      questionId: q.id,
    };
  }
  if (gameState.phase === 'reveal' && gameState.currentQuestion) {
    payload.revealAnswer    = gameState.currentQuestion.answers[0];
    payload.revealQuestionId = gameState.currentQuestion.id;
    payload.revealVotes     = gameState.currentQuestion.votes;
  }
  return payload;
}

function promoteNewHost() {
  if (gameState.players.size === 0) return;
  const newHost = gameState.players.values().next().value;
  newHost.isHost = true;
  gameState.hostId = newHost.id;
  const ws = getPlayerWs(newHost.id);
  if (ws) send(ws, { type: 'promoted_to_host' });
  broadcast({ type: 'chat', system: true, message: `${newHost.name} jest teraz hostem.` });
}

// ── Connection Handler ────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.playerId = null;

  ws.on('message', (rawData) => {
    let msg;
    try { msg = JSON.parse(rawData); } catch { return; }
    const { type } = msg;

    // ── JOIN ──────────────────────────────────────────────────────────────────
    if (type === 'join') {
      const name = (msg.name || '').trim().slice(0, 20);
      if (!name) return send(ws, { type: 'error', message: 'Podaj nazwę gracza.' });

      // ── Try reconnect via token ─────────────────────────────────────────────
      if (msg.token) {
        const slot = gameState.disconnected.get(msg.token);
        if (slot && normalize(slot.player.name) === normalize(name)) {
          const player = slot.player;
          clearTimeout(slot.timer);
          gameState.disconnected.delete(msg.token);
          gameState.players.set(player.id, player);
          ws.playerId = player.id;
          send(ws, buildReconnectPayload(player.id));
          broadcastExcept(player.id, { type: 'chat', system: true, message: `${player.name} wrócił(a)!` });
          broadcastLeaderboard();
          console.log(`[↩] ${player.name} reconnected`);
          return;
        }
        // Bad token — proceed as fresh join (ignore token)
      }

      // ── Fresh join ─────────────────────────────────────────────────────────
      for (const p of gameState.players.values()) {
        if (normalize(p.name) === normalize(name))
          return send(ws, { type: 'error', message: 'Ta nazwa jest już zajęta.' });
      }

      if (gameState.players.size >= MAX_PLAYERS)
        return send(ws, { type: 'error', message: `Serwer pełny – maksymalnie ${MAX_PLAYERS} graczy.` });

      const id    = uuidv4();
      const token = uuidv4();
      ws.playerId = id;

      const isHost = gameState.players.size === 0;
      if (isHost) gameState.hostId = id;

      const player = {
        id, name, token, score: 0,
        hasGuessed: false, wrongGuesses: [], isHost,
        lastGuessAt: 0, lastChatAt: 0,
      };
      gameState.players.set(id, player);

      send(ws, {
        type: 'joined', playerId: id, token, isHost,
        categories: CATEGORIES,
        selectedCategory: getSelectedCategoryLabel(),
        gamePhase: gameState.phase,
      });

      if ((gameState.phase === 'playing' || gameState.phase === 'paused') && gameState.currentQuestion) {
        const q = gameState.currentQuestion;
        send(ws, {
          type: 'round_start',
          roundNumber: gameState.roundNumber,
          questionType: q.type,
          imageUrl: q.type === 'image' ? q.image_url : null,
          questionText: q.question_text,
          timeLeft: gameState.timeLeft,
          category: q.category,
          questionId: q.id,
          lateJoin: true,
        });
        if (gameState.phase === 'paused')
          send(ws, { type: 'game_paused', by: 'host', timeLeft: gameState.timeLeft });
      }

      broadcastLobbyState();
      broadcast({ type: 'chat', system: true, message: `${name} dołączył(a) do gry!` });
      console.log(`[+] ${name} dołączył (id=${id}, host=${isHost})`);
      return;
    }

    // Require auth
    const playerId = ws.playerId;
    if (!playerId || !gameState.players.has(playerId)) return;
    const player = gameState.players.get(playerId);

    // ── SELECT CATEGORY ───────────────────────────────────────────────────────
    if (type === 'select_category') {
      if (playerId !== gameState.hostId || gameState.phase !== 'lobby') return;
      const cats  = Array.isArray(msg.categories) ? msg.categories : [msg.category];
      const valid = cats.filter(c => CATEGORIES.includes(c));
      if (valid.length === 0) return;
      gameState.selectedCategories = new Set(valid);
      broadcast({ type: 'category_changed', category: getSelectedCategoryLabel() });
      return;
    }

    // ── START GAME ────────────────────────────────────────────────────────────
    if (type === 'start_game') {
      if (playerId !== gameState.hostId || gameState.phase !== 'lobby') return;
      questions = loadQuestions();
      gameState.questionQueue = buildQueue();
      if (gameState.questionQueue.length === 0)
        return send(ws, { type: 'error', message: 'Brak aktywnych pytań w tej kategorii.' });
      gameState.players.forEach(p => { p.score = 0; });
      broadcast({ type: 'game_starting', countdown: 3 });
      let cd = 3;
      const cdTimer = setInterval(() => {
        cd--;
        broadcast({ type: 'game_countdown', countdown: cd });
        if (cd <= 0) { clearInterval(cdTimer); startNextRound(); }
      }, 1000);
      return;
    }

    // ── PAUSE / RESUME ────────────────────────────────────────────────────────
    if (type === 'toggle_pause') {
      if (playerId !== gameState.hostId) return;
      if (gameState.phase !== 'playing' && gameState.phase !== 'paused') return;
      togglePause(player);
      return;
    }

    // ── VOTE ON QUESTION ──────────────────────────────────────────────────────
    if (type === 'vote_question') {
      if (gameState.phase !== 'reveal') return;
      const { questionId, vote } = msg;
      if (!['up', 'down'].includes(vote)) return;
      const q = questions.find(x => x.id === questionId);
      if (!q) return;
      q.votes[vote] = (q.votes[vote] || 0) + 1;
      saveQuestions(questions);
      broadcast({ type: 'question_votes', questionId: q.id, votes: q.votes });
      return;
    }

    // ── GUESS ─────────────────────────────────────────────────────────────────
    if (type === 'guess') {
      if (gameState.phase !== 'playing' || player.hasGuessed) return;
      const now = Date.now();
      if (now - (player.lastGuessAt || 0) < COOLDOWN_GUESS) return;
      player.lastGuessAt = now;
      const raw = (msg.guess || '').trim();
      if (!raw) return;

      const normGuess     = normalize(raw);
      const correctAnswers = gameState.currentQuestion.answers.map(normalize);

      if (correctAnswers.includes(normGuess)) {
        player.hasGuessed = true;
        const elapsed     = ROUND_DURATION - gameState.timeLeft;
        const soFar       = [...gameState.players.values()].filter(p => p.hasGuessed).length;
        const points = soFar === 1
          ? POINTS_FIRST
          : Math.max(POINTS_MIN, Math.round(POINTS_MIN + (POINTS_FIRST - POINTS_MIN) * Math.max(0, 1 - elapsed / ROUND_DURATION)));
        player.score += points;
        send(ws, { type: 'correct_guess', points, totalScore: player.score });
        broadcastExcept(playerId, { type: 'player_guessed', playerName: player.name, points });
        broadcastLeaderboard();
        if (checkAllGuessed()) { stopRoundTimer(); setTimeout(() => endRound(), 1000); }
      } else {
        player.wrongGuesses.push(raw);
        broadcast({ type: 'wrong_guess', playerName: player.name, playerId: player.id, guess: raw });
      }
      return;
    }

    // ── PING (heartbeat, no response needed) ────────────────────────────────
    if (type === 'ping') return;

    // ── CHAT ─────────────────────────────────────────────────────────────────
    if (type === 'chat') {
      if (gameState.phase === 'playing') return;
      const now = Date.now();
      if (now - (player.lastChatAt || 0) < COOLDOWN_CHAT) return;
      player.lastChatAt = now;
      const text = (msg.text || '').trim().slice(0, 200);
      if (!text) return;
      broadcast({ type: 'chat', playerName: player.name, message: text });
      return;
    }
  });

  ws.on('close', () => {
    const id = ws.playerId;
    if (!id || !gameState.players.has(id)) return;

    const player  = gameState.players.get(id);
    const wasHost = player.id === gameState.hostId;
    const name    = player.name;

    // During an active game: keep slot alive for reconnect
    if (gameState.phase !== 'lobby') {
      gameState.players.delete(id);
      gameState.disconnected.set(player.token, { player });
      scheduleDisconnectExpiry(player.token);
      broadcast({ type: 'player_disconnected', playerName: name, playerId: id });
      console.log(`[~] ${name} rozłączył się (slot otwarty na ${RECONNECT_WINDOW/1000}s)`);
    } else {
      gameState.players.delete(id);
      broadcast({ type: 'chat', system: true, message: `${name} opuścił(a) grę.` });
      console.log(`[-] ${name} rozłączył się`);
    }

    if (wasHost && gameState.players.size > 0) promoteNewHost();

    if (gameState.players.size === 0 && gameState.disconnected.size === 0) {
      stopRoundTimer();
      if (gameState.revealTimer) { clearTimeout(gameState.revealTimer); gameState.revealTimer = null; }
      gameState.phase = 'lobby';
      gameState.currentQuestion = null;
      gameState.questionQueue   = [];
      gameState.roundNumber     = 0;
      gameState.hostId          = null;
    } else if (gameState.players.size > 0) {
      broadcastLobbyState();
      if (gameState.phase === 'playing' && checkAllGuessed()) {
        stopRoundTimer(); setTimeout(() => endRound(), 500);
      }
    }
  });

  ws.on('error', err => console.error('WS error:', err.message));
});

server.listen(PORT, () => {
  console.log(`✅ QuizGame uruchomiony na porcie ${PORT}`);
  console.log(`📚 ${questions.filter(q => !q.disabled).length}/${questions.length} pytań aktywnych`);
});
