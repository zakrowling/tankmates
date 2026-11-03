// Tankmates arena. Shared by the browser (window.TankmatesArena) and Node tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TankmatesArena = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // One quarter of the arena (top-left). '#' is a wall, '.' is open ground.
  // buildArena() mirrors it left-right and top-bottom so every corner spawn is identical.
  const QUARTER = [
    '#########################',
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
    '#...................####.',
    '#...................####.',
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

  return { QUARTER, CELL, buildArena };
});
