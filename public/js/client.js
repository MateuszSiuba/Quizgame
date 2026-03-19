'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  ws: null,
  playerId: null,
  isHost: false,
  phase: 'login',
  timeLeft: 25,
  roundDuration: 25,
  hasGuessed: false,
  revealCountdown: null,
  playerWrongGuesses: new Map(),
  playerNames: new Map(),
  playerGuessed: new Map(),
  selectedCategories: new Set(),
  allCategories: [],
};

// ── Elements ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  login:    $('screen-login'),
  lobby:    $('screen-lobby'),
  game:     $('screen-game'),
  gameover: $('screen-gameover'),
};

// Login
const usernameInput    = $('username-input');
const joinBtn          = $('join-btn');
const loginError       = $('login-error');
const loginSpinner     = $('login-spinner');

// Lobby
const hostControls       = $('host-controls');
const guestControls      = $('guest-controls');
const categoryChips      = $('category-chips');
const startBtn           = $('start-btn');
const lobbyLeaderboard   = $('lobby-leaderboard');
const chatMessages       = $('chat-messages');
const chatInput          = $('chat-input');
const chatSendBtn        = $('chat-send-btn');
const countdownOverlay   = $('countdown-overlay');
const countdownNumber    = $('countdown-number');
const lobbyCategoryDisplay = $('lobby-category-display');

// Game
const timerBar          = $('timer-bar');
const timerDisplay      = $('timer-display');
const roundLabel        = $('round-label');
const categoryLabel     = $('category-label');
const questionImageWrap = $('question-image-wrap');
const questionImage     = $('question-image');
const questionText      = $('question-text');
const statusBanner      = $('status-banner');
const guessWrap         = $('guess-wrap');
const guessInput        = $('guess-input');
const guessBtn          = $('guess-btn');
const revealCard        = $('reveal-card');
const revealAnswer      = $('reveal-answer');
const revealCountdown   = $('reveal-countdown');
const gameLeaderboard   = $('game-leaderboard');

// Game over
const gameoverLeaderboard = $('gameover-leaderboard');

// ── Screen switch ─────────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  state.phase = name === 'game' ? 'playing' : name;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', name }));
  });
  ws.addEventListener('message', e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  });
  ws.addEventListener('close', () => {
    showLoginError('Połączenie zostało zerwane. Odśwież stronę.');
    showScreen('login');
    loginSpinner.classList.add('hidden');
    joinBtn.disabled = false;
  });
  ws.addEventListener('error', () => {
    showLoginError('Nie można połączyć się z serwerem.');
    loginSpinner.classList.add('hidden');
    joinBtn.disabled = false;
  });
}

function wsSend(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN)
    state.ws.send(JSON.stringify(payload));
}

// ── Message handler ───────────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    case 'joined': {
      state.playerId = msg.playerId;
      state.isHost   = msg.isHost;
      state.allCategories = msg.categories.filter(c => c !== 'Wszystkie');
      loginSpinner.classList.add('hidden');
      buildCategoryChips();
      setupLobbyUI();
      // Apply initial selection from server
      if (msg.selectedCategory) applyServerCategories(msg.selectedCategory);
      showScreen('lobby');
      break;
    }

    case 'error': {
      showLoginError(msg.message);
      loginSpinner.classList.add('hidden');
      joinBtn.disabled = false;
      break;
    }

    case 'lobby_state': {
      if (msg.players) {
        msg.players.forEach(p => state.playerNames.set(p.id, p.name));
        renderPlayerList(lobbyLeaderboard, msg.players, false);
      }
      if (msg.hostId) {
        const wasHost = state.isHost;
        state.isHost = (msg.hostId === state.playerId);
        if (state.isHost !== wasHost) setupLobbyUI();
      }
      if (msg.selectedCategory) applyServerCategories(msg.selectedCategory);
      break;
    }

    case 'category_changed': {
      applyServerCategories(msg.category);
      break;
    }

    case 'chat': {
      appendChat(msg);
      break;
    }

    case 'game_starting': {
      countdownOverlay.classList.remove('hidden');
      countdownNumber.textContent = msg.countdown;
      break;
    }

    case 'game_countdown': {
      countdownNumber.textContent = msg.countdown;
      // re-trigger animation
      countdownNumber.style.animation = 'none';
      void countdownNumber.offsetWidth;
      countdownNumber.style.animation = '';
      if (msg.countdown <= 0) countdownOverlay.classList.add('hidden');
      break;
    }

    case 'round_start':    { startRound(msg); break; }
    case 'timer_tick':     { updateTimer(msg.timeLeft); break; }

    case 'correct_guess': {
      state.hasGuessed = true;
      disableGuessInput();
      showBanner(`Zgadłeś! +${msg.points} pkt 🎉`, 'success');
      state.playerGuessed.set(state.playerId, true);
      break;
    }

    case 'player_guessed': {
      showBanner(`${msg.playerName} odgadł(a)! 🎯`, 'info');
      const pid = getIdByName(msg.playerName);
      if (pid) {
        state.playerGuessed.set(pid, true);
        state.playerWrongGuesses.delete(pid);
      }
      refreshSideWrongs();
      break;
    }

    case 'wrong_guess': {
      const { playerId, playerName, guess } = msg;
      state.playerNames.set(playerId, playerName);
      state.playerWrongGuesses.set(playerId, [guess]);
      refreshSideWrongs();
      setTimeout(() => {
        const cur = state.playerWrongGuesses.get(playerId);
        if (cur && cur[0] === guess) {
          state.playerWrongGuesses.set(playerId, []);
          refreshSideWrongs();
        }
      }, 2200);
      break;
    }

    case 'leaderboard': {
      msg.players.forEach(p => state.playerNames.set(p.id, p.name));
      renderPlayerList(gameLeaderboard, msg.players, true);
      break;
    }

    case 'round_end':  { endRound(msg); break; }
    case 'game_over':  { gameOver(msg); break; }

    case 'promoted_to_host': {
      state.isHost = true;
      setupLobbyUI();
      appendChat({ system: true, message: 'Zostałeś/aś hostem gry.' });
      break;
    }
  }
}

// ── Category chips (multi-select) ─────────────────────────────────────────────
function buildCategoryChips() {
  categoryChips.innerHTML = '';
  state.allCategories.forEach(cat => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cat-chip';
    chip.dataset.cat = cat;
    chip.textContent = cat;
    chip.addEventListener('click', () => toggleChip(cat, chip));
    categoryChips.appendChild(chip);
  });
  // Default: all selected
  state.selectedCategories = new Set(state.allCategories);
  updateChipVisuals();
}

function toggleChip(cat, chip) {
  if (!state.isHost) return;
  if (state.selectedCategories.has(cat)) {
    // Don't allow deselecting all
    if (state.selectedCategories.size === 1) return;
    state.selectedCategories.delete(cat);
  } else {
    state.selectedCategories.add(cat);
  }
  updateChipVisuals();
  sendCategorySelection();
}

function updateChipVisuals() {
  categoryChips.querySelectorAll('.cat-chip').forEach(chip => {
    chip.classList.toggle('selected', state.selectedCategories.has(chip.dataset.cat));
  });
}

function sendCategorySelection() {
  wsSend({ type: 'select_category', categories: [...state.selectedCategories] });
}

// When server reports category change (for guests)
function applyServerCategories(categoryStr) {
  // categoryStr might be "Filmy, Muzyka" or "Wszystkie"
  if (lobbyCategoryDisplay) lobbyCategoryDisplay.textContent = categoryStr;
  // Sync chips if host
  if (state.isHost && categoryStr !== 'Wszystkie') {
    const cats = categoryStr.split(',').map(s => s.trim());
    state.selectedCategories = new Set(cats);
    updateChipVisuals();
  }
}

// ── Lobby UI ──────────────────────────────────────────────────────────────────
function setupLobbyUI() {
  if (state.isHost) {
    hostControls.classList.remove('hidden');
    guestControls.classList.add('hidden');
  } else {
    hostControls.classList.add('hidden');
    guestControls.classList.remove('hidden');
  }
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function appendChat(msg) {
  const el = document.createElement('div');
  el.className = 'chat-msg' + (msg.system ? ' sys' : '');
  if (msg.system) {
    el.textContent = msg.message;
  } else {
    el.innerHTML = `<span class="cn">${esc(msg.playerName)}</span>: ${esc(msg.message)}`;
  }
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Player list ───────────────────────────────────────────────────────────────
function renderPlayerList(container, players, showGame) {
  const medals = ['🥇','🥈','🥉'];
  const mClass = ['gold','silver','bronze'];
  container.innerHTML = '';
  players.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'pl-item' +
      (p.id === state.playerId ? ' me' : '') +
      (i === 0 && showGame ? ' top1' : '');

    const rank = i < 3 ? medals[i] : `${i+1}.`;
    const rc   = i < 3 ? mClass[i] : '';
    const guessed = showGame && state.playerGuessed.get(p.id);
    const wrongs   = showGame ? (state.playerWrongGuesses.get(p.id) || []) : [];

    item.innerHTML = `
      <div class="pl-main">
        <span class="pl-rank ${rc}">${rank}</span>
        <span class="pl-name">${esc(p.name)}${guessed ? '<span class="pl-ok">✓</span>' : ''}</span>
        <span class="pl-score">${p.score} pkt</span>
      </div>
    `;

    if (wrongs.length > 0) {
      const row = document.createElement('div');
      row.className = 'pl-wrongs';
      wrongs.forEach(g => {
        const chip = document.createElement('span');
        chip.className = 'pl-chip';
        chip.textContent = g;
        row.appendChild(chip);
      });
      item.appendChild(row);
    }

    container.appendChild(item);
  });
}

function refreshSideWrongs() {
  gameLeaderboard.querySelectorAll('.pl-item').forEach(item => {
    const nameEl = item.querySelector('.pl-name');
    if (!nameEl) return;
    const raw = nameEl.childNodes[0]?.textContent?.trim();
    if (!raw) return;
    const pid = getIdByName(raw);
    if (!pid) return;

    const wrongs = state.playerWrongGuesses.get(pid) || [];
    let wrow = item.querySelector('.pl-wrongs');

    if (wrongs.length === 0) { if (wrow) wrow.remove(); return; }
    if (!wrow) { wrow = document.createElement('div'); wrow.className = 'pl-wrongs'; item.appendChild(wrow); }
    wrow.innerHTML = '';
    wrongs.forEach(g => {
      const chip = document.createElement('span');
      chip.className = 'pl-chip'; chip.textContent = g;
      wrow.appendChild(chip);
    });
  });
}

function getIdByName(name) {
  for (const [id, n] of state.playerNames) if (n === name) return id;
  return null;
}

// ── Round ─────────────────────────────────────────────────────────────────────
function startRound(msg) {
  state.hasGuessed = false;
  state.playerWrongGuesses.clear();
  state.playerGuessed.clear();
  state.timeLeft = msg.timeLeft;

  showScreen('game');
  state.phase = 'playing';

  roundLabel.textContent    = `Runda ${msg.roundNumber}`;
  categoryLabel.textContent = msg.category || '';

  if (msg.questionType === 'image' && msg.imageUrl) {
    questionImageWrap.classList.remove('hidden');
    questionImage.src = msg.imageUrl;
    questionText.textContent = msg.questionText || 'Co to za zdjęcie?';
  } else {
    questionImageWrap.classList.add('hidden');
    questionImage.src = '';
    questionText.textContent = msg.questionText || '';
  }

  statusBanner.classList.add('hidden');
  revealCard.classList.add('hidden');
  guessWrap.style.display = '';
  enableGuessInput();
  guessInput.value = '';
  guessInput.focus();
  updateTimer(msg.timeLeft);
}

function updateTimer(t) {
  state.timeLeft = t;
  timerDisplay.textContent = t;
  const pct = (t / state.roundDuration) * 100;
  timerBar.style.width = `${pct}%`;

  if (t > 15) {
    timerBar.style.backgroundColor = 'var(--accent)';
    timerDisplay.className = 'timer-display';
  } else if (t > 8) {
    timerBar.style.backgroundColor = 'var(--warning)';
    timerDisplay.className = 'timer-display warn';
  } else {
    timerBar.style.backgroundColor = 'var(--accent3)';
    timerDisplay.className = 'timer-display danger';
  }
}

function showBanner(text, type) {
  statusBanner.textContent = text;
  statusBanner.className = `status-banner ${type}`;
  statusBanner.classList.remove('hidden');
  clearTimeout(statusBanner._t);
  statusBanner._t = setTimeout(() => statusBanner.classList.add('hidden'), 3200);
}

function enableGuessInput() {
  guessInput.disabled = false;
  guessBtn.disabled = false;
  guessInput.placeholder = 'Wpisz odpowiedź…';
}
function disableGuessInput() {
  guessInput.disabled = true;
  guessBtn.disabled = true;
  guessInput.placeholder = 'Już odpowiedziałeś/aś!';
}

function endRound(msg) {
  state.phase = 'reveal';
  disableGuessInput();
  guessWrap.style.display = 'none';

  revealAnswer.textContent = msg.answer;
  revealCard.classList.remove('hidden');

  let cd = msg.nextRoundIn || 5;
  revealCountdown.textContent = cd;
  if (state.revealCountdown) clearInterval(state.revealCountdown);
  state.revealCountdown = setInterval(() => {
    cd--;
    revealCountdown.textContent = cd;
    if (cd <= 0) { clearInterval(state.revealCountdown); state.revealCountdown = null; }
  }, 1000);

  if (msg.leaderboard) {
    msg.leaderboard.forEach(p => state.playerNames.set(p.id, p.name));
    renderPlayerList(gameLeaderboard, msg.leaderboard, false);
  }
}

function gameOver(msg) {
  if (state.revealCountdown) clearInterval(state.revealCountdown);
  state.phase = 'gameover';
  if (msg.leaderboard) {
    msg.leaderboard.forEach(p => state.playerNames.set(p.id, p.name));
    renderPlayerList(gameoverLeaderboard, msg.leaderboard, false);
  }
  showScreen('gameover');
  setTimeout(() => {
    showScreen('lobby');
    setupLobbyUI();
    state.playerWrongGuesses.clear();
    state.playerGuessed.clear();
  }, 8500);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

// ── Events ────────────────────────────────────────────────────────────────────
joinBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  if (!name) { showLoginError('Wpisz pseudonim!'); return; }
  loginError.classList.add('hidden');
  loginSpinner.classList.remove('hidden');
  joinBtn.disabled = true;
  connectWS(name);
});
usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });

startBtn.addEventListener('click', () => {
  if (!state.isHost) return;
  wsSend({ type: 'start_game' });
});

guessBtn.addEventListener('click', submitGuess);
guessInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitGuess(); });

function submitGuess() {
  if (state.hasGuessed || state.phase !== 'playing') return;
  const guess = guessInput.value.trim();
  if (!guess) return;
  wsSend({ type: 'guess', guess });
  guessInput.value = '';
  guessInput.focus();
}

chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  wsSend({ type: 'chat', text });
  chatInput.value = '';
}
