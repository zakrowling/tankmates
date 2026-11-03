# Tankmates

Online multiplayer tank battles for up to 4 mates. Play it at **https://zakrowling.github.io/tankmates/**

Based on [RetroTanks](https://github.com/enesser/retroTanks) by Eric J Nesser (MIT), a take on Atari's Combat (1977), and built on the same lobby and peer-to-peer setup as [Pacmates](https://github.com/zakrowling/pacmates).

- **Link rooms**: share https://zakrowling.github.io/tankmates/mate and nobody needs a code. The first person to open it hosts and everyone else joins. If the host leaves, the next player takes over, so the room stays open while anyone is in it. Any 2–16 letters, numbers or dashes work as a room name.
- **Room codes**: Create Room gives a 4-letter code (and invite link) for private games. Friends can join mid-game.
- **Tanks**: each player drives a different modern tank, drawn as detailed retro pixel art (limited palette, light dither, crisp outline): P1 a green-camo Leopard 2A7 style, P2 a sand M1A2 Abrams style, P3 a silver T-14 Armata style, and P4 a blue-grey AbramsX style. A turret band and chevron in the player's colour (red, blue, yellow, purple) mark whose is whose.
- **Lobby**: 4 player slots, each showing that player's tank and a random 4-letter name. Any player can start. Open `/?showcase` to see all four designs up close.
- **Capture the flag**: one flag starts in the channel through the centre bunker. Drive over it to grab it; you hold it (with a golden aura) until you're shot, then you drop it right where you were hit for anyone to grab. Holding the flag scores 1 point a second, and each hit scores 2.
- **Battle**: drive with arrow keys or WASD, fire with Space or Enter. One shell in flight per tank. A hit tank explodes, spins out, then respawns in its corner with a moment of protection.
- **Winning**: first to 60 points, or the highest score when the 3-minute timer runs out.
- **Battlefield**: a 1200×720 mirrored arena (layout in [`public/arena.js`](public/arena.js)) with churned mud and grass and old tread marks, weathered red-brick walls, and a concrete perimeter. Shooting a brick block knocks bricks out of it; after 3 hits it crumbles away, leaving rubble and opening a new path (walls rebuild each game). Hits and shell impacts leave scorch marks for the rest of the game, and hit tanks pour smoke while they spin out.
- **Sound**: all synthesized with Web Audio: a diesel engine rumble and track clatter that revs as you drive, cannon fire, shell impacts, and big explosions with debris, panned and faded by distance. Plus flag pickup/drop jingles and a bugle start.
- **Retro touches**: name bubbles (yours is yellow), tracers and muzzle flashes.
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
