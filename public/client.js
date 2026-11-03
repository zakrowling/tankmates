(() => {
  const socket = window.TankmatesNet.createNet();

  const KEY_TO_CONTROL = {
    ArrowUp: 'forward', w: 'forward', W: 'forward',
    ArrowDown: 'back', s: 'back', S: 'back',
    ArrowLeft: 'left', a: 'left', A: 'left',
    ArrowRight: 'right', d: 'right', D: 'right',
    ' ': 'fire', Enter: 'fire',
  };
  const FIELD_COLOR = '#2d4a1c';
  const WALL_COLOR = '#a97d5d'; // RetroTanks wall colour

  const $ = (id) => document.getElementById(id);
  const canvas = $('game-canvas');
  const ctx = canvas.getContext('2d');

  const state = {
    playerId: null,
    hostId: null,
    linkRoom: false, // entered via a link like /tankmates/mate: no room code UI
    lobbyPlayers: [],
    arena: null,
    fieldLayer: null,
    tickMs: 1000 / 30,
    ticksLeft: 0,
    winScore: 10,
    prevPlayers: new Map(),
    currPlayers: new Map(),
    prevBullets: new Map(),
    currBullets: new Map(),
    blasts: [],
    lastSnapshotAt: 0,
    playing: false,
    rafId: null,
    controls: { forward: false, back: false, left: false, right: false, fire: false },
  };

  // ---------- Synthesized sound ----------

  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  // Browsers only allow audio after a user gesture.
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, getAudioCtx, { once: true }));

  function tone(ac, { type = 'square', from, to = from, start = 0, dur, vol = 0.08 }) {
    const t0 = ac.currentTime + start;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(ac, { dur, vol = 0.15, from = 1200, to = 80 }) {
    const t0 = ac.currentTime;
    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(from, t0);
    filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(ac.destination);
    src.start(t0);
  }

  const SYNTH = {
    fire(ac) {
      noise(ac, { dur: 0.12, vol: 0.12, from: 3000, to: 400 });
      tone(ac, { from: 220, to: 90, dur: 0.1, vol: 0.05 });
    },
    hit(ac) {
      noise(ac, { dur: 0.7, vol: 0.25, from: 900, to: 40 });
    },
    hitMe(ac) {
      noise(ac, { dur: 0.9, vol: 0.3, from: 700, to: 30 });
      tone(ac, { type: 'sawtooth', from: 300, to: 40, dur: 0.8, vol: 0.06 });
    },
    score(ac) {
      [660, 880].forEach((f, i) => tone(ac, { from: f, start: i * 0.08, dur: 0.08, vol: 0.06 }));
    },
    start(ac) {
      [196, 262, 330, 392, 523].forEach((f, i) => tone(ac, { from: f, start: i * 0.1, dur: 0.09, vol: 0.06 }));
    },
    end(ac) {
      [523, 392, 330, 262].forEach((f, i) => tone(ac, { type: 'triangle', from: f, start: i * 0.18, dur: 0.17, vol: 0.1 }));
    },
  };

  function playSound(key) {
    const ac = getAudioCtx();
    if (ac && SYNTH[key]) SYNTH[key](ac);
  }

  // ---------- Drawing helpers ----------

  // ---------- Pixel-art tank sprites ----------

  // Sprites are drawn facing up on a 16x22 pixel grid, then rotated to the tank's heading.
  const SPRITE_W = 16;
  const SPRITE_H = 22;
  const PX = 2; // screen pixels per sprite pixel
  const HULL_CENTRE_Y = 13.5; // sprite row the tank pivots around (centre of the hull and tracks)
  const spriteCache = new Map();

  // Mixes a #rrggbb colour towards black (amt < 0) or white (amt > 0).
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const target = amt < 0 ? 0 : 255;
    const p = Math.abs(amt);
    const mix = (v) => Math.round(v + (target - v) * p);
    return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
  }

  function buildTankSprite(color) {
    const c = document.createElement('canvas');
    c.width = SPRITE_W * PX;
    c.height = SPRITE_H * PX;
    const g = c.getContext('2d');
    const P = {
      outline: shade(color, -0.72),
      track: shade(color, -0.6),
      tread: shade(color, -0.38),
      shadow: shade(color, -0.25),
      mid: color,
      light: shade(color, 0.28),
      hi: shade(color, 0.55),
    };
    const px = (x, y, col) => {
      g.fillStyle = col;
      g.fillRect(x * PX, y * PX, PX, PX);
    };

    // Tracks: 3 wide on each side with a checkered tread pattern.
    for (let y = 6; y <= 21; y++) {
      for (const x0 of [0, 13]) {
        for (let x = x0; x < x0 + 3; x++) {
          const edge = x === x0 || x === x0 + 2;
          px(x, y, (y + (edge ? 0 : 1)) % 2 ? P.tread : P.track);
        }
      }
    }

    // Hull: dark outline, lit top/left rim, shaded bottom/right rim.
    for (let y = 7; y <= 20; y++) {
      for (let x = 3; x <= 12; x++) {
        let col = P.mid;
        if (x === 3 || x === 12 || y === 7 || y === 20) col = P.outline;
        else if (x === 4 || y === 8) col = P.light;
        else if (x === 11 || y === 19) col = P.shadow;
        px(x, y, col);
      }
    }
    // Inner panel lines and an engine grille at the back.
    for (let y = 10; y <= 17; y++) { px(5, y, P.shadow); px(10, y, P.shadow); }
    for (let x = 6; x <= 9; x += 1) px(x, 18, x % 2 ? P.outline : P.shadow);

    // Turret: shaded dome with a highlight and a hatch.
    const tcx = 8;
    const tcy = 13;
    for (let y = 8; y <= 18; y++) {
      for (let x = 3; x <= 12; x++) {
        const d = Math.hypot(x + 0.5 - tcx, y + 0.5 - tcy);
        if (d > 3.7) continue;
        let col = P.light;
        if (d > 2.9) col = P.outline;
        else if (x + y <= tcx + tcy - 3) col = P.hi;
        else if (x + y >= tcx + tcy + 2) col = P.shadow;
        px(x, y, col);
      }
    }
    px(8, 13, P.outline);
    px(7, 14, P.shadow);
    px(8, 14, P.shadow);

    // Barrel with a muzzle brake at the tip.
    for (let y = 2; y <= 10; y++) {
      px(6, y, P.outline);
      px(7, y, P.hi);
      px(8, y, P.light);
      px(9, y, P.outline);
    }
    for (let x = 6; x <= 9; x++) px(x, 0, P.outline);
    px(6, 1, P.outline);
    px(7, 1, P.light);
    px(8, 1, P.mid);
    px(9, 1, P.outline);
    return c;
  }

  function tankSprite(color) {
    if (!spriteCache.has(color)) spriteCache.set(color, buildTankSprite(color));
    return spriteCache.get(color);
  }

  // Draws a tank centred on its hull; angle 0 points right (the sprite is drawn facing up).
  function drawTank(c, p, cx, cy, angleDeg, scale = 1) {
    const sprite = tankSprite(p.color);
    c.save();
    c.translate(cx, cy);
    c.rotate(((angleDeg + 90) * Math.PI) / 180);
    c.scale(scale, scale);
    c.imageSmoothingEnabled = false; // keep the pixel art crisp
    c.drawImage(sprite, -(SPRITE_W * PX) / 2, -HULL_CENTRE_Y * PX);
    c.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  // ---------- Lobby UI ----------

  function showError(msg) {
    $('error-msg').textContent = msg || '';
  }

  function playerLabel(p) {
    return `${p.name}${p.id === state.playerId ? ' (YOU)' : ''}`;
  }

  const PREVIEW_PLAYER = { id: 'preview', number: 1, name: '', color: '#cf5353' };

  function buildSlots() {
    $('slots').replaceChildren(...[1, 2, 3, 4].map((n) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.innerHTML = `<span class="slot-num">P${n}</span><canvas width="64" height="64"></canvas>`
        + '<span class="slot-name"></span><span class="slot-tag"></span>';
      return slot;
    }));
  }

  function slotPlayers() {
    if (!state.playerId) return [PREVIEW_PLAYER];
    return state.lobbyPlayers;
  }

  function renderSlots() {
    const players = slotPlayers();
    [...$('slots').children].forEach((slot, i) => {
      const p = players.find((pl) => pl.number === i + 1);
      const isYou = p && (p.id === state.playerId || p === PREVIEW_PLAYER);
      slot.classList.toggle('filled', !!p);
      slot.classList.toggle('you', !!isYou);
      slot.style.color = p ? p.color : '';
      slot.style.borderColor = p ? p.color : '';
      slot.querySelector('.slot-name').textContent = p ? (p.name || 'YOU') : 'EMPTY';
      let tag = '';
      if (p && p !== PREVIEW_PLAYER) {
        tag = [isYou && '(YOU)', !state.linkRoom && p.id === state.hostId && 'HOST'].filter(Boolean).join(' ');
      }
      slot.querySelector('.slot-tag').textContent = tag;
    });
  }

  function animateSlots(now) {
    requestAnimationFrame(animateSlots);
    if ($('lobby-card').style.display === 'none') return;
    const players = slotPlayers();
    [...$('slots').children].forEach((slot, i) => {
      const c = slot.querySelector('canvas').getContext('2d');
      c.clearRect(0, 0, 64, 64);
      const p = players.find((pl) => pl.number === i + 1);
      if (p) {
        // Each tank slowly turns its turret around, like it's scanning for targets.
        drawTank(c, p, 32, 32, ((now / 25) + i * 90) % 360, 1.15);
      } else {
        c.strokeStyle = '#3a3a2a';
        c.setLineDash([4, 4]);
        c.strokeRect(14, 14, 36, 36);
        c.setLineDash([]);
      }
    });
  }

  function renderPlayerList(ul, players, rightText) {
    ul.replaceChildren(...players.map((p) => {
      const li = document.createElement('li');
      li.className = 'player-item';
      li.style.background = `${p.color}22`;
      li.style.color = p.color;
      const name = document.createElement('span');
      name.textContent = playerLabel(p);
      const right = document.createElement('span');
      right.textContent = rightText(p);
      li.append(name, right);
      return li;
    }));
  }

  function applyLobby(payload) {
    state.hostId = payload.hostId;
    state.lobbyPlayers = payload.players;
    $('setup-view').style.display = 'none';
    $('room-view').style.display = 'block';
    $('room-code-txt').textContent = payload.roomCode;
    $('lobby-card').classList.toggle('link-room', state.linkRoom);
    renderSlots();
    // Any player can start.
    const count = payload.players.length;
    $('start-btn').textContent = `Start game with ${count} player${count === 1 ? '' : 's'}`;
    $('start-btn').style.display = 'block';
    $('room-code-txt').classList.toggle('long', payload.roomCode.length > 6);
    $('share-link').value = shareLink(payload.roomCode);
    history.replaceState(null, '', `${basePath()}?room=${encodeURIComponent(payload.roomCode.toLowerCase())}`);
  }

  function showLobby() {
    state.playing = false;
    releaseControls();
    $('game-view').style.display = 'none';
    $('game-over').style.display = 'none';
    $('lobby-card').style.display = 'block';
    document.body.classList.remove('in-game');
  }

  // Directory the game is served from, e.g. "/tankmates/" on GitHub Pages or "/" locally.
  function basePath() {
    return location.pathname.replace(/[^/]*$/, '');
  }

  function shareLink(roomCode) {
    return `${location.origin}${basePath()}${roomCode.toLowerCase()}`;
  }

  function resetToSetup() {
    history.replaceState(null, '', basePath());
    state.linkRoom = false;
    $('lobby-card').classList.remove('link-room');
    state.playerId = null;
    state.hostId = null;
    state.lobbyPlayers = [];
    renderSlots();
    $('room-view').style.display = 'none';
    $('setup-view').style.display = 'block';
    showLobby();
  }

  function setConnecting(connecting) {
    $('create-btn').disabled = connecting;
    $('join-btn').disabled = connecting;
    if (connecting) showError('');
    $('connecting-hint').textContent = 'Connecting...';
    $('connecting-hint').style.display = connecting ? 'block' : 'none';
  }

  function handleJoinResponse(res) {
    setConnecting(false);
    if (!res.ok) {
      if (state.linkRoom || $('room-view').style.display === 'block') resetToSetup();
      return showError(res.error);
    }
    showError('');
    state.playerId = res.playerId;
    applyLobby(res);
  }

  $('create-btn').addEventListener('click', () => {
    setConnecting(true);
    socket.emit('createRoom', handleJoinResponse);
  });
  $('join-btn').addEventListener('click', () => {
    const code = $('room-input').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return showError('Enter a 4-letter room code.');
    setConnecting(true);
    socket.emit('joinRoom', code, handleJoinResponse);
  });
  $('room-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('join-btn').click();
  });
  $('start-btn').addEventListener('click', () => socket.emit('startGame'));
  $('again-btn').addEventListener('click', () => socket.emit('startGame'));
  $('leave-btn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    resetToSetup();
  });
  $('exit-btn').addEventListener('click', showLobby);
  // Link rooms: leave and go back to the home screen to create or join a different room.
  $('home-btn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    resetToSetup();
  });

  socket.on('lobbyUpdate', applyLobby);
  socket.on('disconnect', (reason) => {
    resetToSetup();
    showError(reason || 'Disconnected.');
  });
  // Progress through connection steps, so a stuck step is visible instead of a bare "Connecting...".
  socket.on('status', (text) => {
    if ($('connecting-hint').style.display === 'block') $('connecting-hint').textContent = text;
    if ($('reconnect-hint').style.display === 'block') $('reconnect-hint').textContent = text;
  });
  socket.on('reconnecting', (message) => {
    showLobby();
    $('start-btn').style.display = 'none';
    showError('');
    $('reconnect-hint').textContent = message;
    $('reconnect-hint').style.display = 'block';
  });
  socket.on('rejoined', (res) => {
    $('reconnect-hint').style.display = 'none';
    handleJoinResponse(res);
  });

  $('copy-btn').addEventListener('click', async () => {
    const input = $('share-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    $('copy-btn').textContent = 'Copied!';
    setTimeout(() => { $('copy-btn').textContent = 'Copy'; }, 1500);
  });

  // Links like /tankmates/mate (or ?room=mate) open that room: join it if someone is hosting, otherwise host it.
  function enterRoomFromUrl() {
    const requested = new URLSearchParams(location.search).get('room');
    if (!requested) return;
    if (!window.TankmatesNet.normaliseRoomName(requested)) {
      history.replaceState(null, '', basePath());
      return showError('Room names are 2-16 letters, numbers or dashes.');
    }
    state.linkRoom = true;
    $('lobby-card').classList.add('link-room');
    setConnecting(true);
    socket.emit('enterRoom', requested, handleJoinResponse);
  }

  // ---------- Game ----------

  function buildFieldLayer(arena) {
    const layer = document.createElement('canvas');
    layer.width = arena.width;
    layer.height = arena.height;
    const lctx = layer.getContext('2d');
    lctx.fillStyle = FIELD_COLOR;
    lctx.fillRect(0, 0, arena.width, arena.height);
    lctx.fillStyle = WALL_COLOR;
    lctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    lctx.shadowBlur = 10;
    // One path for all wall cells so touching blocks merge into solid walls without seams.
    lctx.beginPath();
    for (let y = 0; y < arena.rows; y++) {
      for (let x = 0; x < arena.cols; x++) {
        if (arena.walls[y][x] === 1) lctx.rect(x * arena.cell, y * arena.cell, arena.cell, arena.cell);
      }
    }
    lctx.fill('nonzero');
    return layer;
  }

  // One panel per spawn corner; a player's panel is chosen by their player number.
  function updateScoreboard(players) {
    document.querySelectorAll('.score-tag[data-slot]').forEach((tag) => {
      const p = players.find((pl) => pl.number === Number(tag.dataset.slot));
      tag.classList.toggle('empty', !p);
      if (!p) return;
      tag.style.color = p.color;
      if (!tag.firstChild) tag.innerHTML = '<span class="tag-name"></span><span class="tag-score"></span>';
      tag.querySelector('.tag-name').textContent = playerLabel(p);
      tag.querySelector('.tag-score').textContent = p.score;
    });
  }

  socket.on('gameStarted', (payload) => {
    applyLobby(payload);
    state.arena = payload.arena;
    state.tickMs = 1000 / payload.tickRate;
    state.ticksLeft = payload.ticksLeft;
    state.winScore = payload.winScore;
    state.fieldLayer = buildFieldLayer(payload.arena);
    canvas.width = payload.arena.width;
    canvas.height = payload.arena.height;
    document.querySelectorAll('.hud').forEach((hud) => { hud.style.maxWidth = `${canvas.width}px`; });
    $('win-score').textContent = payload.winScore;

    const players = new Map(payload.players.map((p) => [p.id, p]));
    state.prevPlayers = players;
    state.currPlayers = players;
    const bullets = new Map(payload.bullets.map((b) => [b.id, b]));
    state.prevBullets = bullets;
    state.currBullets = bullets;
    state.blasts = [];
    state.lastSnapshotAt = performance.now();
    state.playing = true;

    $('lobby-card').style.display = 'none';
    $('game-over').style.display = 'none';
    $('game-view').style.display = 'flex';
    document.body.classList.add('in-game');
    updateScoreboard(payload.players);
    playSound('start');

    if (!state.rafId) state.rafId = requestAnimationFrame(render);
  });

  socket.on('state', (snapshot) => {
    if (!state.arena) return;
    state.prevPlayers = state.currPlayers;
    state.currPlayers = new Map(snapshot.players.map((p) => [p.id, p]));
    state.prevBullets = state.currBullets;
    state.currBullets = new Map(snapshot.bullets.map((b) => [b.id, b]));
    state.ticksLeft = snapshot.ticksLeft;
    const now = performance.now();
    state.lastSnapshotAt = now;

    snapshot.events.forEach((ev) => {
      if (ev.type === 'fire') {
        playSound('fire');
      } else if (ev.type === 'hit') {
        state.blasts.push({ x: ev.x, y: ev.y, start: now, big: true });
        playSound(ev.id === state.playerId ? 'hitMe' : 'hit');
        if (ev.by === state.playerId) playSound('score');
      } else if (ev.type === 'impact') {
        state.blasts.push({ x: ev.x, y: ev.y, start: now, big: false });
      }
    });
    updateScoreboard(snapshot.players);
  });

  socket.on('gameOver', ({ standings, reason, winnerId }) => {
    state.playing = false;
    releaseControls();
    const winner = standings.find((p) => p.id === winnerId);
    let title = 'TIME UP!';
    if (reason === 'win' && winner) title = winner.id === state.playerId ? 'YOU WIN!' : `${winner.name} WINS!`;
    $('game-over-title').textContent = title;
    renderPlayerList($('standings'), standings, (p) => `${p.score}`);
    $('game-over').style.display = 'block';
    playSound('end');
  });

  // ---------- Controls ----------

  function sendControls() {
    socket.emit('input', { ...state.controls });
  }

  function setControl(name, down) {
    if (state.controls[name] === down) return;
    state.controls[name] = down;
    sendControls();
  }

  function releaseControls() {
    const anyDown = Object.values(state.controls).some(Boolean);
    Object.keys(state.controls).forEach((k) => { state.controls[k] = false; });
    if (anyDown && state.playing) sendControls();
  }

  window.addEventListener('keydown', (e) => {
    if (!state.playing) return;
    const control = KEY_TO_CONTROL[e.key];
    if (e.key === 'x' || e.key === 'X') {
      document.body.classList.toggle('scanlines');
      return;
    }
    if (!control) return;
    e.preventDefault();
    setControl(control, true);
  });
  window.addEventListener('keyup', (e) => {
    const control = KEY_TO_CONTROL[e.key];
    if (!control) return;
    if (state.playing) e.preventDefault();
    setControl(control, false);
  });
  // Don't leave a tank driving forever if the window loses focus mid-keypress.
  window.addEventListener('blur', releaseControls);

  // ---------- Render ----------

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpAngle(a, b, t) {
    let d = ((b - a + 540) % 360) - 180;
    return a + d * t;
  }

  function drawNameBubble(p, cx, top) {
    ctx.font = '7px "Press Start 2P", monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const w = ctx.measureText(p.name).width + 14;
    const h = 16;
    const x = Math.max(1, Math.min(canvas.width - w - 1, cx - w / 2));
    const y = Math.max(1, top - h - 2);
    // Your own bubble is yellow with black text so you can spot yourself; everyone else's is black.
    const isYou = p.id === state.playerId;
    ctx.fillStyle = isYou ? '#ffe600' : 'rgba(0, 0, 0, 0.85)';
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = isYou ? '#000' : '#fff';
    ctx.fillText(p.name, x + w / 2, y + h / 2 + 1);
  }

  function drawBlasts(now) {
    state.blasts = state.blasts.filter((b) => now - b.start < (b.big ? 500 : 200));
    state.blasts.forEach((b) => {
      const t = (now - b.start) / (b.big ? 500 : 200);
      const r = (b.big ? 26 : 8) * (0.4 + t);
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = b.big ? '#ffb347' : '#ffffff';
      ctx.shadowColor = '#ff6a00';
      ctx.shadowBlur = b.big ? 20 : 6;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  function drawTimer() {
    const secs = Math.max(0, Math.ceil(state.ticksLeft * state.tickMs / 1000));
    const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    ctx.font = '10px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = secs <= 10 ? '#ff5555' : '#f5e6c8';
    ctx.fillText(text, canvas.width / 2, state.arena.cell / 2 + 1);
  }

  // The host runs the game; everyone else interpolates between the last two snapshots.
  function render(now) {
    state.rafId = requestAnimationFrame(render);
    if (!state.arena || $('game-view').style.display === 'none') return;

    const alpha = Math.min(1, (now - state.lastSnapshotAt) / state.tickMs);
    ctx.drawImage(state.fieldLayer, 0, 0);
    drawTimer();

    state.currBullets.forEach((b) => {
      const prev = state.prevBullets.get(b.id) || b;
      const x = lerp(prev.x, b.x, alpha);
      const y = lerp(prev.y, b.y, alpha);
      ctx.save();
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
      ctx.restore();
    });

    const positions = [];
    state.currPlayers.forEach((p) => {
      const prev = state.prevPlayers.get(p.id) || p;
      const jump = Math.hypot(prev.x - p.x, prev.y - p.y) > 40; // respawned
      const x = jump ? p.x : lerp(prev.x, p.x, alpha);
      const y = jump ? p.y : lerp(prev.y, p.y, alpha);
      const angle = jump ? p.angle : lerpAngle(prev.angle, p.angle, alpha);
      // Flicker while protected after respawning; dim while spinning out after a hit.
      ctx.globalAlpha = (p.invulnerable && Math.floor(now / 100) % 2) ? 0.35 : p.status === 'hit' ? 0.7 : 1;
      drawTank(ctx, p, x, y, angle);
      ctx.globalAlpha = 1;
      positions.push([p, x, y]);
    });

    drawBlasts(now);
    // Bubbles go on top so a tank never covers another player's name.
    positions.forEach(([p, x, y]) => drawNameBubble(p, x, y - 16));
  }

  buildSlots();
  renderSlots();
  requestAnimationFrame(animateSlots);
  enterRoomFromUrl();
})();
