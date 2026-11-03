// Tankmates arena. Shared by the browser (window.TankmatesArena) and Node tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TankmatesArena = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // One quarter of the arena (top-left). '#' is a wall, '.' is open ground.
  // buildArena() mirrors it left-right and top-bottom so every corner spawn is identical.
  // The gaps in the outer wall (end of the top row, bottom of the left column) mirror into
  // 4-cell tunnels in the middle of each side: drive out of one and you come in on the other side.
  const QUARTER = [
    '#######################..',
    '#........................',
    '#........................',
    '#........................',
    '#.....######.............',
    '#.....#..................',
    '#.....#.........###......',
    '#...............###......',
    '#........................',
    '#............#...........',
    '#............#...........',
    '#....##......#...........',
    '#....##......#...........',
    '....................####.',
    '....................####.',
  ];

  const CELL = 24; // pixels per layout cell
  const SPAWN_CELL = { x: 2, y: 2 }; // player 1's spawn; mirrored for the others

  const mirrorRow = (row) => row + [...row].reverse().join('');

  function buildLayout(quarter) {
    const top = quarter.map(mirrorRow);
    return [...top, ...[...top].reverse()];
  }

  function buildArena(quarter = QUARTER) {
    const layout = buildLayout(quarter);
    const rows = layout.length;
    const cols = layout[0].length;
    const walls = layout.map((row) => [...row].map((ch) => (ch === '#' ? 1 : 0)));
    const width = cols * CELL;
    const height = rows * CELL;
    const centre = { x: width / 2, y: height / 2 };

    // Player 1 top-left, 2 top-right, 3 bottom-left, 4 bottom-right; each starts aimed at the centre.
    const cells = [
      { x: SPAWN_CELL.x, y: SPAWN_CELL.y },
      { x: cols - 1 - SPAWN_CELL.x, y: SPAWN_CELL.y },
      { x: SPAWN_CELL.x, y: rows - 1 - SPAWN_CELL.y },
      { x: cols - 1 - SPAWN_CELL.x, y: rows - 1 - SPAWN_CELL.y },
    ];
    const spawns = cells.map((c) => {
      const x = (c.x + 0.5) * CELL;
      const y = (c.y + 0.5) * CELL;
      const angle = Math.round((Math.atan2(centre.y - y, centre.x - x) * 180) / Math.PI / 5) * 5;
      return { x, y, angle };
    });

    return { layout, walls, cols, rows, cell: CELL, width, height, spawns };
  }

  // Small extra pieces of cover that can turn up in a round.
  const EXTRA_PIECES = [
    [[0, 0], [1, 0], [0, 1], [1, 1]], // 2x2 block
    [[0, 0], [1, 0], [2, 0]], // short wall
    [[0, 0], [0, 1], [0, 2]], // short wall, upright
    [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]], // 3x2 block
    [[0, 0], [1, 0], [2, 0], [0, 1]], // small L
  ];

  // A shuffled copy of a quarter layout, so every round plays on a different map. Because the
  // quarter is mirrored, the arena stays fair for all four corners. Each round, inner brick shapes:
  // - move by up to `maxShift` cells, and may be rotated or flipped;
  // - may lose a small block, or gain an extra bit of cover somewhere new.
  // Rules for anything placed:
  // - it stays out of the outer lanes (first 4 rows/columns), so spawns, the perimeter and the
  //   tunnels stay open;
  // - it stays 2+ cells from the mirror lines, keeping the centre channels open;
  // - it keeps at least 2 open cells (wider than a tank) between itself and every other wall.
  // Shapes touching the mirror lines (the centre bunker) never move.
  function shuffleQuarter(quarter = QUARTER, rand = Math.random, {
    chance = 0.9, maxShift = 4, turnChance = 0.5, removeChance = 0.25, extraChance = 0.6,
  } = {}) {
    const rows = quarter.length;
    const cols = quarter[0].length;
    const grid = quarter.map((row) => [...row]);
    const isInner = (x, y) => x > 0 && y > 0;
    const seen = new Set();
    const shapes = [];
    for (let y = 1; y < rows; y++) {
      for (let x = 1; x < cols; x++) {
        if (grid[y][x] !== '#' || seen.has(`${x},${y}`)) continue;
        const cells = [];
        const stack = [[x, y]];
        seen.add(`${x},${y}`);
        while (stack.length) {
          const [cx, cy] = stack.pop();
          cells.push([cx, cy]);
          for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
            if (ny < rows && nx < cols && isInner(nx, ny) && grid[ny][nx] === '#' && !seen.has(`${nx},${ny}`)) {
              seen.add(`${nx},${ny}`);
              stack.push([nx, ny]);
            }
          }
        }
        shapes.push(cells);
      }
    }

    const MIN = 4;
    const maxX = cols - 3;
    const maxY = rows - 3;
    const movable = (cells) => cells.every(([x, y]) => x <= maxX && y <= maxY);
    const shuffle = (list) => list.map((v) => [rand(), v]).sort((p, q) => p[0] - q[0]).map(([, v]) => v);
    const fits = (cells) => cells.every(([x, y]) => {
      if (x < MIN || y < MIN || x > maxX || y > maxY) return false;
      for (let oy = -2; oy <= 2; oy++) {
        for (let ox = -2; ox <= 2; ox++) {
          const row = grid[y + oy];
          if (row && row[x + ox] === '#') return false;
        }
      }
      return true;
    });
    const place = (cells, ch) => cells.forEach(([x, y]) => { grid[y][x] = ch; });

    // The 8 rotations/flips of a shape, keeping its centre where it was.
    const orient = (cells, k) => {
      const cx = cells.reduce((t, [x]) => t + x, 0) / cells.length;
      const cy = cells.reduce((t, [, y]) => t + y, 0) / cells.length;
      return cells.map(([x, y]) => {
        let dx = x - cx;
        let dy = y - cy;
        if (k & 1) [dx, dy] = [dy, dx];
        if (k & 2) dx = -dx;
        if (k & 4) dy = -dy;
        return [Math.round(cx + dx), Math.round(cy + dy)];
      });
    };
    const offsets = [];
    for (let dy = -maxShift; dy <= maxShift; dy++) {
      for (let dx = -maxShift; dx <= maxShift; dx++) offsets.push([dx, dy]);
    }

    const movers = shuffle(shapes.filter(movable));
    // Sometimes a small block is knocked out for the round.
    const small = movers.filter((cells) => cells.length <= 4);
    let removed = null;
    if (small.length && rand() < removeChance) {
      removed = small[Math.floor(rand() * small.length)];
      place(removed, '.');
    }

    for (const cells of movers) {
      if (cells === removed || rand() >= chance) continue;
      place(cells, '.');
      const turned = rand() < turnChance ? orient(cells, 1 + Math.floor(rand() * 7)) : cells;
      const tryShape = (shape) => {
        for (const [dx, dy] of shuffle(offsets)) {
          const moved = shape.map(([x, y]) => [x + dx, y + dy]);
          if (fits(moved)) return moved;
        }
        return null;
      };
      place(tryShape(turned) || tryShape(cells) || cells, '#');
    }

    // Sometimes an extra bit of cover turns up somewhere new.
    for (let n = 0; n < 2; n++) {
      if (rand() >= extraChance) continue;
      const piece = EXTRA_PIECES[Math.floor(rand() * EXTRA_PIECES.length)];
      for (let attempt = 0; attempt < 60; attempt++) {
        const ox = MIN + Math.floor(rand() * (maxX - MIN + 1));
        const oy = MIN + Math.floor(rand() * (maxY - MIN + 1));
        const cells = piece.map(([x, y]) => [x + ox, y + oy]);
        if (fits(cells)) {
          place(cells, '#');
          break;
        }
      }
    }
    return grid.map((row) => row.join(''));
  }

  return { QUARTER, CELL, buildArena, shuffleQuarter };
});
