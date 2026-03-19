'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  ws: null,
  playerId: null,
  isHost: false,
  phase: 'login',  // login | lobby | playing | reveal | gameover
  timeLeft: 25,
  roundDuration: 25,
  hasGuessed: false,
  revealCountdown: null,
  playerWrongGuesses: new Map(), // playerId -> [guess, ...]
  playerNames: new Map(),        // playerId -> name
  playerGuessed: new Map(),      // playerId -> bool
};

// ── Elements ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  login:    $('screen-login'),
  lobby:    $('screen-lobby'),
  game:     $('screen-game'),
  gameover: $('screen-gameover'),
};

// Login
const usernameInput  = $('username-input');
const joinBtn        = $('join-btn');
const loginError     = $('login-error');
const loginSpinner   = $('login-spinner');

// Lobby
const hostControls       = $('host-controls');
const guestControls      = $('guest-controls');
const categorySelect     = $('category-select');
const startBtn           = $('start-btn');
const lobbyLeaderboard   = $('lobby-leaderboard');
const chatMessages       = $('chat-messages');
const chatInput          = $('chat-input');
const chatSendBtn        = $('chat-send-btn');
const countdownOverlay   = $('countdown-overlay');
const countdownNumber    = $('countdown-number');
const lobbyCategoryDisplay = $('lobby-category-display');

// Game
const timerBar         = $('timer-bar');
const timerDisplay     = $('timer-display');
const roundLabel       = $('round-label');
const categoryLabel    = $('category-label');
const questionImageWrap = $('question-image-wrap');
const questionImage    = $('question-image');
const questionText     = $('question-text');
const statusBanner     = $('status-banner');
const guessWrap        = $('guess-wrap');
const guessInput       = $('guess-input');
const guessBtn         = $('guess-btn');
const revealCard       = $('reveal-card');
const revealAnswer     = $('reveal-answer');
const revealCountdown  = $('reveal-countdown');
const gameLeaderboard  = $('game-leaderboard');

// Gameover
const gameoverLeaderboard = $('gameover-leaderboard');

// ── Screen Switching ─────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  state.phase = name === 'game' ? 'playing' : name;
}

// ── WebSocket ────────────────────────────────────────────────────────────────
function connectWS(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url   = `${proto}://${location.host}`;
  const ws    = new WebSocket(url);
  state.ws    = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', name }));
  });

  ws.addEventListener('message', e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
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
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

// ── Message Handler ──────────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    case 'joined': {
      state.playerId = msg.playerId;
      state.isHost   = msg.isHost;
      loginSpinner.classList.add('hidden');
      populateCategorySelect(msg.categories, msg.selectedCategory);
      setupLobbyUI();
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
        renderLeaderboard(lobbyLeaderboard, msg.players, false);
      }
      if (msg.hostId) {
        const wasHost = state.isHost;
        state.isHost = (msg.hostId === state.playerId);
        if (state.isHost !== wasHost) setupLobbyUI();
      }
      if (msg.selectedCategory) {
        lobbyCategoryDisplay.textContent = msg.selectedCategory;
        if (categorySelect) categorySelect.value = msg.selectedCategory;
      }
      break;
    }

    case 'category_changed': {
      lobbyCategoryDisplay.textContent = msg.category;
      if (categorySelect) categorySelect.value = msg.category;
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
      countdownNumber.style.animation = 'none';
      void countdownNumber.offsetWidth;
      countdownNumber.style.animation = '';
      if (msg.countdown <= 0) {
        countdownOverlay.classList.add('hidden');
      }
      break;
    }

    case 'round_start': {
      startRound(msg);
      break;
    }

    case 'timer_tick': {
      updateTimer(msg.timeLeft);
      break;
    }

    case 'correct_guess': {
      // We guessed correctly
      state.hasGuessed = true;
      disableGuessInput();
      showBanner(`Zgadłeś! +${msg.points} pkt 🎉`, 'success');
      state.playerGuessed.set(state.playerId, true);
      break;
    }

    case 'player_guessed': {
      showBanner(`${msg.playerName} odgadł(a)! 🎯`, 'info');
      const pid = getPlayerIdByName(msg.playerName);
      if (pid) {
        state.playerGuessed.set(pid, true);
        state.playerWrongGuesses.delete(pid); // clear wrong guesses on correct
      }
      refreshGameLeaderboard();
      break;
    }

    case 'wrong_guess': {
      const { playerId, playerName, guess } = msg;
      state.playerNames.set(playerId, playerName);

      const prev = state.playerWrongGuesses.get(playerId) || [];
      // Keep only last guess (replaces previous display)
      state.playerWrongGuesses.set(playerId, [guess]);

      // Show wrong chip briefly under player
      refreshGameLeaderboard();

      // After 2s, remove it
      setTimeout(() => {
        const cur = state.playerWrongGuesses.get(playerId);
        if (cur && cur.length > 0 && cur[cur.length - 1] === guess) {
          state.playerWrongGuesses.set(playerId, []);
          refreshGameLeaderboard();
        }
      }, 2200);
      break;
    }

    case 'leaderboard': {
      msg.players.forEach(p => state.playerNames.set(p.id, p.name));
      renderLeaderboard(gameLeaderboard, msg.players, true);
      break;
    }

    case 'round_end': {
      endRound(msg);
      break;
    }

    case 'game_over': {
      gameOver(msg);
      break;
    }

    case 'promoted_to_host': {
      state.isHost = true;
      setupLobbyUI();
      appendChat({ system: true, message: 'Zostałeś/aś hostem gry.' });
      break;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getPlayerIdByName(name) {
  for (const [id, n] of state.playerNames) {
    if (n === name) return id;
  }
  return null;
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

function populateCategorySelect(categories, selected) {
  categorySelect.innerHTML = '';
  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    if (cat === selected) opt.selected = true;
    categorySelect.appendChild(opt);
  });
}

function setupLobbyUI() {
  if (state.isHost) {
    hostControls.classList.remove('hidden');
    guestControls.classList.add('hidden');
  } else {
    hostControls.classList.add('hidden');
    guestControls.classList.remove('hidden');
  }
}

// ── Chat ─────────────────────────────────────────────────────────────────────
function appendChat(msg) {
  const el = document.createElement('div');
  el.classList.add('chat-msg');
  if (msg.system) {
    el.classList.add('system');
    el.textContent = msg.message;
  } else {
    el.innerHTML = `<span class="chat-name">${escHtml(msg.playerName)}</span>: ${escHtml(msg.message)}`;
  }
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Leaderboard Rendering ─────────────────────────────────────────────────────
function renderLeaderboard(container, players, showGuessStatus) {
  const rankSymbols = ['🥇', '🥈', '🥉'];
  const rankClasses = ['gold','silver','bronze'];

  container.innerHTML = '';
  players.forEach((p, i) => {
    const item = document.createElement('div');
    item.classList.add('leaderboard-item');
    if (p.id === state.playerId) item.classList.add('me');
    if (i === 0 && showGuessStatus) item.classList.add('first');

    const isGuessed = state.playerGuessed.get(p.id);
    const wrongGuesses = state.playerWrongGuesses.get(p.id) || [];

    const rankLabel = i < 3 ? rankSymbols[i] : `${i+1}.`;
    const rankClass = i < 3 ? rankClasses[i] : '';

    const hostBadge = p.id === state.hostId || (!showGuessStatus && state.hostId)
      ? '' : '';

    item.innerHTML = `
      <div class="lb-row-main">
        <span class="lb-rank ${rankClass}">${rankLabel}</span>
        <span class="lb-name">
          ${escHtml(p.name)}
          ${isGuessed && showGuessStatus ? '<span style="color:var(--success);margin-left:4px;">✓</span>' : ''}
        </span>
        <span class="lb-score">${p.score} pkt</span>
      </div>
    `;

    if (showGuessStatus && wrongGuesses.length > 0) {
      const row = document.createElement('div');
      row.classList.add('lb-wrong-guesses');
      wrongGuesses.forEach(g => {
        const chip = document.createElement('span');
        chip.classList.add('lb-wrong-chip');
        chip.textContent = g;
        row.appendChild(chip);
      });
      item.appendChild(row);
    }

    container.appendChild(item);
  });
}

function refreshGameLeaderboard() {
  // Re-render with current wrong guesses overlay
  // We'll just update wrong guess chips in-place by triggering a re-render
  // The server periodically sends leaderboard updates; we just update chips here
  const items = gameLeaderboard.querySelectorAll('.leaderboard-item');
  items.forEach(item => {
    const nameEl = item.querySelector('.lb-name');
    if (!nameEl) return;
    const nameText = nameEl.childNodes[0]?.textContent?.trim();
    const pid = getPlayerIdByName(nameText);
    if (!pid) return;

    // Update wrong guess chips
    let wrongRow = item.querySelector('.lb-wrong-guesses');
    const wrongs = state.playerWrongGuesses.get(pid) || [];

    if (wrongs.length === 0) {
      if (wrongRow) wrongRow.remove();
      return;
    }

    if (!wrongRow) {
      wrongRow = document.createElement('div');
      wrongRow.classList.add('lb-wrong-guesses');
      item.appendChild(wrongRow);
    }

    wrongRow.innerHTML = '';
    wrongs.forEach(g => {
      const chip = document.createElement('span');
      chip.classList.add('lb-wrong-chip');
      chip.textContent = g;
      wrongRow.appendChild(chip);
    });
  });
}

// ── Round ─────────────────────────────────────────────────────────────────────
function startRound(msg) {
  state.hasGuessed = false;
  state.playerWrongGuesses.clear();
  state.playerGuessed.clear();
  state.timeLeft  = msg.timeLeft;

  // Switch screen
  showScreen('game');
  state.phase = 'playing';

  // Header info
  roundLabel.textContent    = `Runda ${msg.roundNumber}`;
  categoryLabel.textContent = msg.category || '';

  // Question content
  if (msg.questionType === 'image' && msg.imageUrl) {
    questionImageWrap.classList.remove('hidden');
    questionImage.src = msg.imageUrl;
    questionText.textContent = msg.question_text || 'Jaki to?';
  } else {
    questionImageWrap.classList.add('hidden');
    questionImage.src = '';
    questionText.textContent = msg.questionText || '';
  }

  // Reset UI
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
    timerBar.style.backgroundColor = 'var(--timer-full)';
    timerDisplay.className = 'timer-display';
  } else if (t > 8) {
    timerBar.style.backgroundColor = 'var(--timer-mid)';
    timerDisplay.className = 'timer-display warning';
  } else {
    timerBar.style.backgroundColor = 'var(--timer-low)';
    timerDisplay.className = 'timer-display danger';
  }
}

function showBanner(text, type) {
  statusBanner.textContent = text;
  statusBanner.className   = `status-banner ${type}`;
  statusBanner.classList.remove('hidden');

  clearTimeout(statusBanner._hideTimer);
  statusBanner._hideTimer = setTimeout(() => {
    statusBanner.classList.add('hidden');
  }, 3000);
}

function enableGuessInput() {
  guessInput.disabled = false;
  guessBtn.disabled   = false;
  guessInput.placeholder = 'Wpisz odpowiedź…';
}

function disableGuessInput() {
  guessInput.disabled = true;
  guessBtn.disabled   = true;
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
    cd -= 1;
    revealCountdown.textContent = cd;
    if (cd <= 0) {
      clearInterval(state.revealCountdown);
      state.revealCountdown = null;
    }
  }, 1000);

  if (msg.leaderboard) {
    msg.leaderboard.forEach(p => state.playerNames.set(p.id, p.name));
    renderLeaderboard(gameLeaderboard, msg.leaderboard, false);
  }
}

function gameOver(msg) {
  if (state.revealCountdown) clearInterval(state.revealCountdown);
  state.phase = 'gameover';

  if (msg.leaderboard) {
    msg.leaderboard.forEach(p => state.playerNames.set(p.id, p.name));
    renderLeaderboard(gameoverLeaderboard, msg.leaderboard, false);
  }

  showScreen('gameover');

  // Server will reset and send lobby_state after 8s
  setTimeout(() => {
    showScreen('lobby');
    setupLobbyUI();
    state.playerWrongGuesses.clear();
    state.playerGuessed.clear();
  }, 8500);
}

// ── Event Listeners ──────────────────────────────────────────────────────────

// Login
joinBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  if (!name) { showLoginError('Wpisz pseudonim!'); return; }
  loginError.classList.add('hidden');
  loginSpinner.classList.remove('hidden');
  joinBtn.disabled = true;
  connectWS(name);
});

usernameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') joinBtn.click();
});

// Category
categorySelect.addEventListener('change', () => {
  if (!state.isHost) return;
  wsSend({ type: 'select_category', category: categorySelect.value });
});

// Start game
startBtn.addEventListener('click', () => {
  if (!state.isHost) return;
  wsSend({ type: 'start_game' });
});

// Guess
guessBtn.addEventListener('click', submitGuess);
guessInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') submitGuess();
});

function submitGuess() {
  if (state.hasGuessed || state.phase !== 'playing') return;
  const guess = guessInput.value.trim();
  if (!guess) return;
  wsSend({ type: 'guess', guess });
  guessInput.value = '';
  guessInput.focus();
}

// Chat
chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  wsSend({ type: 'chat', text });
  chatInput.value = '';
}
