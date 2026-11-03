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

  // A lightly shuffled copy of a quarter layout: some of the inner brick shapes are nudged by a
  // cell or two, so every round feels a little different but plays much the same. Because the
  // quarter is mirrored, the arena stays fair for all four corners. Rules for a moved shape:
  // - it stays out of the outer lanes (first 4 rows/columns), so spawns and the perimeter stay open;
  // - it stays 2+ cells from the mirror lines, keeping the centre channels open;
  // - it keeps at least 2 open cells (wider than a tank) between itself and every other wall.
  // Shapes touching the mirror lines (the centre bunker) never move.
  function shuffleQuarter(quarter = QUARTER, rand = Math.random, { chance = 0.6, maxShift = 2 } = {}) {
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
    const offsets = [];
    for (let dy = -maxShift; dy <= maxShift; dy++) {
      for (let dx = -maxShift; dx <= maxShift; dx++) if (dx || dy) offsets.push([dx, dy]);
    }

    for (const cells of shapes) {
      if (!movable(cells) || rand() >= chance) continue;
      cells.forEach(([x, y]) => { grid[y][x] = '.'; });
      const order = offsets.map((o) => [rand(), o]).sort((a, b) => a[0] - b[0]).map(([, o]) => o);
      const fits = ([dx, dy]) => cells.every(([x, y]) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < MIN || ny < MIN || nx > maxX || ny > maxY) return false;
        for (let oy = -2; oy <= 2; oy++) {
          for (let ox = -2; ox <= 2; ox++) {
            const row = grid[ny + oy];
            if (row && row[nx + ox] === '#') return false;
          }
        }
        return true;
      });
      const [dx, dy] = order.find(fits) || [0, 0];
      cells.forEach(([x, y]) => { grid[y + dy][x + dx] = '#'; });
    }
    return grid.map((row) => row.join(''));
  }

  return { QUARTER, CELL, buildArena, shuffleQuarter };
});
