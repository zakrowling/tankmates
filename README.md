# Tankmates

Online multiplayer tank battles for up to 4 mates. Play it at **https://zakrowling.github.io/tankmates/**

Based on [RetroTanks](https://github.com/enesser/retroTanks) by Eric J Nesser (MIT), a take on Atari's Combat (1977), and built on the same lobby and peer-to-peer setup as [Pacmates](https://github.com/zakrowling/pacmates).

- **Link rooms**: share https://zakrowling.github.io/tankmates/mate and nobody needs a code. The first person to open it hosts and everyone else joins. If the host leaves, the next player takes over, so the room stays open while anyone is in it. Any 2–16 letters, numbers or dashes work as a room name.
- **Room codes**: Create Room gives a 4-letter code (and invite link) for private games. Friends can join mid-game.
- **Lobby**: 4 player slots, each with that player's detailed pixel-art tank (treaded tracks, shaded hull, domed turret, long barrel) in the Combat colours (red, blue, yellow, purple) and a random 4-letter name. Any player can start.
- **Capture the flag**: one flag starts in the channel through the centre bunker. Drive over it to grab it; you hold it (with a golden aura) until you're shot, then it reappears at a random spot away from the tanks. Holding the flag scores 1 point a second, and each hit scores 2.
- **Battle**: drive with arrow keys or WASD, fire with Space or Enter. One shell in flight per tank. A hit tank explodes, spins out, then respawns in its corner with a moment of protection.
- **Winning**: first to 60 points, or the highest score when the 3-minute timer runs out.
- **Battlefield**: a 1200×720 mirrored arena (layout in [`public/arena.js`](public/arena.js)) with churned mud and grass and old tread marks, rubble heaps of broken brick and concrete, and a concrete perimeter. Hits and shell impacts leave scorch marks for the rest of the game, and hit tanks pour smoke while they spin out.
- **Sound**: all synthesized with Web Audio: a diesel engine rumble and track clatter that revs as you drive, cannon fire, shell impacts, and big explosions with debris, panned and faded by distance. Plus flag pickup/drop jingles and a bugle start.
- **Retro touches**: name bubbles (yours is yellow), tracers and muzzle flashes, and X toggles CRT scanlines.
- **Logo**: put your title image at [`public/assets/image/tankmates-logo.png`](public/assets/image/README.md) and it replaces the text title automatically.

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
