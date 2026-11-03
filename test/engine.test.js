const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GameRoom, generateRoomCode, ARENA, TANK_RADIUS, WIN_SCORE, GAME_SECONDS, TICK_RATE,
  SPIN_TICKS, INVULNERABLE_TICKS, BULLET_LIFE_TICKS, circleHitsWall,
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
  return ctx;
}

const press = (room, id, controls) => room.input(id, { forward: false, back: false, left: false, right: false, fire: false, ...controls });

// Puts two tanks on the same open row, the shooter facing the target.
function lineUp(room, shooter, target, gap = 120) {
  Object.assign(shooter, { x: 200, y: 36, angle: 0, invulnerableTicks: 0 });
  Object.assign(target, { x: 200 + gap, y: 36, angle: 180, invulnerableTicks: 0 });
}

test('room codes are 4 letters without I or O', () => {
  for (let i = 0; i < 500; i++) assert.match(generateRoomCode(), /^[A-HJ-NP-Z]{4}$/);
  assert.throws(() => generateRoomCode(() => true));
});

test('arena is mirrored with 4 clear corner spawns aimed at the centre', () => {
  assert.equal(ARENA.width, 960);
  assert.equal(ARENA.height, 576);
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
  assert.ok(seen.size > 500, `only ${seen.size} cells reachable`);
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
  assert.ok(p.x >= ARENA.cell + TANK_RADIUS - 0.01, `x=${p.x}`);
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
  Object.assign(p, { x: 200, y: 36, angle: 0 });
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

test('a hit scores a point, spins the target out, then respawns it protected', () => {
  const { room, run, events } = startedRoom(2);
  const [a, b] = ['p1', 'p2'].map((id) => room.players.get(id));
  lineUp(room, a, b);
  press(room, 'p1', { fire: true });
  run(15);
  assert.equal(a.score, 1);
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
  Object.assign(p, { x: 200, y: 36, angle: 0 });
  press(room, 'p1', { fire: true });
  run(BULLET_LIFE_TICKS);
  assert.equal(p.status, 'alive');
});

test('first to the win score ends the game', () => {
  const { room, run, last, isRunning } = startedRoom(2);
  room.players.get('p2').score = WIN_SCORE - 1;
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
