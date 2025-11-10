# Spy vs Spy (Prototype)

Spy vs Spy is a fast-paced, multiplayer stealth duel where up to seven spies skulk through a Cold War compound in search of intel, gadgets, and the exit. The prototype recreates the trap-laying chaos of the classic magazines and video games while layering on modern real-time networking and mobile-friendly controls.

## Features

- **Real-time multiplayer arena** powered by WebSockets with a deterministic server tick for authoritative movement and combat resolution.
- **Procedural match flow** with multiple map variants, randomized loot spawns, and round-based scoring that keeps sessions fresh.【F:server.js†L38-L140】
- **Tactical gadgets and traps** including bombs, spring-loaded doors, radar pings, disguises, and more, each with unique stun timers and usage rules enforced by the server.【F:server.js†L16-L37】【F:public/client.js†L659-L724】
- **Cross-platform controls** featuring keyboard/mouse bindings on desktop plus tap, double-tap, and long-press gestures on mobile devices.【F:public/client.js†L112-L210】【F:public/client.js†L295-L426】【F:public/index.html†L123-L211】
- **Incremental HUD** that streams inventory, objectives, scores, and radar intel directly from the authoritative server snapshot feed.【F:public/client.js†L592-L658】

## Project Structure

```
.
├── public/           # Phaser-powered client, HUD, and responsive layout
│   ├── client.js
│   ├── index.html
│   └── style.css
├── server.js         # Express + ws authoritative game server
├── package.json      # Project metadata and npm scripts
└── package-lock.json
```

## Getting Started

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Run the dev server**
   ```bash
   npm start
   ```
3. Open `http://localhost:3000` in multiple browser tabs (or share the URL on your LAN) to start a match. Each client automatically connects over WebSockets and receives state snapshots from the server loop.【F:server.js†L1475-L1510】

> **Node.js version**: The project targets modern ESM-enabled Node runtimes (Node 18+ recommended) because it relies on native ES modules and WebSocket features.【F:package.json†L1-L12】

## Gameplay Basics

- **Objective**: Grab the briefcase intel, find the exit door, and escape five times before your rivals to win the match.【F:server.js†L25-L27】【F:server.js†L1407-L1420】
- **Movement**: Use `WASD` or arrow keys on desktop; tap or drag on the playfield to move on mobile.【F:public/client.js†L183-L210】【F:public/client.js†L334-L372】
- **Interact**: Tap/press the action button (or `SPACE`) when prompted to pick up items or plant traps. Use items from your inventory with `E` once selected.【F:public/client.js†L188-L230】【F:public/client.js†L724-L753】
- **Combat**: Fire your blunderbuss with `SPACE`, right-click (hold to auto-fire) on desktop, or double tap/long press on mobile. Three direct hits will eliminate a spy and score a point for you.【F:server.js†L20-L24】【F:public/client.js†L295-L359】【F:public/client.js†L374-L411】
- **Traps & Gadgets**: Lay spring traps on doors, deploy bombs with arming delays, or activate radar and disguises to mislead opponents. The HUD highlights pickup ranges and cooldowns so timing matters.【F:server.js†L16-L24】【F:server.js†L1183-L1286】【F:public/client.js†L592-L658】

Rounds pause briefly after an escape so everyone can reset. Floor traps, door springs, and items respawn based on configurable tables in `server.js`, making it easy to tweak balance or author new maps.【F:server.js†L94-L137】【F:server.js†L117-L140】

## Development Notes

- **Authoritative snapshots**: The server composes per-player snapshots each tick, filtering room visibility and fog-of-war data before broadcasting it.【F:server.js†L1403-L1488】
- **Extending maps**: Add new rooms, doors, or spawn tables by pushing additional entries into the `MAP_VARIANTS` array near the top of `server.js`. Each variant defines room geometry, items, door links, and respawn patterns.【F:server.js†L38-L140】
- **Tuning gameplay**: Core balancing constants (movement speed, stun durations, fire rate, etc.) live in the `Tunables` section of `server.js` for quick iteration.【F:server.js†L16-L33】
- **Client rendering**: `public/client.js` bootstraps a Phaser scene into separate layers for rooms, players, gadgets, and win banners. Rendering is incremental; only changed HUD elements rerender each frame to keep updates snappy.【F:public/client.js†L82-L155】【F:public/client.js†L592-L724】

## Roadmap Ideas

- Hero-specific loadouts or perks to differentiate spies.
- Additional trap types (tripwires, decoys) and environmental hazards.
- Dedicated matchmaking/lobby service and persistence for ranked play.
- Spectator mode with fog-of-war toggles for shoutcasting.

Have fun scheming, sabotaging, and sprinting to the exit!
