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

  // ---------- Sound (all synthesized with Web Audio) ----------

  let audioCtx = null;
  let master = null;
  let noiseBuffer = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
      // A gentle compressor keeps stacked explosions punchy without clipping.
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      master = audioCtx.createGain();
      master.gain.value = 0.9;
      master.connect(comp).connect(audioCtx.destination);
      noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  // Browsers only allow audio after a user gesture.
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, getAudioCtx, { once: true }));

  // Sounds further from your tank are quieter and panned left/right by where they happen.
  function spatial(ac, x, y) {
    const out = ac.createGain();
    const me = state.currPlayers.get(state.playerId);
    let vol = 1;
    let pan = 0;
    if (state.arena && x !== undefined) {
      pan = Math.max(-1, Math.min(1, (x / state.arena.width) * 2 - 1)) * 0.7;
      if (me) vol = Math.max(0.25, 1 - Math.hypot(me.x - x, me.y - y) / (state.arena.width * 0.9));
    }
    out.gain.value = vol;
    if (ac.createStereoPanner) {
      const panner = ac.createStereoPanner();
      panner.pan.value = pan;
      out.connect(panner).connect(master);
    } else {
      out.connect(master);
    }
    return out;
  }

  function envGain(ac, dest, t0, peak, attack, decay) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    g.connect(dest);
    return g;
  }

  function osc(ac, dest, { type = 'sine', from, to = from, t0, dur, peak, attack = 0.005 }) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t0);
    o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    o.connect(envGain(ac, dest, t0, peak, attack, dur));
    o.start(t0);
    o.stop(t0 + attack + dur + 0.05);
  }

  function noiseBurst(ac, dest, { t0, dur, peak, type = 'lowpass', from, to = from, q = 0.7, attack = 0.003 }) {
    const src = ac.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const filter = ac.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t0);
    filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    src.connect(filter).connect(envGain(ac, dest, t0, peak, attack, dur));
    src.start(t0, Math.random());
    src.stop(t0 + attack + dur + 0.05);
  }

  const SFX = {
    // Tank cannon: sharp crack, a low thump and a short tail.
    fire(ac, out) {
      const t = ac.currentTime;
      noiseBurst(ac, out, { t0: t, dur: 0.08, peak: 0.5, type: 'highpass', from: 2500, to: 800 });
      osc(ac, out, { from: 140, to: 45, t0: t, dur: 0.22, peak: 0.6 });
      noiseBurst(ac, out, { t0: t + 0.02, dur: 0.35, peak: 0.25, from: 1800, to: 120 });
    },
    // Shell hitting a wall: dull thud and a sprinkle of debris.
    impact(ac, out) {
      const t = ac.currentTime;
      osc(ac, out, { from: 180, to: 60, t0: t, dur: 0.12, peak: 0.3 });
      noiseBurst(ac, out, { t0: t, dur: 0.18, peak: 0.25, type: 'bandpass', from: 1400, to: 500, q: 1.2 });
      for (let i = 0; i < 4; i++) {
        noiseBurst(ac, out, { t0: t + 0.05 + Math.random() * 0.15, dur: 0.03, peak: 0.06, type: 'highpass', from: 3000 });
      }
    },
    // Tank destroyed: big boom, sub-bass rumble and crackling debris.
    explosion(ac, out, big = 1) {
      const t = ac.currentTime;
      noiseBurst(ac, out, { t0: t, dur: 1.2 * big, peak: 0.9, from: 2200, to: 60, attack: 0.008 });
      osc(ac, out, { from: 90, to: 28, t0: t, dur: 0.9 * big, peak: 0.9, attack: 0.01 });
      osc(ac, out, { type: 'triangle', from: 60, to: 30, t0: t + 0.05, dur: 1.1 * big, peak: 0.5 });
      for (let i = 0; i < 10; i++) {
        noiseBurst(ac, out, {
          t0: t + 0.1 + Math.random() * 0.9, dur: 0.04 + Math.random() * 0.06, peak: 0.08 + Math.random() * 0.08,
          type: 'bandpass', from: 1500 + Math.random() * 2500, q: 2,
        });
      }
    },
    flagTaken(ac, out) {
      const t = ac.currentTime;
      [523, 659, 784, 1047].forEach((f, i) => osc(ac, out, { type: 'square', from: f, t0: t + i * 0.08, dur: 0.1, peak: 0.08 }));
    },
    flagLost(ac, out) {
      const t = ac.currentTime;
      [659, 523, 392].forEach((f, i) => osc(ac, out, { type: 'square', from: f, t0: t + i * 0.1, dur: 0.12, peak: 0.07 }));
    },
    flagRespawn(ac, out) {
      osc(ac, out, { type: 'triangle', from: 880, to: 1320, t0: ac.currentTime, dur: 0.25, peak: 0.08 });
    },
    // Military bugle-style call to start.
    start(ac, out) {
      const t = ac.currentTime;
      [392, 523, 659, 784, 659, 784].forEach((f, i) => osc(ac, out, { type: 'square', from: f, t0: t + i * 0.13, dur: 0.12, peak: 0.07 }));
    },
    end(ac, out) {
      const t = ac.currentTime;
      [784, 659, 523, 392].forEach((f, i) => osc(ac, out, { type: 'triangle', from: f, t0: t + i * 0.2, dur: 0.18, peak: 0.12 }));
    },
  };

  function playSound(key, x, y, arg) {
    const ac = getAudioCtx();
    if (!ac || !SFX[key]) return;
    SFX[key](ac, spatial(ac, x, y), arg);
  }

  // Your own tank's engine: a continuous diesel rumble that revs and clanks while you drive.
  const engine = {
    nodes: null,
    start() {
      const ac = getAudioCtx();
      if (!ac || this.nodes) return;
      const out = ac.createGain();
      out.gain.value = 0.0001;
      out.connect(master);
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 300;
      lp.connect(out);
      const saw = ac.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.value = 38;
      const sub = ac.createOscillator();
      sub.type = 'square';
      sub.frequency.value = 19;
      const subGain = ac.createGain();
      subGain.gain.value = 0.4;
      saw.connect(lp);
      sub.connect(subGain).connect(lp);
      // Track clatter: filtered noise pulsed by a low-frequency oscillator.
      const clank = ac.createBufferSource();
      clank.buffer = noiseBuffer;
      clank.loop = true;
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 3;
      const clankGain = ac.createGain();
      clankGain.gain.value = 0;
      const lfo = ac.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 9;
      const lfoGain = ac.createGain();
      lfoGain.gain.value = 0.05;
      lfo.connect(lfoGain).connect(clankGain.gain);
      clank.connect(bp).connect(clankGain).connect(out);
      [saw, sub, clank, lfo].forEach((n) => n.start());
      this.nodes = { out, saw, sub, clank, lfo, lp, lfoGain };
    },
    update(moving, alive) {
      if (!this.nodes) return;
      const t = audioCtx.currentTime;
      const { out, saw, sub, lp, lfo, lfoGain } = this.nodes;
      const level = !alive ? 0.0001 : moving ? 0.22 : 0.09;
      out.gain.setTargetAtTime(level, t, 0.15);
      saw.frequency.setTargetAtTime(moving ? 58 : 38, t, 0.25);
      sub.frequency.setTargetAtTime(moving ? 29 : 19, t, 0.25);
      lp.frequency.setTargetAtTime(moving ? 520 : 300, t, 0.25);
      lfo.frequency.setTargetAtTime(moving ? 13 : 6, t, 0.25);
      lfoGain.gain.setTargetAtTime(moving ? 0.6 : 0.0, t, 0.1);
    },
    stop() {
      if (!this.nodes) return;
      const { out, saw, sub, clank, lfo } = this.nodes;
      out.gain.setTargetAtTime(0.0001, audioCtx.currentTime, 0.1);
      [saw, sub, clank, lfo].forEach((n) => n.stop(audioCtx.currentTime + 0.5));
      this.nodes = null;
    },
  };

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
    engine.stop();
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

  // Small seeded random generator so every player sees the same battlefield.
  function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function paintGround(g, arena, rand) {
    const { width: w, height: h } = arena;
    g.fillStyle = '#3d4a24';
    g.fillRect(0, 0, w, h);

    // Large patches of churned mud and scorched grass.
    for (let i = 0; i < 70; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const r = 30 + rand() * 90;
      const mud = rand() < 0.55;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, mud ? 'rgba(92, 70, 40, 0.45)' : 'rgba(80, 100, 45, 0.4)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // Fine grit: thousands of 2px specks in earthy tones.
    const specks = ['#2e3a1a', '#4a5a2c', '#5b4a2e', '#6a5a38', '#34401f', '#556b2f'];
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = specks[Math.floor(rand() * specks.length)];
      g.globalAlpha = 0.35 + rand() * 0.4;
      g.fillRect(Math.floor(rand() * w), Math.floor(rand() * h), 2, 2);
    }
    g.globalAlpha = 1;

    // Grass tufts.
    for (let i = 0; i < 260; i++) {
      const x = rand() * w;
      const y = rand() * h;
      g.strokeStyle = rand() < 0.5 ? '#6b7f3a' : '#55692c';
      g.lineWidth = 1;
      g.beginPath();
      for (let b = 0; b < 4; b++) {
        g.moveTo(x + b * 1.5, y);
        g.lineTo(x + b * 1.5 + (rand() - 0.5) * 4, y - 3 - rand() * 4);
      }
      g.stroke();
    }

    // Old tank tread marks.
    for (let i = 0; i < 9; i++) {
      let x = rand() * w;
      let y = rand() * h;
      let a = rand() * Math.PI * 2;
      g.fillStyle = 'rgba(30, 24, 14, 0.28)';
      for (let step = 0; step < 90; step++) {
        a += (rand() - 0.5) * 0.12;
        x += Math.cos(a) * 4;
        y += Math.sin(a) * 4;
        if (step % 2) continue;
        for (const side of [-11, 11]) {
          const tx = x + Math.cos(a + Math.PI / 2) * side;
          const ty = y + Math.sin(a + Math.PI / 2) * side;
          g.save();
          g.translate(tx, ty);
          g.rotate(a);
          g.fillRect(-2, -3, 3, 6);
          g.restore();
        }
      }
    }

    // Shell craters: dark pit, scorched ring and a lit rim.
    // Keep craters off the corner spawns and the flag's starting spot.
    const keepClear = [...[[60, 60], [w - 60, 60], [60, h - 60], [w - 60, h - 60]], [w / 2, h / 2]];
    for (let i = 0; i < 22; i++) {
      const x = rand() * w;
      const y = rand() * h;
      const r = 8 + rand() * 16;
      if (keepClear.some(([kx, ky]) => Math.hypot(kx - x, ky - y) < 70)) continue;
      paintCrater(g, x, y, r);
    }
  }

  function paintCrater(g, x, y, r) {
    const scorch = g.createRadialGradient(x, y, r * 0.5, x, y, r * 2.2);
    scorch.addColorStop(0, 'rgba(20, 16, 10, 0.55)');
    scorch.addColorStop(1, 'rgba(20, 16, 10, 0)');
    g.fillStyle = scorch;
    g.beginPath();
    g.arc(x, y, r * 2.2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(140, 115, 75, 0.55)';
    g.beginPath();
    g.ellipse(x + r * 0.15, y + r * 0.15, r, r * 0.85, 0, 0, Math.PI * 2);
    g.fill();
    const pit = g.createRadialGradient(x - r * 0.2, y - r * 0.2, 0, x, y, r);
    pit.addColorStop(0, '#1b150c');
    pit.addColorStop(1, '#3e3220');
    g.fillStyle = pit;
    g.beginPath();
    g.ellipse(x, y, r * 0.85, r * 0.72, 0, 0, Math.PI * 2);
    g.fill();
  }

  // Sandbag bunkers: staggered rows of rounded, shaded bags. The outer wall is reinforced concrete.
  function paintWalls(g, arena, rand) {
    const c = arena.cell;
    const isWall = (x, y) => arena.walls[y] && arena.walls[y][x] === 1;
    const isOuter = (x, y) => x === 0 || y === 0 || x === arena.cols - 1 || y === arena.rows - 1;

    // Drop shadow under every wall, offset down-right.
    g.save();
    g.fillStyle = 'rgba(0, 0, 0, 0.45)';
    g.filter = 'blur(4px)';
    for (let y = 0; y < arena.rows; y++) {
      for (let x = 0; x < arena.cols; x++) if (isWall(x, y)) g.fillRect(x * c + 5, y * c + 6, c, c);
    }
    g.restore();

    // Concrete outer wall with panel seams, stains and hazard stripes at the corners.
    for (let y = 0; y < arena.rows; y++) {
      for (let x = 0; x < arena.cols; x++) {
        if (!isWall(x, y) || !isOuter(x, y)) continue;
        const px = x * c;
        const py = y * c;
        g.fillStyle = '#6f6a5e';
        g.fillRect(px, py, c, c);
        for (let i = 0; i < 18; i++) {
          g.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.12)';
          g.fillRect(px + rand() * c, py + rand() * c, 2, 2);
        }
        g.fillStyle = 'rgba(0,0,0,0.25)';
        if ((x + y) % 2 === 0) g.fillRect(px + c - 1, py, 1, c);
        g.fillRect(px, py + c - 1, c, 1);
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(px, py, c, 1);
      }
    }
    // Inner edge highlight so the arena boundary reads as a raised wall.
    g.fillStyle = 'rgba(0, 0, 0, 0.35)';
    g.fillRect(c, c, arena.width - 2 * c, 3);
    g.fillRect(c, c, 3, arena.height - 2 * c);

    // Sandbags on interior walls.
    const bagH = c / 2;
    const bagW = c * 0.75;
    g.save();
    g.beginPath();
    for (let y = 0; y < arena.rows; y++) {
      for (let x = 0; x < arena.cols; x++) if (isWall(x, y) && !isOuter(x, y)) g.rect(x * c, y * c, c, c);
    }
    g.clip();
    g.fillStyle = '#4a3f2a';
    g.fillRect(0, 0, arena.width, arena.height);
    for (let row = 0; row * bagH < arena.height; row++) {
      const offset = row % 2 ? bagW / 2 : 0;
      for (let col = -1; col * bagW < arena.width; col++) {
        const bx = col * bagW + offset + 1;
        const by = row * bagH + 1;
        const tone = 150 + Math.floor(rand() * 30);
        const grad = g.createLinearGradient(bx, by, bx, by + bagH);
        grad.addColorStop(0, `rgb(${tone + 30}, ${tone + 12}, ${tone - 40})`);
        grad.addColorStop(0.6, `rgb(${tone}, ${tone - 20}, ${tone - 70})`);
        grad.addColorStop(1, `rgb(${tone - 60}, ${tone - 75}, ${tone - 105})`);
        g.fillStyle = grad;
        roundRect(g, bx, by, bagW - 2, bagH - 2, 4);
        g.fill();
        // Tie seam on each bag.
        g.fillStyle = 'rgba(60, 45, 25, 0.5)';
        g.fillRect(bx + bagW * 0.45, by + 2, 1, bagH - 6);
      }
    }
    g.restore();
  }

  function buildFieldLayer(arena) {
    const layer = document.createElement('canvas');
    layer.width = arena.width;
    layer.height = arena.height;
    const g = layer.getContext('2d');
    const rand = seededRandom(19771977);
    paintGround(g, arena, rand);
    paintWalls(g, arena, rand);
    return layer;
  }

  // Battle damage stays on the ground for the rest of the game.
  function addScorch(x, y, big) {
    if (!state.fieldLayer) return;
    const g = state.fieldLayer.getContext('2d');
    if (big) {
      paintCrater(g, x, y, 10 + Math.random() * 4);
    } else {
      const grad = g.createRadialGradient(x, y, 0, x, y, 9);
      grad.addColorStop(0, 'rgba(15, 12, 8, 0.6)');
      grad.addColorStop(1, 'rgba(15, 12, 8, 0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, 9, 0, Math.PI * 2);
      g.fill();
    }
  }

  // One panel per spawn corner; a player's panel is chosen by their player number.
  function updateScoreboard(players) {
    document.querySelectorAll('.score-tag[data-slot]').forEach((tag) => {
      const p = players.find((pl) => pl.number === Number(tag.dataset.slot));
      tag.classList.toggle('empty', !p);
      if (!p) return;
      tag.style.color = p.color;
      if (!tag.firstChild) {
        tag.innerHTML = '<span class="tag-name"></span><span class="tag-score"></span><span class="tag-flag" title="Holding the flag">⚑</span>';
      }
      tag.querySelector('.tag-name').textContent = playerLabel(p);
      tag.querySelector('.tag-score').textContent = p.score;
      tag.querySelector('.tag-flag').style.visibility = p.hasFlag ? 'visible' : 'hidden';
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
    state.flag = payload.flag;
    state.lastSnapshotAt = performance.now();
    state.playing = true;
    engine.start();

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
    state.flag = snapshot.flag;
    const now = performance.now();
    state.lastSnapshotAt = now;

    snapshot.events.forEach((ev) => {
      if (ev.type === 'fire') {
        playSound('fire', ev.x, ev.y);
        state.blasts.push({ x: ev.x, y: ev.y, start: now, kind: 'muzzle' });
      } else if (ev.type === 'hit') {
        state.blasts.push({ x: ev.x, y: ev.y, start: now, kind: 'explosion' });
        addScorch(ev.x, ev.y, true);
        playSound('explosion', ev.x, ev.y, ev.id === state.playerId ? 1.4 : 1);
        if (ev.hadFlag) playSound(ev.id === state.playerId ? 'flagLost' : 'flagRespawn');
      } else if (ev.type === 'impact') {
        state.blasts.push({ x: ev.x, y: ev.y, start: now, kind: 'impact' });
        addScorch(ev.x, ev.y, false);
        playSound('impact', ev.x, ev.y);
      } else if (ev.type === 'flagTaken') {
        playSound(ev.by === state.playerId ? 'flagTaken' : 'flagRespawn');
      }
    });
    const me = state.currPlayers.get(state.playerId);
    if (me) engine.update(me.moving, me.status === 'alive');
    updateScoreboard(snapshot.players);
  });

  socket.on('gameOver', ({ standings, reason, winnerId }) => {
    state.playing = false;
    releaseControls();
    engine.stop();
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

  const BLAST_MS = { muzzle: 120, impact: 350, explosion: 1100 };

  function drawBlasts(now) {
    state.blasts = state.blasts.filter((b) => now - b.start < BLAST_MS[b.kind]);
    state.blasts.forEach((b) => {
      const t = (now - b.start) / BLAST_MS[b.kind];
      ctx.save();
      if (b.kind === 'muzzle') {
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = '#fff4b0';
        ctx.shadowColor = '#ffb000';
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(b.x, b.y, 7 * (1 - t * 0.5), 0, Math.PI * 2);
        ctx.fill();
      } else if (b.kind === 'impact') {
        // Dust puff and a few sparks.
        ctx.globalAlpha = 0.6 * (1 - t);
        ctx.fillStyle = '#a89070';
        ctx.beginPath();
        ctx.arc(b.x, b.y, 6 + 12 * t, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = '#ffd27a';
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + b.x;
          ctx.fillRect(b.x + Math.cos(a) * 16 * t, b.y + Math.sin(a) * 16 * t, 2, 2);
        }
      } else {
        // Explosion: rising smoke, fireball and flying debris.
        if (!b.debris) {
          b.debris = Array.from({ length: 14 }, () => ({ a: Math.random() * Math.PI * 2, v: 30 + Math.random() * 60, s: 2 + Math.random() * 3 }));
          b.smoke = Array.from({ length: 6 }, () => ({ dx: (Math.random() - 0.5) * 26, dy: (Math.random() - 0.5) * 26, r: 10 + Math.random() * 10 }));
        }
        b.smoke.forEach((sm) => {
          ctx.globalAlpha = 0.45 * (1 - t);
          ctx.fillStyle = '#2b2620';
          ctx.beginPath();
          ctx.arc(b.x + sm.dx * (0.5 + t), b.y + sm.dy * (0.5 + t) - 20 * t, sm.r * (0.6 + t), 0, Math.PI * 2);
          ctx.fill();
        });
        const fire = Math.max(0, 1 - t * 2.2);
        if (fire > 0) {
          const r = 34 * (0.4 + t);
          const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
          grad.addColorStop(0, `rgba(255, 250, 210, ${fire})`);
          grad.addColorStop(0.35, `rgba(255, 170, 40, ${fire})`);
          grad.addColorStop(0.75, `rgba(200, 50, 10, ${fire * 0.8})`);
          grad.addColorStop(1, 'rgba(80, 20, 0, 0)');
          ctx.globalAlpha = 1;
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = Math.max(0, 1 - t * 1.3);
        b.debris.forEach((d) => {
          ctx.fillStyle = t < 0.3 ? '#ffcf70' : '#3a2f22';
          ctx.fillRect(b.x + Math.cos(d.a) * d.v * t, b.y + Math.sin(d.a) * d.v * t, d.s, d.s);
        });
      }
      ctx.restore();
    });
  }

  // A gold flag on a pole, gently waving. Carried flags fly from the tank's turret.
  function drawFlag(x, y, now, carried) {
    const poleH = carried ? 24 : 30;
    const baseY = y + (carried ? 2 : 10);
    ctx.save();
    if (!carried) {
      // Glowing beacon ring so the flag is easy to spot.
      const pulse = 0.5 + 0.5 * Math.sin(now / 250);
      ctx.strokeStyle = `rgba(255, 215, 64, ${0.35 + 0.35 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y + 6, 16 + 4 * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.ellipse(x + 3, baseY, 7, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#d8d0c0';
    ctx.fillRect(x - 1, baseY - poleH, 2, poleH);
    ctx.fillStyle = '#ffd740';
    ctx.strokeStyle = '#a07800';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const top = baseY - poleH;
    ctx.moveTo(x + 1, top);
    for (let i = 0; i <= 16; i++) {
      ctx.lineTo(x + 1 + i, top + Math.sin(now / 140 + i / 3) * 1.6);
    }
    for (let i = 16; i >= 0; i--) {
      ctx.lineTo(x + 1 + i, top + 11 + Math.sin(now / 140 + i / 3) * 1.6);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Star emblem.
    ctx.fillStyle = '#b3261e';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', x + 9, top + 6 + Math.sin(now / 140 + 2.6) * 1.6);
    ctx.restore();
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
      // Tracer: a short glowing streak behind the shell.
      ctx.strokeStyle = 'rgba(255, 210, 120, 0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(prev.x - (b.x - prev.x) * 0.6, prev.y - (b.y - prev.y) * 0.6);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.shadowColor = '#ffb000';
      ctx.shadowBlur = 10;
      ctx.fillStyle = '#fff6d0';
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    if (state.flag && !state.flag.holder) drawFlag(state.flag.x, state.flag.y, now, false);

    const positions = [];
    state.currPlayers.forEach((p) => {
      const prev = state.prevPlayers.get(p.id) || p;
      const jump = Math.hypot(prev.x - p.x, prev.y - p.y) > 40; // respawned
      const x = jump ? p.x : lerp(prev.x, p.x, alpha);
      const y = jump ? p.y : lerp(prev.y, p.y, alpha);
      const angle = jump ? p.angle : lerpAngle(prev.angle, p.angle, alpha);
      // Flicker while protected after respawning; dim while spinning out after a hit.
      ctx.globalAlpha = (p.invulnerable && Math.floor(now / 100) % 2) ? 0.35 : p.status === 'hit' ? 0.7 : 1;
      if (p.hasFlag) {
        // Golden aura marks the flag carrier for everyone.
        const grad = ctx.createRadialGradient(x, y, 8, x, y, 30);
        grad.addColorStop(0, 'rgba(255, 215, 64, 0.35)');
        grad.addColorStop(1, 'rgba(255, 215, 64, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, 30, 0, Math.PI * 2);
        ctx.fill();
      }
      drawTank(ctx, p, x, y, angle);
      if (p.hasFlag) drawFlag(x - 4, y - 6, now, true);
      ctx.globalAlpha = 1;
      positions.push([p, x, y]);
    });

    drawBlasts(now);
    // Bubbles go on top so a tank never covers another player's name.
    positions.forEach(([p, x, y]) => drawNameBubble(p, x, y - (p.hasFlag ? 30 : 16)));
  }

  buildSlots();
  renderSlots();
  requestAnimationFrame(animateSlots);
  enterRoomFromUrl();
})();
