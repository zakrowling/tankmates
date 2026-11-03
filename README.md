# Tankmates

Online multiplayer tank battles for up to 4 mates. Play it at **https://zakrowling.github.io/tankmates/**

Based on [RetroTanks](https://github.com/enesser/retroTanks) by Eric J Nesser (MIT), a take on Atari's Combat (1977), and built on the same lobby and peer-to-peer setup as [Pacmates](https://github.com/zakrowling/pacmates).

- **Link rooms**: share https://zakrowling.github.io/tankmates/mate and nobody needs a code. The first person to open it hosts and everyone else joins. If the host leaves, the next player takes over, so the room stays open while anyone is in it. Any 2–16 letters, numbers or dashes work as a room name.
- **Room codes**: Create Room gives a 4-letter code (and invite link) for private games. Friends can join mid-game.
- **Lobby**: 4 player slots, each with that player's tank in the Combat colours (red, blue, yellow, purple) and a random 4-letter name. Any player can start.
- **Battle**: drive with arrow keys or WASD, fire with Space or Enter. One shell in flight per tank. A hit scores a point; the hit tank spins out, then respawns in its corner with a moment of protection.
- **Winning**: first to 10 hits, or the highest score when the 3-minute timer runs out.
- **Arena**: a mirrored field of walls so every corner is fair (layout in [`public/arena.js`](public/arena.js)).
- **Retro touches**: name bubbles (yours is yellow), synthesized sound effects, and X toggles CRT scanlines.

## How it works

There is no game server, so it runs on GitHub Pages.

- The **host's browser** runs the game engine ([`public/engine.js`](public/engine.js)) at 30 FPS: movement, wall collisions, shells, hits and scores. Other players only send which controls they're holding.
- Players connect over WebRTC using [PeerJS](https://peerjs.com/) ([`public/net.js`](public/net.js)). If some players can't connect (e.g. Firefox ↔ Chrome, mobile data), add a free TURN relay URL in [`public/config.js`](public/config.js).

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 (or http://localhost:3000/mate).

## Test

```bash
npm test
```

## Deploy

Every push to `main` runs the tests and publishes `public/` to GitHub Pages.
