// Authoritative Tankmates game engine, based on the rules of RetroTanks (github.com/enesser/retroTanks,
// MIT, Eric J Nesser), itself a take on Atari Combat (1977). Runs in the host's browser
// (window.TankmatesEngine) and in Node for tests (require). It knows nothing about networking:
// the caller supplies broadcast(event, data) and send(playerId, event, data).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./arena.js'));
  else root.TankmatesEngine = factory(root.TankmatesArena);
})(typeof self !== 'undefined' ? self : this, ({ buildArena }) => {
  const TICK_RATE = 30;
  const MAX_PLAYERS = 4;
  const TANK_RADIUS = 16; // covers the drawn tracks so tanks never overlap walls
  const TANK_SPEED = 2.6; // px per tick forward
  const REVERSE_SPEED = 1.8;
  const TURN_SPEED = 5; // degrees per tick
  const BULLET_SPEED = 9;
  const BULLET_LIFE_TICKS = 2 * TICK_RATE;
  const BULLET_SUBSTEP = 3;
  const MUZZLE_OFFSET = 26; // shells leave from the barrel tip
  const FIRE_COOLDOWN_TICKS = 12;
  const MAX_BULLETS_PER_TANK = 1; // one shell in flight at a time, like Combat
  const SPIN_TICKS = Math.round(1.2 * TICK_RATE); // a hit tank spins out before respawning
  const SPIN_SPEED = 15;
  const INVULNERABLE_TICKS = 2 * TICK_RATE;
  // Capture the flag: hold the flag to score; shooting the holder makes them drop it on the spot.
  const WIN_SCORE = 60;
  const MINE_ARM_TICKS = TICK_RATE; // a mine arms 1s after being dropped, so you can drive off it
  const MINE_TRIGGER_RADIUS = 20;
  const MINE_DROP_OFFSET = 24; // dropped just behind the tank
  const WALL_HP = 3; // shots for an interior brick block to crumble away; the outer wall can't be destroyed
  const HOLD_TICKS_PER_POINT = TICK_RATE; // 1 point per second holding the flag
  const HIT_POINTS = 2;
  const FLAG_PICKUP_RADIUS = 24;
  const FLAG_CLEARANCE = 20; // flag spots keep this far from walls
  const FLAG_MIN_TANK_DISTANCE = 220; // respawned flags appear away from tanks
  const GAME_SECONDS = 180;
  const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion with 1/0
  // Atari Combat palette (from RetroTanks).
  const PLAYER_COLORS = ['#cf5353', '#8286ff', '#fafd00', '#ae66de'];
  const PLAYER_NAMES = [
    'BOOM', 'BLAM', 'ZOOM', 'TANK', 'RUST', 'IRON', 'BOLT', 'DASH', 'JAZZ', 'FLUX',
    'NOVA', 'MOJO', 'ZEST', 'BUZZ', 'ECHO', 'YETI', 'KIWI', 'HOOT', 'ZINC', 'ONYX',
    'OPAL', 'DINO', 'ROXY', 'CHIP', 'DUKE', 'GRIT', 'HAWK', 'MACE', 'TACO', 'WISP',
  ];

  const ARENA = buildArena();
  const randInt = (n) => Math.floor(Math.random() * n);
  const rad = (deg) => (deg * Math.PI) / 180;
  const normAngle = (a) => ((a % 360) + 360) % 360;

  function generateRoomCode(isTaken = () => false) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += ROOM_CODE_ALPHABET[randInt(ROOM_CODE_ALPHABET.length)];
      if (!isTaken(code)) return code;
    }
    throw new Error('Unable to allocate a unique room code');
  }

  // ---------- Geometry ----------

  const isOuterCell = (cx, cy) => cx === 0 || cy === 0 || cx === ARENA.cols - 1 || cy === ARENA.rows - 1;

  function wallCellAt(px, py) {
    return { cx: Math.floor(px / ARENA.cell), cy: Math.floor(py / ARENA.cell) };
  }

  // Solid area of a wall cell. The outer concrete wall is only half a cell thick (its outer half),
  // giving the playing field more room.
  function wallRect(cx, cy) {
    const c = ARENA.cell;
    let x0 = cx * c;
    let y0 = cy * c;
    let x1 = x0 + c;
    let y1 = y0 + c;
    if (cx === 0) x1 = x0 + c / 2;
    if (cx === ARENA.cols - 1) x0 = x1 - c / 2;
    if (cy === 0) y1 = y0 + c / 2;
    if (cy === ARENA.rows - 1) y0 = y1 - c / 2;
    return [x0, y0, x1, y1];
  }

  function isWallAt(px, py, walls = ARENA.walls) {
    const { cx, cy } = wallCellAt(px, py);
    if (cy < 0 || cy >= ARENA.rows || cx < 0 || cx >= ARENA.cols) return true;
    if (walls[cy][cx] !== 1) return false;
    const [x0, y0, x1, y1] = wallRect(cx, cy);
    return px >= x0 && px < x1 && py >= y0 && py < y1;
  }

  // Does a circle overlap any wall cell?
  function circleHitsWall(x, y, r, walls = ARENA.walls) {
    const c = ARENA.cell;
    const x0 = Math.floor((x - r) / c);
    const x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c);
    const y1 = Math.floor((y + r) / c);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        if (cy < 0 || cy >= ARENA.rows || cx < 0 || cx >= ARENA.cols || walls[cy][cx] === 1) {
          const [x0, y0, x1, y1] = cy < 0 || cy >= ARENA.rows || cx < 0 || cx >= ARENA.cols
            ? [cx * c, cy * c, (cx + 1) * c, (cy + 1) * c]
            : wallRect(cx, cy);
          const nx = Math.max(x0, Math.min(x, x1));
          const ny = Math.max(y0, Math.min(y, y1));
          if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return true;
        }
      }
    }
    return false;
  }

  const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

  // Every open spot the flag may appear on (cell centres clear of walls).
  const FLAG_SPOTS = [];
  for (let cy = 0; cy < ARENA.rows; cy++) {
    for (let cx = 0; cx < ARENA.cols; cx++) {
      const x = (cx + 0.5) * ARENA.cell;
      const y = (cy + 0.5) * ARENA.cell;
      if (!circleHitsWall(x, y, FLAG_CLEARANCE)) FLAG_SPOTS.push({ x, y });
    }
  }
  // Each game starts with the flag in the channel through the centre bunker.
  const FLAG_START = { x: ARENA.width / 2, y: ARENA.height / 2 };

  // ---------- Players ----------

  const EMPTY_INPUT = { forward: false, back: false, left: false, right: false, fire: false, mine: false };

  function serializePlayer(p) {
    return {
      id: p.id,
      number: p.number,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      angle: p.angle,
      moving: p.moving,
      score: p.score,
      hasFlag: !!p.hasFlag,
      status: p.status,
      invulnerable: p.invulnerableTicks > 0,
    };
  }

  function serializeMine(m, tick) {
    return { id: m.id, owner: m.owner, color: m.color, x: m.x, y: m.y, armed: tick >= m.armTick };
  }

  function serializeBullet(b) {
    return { id: b.id, owner: b.owner, color: b.color, x: b.x, y: b.y };
  }

  class GameRoom {
    /**
     * @param {string} code room code
     * @param {object} hooks broadcast(event, data), send(playerId, event, data), optional setInterval/clearInterval
     */
    constructor(code, hooks) {
      this.code = code;
      this.broadcast = hooks.broadcast;
      this.send = hooks.send;
      this.setInterval = hooks.setInterval || ((fn, ms) => setInterval(fn, ms));
      this.clearInterval = hooks.clearInterval || ((id) => clearInterval(id));
      this.hostId = null;
      this.players = new Map();
      this.bullets = [];
      this.mines = [];
      this.nextBulletId = 1;
      this.started = false;
      this.loop = null;
      this.tick = 0;
      this.ticksLeft = 0;
      this.flag = { ...FLAG_START, holder: null };
      this.resetWalls();
    }

    // Each room has its own copy of the walls, with hit points for the destructible brick blocks.
    resetWalls() {
      this.walls = ARENA.walls.map((row) => [...row]);
      this.wallHp = ARENA.walls.map((row, cy) => row.map((t, cx) => (t === 1 && !isOuterCell(cx, cy) ? WALL_HP : 0)));
    }

    get size() {
      return this.players.size;
    }

    // Adds a player without messaging anyone; call announceJoin() after acknowledging the joiner.
    // preferredName keeps a player's name when they move to a new host after a handover.
    join(id, preferredName) {
      if (this.players.has(id)) return { ok: false, error: 'Already in this room.' };
      if (this.players.size >= MAX_PLAYERS) return { ok: false, error: 'Room is full (max 4 players)!' };

      const taken = new Set([...this.players.values()].map((p) => p.number));
      let number = 1;
      while (taken.has(number)) number++;
      const usedNames = new Set([...this.players.values()].map((p) => p.name));
      const names = PLAYER_NAMES.filter((n) => !usedNames.has(n));
      const name = names.includes(preferredName) ? preferredName : names[randInt(names.length)];
      const player = { id, number, name, color: PLAYER_COLORS[number - 1], score: 0 };
      this.resetPlayer(player);
      this.players.set(id, player);
      // Mid-game joiners drop in at a free spawn, briefly protected.
      if (this.started) this.respawn(player);
      if (!this.hostId) this.hostId = id;
      return { ok: true, payload: { playerId: id, ...this.lobbyPayload() } };
    }

    announceJoin(id) {
      this.broadcastLobby();
      if (this.started) this.send(id, 'gameStarted', this.gamePayload());
    }

    leave(id) {
      const leaver = this.players.get(id);
      if (!this.players.delete(id)) return;
      if (leaver.hasFlag) this.respawnFlag();
      this.bullets = this.bullets.filter((b) => b.owner !== id);
      this.mines = this.mines.filter((m) => m.owner !== id);
      if (this.players.size === 0) {
        this.stopLoop();
        return;
      }
      if (this.hostId === id) this.hostId = this.players.keys().next().value;
      this.broadcastLobby();
    }

    // Any player in the room can start (or restart) the game.
    start(requesterId) {
      if (this.started || !this.players.has(requesterId)) return false;
      this.tick = 0;
      this.ticksLeft = GAME_SECONDS * TICK_RATE;
      this.bullets = [];
      this.mines = [];
      this.started = true;
      this.flag = { ...FLAG_START, holder: null };
      this.resetWalls();
      this.players.forEach((p) => {
        p.score = 0;
        this.resetPlayer(p);
      });

      this.broadcast('gameStarted', this.gamePayload());
      this.stopLoop();
      this.loop = this.setInterval(() => this.gameTick(), 1000 / TICK_RATE);
      return true;
    }

    // Clients send which controls are held; the engine owns all positions and shots.
    input(id, controls) {
      const player = this.started && this.players.get(id);
      if (!player || !controls || typeof controls !== 'object') return;
      const next = {};
      for (const key of Object.keys(EMPTY_INPUT)) next[key] = controls[key] === true;
      player.input = next;
    }

    destroy() {
      this.stopLoop();
      this.started = false;
    }

    // ---------- internals ----------

    resetPlayer(p) {
      const spawn = ARENA.spawns[p.number - 1];
      p.x = spawn.x;
      p.y = spawn.y;
      p.angle = spawn.angle;
      p.status = 'alive';
      p.spinTicks = 0;
      p.invulnerableTicks = 0;
      p.cooldown = 0;
      p.firePrev = false;
      p.minePrev = false;
      p.moving = false;
      p.input = { ...EMPTY_INPUT };
      p.hasFlag = false;
      p.holdTicks = 0;
    }

    // Respawn at the player's own corner if it's clear, otherwise the spawn furthest from other tanks.
    respawn(p) {
      const others = [...this.players.values()].filter((o) => o !== p && o.status === 'alive');
      const clearance = (s) => Math.min(Infinity, ...others.map((o) => dist2(o, s)));
      const own = ARENA.spawns[p.number - 1];
      let spawn = own;
      if (clearance(own) < (TANK_RADIUS * 4) ** 2) {
        spawn = [...ARENA.spawns].sort((a, b) => clearance(b) - clearance(a))[0];
      }
      p.x = spawn.x;
      p.y = spawn.y;
      p.angle = spawn.angle;
      p.status = 'alive';
      p.spinTicks = 0;
      p.invulnerableTicks = INVULNERABLE_TICKS;
      p.cooldown = 0;
      p.moving = false;
    }

    lobbyPayload() {
      return {
        roomCode: this.code,
        hostId: this.hostId,
        started: this.started,
        players: [...this.players.values()].map(serializePlayer).sort((a, b) => a.number - b.number),
      };
    }

    gamePayload() {
      return {
        arena: { width: ARENA.width, height: ARENA.height, cols: ARENA.cols, rows: ARENA.rows, cell: ARENA.cell, walls: this.walls, wallHp: this.wallHp, maxWallHp: WALL_HP },
        tickRate: TICK_RATE,
        winScore: WIN_SCORE,
        ticksLeft: this.ticksLeft,
        bullets: this.bullets.map(serializeBullet),
        mines: this.mines.map((m) => serializeMine(m, this.tick)),
        flag: this.serializeFlag(),
        ...this.lobbyPayload(),
      };
    }

    serializeFlag() {
      return { x: this.flag.x, y: this.flag.y, holder: this.flag.holder };
    }

    // Puts the flag on a random open spot away from every tank (falling back to the furthest spot).
    respawnFlag(events) {
      const tanks = [...this.players.values()].filter((p) => p.status === 'alive');
      const clearance = (s) => Math.min(Infinity, ...tanks.map((t) => dist2(t, s)));
      const far = FLAG_SPOTS.filter((s) => clearance(s) >= FLAG_MIN_TANK_DISTANCE ** 2);
      const spot = far.length
        ? far[randInt(far.length)]
        : FLAG_SPOTS.reduce((best, s) => (clearance(s) > clearance(best) ? s : best), FLAG_SPOTS[0]);
      this.players.forEach((p) => { p.hasFlag = false; });
      this.flag = { x: spot.x, y: spot.y, holder: null };
      if (events) events.push({ type: 'flagRespawn', x: spot.x, y: spot.y });
    }

    // The holder was shot: the flag falls where their tank was hit, ready for anyone to grab.
    dropFlag(holder, events) {
      holder.hasFlag = false;
      this.flag = { x: holder.x, y: holder.y, holder: null };
      events.push({ type: 'flagDropped', x: holder.x, y: holder.y });
    }

    stepFlag(events) {
      const holder = this.flag.holder && this.players.get(this.flag.holder);
      if (holder) {
        this.flag.x = holder.x;
        this.flag.y = holder.y;
        if (++holder.holdTicks % HOLD_TICKS_PER_POINT === 0) holder.score++;
        return;
      }
      for (const p of this.players.values()) {
        if (p.status !== 'alive' || dist2(p, this.flag) > FLAG_PICKUP_RADIUS ** 2) continue;
        p.hasFlag = true;
        p.holdTicks = 0;
        this.flag = { x: p.x, y: p.y, holder: p.id };
        events.push({ type: 'flagTaken', by: p.id });
        return;
      }
    }

    broadcastLobby() {
      this.broadcast('lobbyUpdate', this.lobbyPayload());
    }

    stopLoop() {
      if (this.loop !== null) this.clearInterval(this.loop);
      this.loop = null;
    }

    gameTick() {
      this.tick++;
      this.ticksLeft--;
      const events = [];
      this.players.forEach((p) => this.stepPlayer(p, events));
      this.stepBullets(events);
      this.stepMines(events);
      this.stepFlag(events);

      this.broadcast('state', {
        tick: this.tick,
        ticksLeft: this.ticksLeft,
        players: [...this.players.values()].map(serializePlayer),
        bullets: this.bullets.map(serializeBullet),
        mines: this.mines.map((m) => serializeMine(m, this.tick)),
        flag: this.serializeFlag(),
        events,
      });

      const leader = [...this.players.values()].sort((a, b) => b.score - a.score)[0];
      if (leader && leader.score >= WIN_SCORE) this.endGame('win', leader.id);
      else if (this.ticksLeft <= 0) this.endGame('time');
    }

    endGame(reason, winnerId = null) {
      this.stopLoop();
      this.started = false;
      this.bullets = [];
      this.mines = [];
      const standings = [...this.players.values()].map(serializePlayer).sort((a, b) => b.score - a.score);
      this.broadcast('gameOver', { standings, reason, winnerId });
      this.broadcastLobby();
    }

    stepPlayer(p, events) {
      if (p.invulnerableTicks > 0) p.invulnerableTicks--;
      if (p.cooldown > 0) p.cooldown--;

      if (p.status === 'hit') {
        p.angle = normAngle(p.angle + SPIN_SPEED);
        if (--p.spinTicks <= 0) {
          this.respawn(p);
          events.push({ type: 'respawn', id: p.id });
        }
        return;
      }

      const { forward, back, left, right, fire } = p.input;
      if (left) p.angle = normAngle(p.angle - TURN_SPEED);
      if (right) p.angle = normAngle(p.angle + TURN_SPEED);

      const speed = forward ? TANK_SPEED : back ? -REVERSE_SPEED : 0;
      p.moving = speed !== 0 || left || right;
      if (speed) {
        const dx = Math.cos(rad(p.angle)) * speed;
        const dy = Math.sin(rad(p.angle)) * speed;
        // Move each axis separately so tanks slide along walls instead of sticking.
        if (this.canOccupy(p, p.x + dx, p.y)) p.x += dx;
        if (this.canOccupy(p, p.x, p.y + dy)) p.y += dy;
      }

      // Fire on press (not while held), one shell in flight at a time.
      if (fire && !p.firePrev) this.tryFire(p, events);
      p.firePrev = fire;
      if (p.input.mine && !p.minePrev) this.tryDropMine(p, events);
      p.minePrev = p.input.mine;
    }

    canOccupy(p, x, y) {
      if (circleHitsWall(x, y, TANK_RADIUS, this.walls)) return false;
      for (const o of this.players.values()) {
        if (o === p || o.status !== 'alive') continue;
        const before = dist2(p, o);
        const after = (x - o.x) ** 2 + (y - o.y) ** 2;
        // Tanks can't drive into each other, but can always move apart if they somehow overlap.
        if (after < (TANK_RADIUS * 2) ** 2 && after < before) return false;
      }
      return true;
    }

    tryFire(p, events) {
      if (p.cooldown > 0) return;
      if (this.bullets.filter((b) => b.owner === p.id).length >= MAX_BULLETS_PER_TANK) return;
      const x = p.x + Math.cos(rad(p.angle)) * MUZZLE_OFFSET;
      const y = p.y + Math.sin(rad(p.angle)) * MUZZLE_OFFSET;
      p.cooldown = FIRE_COOLDOWN_TICKS;
      events.push({ type: 'fire', by: p.id, x, y });
      if (isWallAt(x, y, this.walls)) { // barrel against a wall: the shell hits it point blank
        this.damageWall(x, y, events);
        return;
      }
      this.bullets.push({
        id: this.nextBulletId++,
        owner: p.id,
        color: p.color,
        x,
        y,
        vx: Math.cos(rad(p.angle)) * BULLET_SPEED,
        vy: Math.sin(rad(p.angle)) * BULLET_SPEED,
        life: BULLET_LIFE_TICKS,
      });
    }

    // A shell knocks bricks out of the block it hits; at 0 hit points the block crumbles away.
    damageWall(x, y, events) {
      const { cx, cy } = wallCellAt(x, y);
      if (!this.wallHp[cy] || !this.wallHp[cy][cx]) return;
      const hp = --this.wallHp[cy][cx];
      if (hp <= 0) this.walls[cy][cx] = 0;
      events.push({ type: 'wallHit', cx, cy, hp });
    }

    // A tank is knocked out (by a shell or a mine): the attacker scores, the tank spins out,
    // and any flag it carried drops where it was hit.
    destroyTank(t, attackerId, events, cause) {
      const attacker = attackerId !== t.id && this.players.get(attackerId);
      if (attacker) attacker.score += HIT_POINTS;
      const hadFlag = !!t.hasFlag;
      t.status = 'hit';
      t.spinTicks = SPIN_TICKS;
      t.moving = false;
      events.push({ type: 'hit', by: attackerId, id: t.id, x: t.x, y: t.y, hadFlag, cause });
      if (hadFlag) this.dropFlag(t, events);
    }

    // One mine per player at a time, dropped behind the tank.
    tryDropMine(p, events) {
      if (this.mines.some((m) => m.owner === p.id)) return;
      let x = p.x - Math.cos(rad(p.angle)) * MINE_DROP_OFFSET;
      let y = p.y - Math.sin(rad(p.angle)) * MINE_DROP_OFFSET;
      if (circleHitsWall(x, y, 6, this.walls)) {
        x = p.x;
        y = p.y;
      }
      const mine = { id: this.nextBulletId++, owner: p.id, color: p.color, x, y, armTick: this.tick + MINE_ARM_TICKS };
      this.mines.push(mine);
      events.push({ type: 'mineDropped', by: p.id, x, y });
    }

    stepMines(events) {
      this.mines = this.mines.filter((m) => {
        if (this.tick < m.armTick) return true;
        for (const t of this.players.values()) {
          if (t.status !== 'alive' || t.invulnerableTicks > 0) continue;
          if (dist2(t, m) > MINE_TRIGGER_RADIUS ** 2) continue;
          events.push({ type: 'mineExploded', by: m.owner, id: t.id, x: m.x, y: m.y });
          this.destroyTank(t, m.owner, events, 'mine');
          return false;
        }
        return true;
      });
    }

    stepBullets(events) {
      const steps = Math.ceil(BULLET_SPEED / BULLET_SUBSTEP);
      this.bullets = this.bullets.filter((b) => {
        if (--b.life <= 0) return false;
        for (let i = 0; i < steps; i++) {
          b.x += b.vx / steps;
          b.y += b.vy / steps;
          if (isWallAt(b.x, b.y, this.walls)) {
            events.push({ type: 'impact', x: b.x, y: b.y });
            this.damageWall(b.x, b.y, events);
            return false;
          }
          for (const t of this.players.values()) {
            if (t.id === b.owner || t.status !== 'alive' || t.invulnerableTicks > 0) continue;
            if (dist2(t, b) > TANK_RADIUS * TANK_RADIUS) continue;
            this.destroyTank(t, b.owner, events, 'shell');
            return false;
          }
        }
        return true;
      });
    }
  }

  return {
    GameRoom,
    generateRoomCode,
    ARENA,
    TICK_RATE,
    MAX_PLAYERS,
    TANK_RADIUS,
    WIN_SCORE,
    HIT_POINTS,
    HOLD_TICKS_PER_POINT,
    FLAG_START,
    FLAG_SPOTS,
    GAME_SECONDS,
    WALL_HP,
    MINE_ARM_TICKS,
    SPIN_TICKS,
    INVULNERABLE_TICKS,
    BULLET_LIFE_TICKS,
    circleHitsWall,
    wallRect,
  };
});
