(() => {
  const socket = window.TankmatesNet.createNet();

  const KEY_TO_CONTROL = {
    ArrowUp: 'forward', w: 'forward', W: 'forward',
    ArrowDown: 'back', s: 'back', S: 'back',
    ArrowLeft: 'left', a: 'left', A: 'left',
    ArrowRight: 'right', d: 'right', D: 'right',
    ' ': 'fire', Enter: 'fire',
    x: 'mine', X: 'mine',
    Shift: 'boost',
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
    controls: { forward: false, back: false, left: false, right: false, fire: false, mine: false, boost: false },
    mines: [],
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
    mineDropped(ac, out) {
      const t = ac.currentTime;
      osc(ac, out, { type: 'square', from: 300, to: 200, t0: t, dur: 0.05, peak: 0.08 });
      osc(ac, out, { type: 'square', from: 900, t0: t + 0.9, dur: 0.06, peak: 0.05 }); // armed beep
    },
    // Landmine: a sharp crack under a deep, long boom.
    mineBlast(ac, out) {
      const t = ac.currentTime;
      noiseBurst(ac, out, { t0: t, dur: 0.15, peak: 0.6, type: 'highpass', from: 3000, to: 1000 });
      osc(ac, out, { from: 70, to: 22, t0: t, dur: 1.3, peak: 1, attack: 0.005 });
    },
    // Brick block giving way: a crunch and tumbling bricks.
    collapse(ac, out) {
      const t = ac.currentTime;
      noiseBurst(ac, out, { t0: t, dur: 0.6, peak: 0.55, from: 1600, to: 90 });
      osc(ac, out, { from: 110, to: 40, t0: t, dur: 0.4, peak: 0.4 });
      for (let i = 0; i < 8; i++) {
        noiseBurst(ac, out, { t0: t + 0.08 + Math.random() * 0.5, dur: 0.05, peak: 0.12, type: 'bandpass', from: 700 + Math.random() * 900, q: 2 });
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

  // ---------- Military tank sprites ----------

  // Tanks are drawn facing up in a 36x54 unit box (1 unit = 1 game pixel), at RES x resolution
  // for crisp detail, then rotated to the tank's heading. The hull centre is the pivot.
  const SPRITE_W = 36;
  const SPRITE_H = 54;
  const PIVOT = { x: 18, y: 32 };
  const RES = 2; // drawn at 2 pixels per game pixel, then pixel-art post-processed (see pixelate)
  const spriteCache = new Map();

  // Mixes a #rrggbb colour towards black (amt < 0) or white (amt > 0).
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const target = amt < 0 ? 0 : 255;
    const p = Math.abs(amt);
    const mix = (v) => Math.round(v + (target - v) * p);
    return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
  }

  // Four tank designs, one per player slot, inspired by real top-down tank silhouettes.
  const TANK_DESIGNS = [
    // ramp: colours the finished sprite is reduced to (each also gets darker/lighter shades).
    { name: 'Leopard 2A7 style', draw: drawLeopard, ramp: ['#4c5b34', '#2b2a22', '#5c4a30', '#3a4a2a'] }, // green camo
    { name: 'M1A2 Abrams style', draw: drawAbrams, ramp: ['#c2a878', '#a8915f', '#5a5246'] }, // desert sand
    { name: 'T-14 Armata style', draw: drawArmata, ramp: ['#a3a9ad', '#3d4246'] }, // silver
    { name: 'AbramsX style', draw: drawAbramsX, ramp: ['#66727f', '#3b434b'] }, // blue-grey
  ];

  function poly(g, pts) {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
  }

  // Paints a body panel: base colour, optional camo blotches, top-left lighting and a dark outline.
  function paintBody(g, build, base, { camo = null, seed = 1, blobs = 7, blobSize = 6, outline = -0.62 } = {}) {
    g.save();
    build();
    g.fillStyle = base;
    g.fill();
    g.clip();
    if (camo) {
      const rand = seededRandom(seed);
      for (let i = 0; i < blobs; i++) {
        const cx = rand() * SPRITE_W;
        const cy = 8 + rand() * (SPRITE_H - 8);
        const pts = [];
        for (let k = 0; k < 7; k++) {
          const a = (k / 7) * Math.PI * 2;
          const r = blobSize * (0.5 + rand() * 0.7);
          pts.push([cx + Math.cos(a) * r * 1.3, cy + Math.sin(a) * r]);
        }
        g.fillStyle = camo[i % camo.length];
        poly(g, pts);
        g.fill();
      }
    }
    const light = g.createLinearGradient(0, 8, SPRITE_W, SPRITE_H);
    light.addColorStop(0, 'rgba(255, 255, 255, 0.22)');
    light.addColorStop(0.45, 'rgba(255, 255, 255, 0)');
    light.addColorStop(1, 'rgba(0, 0, 0, 0.32)');
    g.fillStyle = light;
    g.fillRect(0, 0, SPRITE_W, SPRITE_H);
    g.restore();
    build();
    g.strokeStyle = shade(base, outline);
    g.lineWidth = 0.7;
    g.stroke();
  }

  function tracks(g, x, y, w, h, base) {
    for (const tx of [x, SPRITE_W - x - w]) {
      g.fillStyle = shade(base, -0.78);
      roundRect(g, tx, y, w, h, 1.5);
      g.fill();
      g.fillStyle = shade(base, -0.6);
      for (let ty = y + 0.8; ty < y + h - 0.8; ty += 1.8) g.fillRect(tx + 0.5, ty, w - 1, 0.9);
    }
  }

  function line(g, x0, y0, x1, y1, color, w = 0.5) {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  }

  function barrel(g, x, y0, y1, w, base) {
    const grad = g.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    grad.addColorStop(0, shade(base, 0.3));
    grad.addColorStop(0.5, base);
    grad.addColorStop(1, shade(base, -0.45));
    g.fillStyle = grad;
    g.fillRect(x - w / 2, y0, w, y1 - y0);
    g.strokeStyle = shade(base, -0.65);
    g.lineWidth = 0.5;
    g.strokeRect(x - w / 2, y0, w, y1 - y0);
  }

  function hatch(g, x, y, r, base) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = shade(base, -0.12);
    g.fill();
    g.strokeStyle = shade(base, -0.6);
    g.lineWidth = 0.5;
    g.stroke();
    g.beginPath();
    g.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, Math.PI * 2);
    g.fillStyle = shade(base, 0.25);
    g.fill();
  }

  function box(g, x, y, w, h, base) {
    g.fillStyle = base;
    g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(x, y, w, 0.5);
    g.strokeStyle = shade(base, -0.6);
    g.lineWidth = 0.4;
    g.strokeRect(x, y, w, h);
  }

  function engineDeck(g, x0, x1, y0, y1, base) {
    g.fillStyle = shade(base, -0.35);
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    for (let x = x0 + 1; x < x1; x += 1.6) line(g, x, y0 + 0.5, x, y1 - 0.5, shade(base, -0.6), 0.5);
  }

  // Team marking: a coloured band across the back of the turret.
  function teamBand(g, build, team) {
    g.save();
    build();
    g.clip();
    g.fillStyle = team;
    g.globalAlpha = 0.92;
    g.fillRect(0, 0, SPRITE_W, SPRITE_H);
    g.restore();
  }

  // Green: Leopard 2A7 style. Long hull with full skirts, wedge-armour turret front, NATO camo.
  function drawLeopard(g, team) {
    const base = '#4c5b34';
    const camo = ['#2b2a22', '#5c4a30', '#3a4a2a'];
    tracks(g, 5, 12, 6, 41, base);
    paintBody(g, () => poly(g, [[8, 12], [28, 12], [31, 15], [31, 52], [5, 52], [5, 15]]), base, { camo, seed: 11, blobs: 10 });
    for (let y = 18; y < 48; y += 7) { line(g, 5, y, 9, y, shade(base, -0.55)); line(g, 27, y, 31, y, shade(base, -0.55)); }
    engineDeck(g, 11, 25, 44, 50.5, base);
    hatch(g, 13, 15.5, 1.6, base); // driver
    // Turret with arrowhead wedge armour either side of the gun.
    const turret = () => poly(g, [[17, 18], [12, 17], [8, 24], [7, 37], [10, 41], [26, 41], [29, 37], [28, 24], [24, 17], [19, 18]]);
    paintBody(g, turret, shade(base, 0.05), { camo, seed: 23, blobs: 6, blobSize: 5 });
    line(g, 12, 17, 13, 24, shade(base, -0.6));
    line(g, 24, 17, 23, 24, shade(base, -0.6));
    line(g, 8, 24, 28, 24, shade(base, -0.5), 0.4);
    teamBand(g, () => poly(g, [[8, 36], [28, 36], [28, 38.5], [8, 38.5]]), team);
    box(g, 9.5, 25.5, 3.5, 3, '#2d2f28'); // commander's periscope
    box(g, 22.5, 22.5, 3, 2.5, '#2d2f28'); // gunner's sight
    hatch(g, 22.5, 31, 2.4, base);
    hatch(g, 13.5, 32, 2.1, base);
    barrel(g, 18, 0, 22, 2.4, '#3e4a2c');
    for (const y of [5, 10, 15]) line(g, 16.8, y, 19.2, y, '#1f241a', 0.5); // thermal sleeve bands
  }

  // Sand: M1A2 Abrams style. Wide flat turret, bustle rack, CITV sight, commander's weapon station.
  function drawAbrams(g, team) {
    const base = '#c2a878';
    tracks(g, 5, 12, 6, 41, base);
    paintBody(g, () => poly(g, [[8, 12], [28, 12], [31, 15], [31, 52], [5, 52], [5, 15]]), base, { camo: ['#b39a6a', '#cdb586'], seed: 31, blobs: 8, blobSize: 7 });
    for (let y = 17; y < 49; y += 5) { line(g, 5, y, 9, y, shade(base, -0.4)); line(g, 27, y, 31, y, shade(base, -0.4)); }
    engineDeck(g, 11, 25, 45, 51, base);
    hatch(g, 18, 15, 1.6, base); // driver
    // Bustle rack (cage) behind the turret.
    g.strokeStyle = shade(base, -0.55);
    g.lineWidth = 0.6;
    g.strokeRect(7.5, 39, 21, 5);
    for (let x = 9.5; x < 28; x += 2) line(g, x, 39, x, 44, shade(base, -0.45), 0.4);
    const turret = () => poly(g, [[10, 20], [16.5, 20], [16.5, 22], [19.5, 22], [19.5, 20], [26, 20], [30, 26], [30, 39.5], [6, 39.5], [6, 26]]);
    paintBody(g, turret, shade(base, 0.06), { camo: ['#b39a6a'], seed: 37, blobs: 4, blobSize: 6 });
    line(g, 10, 20, 7.5, 26, shade(base, -0.5));
    line(g, 26, 20, 28.5, 26, shade(base, -0.5));
    teamBand(g, () => poly(g, [[6, 36.5], [30, 36.5], [30, 39], [6, 39]]), team);
    // CITV sight (cylinder), loader's hatch, commander's cupola with remote weapon.
    g.beginPath();
    g.arc(11, 24.5, 1.8, 0, Math.PI * 2);
    g.fillStyle = '#5a5246';
    g.fill();
    hatch(g, 12, 31, 2.3, base);
    hatch(g, 24, 30, 2.6, base);
    box(g, 23, 25.5, 3, 2, '#5a5246');
    line(g, 24.5, 25.5, 24.5, 22.5, '#3a352e', 0.7);
    barrel(g, 18, 0, 21, 2.8, '#a8915f');
    box(g, 16.3, 8, 3.4, 3, shade(base, -0.25)); // bore evacuator
  }

  // Silver: T-14 Armata style. Long flat hull, crew capsule up front, compact unmanned turret.
  function drawArmata(g, team) {
    const base = '#a3a9ad';
    tracks(g, 5, 11, 6, 43, base);
    paintBody(g, () => poly(g, [[8, 11], [28, 11], [31, 14], [31, 53], [5, 53], [5, 14]]), base, { camo: ['#b5bbbf', '#8e9498'], seed: 41, blobs: 6, blobSize: 8 });
    for (let y = 16; y < 50; y += 4) { line(g, 5, y, 9, y, shade(base, -0.45)); line(g, 27, y, 31, y, shade(base, -0.45)); }
    // Armoured crew capsule: three hatches across the front.
    for (const x of [12.5, 18, 23.5]) hatch(g, x, 16, 1.5, base);
    line(g, 9, 19.5, 27, 19.5, shade(base, -0.5));
    // Long engine deck with slats.
    engineDeck(g, 10, 26, 42, 51.5, base);
    const turret = () => poly(g, [[13, 23], [23, 23], [26, 27], [26, 39], [23, 41], [13, 41], [10, 39], [10, 27]]);
    paintBody(g, turret, shade(base, 0.08), { camo: ['#8e9498'], seed: 47, blobs: 3, blobSize: 5 });
    teamBand(g, () => poly(g, [[10, 37], [26, 37], [26, 39.5], [10, 39.5]]), team);
    // Sensor blocks and the remote weapon station on top.
    box(g, 11.5, 26, 3, 2.5, '#3d4246');
    box(g, 21.5, 26, 3, 2.5, '#3d4246');
    box(g, 16, 30, 4, 4, '#5f666b');
    line(g, 18, 30, 18, 27, '#2e3236', 0.7);
    for (const x of [11, 25]) { g.beginPath(); g.arc(x, 34, 1, 0, Math.PI * 2); g.fillStyle = '#2e3236'; g.fill(); }
    barrel(g, 18, 0, 24, 2.6, '#8c9296');
    box(g, 16.4, 10, 3.2, 3.5, shade(base, -0.3));
  }

  // Blue-grey: AbramsX style. Sleek hull, low angular turret, slim gun, remote weapon station.
  function drawAbramsX(g, team) {
    const base = '#66727f';
    tracks(g, 5, 12, 6, 41, base);
    paintBody(g, () => poly(g, [[9, 12], [27, 12], [31, 16], [31, 51], [28, 53], [8, 53], [5, 51], [5, 16]]), base, { camo: ['#5a6571', '#747f8b'], seed: 53, blobs: 8, blobSize: 6 });
    for (let y = 18; y < 50; y += 8) { line(g, 5, y, 9, y, shade(base, -0.5)); line(g, 27, y, 31, y, shade(base, -0.5)); }
    engineDeck(g, 11, 25, 45, 51, base);
    hatch(g, 18, 15.5, 1.5, base);
    const turret = () => poly(g, [[11, 21], [25, 21], [29, 27], [28.5, 38], [25, 41], [11, 41], [7.5, 38], [7, 27]]);
    paintBody(g, turret, shade(base, 0.06), { camo: ['#5a6571'], seed: 59, blobs: 4, blobSize: 5 });
    line(g, 11, 21, 9, 27, shade(base, -0.55));
    line(g, 25, 21, 27, 27, shade(base, -0.55));
    line(g, 9, 27, 27, 27, shade(base, -0.45), 0.4);
    teamBand(g, () => poly(g, [[8, 36], [28, 36], [28, 38.5], [8, 38.5]]), team);
    // Remote weapon station and sensor mast.
    box(g, 20.5, 29, 5, 4, '#3b434b');
    line(g, 23, 29, 23, 25, '#2a3036', 0.7);
    g.beginPath();
    g.arc(12.5, 31, 2, 0, Math.PI * 2);
    g.fillStyle = '#3b434b';
    g.fill();
    box(g, 10, 24, 3, 2, '#2a3036');
    barrel(g, 18, 0, 22, 2.2, '#57626d');
  }

  // Turns the smooth drawing into retro pixel art: hard alpha edges, a limited palette with
  // a light ordered dither, and a 1px dark outline around the whole tank.
  const BAYER = [[0, 2], [3, 1]];
  function toRgb(col) {
    const m = col.match(/\d+/g);
    if (col.startsWith('#')) {
      const n = parseInt(col.slice(1), 16);
      return [n >> 16, (n >> 8) & 255, n & 255];
    }
    return m.slice(0, 3).map(Number);
  }

  function pixelate(canvas, ramp, team) {
    const g = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    const palette = [];
    for (const col of [...ramp, team]) {
      for (const amt of [-0.6, -0.4, -0.22, 0, 0.2, 0.4]) palette.push(toRgb(shade(col, amt)));
    }
    palette.push([20, 20, 16], [235, 230, 215]);
    const nearest = (r, gr, b) => {
      let best = palette[0];
      let bestD = Infinity;
      for (const p of palette) {
        const dd = (p[0] - r) ** 2 * 0.3 + (p[1] - gr) ** 2 * 0.59 + (p[2] - b) ** 2 * 0.11;
        if (dd < bestD) { bestD = dd; best = p; }
      }
      return best;
    };
    const solid = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 110) { d[i + 3] = 0; continue; }
        solid[y * w + x] = 1;
        const bias = (BAYER[y % 2][x % 2] - 1.5) * 2.5;
        const [r, gr, b] = nearest(d[i] + bias, d[i + 1] + bias, d[i + 2] + bias);
        d[i] = r; d[i + 1] = gr; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (solid[y * w + x]) continue;
        const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
          const nx = x + dx;
          const ny = y + dy;
          return nx >= 0 && ny >= 0 && nx < w && ny < h && solid[ny * w + nx];
        });
        if (!touches) continue;
        const i = (y * w + x) * 4;
        d[i] = 18; d[i + 1] = 17; d[i + 2] = 14; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  function buildTankSprite(number, team) {
    const c = document.createElement('canvas');
    c.width = SPRITE_W * RES;
    c.height = SPRITE_H * RES;
    const g = c.getContext('2d');
    g.scale(RES, RES);
    g.lineJoin = 'round';
    const design = TANK_DESIGNS[(number - 1) % TANK_DESIGNS.length];
    design.draw(g, team);
    pixelate(c, design.ramp, team);
    return c;
  }

  function tankSprite(number, team) {
    const key = `${number}|${team}`;
    if (!spriteCache.has(key)) spriteCache.set(key, buildTankSprite(number, team));
    return spriteCache.get(key);
  }

  // Draws a tank centred on its hull; angle 0 points right (the sprite is drawn facing up).
  function drawTank(c, p, cx, cy, angleDeg, scale = 1) {
    const sprite = tankSprite(p.number || 1, p.color);
    c.save();
    c.translate(cx, cy);
    c.rotate(((angleDeg + 90) * Math.PI) / 180);
    c.scale(scale, scale);
    // Ground shadow.
    c.fillStyle = 'rgba(0, 0, 0, 0.35)';
    c.beginPath();
    c.ellipse(2, 3, 14, 22, 0, 0, Math.PI * 2);
    c.fill();
    c.imageSmoothingEnabled = false; // keep the pixel art crisp when rotated and scaled
    c.drawImage(sprite, -PIVOT.x, -PIVOT.y, SPRITE_W, SPRITE_H);
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
        drawTank(c, p, 32, 32, ((now / 25) + i * 90) % 360, 0.95);
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
  }

  // ---------- Walls ----------
  // Walls live on their own layer so a single block can be redrawn as it's shot to pieces.
  // Interior blocks are classic red brick, already a little crumbled; the outer wall is concrete.

  const BRICK_H = 6; // 4 courses per 24px cell
  const BRICK_W = 12;
  const MORTAR = '#6b5f52';
  const BRICK_TONES = ['#9b3b2b', '#a8432f', '#8e3527', '#b04a35', '#963d2c', '#a33f30', '#874031'];

  const isOuterCell = (arena, x, y) => x === 0 || y === 0 || x === arena.cols - 1 || y === arena.rows - 1;

  // Same as the engine's wallRect: the outer wall only fills the outer half of its cells.
  function wallRect(arena, x, y) {
    const c = arena.cell;
    let x0 = x * c;
    let y0 = y * c;
    let x1 = x0 + c;
    let y1 = y0 + c;
    if (x === 0) x1 = x0 + c / 2;
    if (x === arena.cols - 1) x0 = x1 - c / 2;
    if (y === 0) y1 = y0 + c / 2;
    if (y === arena.rows - 1) y0 = y1 - c / 2;
    return [x0, y0, x1, y1];
  }

  // Same as the engine's wallRects: outer-wall corners are an L of the two strips meeting there.
  function wallRects(arena, x, y) {
    const c = arena.cell;
    const outerX = x === 0 || x === arena.cols - 1;
    const outerY = y === 0 || y === arena.rows - 1;
    if (!outerX || !outerY) return [wallRect(arena, x, y)];
    const vx0 = x === 0 ? 0 : (x + 1) * c - c / 2;
    const hy0 = y === 0 ? 0 : (y + 1) * c - c / 2;
    return [
      [vx0, y * c, vx0 + c / 2, (y + 1) * c],
      [x * c, hy0, (x + 1) * c, hy0 + c / 2],
    ];
  }

  function paintConcrete(g, arena, x, y) {
    for (const rect of wallRects(arena, x, y)) paintConcreteRect(g, x, y, rect);
  }

  function paintConcreteRect(g, x, y, [x0, y0, x1, y1]) {
    const rand = seededRandom(x * 7919 + y * 104729 + 3);
    const w = x1 - x0;
    const h = y1 - y0;
    g.fillStyle = '#6f6a5e';
    g.fillRect(x0, y0, w, h);
    for (let i = 0; i < 10; i++) {
      g.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.12)';
      g.fillRect(x0 + rand() * w, y0 + rand() * h, 2, 2);
    }
    // Panel seams every other cell along the wall.
    g.fillStyle = 'rgba(0,0,0,0.3)';
    const horizontal = w > h;
    if ((x + y) % 2 === 0) {
      if (horizontal) g.fillRect(x1 - 1, y0, 1, h);
      else g.fillRect(x0, y1 - 1, w, 1);
    }
  }

  // Paints one brick block. damage 0 = intact (lightly weathered) up to maxHp - 1 = barely standing.
  function paintBrick(g, arena, x, y, damage, maxHp) {
    const c = arena.cell;
    const px = x * c;
    const py = y * c;
    const rand = seededRandom(x * 7919 + y * 104729);
    const wear = damage / Math.max(1, maxHp - 1); // 0..1
    g.save();
    g.beginPath();
    g.rect(px, py, c, c);
    g.clip();
    // Mortar bed.
    g.fillStyle = MORTAR;
    g.fillRect(px, py, c, c);
    for (let course = 0; course < c / BRICK_H; course++) {
      const gy = py + course * BRICK_H;
      const stagger = (Math.floor(gy / BRICK_H) % 2) * (BRICK_W / 2);
      // Bricks follow one global grid, so a brick spanning two blocks keeps its colour across both.
      for (let bx = Math.floor((px - stagger) / BRICK_W) * BRICK_W + stagger; bx < px + c; bx += BRICK_W) {
        const brand = seededRandom(Math.floor(bx) * 92821 + gy * 68917 + 11);
        // Missing bricks: a few even when intact, many more as the block takes hits (per block).
        if (rand() < 0.04 + wear * 0.5) {
          g.fillStyle = 'rgba(30, 22, 18, 0.85)';
          g.fillRect(bx + 0.5, gy + 0.5, BRICK_W - 1, BRICK_H - 1);
          continue;
        }
        const tone = BRICK_TONES[Math.floor(brand() * BRICK_TONES.length)];
        const bw = BRICK_W - 1;
        const bh = BRICK_H - 1;
        g.fillStyle = tone;
        g.fillRect(bx + 0.5, gy + 0.5, bw, bh);
        // Lit top edge, shaded bottom edge, and a little surface grain.
        g.fillStyle = 'rgba(255, 200, 170, 0.18)';
        g.fillRect(bx + 0.5, gy + 0.5, bw, 1);
        g.fillStyle = 'rgba(0, 0, 0, 0.25)';
        g.fillRect(bx + 0.5, gy + bh - 0.5, bw, 1);
        for (let k = 0; k < 3; k++) {
          g.fillStyle = brand() < 0.5 ? 'rgba(0,0,0,0.18)' : 'rgba(255,220,200,0.12)';
          g.fillRect(bx + 1 + brand() * (bw - 2), gy + 1 + brand() * (bh - 2), 1, 1);
        }
        // Chipped corners: some from the start (old, crumbling brick), more with damage.
        if (brand() < 0.25 || rand() < wear * 0.5) {
          g.fillStyle = MORTAR;
          const left = brand() < 0.5;
          const cw = 2 + brand() * 3;
          g.beginPath();
          g.moveTo(left ? bx : bx + bw + 1, gy);
          g.lineTo(left ? bx + cw : bx + bw + 1 - cw, gy);
          g.lineTo(left ? bx : bx + bw + 1, gy + 2 + brand() * 2);
          g.fill();
        }
      }
    }
    // Cracks spread as the block is damaged.
    const cracks = Math.round(wear * 4) + (rand() < 0.4 ? 1 : 0);
    g.strokeStyle = 'rgba(25, 18, 14, 0.8)';
    g.lineWidth = 0.8;
    for (let k = 0; k < cracks; k++) {
      let cx = px + rand() * c;
      let cy = py + rand() * c;
      g.beginPath();
      g.moveTo(cx, cy);
      for (let seg = 0; seg < 4; seg++) {
        cx += (rand() - 0.5) * 10;
        cy += (rand() - 0.3) * 8;
        g.lineTo(cx, cy);
      }
      g.stroke();
    }
    // Soot from shell hits.
    if (wear > 0) {
      const grad = g.createRadialGradient(px + c / 2, py + c / 2, 0, px + c / 2, py + c / 2, c * 0.8);
      grad.addColorStop(0, `rgba(20, 14, 10, ${0.25 + wear * 0.35})`);
      grad.addColorStop(1, 'rgba(20, 14, 10, 0)');
      g.fillStyle = grad;
      g.fillRect(px, py, c, c);
    }
    g.restore();
  }

  function paintWallCell(g, arena, x, y) {
    const c = arena.cell;
    g.clearRect(x * c, y * c, c, c);
    if (arena.walls[y][x] !== 1) return;
    if (isOuterCell(arena, x, y)) paintConcrete(g, arena, x, y);
    else paintBrick(g, arena, x, y, arena.maxWallHp - arena.wallHp[y][x], arena.maxWallHp);
  }

  function buildWallLayer(arena) {
    const layer = document.createElement('canvas');
    layer.width = arena.width;
    layer.height = arena.height;
    const g = layer.getContext('2d');
    for (let y = 0; y < arena.rows; y++) {
      for (let x = 0; x < arena.cols; x++) paintWallCell(g, arena, x, y);
    }
    // Inner shadow along the concrete perimeter so it reads as a raised wall.
    const edge = arena.cell / 2;
    g.fillStyle = 'rgba(0, 0, 0, 0.35)';
    g.fillRect(edge, edge, arena.width - 2 * edge, 3);
    g.fillRect(edge, edge, 3, arena.height - 2 * edge);
    return layer;
  }

  // Soft drop shadow cast by the walls, rebuilt whenever a wall changes.
  function buildShadowLayer(arena) {
    const layer = document.createElement('canvas');
    layer.width = arena.width;
    layer.height = arena.height;
    const g = layer.getContext('2d');
    g.shadowColor = 'rgba(0, 0, 0, 0.55)';
    g.shadowBlur = 8;
    g.shadowOffsetX = 5;
    g.shadowOffsetY = 6;
    g.fillStyle = '#000';
    const c = arena.cell;
    for (let y = 0; y < arena.rows; y++) {
      for (let x = 0; x < arena.cols; x++) {
        if (arena.walls[y][x] !== 1) continue;
        for (const [x0, y0, x1, y1] of wallRects(arena, x, y)) g.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
    // Keep only the shadow, not the black blocks themselves (they sit under the wall layer anyway).
    return layer;
  }

  // A brick block shot to pieces leaves broken bricks scattered on the ground.
  function scatterRubble(arena, x, y) {
    const g = state.fieldLayer.getContext('2d');
    const c = arena.cell;
    const rand = seededRandom(x * 31 + y * 977);
    for (let k = 0; k < 16; k++) {
      const rx = x * c + c / 2 + (rand() - 0.5) * c * 1.4;
      const ry = y * c + c / 2 + (rand() - 0.5) * c * 1.4;
      g.save();
      g.translate(rx, ry);
      g.rotate(rand() * Math.PI);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(-2, -1, 5, 3.5);
      g.fillStyle = rand() < 0.75 ? BRICK_TONES[Math.floor(rand() * BRICK_TONES.length)] : MORTAR;
      g.fillRect(-2.5, -1.5, 3 + rand() * 4, 2 + rand() * 2);
      g.restore();
    }
    const grad = g.createRadialGradient(x * c + c / 2, y * c + c / 2, 0, x * c + c / 2, y * c + c / 2, c);
    grad.addColorStop(0, 'rgba(120, 95, 75, 0.35)');
    grad.addColorStop(1, 'rgba(120, 95, 75, 0)');
    g.fillStyle = grad;
    g.fillRect(x * c - c / 2, y * c - c / 2, c * 2, c * 2);
  }

  function onWallHit(ev, now) {
    const { arena } = state;
    arena.wallHp[ev.cy][ev.cx] = ev.hp;
    if (ev.hp <= 0) {
      arena.walls[ev.cy][ev.cx] = 0;
      scatterRubble(arena, ev.cx, ev.cy);
      state.shadowLayer = buildShadowLayer(arena);
      const c = arena.cell;
      state.blasts.push({ x: (ev.cx + 0.5) * c, y: (ev.cy + 0.5) * c, start: now, kind: 'collapse' });
      playSound('collapse', (ev.cx + 0.5) * c, (ev.cy + 0.5) * c);
    }
    paintWallCell(state.wallLayer.getContext('2d'), arena, ev.cx, ev.cy);
  }

  function buildFieldLayer(arena) {
    const layer = document.createElement('canvas');
    layer.width = arena.width;
    layer.height = arena.height;
    const g = layer.getContext('2d');
    paintGround(g, arena, seededRandom(19771977));
    return layer;
  }

  // Battle damage stays on the ground for the rest of the game.
  function addScorch(x, y, big) {
    if (!state.fieldLayer) return;
    const g = state.fieldLayer.getContext('2d');
    const r = big ? 26 : 9;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(15, 12, 8, ${big ? 0.5 : 0.55})`);
    grad.addColorStop(1, 'rgba(15, 12, 8, 0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
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
    state.wallLayer = buildWallLayer(payload.arena);
    state.shadowLayer = buildShadowLayer(payload.arena);
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
    state.mines = payload.mines || [];
    smoke = [];
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
    state.mines = snapshot.mines || [];
    const now = performance.now();
    state.lastSnapshotAt = now;

    snapshot.events.forEach((ev) => {
      if (ev.type === 'fire') {
        playSound('fire', ev.x, ev.y);
        state.blasts.push({ x: ev.x, y: ev.y, start: now, kind: 'muzzle' });
      } else if (ev.type === 'hit') {
        state.blasts.push({ x: ev.x, y: ev.y, start: now, kind: 'explosion' });
        for (let i = 0; i < 10; i++) emitSmoke(ev.x, ev.y, now, true);
        addScorch(ev.x, ev.y, true);
        playSound('explosion', ev.x, ev.y, ev.id === state.playerId ? 1.4 : 1);
        if (ev.hadFlag) playSound(ev.id === state.playerId ? 'flagLost' : 'flagRespawn', ev.x, ev.y);
      } else if (ev.type === 'mineDropped') {
        if (ev.by === state.playerId) playSound('mineDropped', ev.x, ev.y);
      } else if (ev.type === 'mineExploded') {
        // The 'hit' event that follows handles the tank explosion; add a bigger ground blast here.
        state.blasts.push({ x: ev.x, y: ev.y, start: now, kind: 'explosion' });
        addScorch(ev.x, ev.y, true);
        playSound('mineBlast', ev.x, ev.y);
      } else if (ev.type === 'wallHit') {
        onWallHit(ev, now);
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
    ctx.font = '600 10px Geist, sans-serif';
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

  const BLAST_MS = { muzzle: 120, impact: 350, explosion: 1100, collapse: 900 };

  // Smoke pours out of a tank after it's hit and keeps trailing while it spins out.
  const SMOKE_MS = 1400;
  let smoke = [];
  let lastSmokeAt = 0;

  function emitSmoke(x, y, now, heavy) {
    smoke.push({
      x: x + (Math.random() - 0.5) * 10,
      y: y + (Math.random() - 0.5) * 10,
      vx: (Math.random() - 0.5) * 14,
      vy: -10 - Math.random() * 16,
      r: (heavy ? 7 : 5) + Math.random() * 4,
      dark: heavy || Math.random() < 0.5,
      start: now,
    });
  }

  function drawSmoke(now) {
    smoke = smoke.filter((p) => now - p.start < SMOKE_MS);
    smoke.forEach((p) => {
      const t = (now - p.start) / SMOKE_MS;
      const secs = (now - p.start) / 1000;
      ctx.globalAlpha = (p.dark ? 0.55 : 0.4) * (1 - t);
      ctx.fillStyle = p.dark ? '#1f1c19' : '#5a554e';
      ctx.beginPath();
      ctx.arc(p.x + p.vx * secs, p.y + p.vy * secs, p.r * (1 + t * 1.8), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

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
      } else if (b.kind === 'collapse') {
        if (!b.bits) b.bits = Array.from({ length: 12 }, () => ({ a: Math.random() * Math.PI * 2, v: 20 + Math.random() * 40, s: 2 + Math.random() * 3 }));
        ctx.globalAlpha = 0.55 * (1 - t);
        ctx.fillStyle = '#8a6a55';
        ctx.beginPath();
        ctx.arc(b.x, b.y - 8 * t, 14 + 22 * t, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1 - t;
        b.bits.forEach((d) => {
          ctx.fillStyle = '#a8432f';
          ctx.fillRect(b.x + Math.cos(d.a) * d.v * t, b.y + Math.sin(d.a) * d.v * t, d.s, d.s * 0.6);
        });
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

  // Landmines: a low disc in the owner's colour ring; armed mines blink a red light.
  function drawMine(m, now) {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.beginPath();
    ctx.ellipse(m.x + 1.5, m.y + 2, 8, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    const grad = ctx.createRadialGradient(m.x - 2, m.y - 2, 1, m.x, m.y, 8);
    grad.addColorStop(0, '#6b6a5c');
    grad.addColorStop(1, '#2b2b24');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Pressure plate and spokes.
    ctx.fillStyle = '#4a4a40';
    ctx.beginPath();
    ctx.arc(m.x, m.y, 3, 0, Math.PI * 2);
    ctx.fill();
    const blink = m.armed && Math.floor(now / 400) % 2 === 0;
    ctx.fillStyle = blink ? '#ff3b2f' : m.armed ? '#5a1a14' : '#8a8a70';
    if (blink) {
      ctx.shadowColor = '#ff3b2f';
      ctx.shadowBlur = 6;
    }
    ctx.beginPath();
    ctx.arc(m.x, m.y, 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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
    const el = $('timer');
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('low', secs <= 10);
  }

  // The host runs the game; everyone else interpolates between the last two snapshots.
  function render(now) {
    state.rafId = requestAnimationFrame(render);
    if (!state.arena || $('game-view').style.display === 'none') return;

    const alpha = Math.min(1, (now - state.lastSnapshotAt) / state.tickMs);
    ctx.drawImage(state.fieldLayer, 0, 0);
    ctx.drawImage(state.shadowLayer, 0, 0);
    ctx.drawImage(state.wallLayer, 0, 0);
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

    state.mines.forEach((m) => drawMine(m, now));
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

    const emit = now - lastSmokeAt > 45;
    if (emit) {
      lastSmokeAt = now;
      positions.forEach(([p, x, y]) => { if (p.status === 'hit') emitSmoke(x, y, now, false); });
    }
    drawSmoke(now);
    drawBlasts(now);
    // Bubbles go on top so a tank never covers another player's name.
    positions.forEach(([p, x, y]) => drawNameBubble(p, x, y - (p.hasFlag ? 30 : 16)));
  }

  // Debug aid: ?debug exposes onWallHit so wall damage can be previewed from the console.
  if (new URLSearchParams(location.search).has('debug')) window.__tankmatesDebug = { onWallHit, state };

  // Debug aid: ?showcase draws all four tank designs large on the lobby screen.
  if (new URLSearchParams(location.search).has('showcase')) {
    const sc = document.createElement('canvas');
    sc.width = 640;
    sc.height = 240;
    sc.style.cssText = 'display:block;margin:0 auto 16px;background:#3d4a24;border-radius:8px';
    document.querySelector('header').after(sc);
    const g = sc.getContext('2d');
    ['#cf5353', '#8286ff', '#fafd00', '#ae66de'].forEach((color, i) => drawTank(g, { number: i + 1, color }, 90 + i * 155, 125, -90, 3));
  }

  buildSlots();
  renderSlots();
  requestAnimationFrame(animateSlots);
  enterRoomFromUrl();
})();
