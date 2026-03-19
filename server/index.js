'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const questions = require('../data/questions.json');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Game State ────────────────────────────────────────────────────────────────
const gameState = {
  phase: 'lobby',        // lobby | countdown | playing | reveal
  players: new Map(),    // id -> playerObj
  hostId: null,
  currentQuestion: null,
  currentQuestionIndex: -1,
  questionQueue: [],
  roundTimer: null,
  revealTimer: null,
  timeLeft: 25,
  selectedCategory: 'Wszystkie',
  roundNumber: 0,
};

const ROUND_DURATION = 25;  // seconds
const REVEAL_DURATION = 5;  // seconds
const POINTS_FIRST = 10;
const POINTS_MIN = 2;

// ── Categories derived from questions ────────────────────────────────────────
const CATEGORIES = ['Wszystkie', ...new Set(questions.map(q => q.category))];

// ── Normalization ─────────────────────────────────────────────────────────────
function normalize(str) {
  if (!str) return '';
  const diacritics = {
    'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n',
    'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
    'Ą': 'a', 'Ć': 'c', 'Ę': 'e', 'Ł': 'l', 'Ń': 'n',
    'Ó': 'o', 'Ś': 's', 'Ź': 'z', 'Ż': 'z',
  };
  return str
    .toLowerCase()
    .replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, ch => diacritics[ch] || ch)
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastExcept(excludeId, payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.playerId !== excludeId) ws.send(msg);
  });
}

function getPlayerWs(playerId) {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN && ws.playerId === playerId) return ws;
  }
  return null;
}

// ── Leaderboard helpers ───────────────────────────────────────────────────────
function getLeaderboard() {
  return [...gameState.players.values()]
    .sort((a, b) => b.score - a.score)
    .map(p => ({ id: p.id, name: p.name, score: p.score }));
}

function broadcastLeaderboard() {
  broadcast({ type: 'leaderboard', players: getLeaderboard() });
}

function broadcastLobbyState() {
  broadcast({
    type: 'lobby_state',
    players: getLeaderboard(),
    hostId: gameState.hostId,
    categories: CATEGORIES,
    selectedCategory: gameState.selectedCategory,
  });
}

// ── Question Queue ────────────────────────────────────────────────────────────
function buildQueue(category) {
  let pool = category === 'Wszystkie'
    ? [...questions]
    : questions.filter(q => q.category === category);

  // Shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

// ── Round Management ──────────────────────────────────────────────────────────
function startNextRound() {
  if (gameState.questionQueue.length === 0) {
    endGame();
    return;
  }

  // Reset per-round player state
  gameState.players.forEach(p => {
    p.hasGuessed = false;
    p.wrongGuesses = [];
  });

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
  });

  broadcastLeaderboard();

  // Tick
  gameState.roundTimer = setInterval(() => {
    gameState.timeLeft -= 1;
    broadcast({ type: 'timer_tick', timeLeft: gameState.timeLeft });

    if (gameState.timeLeft <= 0) {
      clearInterval(gameState.roundTimer);
      gameState.roundTimer = null;
      endRound();
    }
  }, 1000);
}

function checkAllGuessed() {
  const activePlayers = [...gameState.players.values()];
  return activePlayers.length > 0 && activePlayers.every(p => p.hasGuessed);
}

function endRound() {
  if (gameState.roundTimer) {
    clearInterval(gameState.roundTimer);
    gameState.roundTimer = null;
  }

  gameState.phase = 'reveal';

  const correctAnswers = gameState.currentQuestion.answers;
  const displayAnswer = correctAnswers[0];

  broadcast({
    type: 'round_end',
    answer: displayAnswer,
    leaderboard: getLeaderboard(),
    nextRoundIn: REVEAL_DURATION,
  });

  gameState.revealTimer = setTimeout(() => {
    if (gameState.questionQueue.length > 0) {
      startNextRound();
    } else {
      endGame();
    }
  }, REVEAL_DURATION * 1000);
}

function endGame() {
  gameState.phase = 'lobby';
  gameState.currentQuestion = null;
  gameState.questionQueue = [];
  gameState.roundNumber = 0;

  broadcast({
    type: 'game_over',
    leaderboard: getLeaderboard(),
  });

  // Reset scores for next game
  setTimeout(() => {
    gameState.players.forEach(p => { p.score = 0; });
    broadcastLobbyState();
  }, 8000);
}

// ── Connection Handler ────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.playerId = null;

  ws.on('message', (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch {
      return;
    }

    const { type } = msg;

    // ── JOIN ──────────────────────────────────────────────────────────────────
    if (type === 'join') {
      const name = (msg.name || '').trim().slice(0, 20);
      if (!name) return send(ws, { type: 'error', message: 'Podaj nazwę gracza.' });

      // Check duplicate name
      for (const p of gameState.players.values()) {
        if (normalize(p.name) === normalize(name)) {
          return send(ws, { type: 'error', message: 'Ta nazwa jest już zajęta.' });
        }
      }

      const id = uuidv4();
      ws.playerId = id;

      const isHost = gameState.players.size === 0;
      if (isHost) gameState.hostId = id;

      const player = {
        id,
        name,
        score: 0,
        hasGuessed: false,
        wrongGuesses: [],
        isHost,
      };

      gameState.players.set(id, player);

      send(ws, {
        type: 'joined',
        playerId: id,
        isHost,
        categories: CATEGORIES,
        selectedCategory: gameState.selectedCategory,
        gamePhase: gameState.phase,
      });

      // If game is running, catch them up
      if (gameState.phase === 'playing' && gameState.currentQuestion) {
        const q = gameState.currentQuestion;
        send(ws, {
          type: 'round_start',
          roundNumber: gameState.roundNumber,
          questionType: q.type,
          imageUrl: q.type === 'image' ? q.image_url : null,
          questionText: q.question_text,
          timeLeft: gameState.timeLeft,
          category: q.category,
          lateJoin: true,
        });
      }

      broadcastLobbyState();
      broadcast({ type: 'chat', system: true, message: `${name} dołączył(a) do gry!` });
      console.log(`[+] ${name} dołączył (id=${id}, host=${isHost})`);
      return;
    }

    // Require authentication for all other events
    const playerId = ws.playerId;
    if (!playerId || !gameState.players.has(playerId)) return;
    const player = gameState.players.get(playerId);

    // ── SELECT CATEGORY ───────────────────────────────────────────────────────
    if (type === 'select_category') {
      if (playerId !== gameState.hostId) return;
      if (gameState.phase !== 'lobby') return;
      const cat = msg.category;
      if (!CATEGORIES.includes(cat)) return;
      gameState.selectedCategory = cat;
      broadcast({ type: 'category_changed', category: cat });
      return;
    }

    // ── START GAME ────────────────────────────────────────────────────────────
    if (type === 'start_game') {
      if (playerId !== gameState.hostId) return;
      if (gameState.phase !== 'lobby') return;
      if (gameState.players.size < 1) return;

      gameState.questionQueue = buildQueue(gameState.selectedCategory);
      if (gameState.questionQueue.length === 0) {
        return send(ws, { type: 'error', message: 'Brak pytań w tej kategorii.' });
      }

      // Reset scores
      gameState.players.forEach(p => { p.score = 0; });

      broadcast({ type: 'game_starting', countdown: 3 });

      let cd = 3;
      const cdTimer = setInterval(() => {
        cd -= 1;
        broadcast({ type: 'game_countdown', countdown: cd });
        if (cd <= 0) {
          clearInterval(cdTimer);
          startNextRound();
        }
      }, 1000);
      return;
    }

    // ── GUESS ─────────────────────────────────────────────────────────────────
    if (type === 'guess') {
      if (gameState.phase !== 'playing') return;
      if (player.hasGuessed) return;

      const raw = (msg.guess || '').trim();
      if (!raw) return;

      const normGuess = normalize(raw);
      const correctAnswers = gameState.currentQuestion.answers.map(normalize);
      const isCorrect = correctAnswers.includes(normGuess);

      if (isCorrect) {
        player.hasGuessed = true;

        // Dynamic scoring: first = 10pts, degrades with time elapsed
        const elapsed = ROUND_DURATION - gameState.timeLeft;
        const correctSoFar = [...gameState.players.values()].filter(p => p.hasGuessed).length;

        let points;
        if (correctSoFar === 1) {
          points = POINTS_FIRST;
        } else {
          const timeFraction = Math.max(0, 1 - elapsed / ROUND_DURATION);
          points = Math.max(POINTS_MIN, Math.round(POINTS_MIN + (POINTS_FIRST - POINTS_MIN) * timeFraction));
        }

        player.score += points;

        send(ws, {
          type: 'correct_guess',
          message: 'Zgadłeś! 🎉',
          points,
          totalScore: player.score,
        });

        broadcastExcept(playerId, {
          type: 'player_guessed',
          playerName: player.name,
          points,
        });

        broadcastLeaderboard();

        if (checkAllGuessed()) {
          if (gameState.roundTimer) {
            clearInterval(gameState.roundTimer);
            gameState.roundTimer = null;
          }
          setTimeout(() => endRound(), 1000);
        }
      } else {
        // Wrong guess — broadcast to all
        player.wrongGuesses.push(raw);
        broadcast({
          type: 'wrong_guess',
          playerName: player.name,
          playerId: player.id,
          guess: raw,
        });
      }
      return;
    }

    // ── CHAT ──────────────────────────────────────────────────────────────────
    if (type === 'chat') {
      if (gameState.phase === 'playing') return; // no chat during game
      const text = (msg.text || '').trim().slice(0, 200);
      if (!text) return;
      broadcast({ type: 'chat', playerName: player.name, message: text });
      return;
    }
  });

  ws.on('close', () => {
    const id = ws.playerId;
    if (!id || !gameState.players.has(id)) return;

    const player = gameState.players.get(id);
    const wasHost = player.isHost;
    const name = player.name;

    gameState.players.delete(id);
    broadcast({ type: 'chat', system: true, message: `${name} opuścił(a) grę.` });
    console.log(`[-] ${name} rozłączył się`);

    // Promote new host if needed
    if (wasHost && gameState.players.size > 0) {
      const newHost = gameState.players.values().next().value;
      newHost.isHost = true;
      gameState.hostId = newHost.id;
      const newHostWs = getPlayerWs(newHost.id);
      if (newHostWs) send(newHostWs, { type: 'promoted_to_host' });
      broadcast({ type: 'chat', system: true, message: `${newHost.name} jest teraz hostem.` });
    }

    if (gameState.players.size === 0) {
      // Reset everything
      if (gameState.roundTimer) clearInterval(gameState.roundTimer);
      if (gameState.revealTimer) clearTimeout(gameState.revealTimer);
      gameState.phase = 'lobby';
      gameState.currentQuestion = null;
      gameState.questionQueue = [];
      gameState.roundNumber = 0;
      gameState.hostId = null;
    } else {
      broadcastLobbyState();

      // If everyone remaining already guessed, end the round
      if (gameState.phase === 'playing' && checkAllGuessed()) {
        if (gameState.roundTimer) {
          clearInterval(gameState.roundTimer);
          gameState.roundTimer = null;
        }
        setTimeout(() => endRound(), 500);
      }
    }
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ QuizGame server running on port ${PORT}`);
  console.log(`📚 Załadowano ${questions.length} pytań w ${CATEGORIES.length - 1} kategoriach`);
});
