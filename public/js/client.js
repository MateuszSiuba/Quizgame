'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  CONFETTI ENGINE — zero dependencies, canvas-based
// ══════════════════════════════════════════════════════════════════════════════
const confetti = (() => {
  const canvas = document.getElementById('confetti-canvas');
  const ctx    = canvas.getContext('2d');
  let   W = 0, H = 0, particles = [], raf = null;

  const COLORS = ['#3b7bff','#00d4ff','#2ecc71','#f39c12','#ff6b6b','#c0f','#ff0','#0ff'];

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  function Particle(x, y) {
    this.x  = x; this.y = y;
    this.vx = (Math.random() - 0.5) * 10;
    this.vy = -(Math.random() * 8 + 5);
    this.ay = 0.35;                          // gravity
    this.color  = COLORS[Math.random() * COLORS.length | 0];
    this.w = Math.random() * 10 + 5;
    this.h = Math.random() * 5  + 3;
    this.angle  = Math.random() * Math.PI * 2;
    this.spin   = (Math.random() - 0.5) * 0.3;
    this.alpha  = 1;
    this.decay  = Math.random() * 0.012 + 0.007;
  }

  function loop() {
    ctx.clearRect(0, 0, W, H);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.vy += p.ay; p.x += p.vx; p.y += p.vy;
      p.angle += p.spin; p.alpha -= p.decay;
      if (p.alpha <= 0 || p.y > H + 20) { particles.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle   = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (particles.length > 0) raf = requestAnimationFrame(loop);
    else raf = null;
  }

  return {
    burst(x, y, count = 90) {
      for (let i = 0; i < count; i++) particles.push(new Particle(x, y));
      if (!raf) raf = requestAnimationFrame(loop);
    },
    // Full-screen celebration (winner podium)
    celebrate() {
      for (let i = 0; i < 5; i++) {
        setTimeout(() => {
          this.burst(Math.random() * W, H * 0.35, 60);
        }, i * 180);
      }
    },
  };
})();

// ══════════════════════════════════════════════════════════════════════════════
//  AUDIO ENGINE — Web Audio API, zero files
// ══════════════════════════════════════════════════════════════════════════════
const audio = (() => {
  let ctx = null;
  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone({ freq=440, type='sine', gainPeak=0.35,
                  attack=0.01, decay=0.08, release=0.12, duration=0.22, detune=0 }={}) {
    try {
      const c=getCtx(), osc=c.createOscillator(), env=c.createGain();
      osc.connect(env); env.connect(c.destination);
      osc.type=type; osc.frequency.value=freq; osc.detune.value=detune;
      const t=c.currentTime;
      env.gain.setValueAtTime(0,t);
      env.gain.linearRampToValueAtTime(gainPeak, t+attack);
      env.gain.linearRampToValueAtTime(0.001, t+attack+decay+release);
      osc.start(t); osc.stop(t+duration+0.05);
    } catch(_) {}
  }
  return {
    correct() {
      tone({ freq:523, type:'triangle', gainPeak:0.4, attack:0.005, decay:0.06, release:0.18, duration:0.28 });
      setTimeout(() => tone({ freq:784, type:'triangle', gainPeak:0.32, attack:0.005, decay:0.05, release:0.22, duration:0.32 }), 100);
    },
    tick(t) {
      const freq = 280 + (6 - t) * 28;
      tone({ freq, type:'square', gainPeak:0.15, attack:0.004, decay:0.04, release:0.06, duration:0.08 });
    },
  };
})();

// ══════════════════════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════════════════════
const LS_TOKEN = 'qg_token';
const LS_NAME  = 'qg_name';
const LS_PID   = 'qg_pid';

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
  roomCode: null,
  myStreak: 0,
};

// ══════════════════════════════════════════════════════════════════════════════
//  ELEMENTS
// ══════════════════════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

const screens = {
  login: $('screen-login'), lobby: $('screen-lobby'),
  game:  $('screen-game'),  gameover: $('screen-gameover'),
  reconnect: $('screen-reconnect'),
};

const usernameInput        = $('username-input');
const joinBtn              = $('join-btn');
const loginError           = $('login-error');
const loginSpinner         = $('login-spinner');
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
const roomCodeEl           = $('room-code');
const roomCopyBtn          = $('room-copy-btn');
const roomCopyIcon         = $('room-copy-icon');
const timerBar             = $('timer-bar');
const timerDisplay         = $('timer-display');
const pauseBtn             = $('pause-btn');
const roundLabel           = $('round-label');
const categoryLabel        = $('category-label');
const questionImageWrap    = $('question-image-wrap');
const questionImage        = $('question-image');
const questionText         = $('question-text');
const statusBanner         = $('status-banner');
const guessWrap            = $('guess-wrap');
const guessInput           = $('guess-input');
const guessBtn             = $('guess-btn');
const revealCard           = $('reveal-card');
const revealAnswer         = $('reveal-answer');
const revealCountdown      = $('reveal-countdown');
const gameLeaderboard      = $('game-leaderboard');
const gameOverlay          = $('game-overlay');
const gameOverlayIcon      = $('game-overlay-icon');
const gameOverlayTitle     = $('game-overlay-title');
const gameOverlaySub       = $('game-overlay-sub');
const overlayResumeBtn     = $('overlay-resume-btn');
const voteUp               = $('vote-up');
const voteDown             = $('vote-down');
const voteUpCount          = $('vote-up-count');
const voteDownCount        = $('vote-down-count');
const voteDisabledBadge    = $('vote-disabled-badge');
const gameoverLeaderboard  = $('gameover-leaderboard');
const statsGrid            = $('stats-grid');
const reconnectSub         = $('reconnect-sub');
const reconnectCancel      = $('reconnect-cancel');
const streakBadge          = $('streak-badge');
const streakText           = $('streak-text');
const streakIcon           = $('streak-icon');

// ══════════════════════════════════════════════════════════════════════════════
//  SCREEN SWITCH
// ══════════════════════════════════════════════════════════════════════════════
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  if (name !== 'reconnect') state.phase = name === 'game' ? 'playing' : name;
}

// ══════════════════════════════════════════════════════════════════════════════
//  WEBSOCKET
// ══════════════════════════════════════════════════════════════════════════════
function connectWS(name, token) {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    const p = { type: 'join', name };
    if (token) p.token = token;
    ws.send(JSON.stringify(p));
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
    if (state.token && state.savedName &&
        (state.phase==='playing'||state.phase==='paused'||state.phase==='reveal')) {
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

function wsSend(p) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(p));
}

// ══════════════════════════════════════════════════════════════════════════════
//  RECONNECT LOOP
// ══════════════════════════════════════════════════════════════════════════════
const MAX_RECONNECT   = 8;
const RECONNECT_DELAY = [1000,2000,3000,4000,5000,6000,8000,10000];

function startReconnectLoop() {
  state.reconnectAttempts = 0;
  showScreen('reconnect');
  scheduleReconnect();
}
function scheduleReconnect() {
  if (state.reconnectAttempts >= MAX_RECONNECT) {
    reconnectSub.textContent = 'Nie udało się połączyć. Wróć do logowania.'; return;
  }
  const delay = RECONNECT_DELAY[state.reconnectAttempts] || 10000;
  reconnectSub.textContent = `Próba ${state.reconnectAttempts+1}/${MAX_RECONNECT} za ${Math.round(delay/1000)}s…`;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectAttempts++;
    reconnectSub.textContent = `Łączenie… (próba ${state.reconnectAttempts}/${MAX_RECONNECT})`;
    connectWS(state.savedName, state.token);
  }, delay);
}
function clearReconnectTimer() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROOM CODE / INVITE LINK
// ══════════════════════════════════════════════════════════════════════════════
function setRoomCode(code) {
  state.roomCode = code;
  if (roomCodeEl) roomCodeEl.textContent = code || '—';
}

function getInviteUrl() {
  const base = `${location.protocol}//${location.host}`;
  return state.roomCode ? `${base}?room=${state.roomCode}` : base;
}

roomCopyBtn.addEventListener('click', async () => {
  const url = getInviteUrl();
  try {
    await navigator.clipboard.writeText(url);
    roomCopyIcon.textContent = '✅';
    roomCopyBtn.querySelector('span + *')?.remove();
    roomCopyBtn.lastChild.textContent = ' Skopiowano!';
    setTimeout(() => {
      roomCopyIcon.textContent = '🔗';
      // reset text
      roomCopyBtn.innerHTML = '<span id="room-copy-icon">🔗</span> Kopiuj link';
    }, 2000);
  } catch {
    // fallback: prompt
    window.prompt('Skopiuj link zaproszenia:', url);
  }
});

// On load: if ?room= param exists, pre-fill nothing (server uses single room)
window.addEventListener('load', () => {
  const token = localStorage.getItem(LS_TOKEN);
  const name  = localStorage.getItem(LS_NAME);
  if (token && name) { state.token = token; state.savedName = name; usernameInput.value = name; }
});

// ══════════════════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════════════════════
function handleMessage(msg) {
  switch (msg.type) {

    case 'joined': {
      clearReconnectTimer();
      state.playerId  = msg.playerId;
      state.token     = msg.token;
      state.savedName = usernameInput.value.trim() || state.savedName;
      state.isHost    = msg.isHost;
      state.allCategories = msg.categories.filter(c => c !== 'Wszystkie');
      localStorage.setItem(LS_TOKEN, msg.token);
      localStorage.setItem(LS_NAME,  state.savedName);
      localStorage.setItem(LS_PID,   msg.playerId);
      loginSpinner.classList.add('hidden');
      setRoomCode(msg.roomCode);
      buildCategoryChips();
      setupLobbyUI();
      if (msg.selectedCategory) applyServerCategories(msg.selectedCategory);
      showScreen('lobby');
      break;
    }

    case 'reconnected': {
      clearReconnectTimer();
      state.disconnectedInGame = false;
      state.playerId   = msg.playerId;
      state.isHost     = msg.isHost;
      state.hasGuessed = msg.hasGuessed;
      state.allCategories = msg.categories.filter(c => c !== 'Wszystkie');
      if (msg.roomCode) setRoomCode(msg.roomCode);
      if (msg.selectedCategory) applyServerCategories(msg.selectedCategory);
      if (msg.leaderboard) msg.leaderboard.forEach(p => state.playerNames.set(p.id, p.name));
      if (msg.gamePhase === 'playing' || msg.gamePhase === 'paused') {
        showScreen('game');
        if (msg.currentRound) restoreRound(msg.currentRound, msg.gamePhase);
      } else if (msg.gamePhase === 'reveal') {
        showScreen('game');
        if (msg.revealAnswer) showReveal(msg.revealAnswer, msg.revealQuestionId, msg.revealVotes, 3);
      } else {
        buildCategoryChips(); setupLobbyUI(); showScreen('lobby');
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
      if (msg.players) { msg.players.forEach(p => state.playerNames.set(p.id, p.name)); renderPlayerList(lobbyLeaderboard, msg.players, false); }
      if (msg.hostId !== undefined) { const was = state.isHost; state.isHost = (msg.hostId === state.playerId); if (state.isHost !== was) setupLobbyUI(); }
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
      state.roundPaused = true; state.phase = 'paused';
      disableGuessInput('Gra wstrzymana…');
      showGameOverlay('⏸', 'Gra wstrzymana', `przez ${msg.by}`);
      updatePauseButton();
      break;
    }
    case 'game_resumed': {
      state.roundPaused = false; state.phase = 'playing';
      hideGameOverlay();
      if (!state.hasGuessed) enableGuessInput();
      showBanner('Gra wznowiona!', 'info');
      updatePauseButton();
      break;
    }

    case 'correct_guess': {
      state.hasGuessed = true;
      state.myStreak = msg.streak || (state.myStreak + 1);
      disableGuessInput('Już odpowiedziałeś/aś!');
      audio.correct();
      showBanner(`Zgadłeś! +${msg.points} pkt 🎉`, 'success');
      state.playerGuessed.set(state.playerId, true);
      // Confetti burst at guess input position
      const rect = guessInput.getBoundingClientRect();
      confetti.burst(rect.left + rect.width / 2, rect.top);
      // Streak badge
      showStreakBadge(state.myStreak);
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
        if (cur && cur[0] === guess) { state.playerWrongGuesses.set(playerId, []); refreshSideWrongs(); }
      }, 2200);
      break;
    }

    case 'leaderboard': {
      msg.players.forEach(p => state.playerNames.set(p.id, p.name));
      renderPlayerList(gameLeaderboard, msg.players, true);
      break;
    }

    case 'round_end':  { endRound(msg); break; }

    case 'question_votes': {
      if (voteUpCount)   voteUpCount.textContent   = msg.votes.up   || 0;
      if (voteDownCount) voteDownCount.textContent = msg.votes.down || 0;
      break;
    }

    case 'game_over':  { gameOver(msg); break; }

    case 'promoted_to_host': {
      state.isHost = true;
      setupLobbyUI(); updatePauseButton();
      appendChat({ system: true, message: 'Zostałeś/aś hostem gry.' });
      break;
    }

    case 'player_disconnected': {
      state.playerDisconnected.add(msg.playerId);
      appendChat({ system: true, message: `${msg.playerName} stracił(a) połączenie…` });
      refreshDisconnectedMarkers();
      break;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  STREAK BADGE
// ══════════════════════════════════════════════════════════════════════════════
let streakHideTimer = null;

function showStreakBadge(streak) {
  if (streak < 2) { streakBadge.classList.add('hidden'); return; }

  const icons  = ['','','🔥','🔥🔥','⚡','⚡⚡','💥','🌟','👑'];
  const labels = ['','','2 z rzędu!','3 z rzędu!','4 z rzędu!','5 z rzędu!','SERIA x6!','SERIA x7!','MISTRZ! x8+'];
  const i = Math.min(streak, icons.length - 1);

  streakIcon.textContent = icons[i] || '🔥';
  streakText.textContent = labels[i] || `SERIA x${streak}!`;
  streakBadge.classList.remove('hidden');
  // pop animation reset
  streakBadge.style.animation = 'none';
  void streakBadge.offsetWidth;
  streakBadge.style.animation = '';

  clearTimeout(streakHideTimer);
  streakHideTimer = setTimeout(() => streakBadge.classList.add('hidden'), 3000);
}

// ══════════════════════════════════════════════════════════════════════════════
//  GAME OVERLAY (pause)
// ══════════════════════════════════════════════════════════════════════════════
function showGameOverlay(icon, title, sub) {
  gameOverlayIcon.textContent  = icon;
  gameOverlayTitle.textContent = title;
  gameOverlaySub.textContent   = sub || '';
  gameOverlay.classList.remove('hidden');
}
function hideGameOverlay() { gameOverlay.classList.add('hidden'); }

// ══════════════════════════════════════════════════════════════════════════════
//  CATEGORIES
// ══════════════════════════════════════════════════════════════════════════════
function buildCategoryChips() {
  categoryChips.innerHTML = '';
  state.allCategories.forEach(cat => {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'cat-chip';
    chip.dataset.cat = cat; chip.textContent = cat;
    chip.addEventListener('click', () => toggleChip(cat));
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
  categoryChips.querySelectorAll('.cat-chip').forEach(chip =>
    chip.classList.toggle('selected', state.selectedCategories.has(chip.dataset.cat)));
}
function applyServerCategories(label) {
  if (lobbyCategoryDisplay) lobbyCategoryDisplay.textContent = label;
  if (state.isHost && label !== 'Wszystkie') {
    state.selectedCategories = new Set(label.split(',').map(s => s.trim()));
    updateChipVisuals();
  }
}

function setupLobbyUI() {
  hostControls.classList.toggle('hidden', !state.isHost);
  guestControls.classList.toggle('hidden', state.isHost);
}

// ══════════════════════════════════════════════════════════════════════════════
//  CHAT
// ══════════════════════════════════════════════════════════════════════════════
function appendChat(msg) {
  const el = document.createElement('div');
  el.className = 'chat-msg' + (msg.system ? ' sys' : '');
  if (msg.system) el.textContent = msg.message;
  else el.innerHTML = `<span class="cn">${esc(msg.playerName)}</span>: ${esc(msg.message)}`;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ══════════════════════════════════════════════════════════════════════════════
//  PLAYER LIST
// ══════════════════════════════════════════════════════════════════════════════
function renderPlayerList(container, players, showGame) {
  const medals = ['🥇','🥈','🥉'], mClass = ['gold','silver','bronze'];
  container.innerHTML = '';
  players.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'pl-item'
      + (p.id === state.playerId  ? ' me'   : '')
      + (i===0 && showGame        ? ' top1' : '')
      + (state.playerDisconnected.has(p.id) ? ' disconnected' : '');

    const rank   = i<3 ? medals[i] : `${i+1}.`;
    const rc     = i<3 ? mClass[i] : '';
    const guessed = showGame && state.playerGuessed.get(p.id);
    const wrongs  = showGame ? (state.playerWrongGuesses.get(p.id)||[]) : [];

    item.innerHTML = `<div class="pl-main">
      <span class="pl-rank ${rc}">${rank}</span>
      <span class="pl-name">${esc(p.name)}${guessed?'<span class="pl-ok">✓</span>':''}</span>
      <span class="pl-score">${p.score} pkt</span>
    </div>`;

    if (wrongs.length > 0) {
      const row = document.createElement('div'); row.className = 'pl-wrongs';
      wrongs.forEach(g => { const c=document.createElement('span'); c.className='pl-chip'; c.textContent=g; row.appendChild(c); });
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
    const wrongs = state.playerWrongGuesses.get(pid)||[];
    let wrow = item.querySelector('.pl-wrongs');
    if (wrongs.length===0) { if(wrow) wrow.remove(); return; }
    if (!wrow) { wrow=document.createElement('div'); wrow.className='pl-wrongs'; item.appendChild(wrow); }
    wrow.innerHTML='';
    wrongs.forEach(g => { const c=document.createElement('span'); c.className='pl-chip'; c.textContent=g; wrow.appendChild(c); });
  });
}

function refreshDisconnectedMarkers() {
  gameLeaderboard.querySelectorAll('.pl-item').forEach(item => {
    const nameEl = item.querySelector('.pl-name');
    if (!nameEl) return;
    const raw = nameEl.childNodes[0]?.textContent?.trim();
    const pid = getIdByName(raw);
    if (pid) item.classList.toggle('disconnected', state.playerDisconnected.has(pid));
  });
}

function getIdByName(name) {
  for (const [id,n] of state.playerNames) if (n===name) return id;
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  GAME STATS (game over screen)
// ══════════════════════════════════════════════════════════════════════════════
function renderStats(stats, totalRounds) {
  if (!statsGrid || !stats || !stats.length) return;
  statsGrid.innerHTML = '';
  stats.forEach(p => {
    const avgTime = p.roundsGuessed > 0
      ? (p.totalAnswerTime / p.roundsGuessed).toFixed(1)
      : '—';
    const accuracy = totalRounds > 0
      ? Math.round((p.roundsGuessed / totalRounds) * 100)
      : 0;
    const isMe = p.id === state.playerId;

    const card = document.createElement('div');
    card.className = 'stat-card' + (isMe ? ' stat-card--me' : '');
    card.innerHTML = `
      <div class="stat-name">${esc(p.name)}</div>
      <div class="stat-row"><span class="stat-label">Odpowiedzi</span><span class="stat-val">${p.roundsGuessed} / ${totalRounds}</span></div>
      <div class="stat-row"><span class="stat-label">Celność</span><span class="stat-val">${accuracy}%</span></div>
      <div class="stat-row"><span class="stat-label">Śr. czas</span><span class="stat-val">${avgTime}s</span></div>
      <div class="stat-row"><span class="stat-label">Najlepsza seria</span><span class="stat-val">${p.bestStreak > 0 ? '🔥'.repeat(Math.min(p.bestStreak,5)) + ' ' + p.bestStreak : '—'}</span></div>
    `;
    statsGrid.appendChild(card);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROUND LOGIC
// ══════════════════════════════════════════════════════════════════════════════
function startRound(msg) {
  state.hasGuessed = false; state.roundPaused = false;
  state.playerWrongGuesses.clear(); state.playerGuessed.clear();
  state.playerDisconnected.clear();
  state.timeLeft = msg.timeLeft;
  state.currentQuestionId = msg.questionId;
  state.hasVoted = false;

  showScreen('game'); state.phase = 'playing';
  hideGameOverlay(); streakBadge.classList.add('hidden');

  roundLabel.textContent    = `Runda ${msg.roundNumber}`;
  categoryLabel.textContent = msg.category || '';

  if (msg.questionType==='image' && msg.imageUrl) {
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
  enableGuessInput(); guessInput.value = ''; guessInput.focus();
  updateTimer(msg.timeLeft); updatePauseButton();
}

function restoreRound(r, phase) {
  state.timeLeft = r.timeLeft;
  state.currentQuestionId = r.questionId;
  roundLabel.textContent    = `Runda ${r.roundNumber}`;
  categoryLabel.textContent = r.category || '';
  if (r.questionType==='image' && r.imageUrl) {
    questionImageWrap.classList.remove('hidden'); questionImage.src = r.imageUrl;
    questionText.textContent = r.questionText || 'Co to?';
  } else {
    questionImageWrap.classList.add('hidden'); questionImage.src = '';
    questionText.textContent = r.questionText || '';
  }
  revealCard.classList.add('hidden'); statusBanner.classList.add('hidden');
  guessWrap.style.display = '';
  if (state.hasGuessed || phase==='paused') disableGuessInput(state.hasGuessed ? 'Już odpowiedziałeś/aś!' : 'Gra wstrzymana…');
  else { enableGuessInput(); guessInput.focus(); }
  updateTimer(r.timeLeft); updatePauseButton();
  if (phase==='paused') showGameOverlay('⏸','Gra wstrzymana','przez hosta');
  else hideGameOverlay();
}

function updateTimer(t) {
  state.timeLeft = t;
  timerDisplay.textContent = t;
  const pct = (t / state.roundDuration) * 100;
  timerBar.style.width = `${pct}%`;
  if (t > 15) {
    timerBar.style.backgroundColor = 'var(--accent)'; timerDisplay.className = 'timer-display';
  } else if (t > 8) {
    timerBar.style.backgroundColor = 'var(--warning)'; timerDisplay.className = 'timer-display warn';
  } else {
    timerBar.style.backgroundColor = 'var(--accent3)'; timerDisplay.className = 'timer-display danger';
    if (t > 0 && t <= 5 && !state.hasGuessed && !state.roundPaused) audio.tick(t);
  }
}

function showBanner(text, type) {
  statusBanner.textContent = text;
  statusBanner.className = `status-banner ${type}`;
  statusBanner.classList.remove('hidden');
  clearTimeout(statusBanner._t);
  statusBanner._t = setTimeout(() => statusBanner.classList.add('hidden'), 3200);
}
function enableGuessInput()  { guessInput.disabled=false; guessBtn.disabled=false; guessInput.placeholder='Wpisz odpowiedź…'; }
function disableGuessInput(ph) { guessInput.disabled=true; guessBtn.disabled=true; guessInput.placeholder=ph||'Już odpowiedziałeś/aś!'; }

function showReveal(answer, questionId, votes, countdownSec) {
  state.phase = 'reveal';
  disableGuessInput('Runda zakończona!');
  guessWrap.style.display = 'none';
  hideGameOverlay();
  revealAnswer.textContent = answer;
  revealCard.classList.remove('hidden');
  state.hasVoted = false;
  state.currentQuestionId = questionId;
  voteDisabledBadge.classList.add('hidden');
  voteUpCount.textContent   = votes?.up   || 0;
  voteDownCount.textContent = votes?.down || 0;
  voteUp.classList.remove('voted'); voteDown.classList.remove('voted');
  voteUp.disabled = false; voteDown.disabled = false;
  let cd = countdownSec || 5;
  revealCountdown.textContent = cd;
  if (state.revealCountdown) clearInterval(state.revealCountdown);
  state.revealCountdown = setInterval(() => {
    cd--; revealCountdown.textContent = cd;
    if (cd<=0) { clearInterval(state.revealCountdown); state.revealCountdown=null; }
  }, 1000);
}

function endRound(msg) {
  showReveal(msg.answer, msg.questionId, msg.votes, msg.nextRoundIn);
  updatePauseButton();
  if (msg.leaderboard) { msg.leaderboard.forEach(p => state.playerNames.set(p.id,p.name)); renderPlayerList(gameLeaderboard, msg.leaderboard, false); }
}

function gameOver(msg) {
  if (state.revealCountdown) clearInterval(state.revealCountdown);
  state.phase = 'gameover'; state.roundPaused = false; state.myStreak = 0;
  updatePauseButton();
  if (msg.leaderboard) { msg.leaderboard.forEach(p => state.playerNames.set(p.id,p.name)); renderPlayerList(gameoverLeaderboard, msg.leaderboard, false); }
  // Stats
  if (msg.stats) renderStats(msg.stats, msg.totalRounds || 0);
  // Winner confetti
  confetti.celebrate();
  showScreen('gameover');
  setTimeout(() => {
    showScreen('lobby'); setupLobbyUI();
    state.playerWrongGuesses.clear(); state.playerGuessed.clear(); state.playerDisconnected.clear();
  }, 10000);
}

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function showLoginError(msg) { loginError.textContent=msg; loginError.classList.remove('hidden'); }
function updatePauseButton() {
  if (!pauseBtn) return;
  const show = state.isHost && (state.phase==='playing'||state.phase==='paused');
  pauseBtn.classList.toggle('hidden', !show);
  pauseBtn.textContent = state.roundPaused ? '▶ Wznów' : '⏸ Wstrzymaj';
  if (overlayResumeBtn) overlayResumeBtn.classList.toggle('hidden', !state.isHost);
}

// ══════════════════════════════════════════════════════════════════════════════
//  EVENTS
// ══════════════════════════════════════════════════════════════════════════════
joinBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  if (!name) { showLoginError('Wpisz pseudonim!'); return; }
  loginError.classList.add('hidden');
  loginSpinner.classList.remove('hidden');
  joinBtn.disabled = true;
  const savedToken = localStorage.getItem(LS_TOKEN);
  const savedName  = localStorage.getItem(LS_NAME);
  const useToken   = savedToken && savedName && savedName.toLowerCase()===name.toLowerCase() ? savedToken : null;
  state.savedName  = name;
  connectWS(name, useToken);
});
usernameInput.addEventListener('keydown', e => { if (e.key==='Enter') joinBtn.click(); });

startBtn.addEventListener('click', () => { if (state.isHost) wsSend({ type:'start_game' }); });
pauseBtn.addEventListener('click', () => { if (state.isHost) wsSend({ type:'toggle_pause' }); });
if (overlayResumeBtn) overlayResumeBtn.addEventListener('click', () => { if (state.isHost && state.roundPaused) wsSend({ type:'toggle_pause' }); });

guessBtn.addEventListener('click', submitGuess);
guessInput.addEventListener('keydown', e => { if (e.key==='Enter') submitGuess(); });
function submitGuess() {
  if (state.hasGuessed || state.phase!=='playing' || state.roundPaused) return;
  const guess = guessInput.value.trim(); if (!guess) return;
  wsSend({ type:'guess', guess }); guessInput.value=''; guessInput.focus();
}

chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key==='Enter') sendChat(); });
function sendChat() {
  const text = chatInput.value.trim(); if (!text) return;
  wsSend({ type:'chat', text }); chatInput.value='';
}

voteUp.addEventListener('click',   () => submitVote('up'));
voteDown.addEventListener('click', () => submitVote('down'));
function submitVote(dir) {
  if (state.hasVoted || state.phase!=='reveal' || !state.currentQuestionId) return;
  state.hasVoted = true;
  voteUp.classList.toggle('voted',   dir==='up');
  voteDown.classList.toggle('voted', dir==='down');
  voteUp.disabled = voteDown.disabled = true;
  wsSend({ type:'vote_question', questionId:state.currentQuestionId, vote:dir });
}

reconnectCancel.addEventListener('click', () => {
  clearReconnectTimer();
  localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_NAME); localStorage.removeItem(LS_PID);
  state.token=null; state.savedName=null;
  loginSpinner.classList.add('hidden'); joinBtn.disabled=false;
  showScreen('login');
});
