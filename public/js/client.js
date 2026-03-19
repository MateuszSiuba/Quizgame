'use strict';

// ── LocalStorage keys ─────────────────────────────────────────────────────────
const LS_TOKEN = 'qg_token';
const LS_NAME  = 'qg_name';
const LS_PID   = 'qg_pid';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  ws: null,
  playerId: null,
  token: null,
  savedName: null,
  isHost: false,
  phase: 'login',
  timeLeft: 25,
  roundDuration: 25,
  hasGuessed: false,
  revealCountdown: null,
  playerWrongGuesses: new Map(),
  playerNames: new Map(),
  playerGuessed: new Map(),
  playerDisconnected: new Set(),
  selectedCategories: new Set(),
  allCategories: [],
  roundPaused: false,
  currentQuestionId: null,
  hasVoted: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  disconnectedInGame: false,
};

// ── Elements ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  login:     $('screen-login'),
  lobby:     $('screen-lobby'),
  game:      $('screen-game'),
  gameover:  $('screen-gameover'),
  reconnect: $('screen-reconnect'),
};

// Login
const usernameInput  = $('username-input');
const joinBtn        = $('join-btn');
const loginError     = $('login-error');
const loginSpinner   = $('login-spinner');

// Lobby
const hostControls         = $('host-controls');
const guestControls        = $('guest-controls');
const categoryChips        = $('category-chips');
const startBtn             = $('start-btn');
const lobbyLeaderboard     = $('lobby-leaderboard');
const chatMessages         = $('chat-messages');
const chatInput            = $('chat-input');
const chatSendBtn          = $('chat-send-btn');
const countdownOverlay     = $('countdown-overlay');
const countdownNumber      = $('countdown-number');
const lobbyCategoryDisplay = $('lobby-category-display');

// Game
const timerBar          = $('timer-bar');
const timerDisplay      = $('timer-display');
const pauseBtn          = $('pause-btn');
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
const gameOverlay       = $('game-overlay');
const gameOverlayIcon   = $('game-overlay-icon');
const gameOverlayTitle  = $('game-overlay-title');
const gameOverlaySub    = $('game-overlay-sub');
const overlayResumeBtn  = $('overlay-resume-btn');

// Vote
const voteUp            = $('vote-up');
const voteDown          = $('vote-down');
const voteUpCount       = $('vote-up-count');
const voteDownCount     = $('vote-down-count');
const voteDisabledBadge = $('vote-disabled-badge');

// Gameover
const gameoverLeaderboard = $('gameover-leaderboard');

// Reconnect
const reconnectSub    = $('reconnect-sub');
const reconnectCancel = $('reconnect-cancel');

// ── Screen switch ─────────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  if (name !== 'reconnect') state.phase = name === 'game' ? 'playing' : name;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS(name, token) {
  if (state.ws) { try { state.ws.close(); } catch {} }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    const payload = { type: 'join', name };
    if (token) payload.token = token;
    ws.send(JSON.stringify(payload));
    // Heartbeat – keeps connection alive through Render / Cloudflare idle timeouts
    ws._pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25000);
  });

  ws.addEventListener('message', e => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    clearInterval(ws._pingInterval);
    // If we were in an active game, try to reconnect automatically
    if (state.token && state.savedName &&
        (state.phase === 'playing' || state.phase === 'paused' || state.phase === 'reveal')) {
      state.disconnectedInGame = true;
      startReconnectLoop();
    } else {
      showLoginError('Połączenie zostało zerwane. Odśwież stronę.');
      showScreen('login');
      loginSpinner.classList.add('hidden');
      joinBtn.disabled = false;
    }
  });

  ws.addEventListener('error', () => {
    loginSpinner.classList.add('hidden');
    joinBtn.disabled = false;
  });
}

function wsSend(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN)
    state.ws.send(JSON.stringify(payload));
}

// ── Auto-reconnect loop ───────────────────────────────────────────────────────
const MAX_RECONNECT   = 8;
const RECONNECT_DELAY = [1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000];

function startReconnectLoop() {
  state.reconnectAttempts = 0;
  showScreen('reconnect');
  scheduleReconnect();
}

function scheduleReconnect() {
  if (state.reconnectAttempts >= MAX_RECONNECT) {
    reconnectSub.textContent = 'Nie udało się połączyć. Wróć do logowania.';
    return;
  }
  const delay = RECONNECT_DELAY[state.reconnectAttempts] || 10000;
  const sec = Math.round(delay / 1000);
  reconnectSub.textContent = `Próba ${state.reconnectAttempts + 1}/${MAX_RECONNECT} za ${sec}s…`;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectAttempts++;
    reconnectSub.textContent = `Łączenie… (próba ${state.reconnectAttempts}/${MAX_RECONNECT})`;
    connectWS(state.savedName, state.token);
  }, delay);
}

// ── Message handler ───────────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    // ── Fresh join ──────────────────────────────────────────────────────────
    case 'joined': {
      clearReconnectTimer();
      state.playerId  = msg.playerId;
      state.token     = msg.token;
      state.savedName = usernameInput.value.trim() || state.savedName;
      state.isHost    = msg.isHost;
      state.allCategories = msg.categories.filter(c => c !== 'Wszystkie');
      // Persist for reconnect
      localStorage.setItem(LS_TOKEN, msg.token);
      localStorage.setItem(LS_NAME,  state.savedName);
      localStorage.setItem(LS_PID,   msg.playerId);

      loginSpinner.classList.add('hidden');
      buildCategoryChips();
      setupLobbyUI();
      if (msg.selectedCategory) applyServerCategories(msg.selectedCategory);
      showScreen('lobby');
      break;
    }

    // ── Reconnected ─────────────────────────────────────────────────────────
    case 'reconnected': {
      clearReconnectTimer();
      state.disconnectedInGame = false;
      state.playerId  = msg.playerId;
      state.isHost    = msg.isHost;
      state.hasGuessed = msg.hasGuessed;
      state.allCategories = msg.categories.filter(c => c !== 'Wszystkie');
      if (msg.selectedCategory) applyServerCategories(msg.selectedCategory);

      if (msg.leaderboard) {
        msg.leaderboard.forEach(p => state.playerNames.set(p.id, p.name));
      }

      if (msg.gamePhase === 'playing' || msg.gamePhase === 'paused') {
        showScreen('game');
        if (msg.currentRound) restoreRound(msg.currentRound, msg.gamePhase);
      } else if (msg.gamePhase === 'reveal') {
        showScreen('game');
        if (msg.revealAnswer) {
          showReveal(msg.revealAnswer, msg.revealQuestionId, msg.revealVotes, 3);
        }
      } else {
        buildCategoryChips();
        setupLobbyUI();
        showScreen('lobby');
        if (msg.leaderboard) renderPlayerList(lobbyLeaderboard, msg.leaderboard, false);
      }

      showBanner('Połączono ponownie ✓', 'success');
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
      if (msg.hostId !== undefined) {
        const wasHost = state.isHost;
        state.isHost = (msg.hostId === state.playerId);
        if (state.isHost !== wasHost) setupLobbyUI();
      }
      if (msg.selectedCategory) applyServerCategories(msg.selectedCategory);
      break;
    }

    case 'category_changed': { applyServerCategories(msg.category); break; }
    case 'chat': { appendChat(msg); break; }

    case 'game_starting': {
      countdownOverlay.classList.remove('hidden');
      countdownNumber.textContent = msg.countdown;
      break;
    }
    case 'game_countdown': {
      countdownNumber.textContent = msg.countdown;
      countdownNumber.style.animation = 'none';
      void countdownNumber.offsetWidth;
      countdownNumber.style.animation = '';
      if (msg.countdown <= 0) countdownOverlay.classList.add('hidden');
      break;
    }

    case 'round_start': { startRound(msg); break; }
    case 'timer_tick':  { updateTimer(msg.timeLeft); break; }

    case 'game_paused': {
      state.roundPaused = true;
      state.phase = 'paused';
      disableGuessInput('Gra wstrzymana…');
      showGameOverlay('⏸', 'Gra wstrzymana', `przez ${msg.by}`);
      updatePauseButton();
      break;
    }
    case 'game_resumed': {
      state.roundPaused = false;
      state.phase = 'playing';
      hideGameOverlay();
      if (!state.hasGuessed) enableGuessInput();
      showBanner('Gra wznowiona!', 'info');
      updatePauseButton();
      break;
    }

    case 'correct_guess': {
      state.hasGuessed = true;
      disableGuessInput('Już odpowiedziałeś/aś!');
      showBanner(`Zgadłeś! +${msg.points} pkt 🎉`, 'success');
      state.playerGuessed.set(state.playerId, true);
      break;
    }
    case 'player_guessed': {
      showBanner(`${msg.playerName} odgadł(a)! 🎯`, 'info');
      const pid = getIdByName(msg.playerName);
      if (pid) { state.playerGuessed.set(pid, true); state.playerWrongGuesses.delete(pid); }
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

    case 'round_end': {
      endRound(msg);
      break;
    }

    case 'question_votes': {
      // Live vote update during reveal
      if (voteUpCount)   voteUpCount.textContent   = msg.votes.up   || 0;
      if (voteDownCount) voteDownCount.textContent = msg.votes.down || 0;

      break;
    }

    case 'game_over': { gameOver(msg); break; }

    case 'promoted_to_host': {
      state.isHost = true;
      setupLobbyUI();
      updatePauseButton();
      // Jeśli gra jest wstrzymana, pokaż przycisk Wznów w overlay
      if (state.roundPaused && overlayResumeBtn) overlayResumeBtn.classList.remove('hidden');
      appendChat({ system: true, message: 'Zostałeś/aś hostem gry.' });
      break;
    }

    case 'player_disconnected': {
      state.playerDisconnected.add(msg.playerId);
      appendChat({ system: true, message: `${msg.playerName} stracił(a) połączenie…` });
      // Dim in leaderboard
      refreshDisconnectedMarkers();
      break;
    }
  }
}

// ── Game overlay (pause / reconnect message) ──────────────────────────────────
function showGameOverlay(icon, title, sub) {
  gameOverlayIcon.textContent  = icon;
  gameOverlayTitle.textContent = title;
  gameOverlaySub.textContent   = sub || '';
  // Pokaż przycisk Wznów tylko hostowi
  if (overlayResumeBtn) overlayResumeBtn.classList.toggle('hidden', !state.isHost);
  gameOverlay.classList.remove('hidden');
}
function hideGameOverlay() {
  gameOverlay.classList.add('hidden');
}

// ── Reconnect helpers ─────────────────────────────────────────────────────────
function clearReconnectTimer() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
}

function restoreRound(r, phase) {
  state.hasGuessed = state.hasGuessed; // kept from reconnect payload
  state.playerWrongGuesses.clear();
  state.playerGuessed.clear();
  state.timeLeft = r.timeLeft;

  roundLabel.textContent    = `Runda ${r.roundNumber}`;
  categoryLabel.textContent = r.category || '';
  state.currentQuestionId   = r.questionId;

  if (r.questionType === 'image' && r.imageUrl) {
    questionImageWrap.classList.remove('hidden');
    questionImage.src = r.imageUrl;
    questionText.textContent = r.questionText || 'Co to?';
  } else {
    questionImageWrap.classList.add('hidden');
    questionImage.src = '';
    questionText.textContent = r.questionText || '';
  }

  revealCard.classList.add('hidden');
  statusBanner.classList.add('hidden');
  guessWrap.style.display = '';

  if (state.hasGuessed || phase === 'paused') {
    disableGuessInput(state.hasGuessed ? 'Już odpowiedziałeś/aś!' : 'Gra wstrzymana…');
  } else {
    enableGuessInput();
    guessInput.focus();
  }

  updateTimer(r.timeLeft);
  updatePauseButton();

  if (phase === 'paused') showGameOverlay('⏸', 'Gra wstrzymana', 'przez hosta');
  else hideGameOverlay();
}

// ── Category chips ────────────────────────────────────────────────────────────
function buildCategoryChips() {
  categoryChips.innerHTML = '';
  state.allCategories.forEach(cat => {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'cat-chip';
    chip.dataset.cat = cat; chip.textContent = cat;
    chip.addEventListener('click', () => toggleChip(cat, chip));
    categoryChips.appendChild(chip);
  });
  state.selectedCategories = new Set(state.allCategories);
  updateChipVisuals();
}
function toggleChip(cat) {
  if (!state.isHost) return;
  if (state.selectedCategories.has(cat)) {
    if (state.selectedCategories.size === 1) return;
    state.selectedCategories.delete(cat);
  } else {
    state.selectedCategories.add(cat);
  }
  updateChipVisuals();
  wsSend({ type: 'select_category', categories: [...state.selectedCategories] });
}
function updateChipVisuals() {
  categoryChips.querySelectorAll('.cat-chip').forEach(chip => {
    chip.classList.toggle('selected', state.selectedCategories.has(chip.dataset.cat));
  });
}
function applyServerCategories(label) {
  if (lobbyCategoryDisplay) lobbyCategoryDisplay.textContent = label;
  if (state.isHost && label !== 'Wszystkie') {
    state.selectedCategories = new Set(label.split(',').map(s => s.trim()));
    updateChipVisuals();
  }
}

// ── Lobby UI ──────────────────────────────────────────────────────────────────
function setupLobbyUI() {
  hostControls.classList.toggle('hidden', !state.isHost);
  guestControls.classList.toggle('hidden', state.isHost);
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
    const isDisconnected = state.playerDisconnected.has(p.id);
    item.className = 'pl-item'
      + (p.id === state.playerId  ? ' me'    : '')
      + (i === 0 && showGame      ? ' top1'  : '')
      + (isDisconnected           ? ' disconnected' : '');

    const rank    = i < 3 ? medals[i] : `${i+1}.`;
    const rc      = i < 3 ? mClass[i] : '';
    const guessed = showGame && state.playerGuessed.get(p.id);
    const wrongs  = showGame ? (state.playerWrongGuesses.get(p.id) || []) : [];

    item.innerHTML = `
      <div class="pl-main">
        <span class="pl-rank ${rc}">${rank}</span>
        <span class="pl-name">${esc(p.name)}${guessed ? '<span class="pl-ok">✓</span>' : ''}</span>
        <span class="pl-score">${p.score} pkt</span>
      </div>`;

    if (wrongs.length > 0) {
      const row = document.createElement('div');
      row.className = 'pl-wrongs';
      wrongs.forEach(g => {
        const chip = document.createElement('span');
        chip.className = 'pl-chip'; chip.textContent = g;
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

function refreshDisconnectedMarkers() {
  gameLeaderboard.querySelectorAll('.pl-item').forEach(item => {
    const nameEl = item.querySelector('.pl-name');
    if (!nameEl) return;
    const raw = nameEl.childNodes[0]?.textContent?.trim();
    if (!raw) return;
    const pid = getIdByName(raw);
    if (!pid) return;
    item.classList.toggle('disconnected', state.playerDisconnected.has(pid));
  });
}

function getIdByName(name) {
  for (const [id, n] of state.playerNames) if (n === name) return id;
  return null;
}

// ── Round ─────────────────────────────────────────────────────────────────────
function startRound(msg) {
  state.hasGuessed  = false;
  state.roundPaused = false;
  state.playerWrongGuesses.clear();
  state.playerGuessed.clear();
  state.playerDisconnected.clear();
  state.timeLeft = msg.timeLeft;
  state.currentQuestionId = msg.questionId;
  state.hasVoted = false;

  showScreen('game');
  state.phase = 'playing';
  hideGameOverlay();

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
  updatePauseButton();
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
  guessInput.disabled = false; guessBtn.disabled = false;
  guessInput.placeholder = 'Wpisz odpowiedź…';
}
function disableGuessInput(placeholder) {
  guessInput.disabled = true; guessBtn.disabled = true;
  guessInput.placeholder = placeholder || 'Już odpowiedziałeś/aś!';
}

function showReveal(answer, questionId, votes, countdownSec) {
  state.phase = 'reveal';
  disableGuessInput('Runda zakończona!');
  guessWrap.style.display = 'none';
  hideGameOverlay();

  revealAnswer.textContent = answer;
  revealCard.classList.remove('hidden');

  // Votes
  state.hasVoted = false;
  state.currentQuestionId = questionId;
  voteDisabledBadge.classList.add('hidden');
  voteUpCount.textContent   = votes?.up   || 0;
  voteDownCount.textContent = votes?.down || 0;
  voteUp.classList.remove('voted');
  voteDown.classList.remove('voted');
  voteUp.disabled   = false;
  voteDown.disabled = false;


  let cd = countdownSec || 5;
  revealCountdown.textContent = cd;
  if (state.revealCountdown) clearInterval(state.revealCountdown);
  state.revealCountdown = setInterval(() => {
    cd--;
    revealCountdown.textContent = cd;
    if (cd <= 0) { clearInterval(state.revealCountdown); state.revealCountdown = null; }
  }, 1000);
}

function endRound(msg) {
  showReveal(msg.answer, msg.questionId, msg.votes, msg.nextRoundIn);
  updatePauseButton();
  if (msg.leaderboard) {
    msg.leaderboard.forEach(p => state.playerNames.set(p.id, p.name));
    renderPlayerList(gameLeaderboard, msg.leaderboard, false);
  }
}

function gameOver(msg) {
  if (state.revealCountdown) clearInterval(state.revealCountdown);
  state.phase = 'gameover';
  state.roundPaused = false;
  updatePauseButton();
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
    state.playerDisconnected.clear();
  }, 8500);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}
function updatePauseButton() {
  if (!pauseBtn) return;
  const show = state.isHost && (state.phase === 'playing' || state.phase === 'paused');
  pauseBtn.classList.toggle('hidden', !show);
  pauseBtn.textContent = state.roundPaused ? '▶ Wznów' : '⏸ Wstrzymaj';
  // Sync overlay resume button visibility
  if (overlayResumeBtn) overlayResumeBtn.classList.toggle('hidden', !state.isHost);
}

// ── Events ────────────────────────────────────────────────────────────────────

// Auto-reconnect on page load
window.addEventListener('load', () => {
  const token = localStorage.getItem(LS_TOKEN);
  const name  = localStorage.getItem(LS_NAME);
  if (token && name) {
    state.token     = token;
    state.savedName = name;
    // Pre-fill username input
    usernameInput.value = name;
  }
});

joinBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  if (!name) { showLoginError('Wpisz pseudonim!'); return; }
  loginError.classList.add('hidden');
  loginSpinner.classList.remove('hidden');
  joinBtn.disabled = true;
  // Attempt reconnect if we have a saved token and the same name
  const savedToken = localStorage.getItem(LS_TOKEN);
  const savedName  = localStorage.getItem(LS_NAME);
  const useToken   = savedToken && savedName && savedName.toLowerCase() === name.toLowerCase()
    ? savedToken : null;
  state.savedName = name;
  connectWS(name, useToken);
});
usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });

startBtn.addEventListener('click', () => {
  if (!state.isHost) return;
  wsSend({ type: 'start_game' });
});

pauseBtn.addEventListener('click', () => {
  if (!state.isHost) return;
  wsSend({ type: 'toggle_pause' });
});

// Przycisk Wznów w overlayu pauzy — tylko host, działa tak samo
if (overlayResumeBtn) {
  overlayResumeBtn.addEventListener('click', () => {
    if (!state.isHost || !state.roundPaused) return;
    wsSend({ type: 'toggle_pause' });
  });
}

guessBtn.addEventListener('click', submitGuess);
guessInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitGuess(); });
function submitGuess() {
  if (state.hasGuessed || state.phase !== 'playing' || state.roundPaused) return;
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

// ── Voting ────────────────────────────────────────────────────────────────────
voteUp.addEventListener('click', () => submitVote('up'));
voteDown.addEventListener('click', () => submitVote('down'));
function submitVote(dir) {
  if (state.hasVoted || state.phase !== 'reveal') return;
  if (!state.currentQuestionId) return;
  state.hasVoted = true;
  voteUp.classList.toggle('voted',   dir === 'up');
  voteDown.classList.toggle('voted', dir === 'down');
  voteUp.disabled   = true;
  voteDown.disabled = true;
  wsSend({ type: 'vote_question', questionId: state.currentQuestionId, vote: dir });
}

// ── Reconnect screen cancel ───────────────────────────────────────────────────
reconnectCancel.addEventListener('click', () => {
  clearReconnectTimer();
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_NAME);
  localStorage.removeItem(LS_PID);
  state.token = null; state.savedName = null;
  loginSpinner.classList.add('hidden');
  joinBtn.disabled = false;
  showScreen('login');
});
