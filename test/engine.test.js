const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GameRoom, generateRoomCode, ARENA, TANK_RADIUS, WIN_SCORE, GAME_SECONDS, TICK_RATE,
  SPIN_TICKS, INVULNERABLE_TICKS, BULLET_LIFE_TICKS, circleHitsWall, wallRect, wallRects,
  HIT_POINTS, HOLD_TICKS_PER_POINT, FLAG_START, FLAG_SPOTS, WALL_HP, MINE_ARM_TICKS, TANK_SPEED, BOOST,
} = require('../public/engine.js');

// Builds a room with a manual clock and records every message it sends.
function makeRoom() {
  const sent = [];
  let tickFn = null;
  const room = new GameRoom('TEST', {
    broadcast: (ev, data) => sent.push({ to: '*', ev, data }),
    send: (to, ev, data) => sent.push({ to, ev, data }),
    setInterval: (fn) => { tickFn = fn; return 1; },
    clearInterval: () => { tickFn = null; },
    shuffleMap: false,
  });
  const run = (n = 1) => { for (let i = 0; i < n && tickFn; i++) tickFn(); };
  const last = (ev) => [...sent].reverse().find((m) => m.ev === ev);
  const events = (type) => sent.filter((m) => m.ev === 'state').flatMap((m) => m.data.events).filter((e) => e.type === type);
  return { room, sent, run, last, events, isRunning: () => tickFn !== null };
}

function startedRoom(playerCount = 2) {
  const ctx = makeRoom();
  for (let i = 1; i <= playerCount; i++) ctx.room.join(`p${i}`);
  ctx.room.start('p1');
  parkFlag(ctx.room);
  return ctx;
}

// Moves the flag out of reach so it doesn't affect tests that aren't about the flag.
function parkFlag(room) {
  room.flag = { x: -1000, y: -1000, holder: null };
}

const press = (room, id, controls) => room.input(id, { forward: false, back: false, left: false, right: false, fire: false, mine: false, boost: false, ...controls });

// Puts two tanks on the same open row, the shooter facing the target.
function lineUp(room, shooter, target, gap = 120) {
  Object.assign(shooter, { x: 200, y: 60, angle: 0, invulnerableTicks: 0 });
  Object.assign(target, { x: 200 + gap, y: 60, angle: 180, invulnerableTicks: 0 });
}

test('room codes are 4 letters without I or O', () => {
  for (let i = 0; i < 500; i++) assert.match(generateRoomCode(), /^[A-HJ-NP-Z]{4}$/);
  assert.throws(() => generateRoomCode(() => true));
});

test('arena is mirrored with 4 clear corner spawns aimed at the centre', () => {
  assert.equal(ARENA.width, 1200);
  assert.equal(ARENA.height, 720);
  ARENA.layout.forEach((row) => assert.equal(row, [...row].reverse().join('')));
  assert.deepEqual(ARENA.layout, [...ARENA.layout].reverse());
  assert.equal(ARENA.spawns.length, 4);
  for (const s of ARENA.spawns) {
    assert.equal(circleHitsWall(s.x, s.y, TANK_RADIUS), false);
    const toCentre = Math.atan2(ARENA.height / 2 - s.y, ARENA.width / 2 - s.x) * 180 / Math.PI;
    assert.ok(Math.abs(((s.angle - toCentre + 540) % 360) - 180) <= 5);
  }
});

test('every open area of the arena is reachable by a tank', () => {
  const c = ARENA.cell;
  const open = (x, y) => !circleHitsWall((x + 0.5) * c, (y + 0.5) * c, TANK_RADIUS - 2);
  const start = [Math.floor(ARENA.spawns[0].x / c), Math.floor(ARENA.spawns[0].y / c)];
  const seen = new Set([start.join(',')]);
  const queue = [start];
  while (queue.length) {
    const [x, y] = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${x + dx},${y + dy}`;
      if (!seen.has(key) && open(x + dx, y + dy)) { seen.add(key); queue.push([x + dx, y + dy]); }
    }
  }
  for (const s of ARENA.spawns) assert.ok(seen.has(`${Math.floor(s.x / c)},${Math.floor(s.y / c)}`));
  assert.ok(seen.size > 800, `only ${seen.size} cells reachable`);
});

test('players get numbers 1-4, unique names and Combat colours; 5th rejected', () => {
  const { room } = makeRoom();
  [1, 2, 3, 4].forEach((i) => assert.ok(room.join(`p${i}`).ok));
  const players = [...room.players.values()];
  assert.deepEqual(players.map((p) => p.number), [1, 2, 3, 4]);
  assert.equal(new Set(players.map((p) => p.name)).size, 4);
  assert.equal(new Set(players.map((p) => p.color)).size, 4);
  assert.equal(room.hostId, 'p1');
  assert.match(room.join('p5').error, /full/);
});

test('any player can start; outsiders and input before the start are ignored', () => {
  const { room } = makeRoom();
  room.join('p1');
  room.join('p2');
  press(room, 'p1', { forward: true });
  assert.equal(room.players.get('p1').input.forward, false);
  assert.equal(room.start('stranger'), false);
  assert.equal(room.start('p2'), true);
});

test('game starts with tanks on their corner spawns and a timer', () => {
  const { last } = startedRoom(4);
  const payload = last('gameStarted').data;
  payload.players.forEach((p) => {
    const s = ARENA.spawns[p.number - 1];
    assert.deepEqual([p.x, p.y, p.angle], [s.x, s.y, s.angle]);
  });
  assert.equal(payload.ticksLeft, GAME_SECONDS * TICK_RATE);
  assert.equal(payload.winScore, WIN_SCORE);
});

test('tanks drive forward, reverse and turn; malformed input is ignored', () => {
  const { room, run } = startedRoom(1);
  const p = room.players.get('p1');
  const start = { x: p.x, y: p.y };
  press(room, 'p1', { forward: true });
  run(10);
  assert.ok(Math.hypot(p.x - start.x, p.y - start.y) > 20);
  room.input('p1', 'teleport');
  room.input('p1', { forward: 'yes', x: 999 });
  run(5);
  assert.equal(p.input.forward, false);
  assert.ok(p.x < 999);

  const angle = p.angle;
  press(room, 'p1', { right: true });
  run(3);
  assert.equal(p.angle, (angle + 15) % 360);
});

test('walls stop tanks', () => {
  const { room, run } = startedRoom(1);
  const p = room.players.get('p1');
  Object.assign(p, { x: 60, y: 60, angle: 180 }); // facing the left outer wall
  press(room, 'p1', { forward: true });
  run(60);
  assert.ok(p.x >= ARENA.cell / 2 + TANK_RADIUS - 0.01, `x=${p.x}`);
  assert.ok(p.x < ARENA.cell + TANK_RADIUS - 1, 'can now drive into the old wall half');
  assert.equal(circleHitsWall(p.x, p.y, TANK_RADIUS), false);
});

test('tanks cannot drive through each other', () => {
  const { room, run } = startedRoom(2);
  const [a, b] = ['p1', 'p2'].map((id) => room.players.get(id));
  lineUp(room, a, b, 60);
  press(room, 'p1', { forward: true });
  run(40);
  assert.ok(b.x - a.x >= TANK_RADIUS * 2 - 3, `gap ${b.x - a.x}`);
});

test('firing launches one shell at a time; holding fire does not auto-fire', () => {
  const { room, run, events } = startedRoom(1);
  const p = room.players.get('p1');
  Object.assign(p, { x: 200, y: 60, angle: 0 });
  press(room, 'p1', { fire: true });
  run(1);
  assert.equal(room.bullets.length, 1);
  run(20);
  assert.equal(events('fire').length, 1);
  press(room, 'p1', {});
  run(1);
  press(room, 'p1', { fire: true });
  run(1);
  assert.equal(room.bullets.length, 1, 'still only one shell in flight');
});

test('shells stop at walls and expire', () => {
  const { room, run, events } = startedRoom(1);
  const p = room.players.get('p1');
  Object.assign(p, { x: 60, y: 60, angle: 180 });
  press(room, 'p1', { fire: true });
  run(5);
  assert.equal(room.bullets.length, 0);
  assert.ok(events('impact').length >= 1);
  assert.ok(BULLET_LIFE_TICKS > 0);
});

test('a hit scores points, spins the target out, then respawns it protected', () => {
  const { room, run, events } = startedRoom(2);
  const [a, b] = ['p1', 'p2'].map((id) => room.players.get(id));
  lineUp(room, a, b);
  press(room, 'p1', { fire: true });
  run(15);
  assert.equal(a.score, HIT_POINTS);
  assert.equal(b.status, 'hit');
  assert.deepEqual(events('hit').map((e) => [e.by, e.id]), [['p1', 'p2']]);

  run(SPIN_TICKS);
  assert.equal(b.status, 'alive');
  assert.ok(b.invulnerableTicks > 0 && b.invulnerableTicks <= INVULNERABLE_TICKS);
  assert.deepEqual([b.x, b.y], [ARENA.spawns[1].x, ARENA.spawns[1].y]);
});

test('protected and spinning tanks cannot be hit again', () => {
  const { room, run } = startedRoom(2);
  const [a, b] = ['p1', 'p2'].map((id) => room.players.get(id));
  lineUp(room, a, b);
  b.invulnerableTicks = 100;
  press(room, 'p1', { fire: true });
  run(20);
  assert.equal(a.score, 0);
});

test('you cannot shoot yourself', () => {
  const { room, run } = startedRoom(1);
  const p = room.players.get('p1');
  Object.assign(p, { x: 200, y: 60, angle: 0 });
  press(room, 'p1', { fire: true });
  run(BULLET_LIFE_TICKS);
  assert.equal(p.status, 'alive');
});

test('first to the win score ends the game', () => {
  const { room, run, last, isRunning } = startedRoom(2);
  room.players.get('p2').score = WIN_SCORE - HIT_POINTS;
  const [a, b] = ['p2', 'p1'].map((id) => room.players.get(id));
  lineUp(room, a, b);
  press(room, 'p2', { fire: true });
  run(15);
  assert.equal(isRunning(), false);
  const over = last('gameOver').data;
  assert.equal(over.reason, 'win');
  assert.equal(over.winnerId, 'p2');
  assert.equal(over.standings[0].id, 'p2');
});

test('the game ends when time runs out', () => {
  const { room, run, last } = startedRoom(2);
  room.ticksLeft = 3;
  run(5);
  assert.equal(last('gameOver').data.reason, 'time');
});

test('mid-game join drops in at a free spawn without restarting the game', () => {
  const { room, run, sent } = startedRoom(2);
  run(30);
  const tickBefore = room.tick;
  assert.ok(room.join('late').ok);
  room.announceJoin('late');
  const late = room.players.get('late');
  assert.equal(late.number, 3);
  assert.ok(late.invulnerableTicks > 0);
  assert.ok(sent.some((m) => m.to === 'late' && m.ev === 'gameStarted'));
  run(5);
  assert.equal(room.tick, tickBefore + 5);
});

test('leaving migrates host; last player leaving stops the loop', () => {
  const { room, isRunning } = startedRoom(2);
  room.leave('p1');
  assert.equal(room.hostId, 'p2');
  room.leave('p2');
  assert.equal(isRunning(), false);
});

test('a preferred name is kept across host handovers when free', () => {
  const { room } = makeRoom();
  room.join('a', 'BOOM');
  assert.equal(room.players.get('a').name, 'BOOM');
  room.join('b', 'BOOM');
  assert.notEqual(room.players.get('b').name, 'BOOM');
});

test('each game starts with the flag in the centre channel, clear of walls', () => {
  const { last } = (() => { const c = makeRoom(); c.room.join('p1'); c.room.start('p1'); return c; })();
  const flag = last('gameStarted').data.flag;
  assert.deepEqual([flag.x, flag.y, flag.holder], [FLAG_START.x, FLAG_START.y, null]);
  assert.equal(circleHitsWall(FLAG_START.x, FLAG_START.y, TANK_RADIUS), false);
  assert.ok(FLAG_SPOTS.length > 500);
});

test('driving over the flag picks it up and holding it scores 1 point per second', () => {
  const { room, run, events } = startedRoom(2);
  const p = room.players.get('p1');
  room.flag = { x: p.x + 10, y: p.y, holder: null };
  run(1);
  assert.equal(room.flag.holder, 'p1');
  assert.equal(p.hasFlag, true);
  assert.deepEqual(events('flagTaken').map((e) => e.by), ['p1']);

  run(HOLD_TICKS_PER_POINT * 3);
  assert.equal(p.score, 3);
  press(room, 'p1', { forward: true });
  run(10);
  assert.deepEqual([room.flag.x, room.flag.y], [p.x, p.y], 'flag travels with the holder');
});

test('only one tank can hold the flag', () => {
  const { room, run } = startedRoom(2);
  const [a, b] = ['p1', 'p2'].map((id) => room.players.get(id));
  room.flag = { x: a.x, y: a.y, holder: null };
  run(1);
  Object.assign(b, { x: a.x + 33, y: a.y });
  run(5);
  assert.equal(room.flag.holder, 'p1');
  assert.equal(b.hasFlag, false);
});

test('shooting the flag holder makes them drop it where they were hit', () => {
  const { room, run, events } = startedRoom(2);
  const [a, b] = ['p1', 'p2'].map((id) => room.players.get(id));
  lineUp(room, a, b);
  room.flag = { x: b.x, y: b.y, holder: null };
  run(1);
  assert.equal(room.flag.holder, 'p2');

  press(room, 'p1', { fire: true });
  run(15);
  assert.equal(b.status, 'hit');
  assert.equal(b.hasFlag, false);
  assert.equal(events('hit')[0].hadFlag, true);
  const drop = events('flagDropped')[0];
  assert.ok(drop);
  assert.deepEqual([room.flag.x, room.flag.y, room.flag.holder], [drop.x, drop.y, null]);
  assert.ok(Math.abs(drop.x - b.x) < 1 && Math.abs(drop.y - b.y) < 1, 'dropped at the hit tank');

  // The spinning tank can't grab it back, but the shooter can drive over and take it.
  run(5);
  assert.equal(room.flag.holder, null);
  Object.assign(a, { x: drop.x - 10, y: drop.y });
  run(1);
  assert.equal(room.flag.holder, 'p1');
});
test('a holder leaving the room respawns the flag', () => {
  const { room, run } = startedRoom(2);
  const b = room.players.get('p2');
  room.flag = { x: b.x, y: b.y, holder: null };
  run(1);
  assert.equal(room.flag.holder, 'p2');
  room.leave('p2');
  assert.equal(room.flag.holder, null);
  assert.ok(room.flag.x > 0);
});

// The first interior brick block, and an open spot to its left on the same row to shoot from.
function brickTarget() {
  for (let cy = 1; cy < ARENA.rows - 1; cy++) {
    for (let cx = 4; cx < ARENA.cols - 1; cx++) {
      if (ARENA.walls[cy][cx] !== 1) continue;
      const x = (cx - 3 + 0.5) * ARENA.cell;
      const y = (cy + 0.5) * ARENA.cell;
      if (!circleHitsWall(x, y, TANK_RADIUS) && ARENA.walls[cy][cx - 1] === 0 && ARENA.walls[cy][cx - 2] === 0) return { cx, cy, x, y };
    }
  }
  throw new Error('no brick target');
}

test('shooting a brick block wears it down and it crumbles after enough hits', () => {
  const { room, run, events } = startedRoom(1);
  const p = room.players.get('p1');
  const t = brickTarget();
  for (let i = 1; i <= WALL_HP; i++) {
    Object.assign(p, { x: t.x, y: t.y, angle: 0, cooldown: 0 });
    press(room, 'p1', { fire: true });
    run(1);
    press(room, 'p1', {});
    run(20);
    assert.equal(room.wallHp[t.cy][t.cx], WALL_HP - i);
  }
  assert.equal(room.walls[t.cy][t.cx], 0, 'block is gone');
  assert.equal(ARENA.walls[t.cy][t.cx], 1, 'the shared arena layout is untouched');
  assert.deepEqual(events('wallHit').map((e) => e.hp), [2, 1, 0].slice(3 - WALL_HP));
  assert.equal(circleHitsWall((t.cx + 0.5) * ARENA.cell, t.y, 4, room.walls), false);
});

test('the outer concrete wall cannot be destroyed', () => {
  const { room, run } = startedRoom(1);
  const p = room.players.get('p1');
  for (let i = 0; i < WALL_HP + 2; i++) {
    Object.assign(p, { x: 60, y: 60, angle: 180, cooldown: 0 });
    press(room, 'p1', { fire: true });
    run(1);
    press(room, 'p1', {});
    run(15);
  }
  assert.equal(room.walls[2][0], 1);
});

test('a new game rebuilds destroyed walls', () => {
  const { room } = startedRoom(1);
  const t = brickTarget();
  room.walls[t.cy][t.cx] = 0;
  room.wallHp[t.cy][t.cx] = 0;
  room.endGame('time');
  room.start('p1');
  assert.equal(room.walls[t.cy][t.cx], 1);
  assert.equal(room.wallHp[t.cy][t.cx], WALL_HP);
});

// Drops a mine for player id and lets it arm.
function dropArmedMine(room, run, id) {
  press(room, id, { mine: true });
  run(1);
  press(room, id, {});
  run(MINE_ARM_TICKS + 1);
  return room.mines.find((m) => m.owner === id);
}

test('X drops a mine behind the tank; only one at a time per player', () => {
  const { room, run, events } = startedRoom(1);
  const p = room.players.get('p1');
  Object.assign(p, { x: 300, y: 60, angle: 0 });
  press(room, 'p1', { mine: true });
  run(1);
  assert.equal(room.mines.length, 1);
  assert.ok(room.mines[0].x < p.x, 'dropped behind');
  press(room, 'p1', {});
  run(1);
  press(room, 'p1', { mine: true });
  run(1);
  assert.equal(room.mines.length, 1);
  assert.equal(events('mineDropped').length, 1);
});

test('an armed mine blows up a tank that rolls over it and scores for the layer', () => {
  const { room, run, events } = startedRoom(2);
  const [a, b] = ['p1', 'p2'].map((id) => room.players.get(id));
  Object.assign(a, { x: 300, y: 60, angle: 0 });
  const mine = dropArmedMine(room, run, 'p1');
  Object.assign(a, { x: 600, y: 60 });
  Object.assign(b, { x: mine.x + 5, y: mine.y, invulnerableTicks: 0 });
  run(1);
  assert.equal(b.status, 'hit');
  assert.equal(a.score, 2);
  assert.equal(room.mines.length, 0);
  assert.equal(events('mineExploded')[0].id, 'p2');
  run(40);
  assert.equal(b.status, 'alive');
  assert.deepEqual([b.x, b.y], [ARENA.spawns[1].x, ARENA.spawns[1].y]);

  // With the old mine gone, the owner can lay a new one.
  press(room, 'p1', { mine: true });
  run(1);
  assert.equal(room.mines.length, 1);
});

test('mines do not go off before arming, and the dropper is not hit while driving away', () => {
  const { room, run } = startedRoom(1);
  const p = room.players.get('p1');
  Object.assign(p, { x: 300, y: 60, angle: 0 });
  press(room, 'p1', { mine: true });
  run(1);
  press(room, 'p1', { forward: true });
  run(MINE_ARM_TICKS + 5);
  assert.equal(p.status, 'alive');
  assert.equal(room.mines.length, 1);
});

test('your own armed mine can still get you', () => {
  const { room, run } = startedRoom(1);
  const p = room.players.get('p1');
  Object.assign(p, { x: 300, y: 60, angle: 0 });
  const mine = dropArmedMine(room, run, 'p1');
  Object.assign(p, { x: mine.x, y: mine.y });
  run(1);
  assert.equal(p.status, 'hit');
  assert.equal(p.score, 0, 'no points for blowing yourself up');
});

test('the flag carrier drops the flag where a mine gets them', () => {
  const { room, run, events } = startedRoom(2);
  const b = room.players.get('p2');
  Object.assign(room.players.get('p1'), { x: 300, y: 60, angle: 0 });
  const mine = dropArmedMine(room, run, 'p1');
  room.players.get('p1').x = 700;
  room.flag = { x: b.x, y: b.y, holder: null };
  run(1);
  assert.equal(room.flag.holder, 'p2');
  Object.assign(b, { x: mine.x, y: mine.y, invulnerableTicks: 0 });
  run(1);
  assert.equal(b.hasFlag, false);
  assert.equal(room.flag.holder, null);
  assert.ok(Math.abs(room.flag.x - mine.x) < 1);
  assert.equal(events('flagDropped').length, 1);
});

test('mines are cleared when their owner leaves and at the start of each game', () => {
  const { room, run } = startedRoom(2);
  Object.assign(room.players.get('p2'), { x: 300, y: 60, angle: 0 });
  dropArmedMine(room, run, 'p2');
  room.leave('p2');
  assert.equal(room.mines.length, 0);
  Object.assign(room.players.get('p1'), { x: 300, y: 60, angle: 0 });
  dropArmedMine(room, run, 'p1');
  room.endGame('time');
  room.start('p1');
  assert.equal(room.mines.length, 0);
});

test('the outer concrete wall is half a cell thick', () => {
  const c = ARENA.cell;
  assert.deepEqual(wallRect(0, 5), [0, 5 * c, c / 2, 6 * c]);
  assert.deepEqual(wallRect(ARENA.cols - 1, 5), [ARENA.width - c / 2, 5 * c, ARENA.width, 6 * c]);
  assert.deepEqual(wallRect(5, 0), [5 * c, 0, 6 * c, c / 2]);
  assert.equal(circleHitsWall(c / 2 + TANK_RADIUS + 0.5, ARENA.height / 2 - 100, TANK_RADIUS), false);
});

test('outer wall corners are solid L shapes with no gaps', () => {
  const c = ARENA.cell;
  const corners = [[0, 0], [ARENA.cols - 1, 0], [0, ARENA.rows - 1], [ARENA.cols - 1, ARENA.rows - 1]];
  for (const [cx, cy] of corners) assert.equal(wallRects(cx, cy).length, 2);
  // Every point along the thin perimeter strips is solid, including right next to the corners.
  for (let x = 1; x < ARENA.width; x += 3) {
    assert.ok(circleHitsWall(x, c / 4, 1), `top strip at ${x}`);
    assert.ok(circleHitsWall(x, ARENA.height - c / 4, 1), `bottom strip at ${x}`);
  }
  for (let y = 1; y < ARENA.height; y += 3) {
    assert.ok(circleHitsWall(c / 4, y, 1), `left strip at ${y}`);
    assert.ok(circleHitsWall(ARENA.width - c / 4, y, 1), `right strip at ${y}`);
  }
  // The inner quarter of a corner cell is open floor.
  assert.equal(circleHitsWall(c * 0.75, c * 0.75, 1), false);
});

test('holding boost (Shift) drives at top speed', () => {
  const { room, run } = startedRoom(1);
  const p = room.players.get('p1');
  Object.assign(p, { x: 300, y: 60, angle: 0, invulnerableTicks: 0 });
  press(room, 'p1', { forward: true });
  run(5);
  const normal = p.x - 300;
  assert.ok(Math.abs(normal - 5 * TANK_SPEED) < 0.01);
  Object.assign(p, { x: 300, y: 60, angle: 0 });
  press(room, 'p1', { forward: true, boost: true });
  run(5);
  assert.ok(Math.abs(p.x - 300 - 5 * TANK_SPEED * BOOST) < 0.01);
  assert.ok(BOOST > 1);
});

// Small deterministic random generator for repeatable shuffles.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Can a tank drive from a to b? Flood fill on a half-cell lattice, using the real collision test.
function drivable(walls, a, b) {
  const step = ARENA.cell / 2;
  const key = (x, y) => `${x},${y}`;
  const seen = new Set([key(a.x, a.y)]);
  const queue = [[a.x, a.y]];
  while (queue.length) {
    const [x, y] = queue.shift();
    if (Math.abs(x - b.x) < step && Math.abs(y - b.y) < step) return true;
    for (const [nx, ny] of [[x + step, y], [x - step, y], [x, y + step], [x, y - step]]) {
      if (seen.has(key(nx, ny)) || circleHitsWall(nx, ny, TANK_RADIUS, walls)) continue;
      seen.add(key(nx, ny));
      queue.push([nx, ny]);
    }
  }
  return false;
}

test('map shuffle nudges a few shapes but keeps the lanes, centre and spacing', () => {
  const { QUARTER, shuffleQuarter } = require('../public/arena.js');
  let changed = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const q = shuffleQuarter(QUARTER, seeded(seed));
    assert.equal(q.length, QUARTER.length);
    q.forEach((row, y) => assert.equal(row.length, QUARTER[y].length));
    // Same amount of wall, just moved around.
    const count = (rows) => rows.join('').split('#').length;
    assert.equal(count(q), count(QUARTER));
    // Border, outer lanes and the centre bunker are untouched.
    for (let y = 0; y < QUARTER.length; y++) {
      for (let x = 0; x < QUARTER[0].length; x++) {
        const fixed = x === 0 || y === 0 || x < 4 || y < 4 || x >= QUARTER[0].length - 2 || y >= QUARTER.length - 2;
        if (fixed && QUARTER[y][x] !== q[y][x]) {
          // Only the centre bunker's region may differ... and it must not.
          assert.fail(`fixed cell ${x},${y} changed (seed ${seed})`);
        }
      }
    }
    if (q.join() !== QUARTER.join()) changed++;
  }
  assert.ok(changed > 250, `most rounds get a different layout (${changed}/300)`);
});

test('every shuffled map lets each tank reach the flag and every other spawn', () => {
  const { QUARTER, shuffleQuarter, buildArena } = require('../public/arena.js');
  for (let seed = 1; seed <= 300; seed++) {
    const { walls } = buildArena(shuffleQuarter(QUARTER, seeded(seed)));
    for (const spawn of ARENA.spawns) {
      assert.ok(!circleHitsWall(spawn.x, spawn.y, TANK_RADIUS, walls), `spawn clear (seed ${seed})`);
      assert.ok(drivable(walls, spawn, FLAG_START), `spawn reaches the flag (seed ${seed})`);
    }
    for (let i = 1; i < 4; i++) assert.ok(drivable(walls, ARENA.spawns[0], ARENA.spawns[i]), `spawns connected (seed ${seed})`);
  }
});

test('each new game uses a freshly shuffled map, sent to every player', () => {
  const sent = [];
  const room = new GameRoom('SHUF', {
    broadcast: (ev, data) => sent.push({ ev, data }),
    send: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    random: seeded(42),
  });
  room.join('p1');
  room.start('p1');
  const first = room.walls.map((r) => r.join('')).join('/');
  assert.notEqual(first, ARENA.walls.map((r) => r.join('')).join('/'), 'differs from the standard layout');
  const payload = sent.filter((m) => m.ev === 'gameStarted').pop().data;
  assert.deepEqual(payload.arena.walls, room.walls);
  // Flag respawn spots follow the new walls.
  assert.ok(room.flagSpots.every((s) => !circleHitsWall(s.x, s.y, 10, room.walls)));
  room.started = false;
  room.start('p1');
  assert.notEqual(room.walls.map((r) => r.join('')).join('/'), first, 'the next game is different again');
});
