import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const app = express();
app.use(express.static("public"));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// --------------------------------------------------
// Tunables
// --------------------------------------------------
const SPEED = 140;          // px/sec
const TICK_HZ = 15;         // server tickrate
const STUN_MS = 2000;       // trap stun
const TRIGGER_RADIUS = 32;  // trap radius
const PICK_RADIUS = 20;     // pickup distance
const WIN_RADIUS = 24;      // distance to exit pad to escape
const ROUND_END_FREEZE_MS = 3000; // pause before new round
const SCORE_PER_WIN = 1;
const SCORE_TARGET = 5;

// --------------------------------------------------
function now() { return Date.now(); }

// --------------------------------------------------
// ROOM TEMPLATES
// --------------------------------------------------
const ROOM_TEMPLATES = {
  ARMORY: {
    w: 320, h: 200,
    items: [
      { id: "bomb",   x: 80,  y: 100, label: "BOMB" },
      { id: "spring", x: 120, y: 140, label: "SPRING" }
    ],
    doors: [
      { x:300, y:80, w:20, h:40, targetRoom:"CONTROL", targetX:20,  targetY:100 }
    ]
  },

  CONTROL: {
    w: 320, h: 200,
    items: [
      { id: "map",  x:160, y:60,  label:"MAP" },
      { id: "wire", x:220, y:120, label:"WIRE CUTTER" }
    ],
    doors: [
      { x:0,   y:80,  w:20, h:40, targetRoom:"ARMORY",  targetX:300, targetY:100 },
      { x:140, y:180, w:40, h:20, targetRoom:"INTEL",   targetX:160, targetY:20 }
    ]
  },

  INTEL: {
    w: 320, h: 200,
    items: [
      { id: "brief", x:160, y:100, label:"INTEL" },
      { id: "key",   x:260, y:160, label:"KEY" }
    ],
    doors: [
      { x:140, y:0,   w:40, h:20, targetRoom:"CONTROL",  targetX:160, targetY:180 },
      { x:300, y:80,  w:20, h:40, targetRoom:"WORKSHOP", targetX:20,  targetY:100 },
      { x:140, y:180, w:40, h:20, targetRoom:"EXIT",     targetX:160, targetY:20 }
    ]
  },

  WORKSHOP: {
    w: 320, h: 200,
    items: [
      // note: trap kit will get randomized later on pickup too
      { id: "paint", x:80,  y:60,  label:"DISGUISE" },
      { id: "trap",  x:200, y:120, label:"TRAP KIT" }
    ],
    doors: [
      { x:0, y:80, w:20, h:40, targetRoom:"INTEL", targetX:300, targetY:100 }
    ]
  },

  EXIT: {
    w: 320, h: 200,
    items: [
      { id: "escape", x:160, y:100, label:"EXIT PAD" }
    ],
    doors: [
      { x:140, y:0, w:40, h:20, targetRoom:"INTEL", targetX:160, targetY:180 }
    ]
  }
};

// --------------------------------------------------
// SPAWN POINTS FOR PLAYERS
// --------------------------------------------------
const SPAWNS = [
  { room: "CONTROL",  x:160, y:100 },
  { room: "ARMORY",   x:200, y:120 },
  { room: "INTEL",    x:80,  y:140 },
  { room: "WORKSHOP", x:260, y:100 }
];

function randSpawn() {
  const base = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
  // jitter a bit so 2 people don't stack perfectly
  const jitterX = (Math.random() * 20 - 10); // -10..+10
  const jitterY = (Math.random() * 20 - 10);
  return {
    room: base.room,
    x: base.x + jitterX,
    y: base.y + jitterY
  };
}

// --------------------------------------------------
// RANDOM TRAP KIT SPAWNS (inside WORKSHOP)
// --------------------------------------------------
const TRAP_SPAWN_SPOTS = [
  { x: 60,  y: 60  },
  { x: 200, y: 120 },
  { x: 260, y: 150 },
  { x: 140, y: 100 }
];

function randomTrapSpot() {
  return TRAP_SPAWN_SPOTS[
    Math.floor(Math.random() * TRAP_SPAWN_SPOTS.length)
  ];
}

// --------------------------------------------------
// GLOBAL RUNTIME STATE
// --------------------------------------------------
const STATE = {
  tick: 0,
  players: new Map(),    // id -> player
  roomItems: {},         // live items per roomName -> [{id,x,y,label}, ...]
  roomTraps: {},         // roomName -> [{id,x,y,owner,armed}, ...]
  roundOver: false,
  winner: null,          // { id, type }
  roundResetAt: 0
};

resetRooms();

// --------------------------------------------------
// Initial room state / round reset helpers
// --------------------------------------------------
function resetRooms() {
  STATE.roomItems = {};
  STATE.roomTraps = {};

  for (const roomName of Object.keys(ROOM_TEMPLATES)) {
    const tmpl = ROOM_TEMPLATES[roomName];
    // deep copy items
    STATE.roomItems[roomName] = tmpl.items.map(it => ({ ...it }));
    STATE.roomTraps[roomName] = [];
  }

  // we keep trap kit initially where template says.
  // after pickup we will respawn it somewhere random.
}

function respawnPlayer(p) {
  const s = randSpawn();
  p.room = s.room;
  p.x = s.x;
  p.y = s.y;
  p.vx = 0;
  p.vy = 0;
  p.lastSeq = 0;
  p.lastHeard = now();
  p.inventory = [];
  p.stunnedUntil = 0;
}

// --------------------------------------------------
// New connections
// --------------------------------------------------
wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  const s = randSpawn();

  const player = {
    id,
    shortId: id.slice(0,4),
    room: s.room,
    x: s.x,
    y: s.y,
    vx: 0,
    vy: 0,
    color: randColor(),

    score: 0,          // persists across rounds

    lastSeq: 0,
    lastHeard: now(),

    inventory: [],
    stunnedUntil: 0,
    _ws: ws
  };

  STATE.players.set(id, player);
  console.log(`[server] player connected ${id} in ${player.room} (${player.x},${player.y})`);

  ws.send(JSON.stringify({
    t: "welcome",
    id,
    tick: STATE.tick
  }));

  sendSnapshot(ws);

  ws.on("message", (buf) => {
    if (STATE.roundOver) {
      // freeze during end-of-round
      return;
    }
    let m;
    try {
      m = JSON.parse(buf);
    } catch {
      return;
    }

    if (m.t === "input") {
      handleInput(player, m);
    }
    if (m.t === "pickup") {
      console.log(`[server] ${player.id} requests PICKUP`);
      handlePickup(player);
    }
    if (m.t === "placeTrap") {
      console.log(`[server] ${player.id} requests PLACE TRAP`);
      handlePlaceTrap(player);
    }
  });

  ws.on("close", () => {
    console.log(`[server] player disconnected ${id}`);
    STATE.players.delete(id);
  });
});

// --------------------------------------------------
// Input / Action
// --------------------------------------------------
function handleInput(player, m) {
  // stunned players can't move
  if (player.stunnedUntil > now()) {
    player.vx = 0;
    player.vy = 0;
    return;
  }

  if (m.seq <= player.lastSeq) return;
  player.lastSeq = m.seq;

  const dx = m.dx ?? 0;
  const dy = m.dy ?? 0;
  const mag = Math.hypot(dx, dy) || 1;

  player.vx = (dx / mag) * SPEED;
  player.vy = (dy / mag) * SPEED;
  player.lastHeard = now();
}

// pickup item in same room within PICK_RADIUS
function handlePickup(player) {
  const roomName = player.room;
  const itemsInRoom = STATE.roomItems[roomName];
  if (!itemsInRoom || !itemsInRoom.length) return;

  for (let i = 0; i < itemsInRoom.length; i++) {
    const it = itemsInRoom[i];
    const dist = Math.hypot(player.x - it.x, player.y - it.y);

    if (dist <= PICK_RADIUS) {
      console.log(
        `[server] ${player.id} PICKED UP ${it.label} in ${roomName} at (${it.x},${it.y})`
      );

      player.inventory.push({ id: it.id, label: it.label });

      // was it the TRAP KIT?
      const pickedTrapKit = (it.id === "trap" || it.label === "TRAP KIT");

      // remove from floor
      itemsInRoom.splice(i, 1);

      // if TRAP KIT, immediately respawn a NEW trap kit somewhere else in WORKSHOP
      if (pickedTrapKit) {
        respawnTrapKitInWorkshop();
      }

      break;
    }
  }
}

// re-drop a trap kit in WORKSHOP at a random allowed spawn
function respawnTrapKitInWorkshop() {
  const workshopItems = STATE.roomItems["WORKSHOP"];
  if (!workshopItems) return;

  const spot = randomTrapSpot();
  // push a NEW trap kit
  workshopItems.push({
    id: "trap",
    label: "TRAP KIT",
    x: spot.x,
    y: spot.y
  });

  console.log(`[server] TRAP KIT respawned in WORKSHOP at (${spot.x},${spot.y})`);
}

function handlePlaceTrap(player) {
  // check inventory for trap kit
  const trapIndex = player.inventory.findIndex(
    it => it.id === "trap" || it.label === "TRAP KIT"
  );
  if (trapIndex === -1) {
    console.log(`[server] ${player.id} tried to PLACE TRAP but has no TRAP KIT`);
    return;
  }

  const roomName = player.room;
  const trapsInRoom = STATE.roomTraps[roomName];
  if (!trapsInRoom) return;

  const newTrap = {
    id: "trap-" + crypto.randomUUID().slice(0, 8),
    owner: player.id,
    x: player.x,
    y: player.y,
    armed: true
  };

  trapsInRoom.push(newTrap);

  console.log(
    `[server] ${player.id} PLACED TRAP ${newTrap.id} in ${roomName} at (${newTrap.x},${newTrap.y})`
  );

  // consume kit
  player.inventory.splice(trapIndex, 1);
}

// --------------------------------------------------
// Simulation
// --------------------------------------------------
function step(dt) {
  const tNow = now();

  // if roundOver, lock everyone
  if (STATE.roundOver) {
    STATE.players.forEach((p) => {
      p.vx = 0;
      p.vy = 0;
    });
  }

  STATE.players.forEach((p) => {
    // movement only if not stunned and not in round freeze
    if (!STATE.roundOver && p.stunnedUntil <= tNow) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    } else {
      p.vx = 0;
      p.vy = 0;
    }

    // clamp in room bounds
    const def = ROOM_TEMPLATES[p.room];
    p.x = Math.max(16, Math.min(def.w - 16, p.x));
    p.y = Math.max(16, Math.min(def.h - 16, p.y));

    // door teleport
    if (!STATE.roundOver && p.stunnedUntil <= tNow) {
      for (const door of def.doors) {
        const inside =
          p.x > door.x &&
          p.x < door.x + door.w &&
          p.y > door.y &&
          p.y < door.y + door.h;
        if (inside) {
          console.log(
            `[server] ${p.id} GOES THROUGH DOOR ${p.room} -> ${door.targetRoom}`
          );
          p.room = door.targetRoom;
          p.x = door.targetX;
          p.y = door.targetY;
          break;
        }
      }
    }

    if (!STATE.roundOver) {
      applyTrapIfHit(p, tNow);
    }
  });

  if (!STATE.roundOver) {
    checkWinCondition();
  } else {
    maybeResetRound();
  }

  STATE.tick++;
}

// trap logic
function applyTrapIfHit(player, tNow) {
  const roomName = player.room;
  const traps = STATE.roomTraps[roomName];
  if (!traps || !traps.length) return;

  for (let i = 0; i < traps.length; i++) {
    const tr = traps[i];
    if (!tr.armed) continue;

    const dist = Math.hypot(player.x - tr.x, player.y - tr.y);

    if (dist < TRIGGER_RADIUS * 2) {
      console.log(
        `[server] checking trap ${tr.id} vs player ${player.id} in ${roomName}: dist=${dist.toFixed(
          1
        )}, radius=${TRIGGER_RADIUS}`
      );
    }

    // can't trigger your own trap
    if (player.id === tr.owner) {
      if (dist <= TRIGGER_RADIUS) {
        console.log(
          `[server] ${player.id} is standing on their OWN trap ${tr.id} (safe)`
        );
      }
      continue;
    }

    if (dist <= TRIGGER_RADIUS) {
      console.log(
        `[server] TRAP TRIGGERED ${tr.id} on player ${player.id} in ${roomName} at (${tr.x},${tr.y})`
      );

      tr.armed = false;

      // stun victim
      player.stunnedUntil = tNow + STUN_MS;
      player.vx = 0;
      player.vy = 0;

      // remove the trap from room
      traps.splice(i, 1);
      break;
    }
  }
}

// --------------------------------------------------
// Winning / Round reset
// --------------------------------------------------
function checkWinCondition() {
  if (STATE.roundOver) return;

  STATE.players.forEach((p) => {
    if (canEscape(p)) {
      console.log(`[server] WINNER (escape) IS ${p.id}`);

      // give score
      p.score += SCORE_PER_WIN;

      startRoundOver(p.id, "escape");
      return;
    }

    // future: score race
    // if (p.score >= SCORE_TARGET) { ... }
  });
}

function canEscape(p) {
  const hasIntel = p.inventory.some(
    it => it.id === "brief" || it.label === "INTEL"
  );
  const hasKey = p.inventory.some(
    it => it.id === "key" || it.label === "KEY"
  );
  if (!(hasIntel && hasKey)) return false;

  if (p.room !== "EXIT") return false;

  const exitAnchor = ROOM_TEMPLATES.EXIT.items.find(
    it => it.id === "escape"
  );
  if (!exitAnchor) return false;

  const distToExit = Math.hypot(p.x - exitAnchor.x, p.y - exitAnchor.y);
  return distToExit <= WIN_RADIUS;
}

function startRoundOver(winnerId, type) {
  STATE.roundOver = true;
  STATE.winner = { id: winnerId, type };
  STATE.roundResetAt = now() + ROUND_END_FREEZE_MS;

  // freeze everyone, visually stun them until reset
  STATE.players.forEach((p) => {
    p.vx = 0;
    p.vy = 0;
    p.stunnedUntil = STATE.roundResetAt;
  });
}

function maybeResetRound() {
  const tNow = now();
  if (!STATE.roundOver) return;
  if (tNow < STATE.roundResetAt) return;

  // reset items/traps
  resetRooms();

  // respawn every player, KEEP score/color
  STATE.players.forEach((p) => {
    respawnPlayer(p);
  });

  // clear roundOver state
  STATE.roundOver = false;
  STATE.winner = null;
  STATE.roundResetAt = 0;

  console.log("[server] round reset complete");
}

// --------------------------------------------------
// Snapshot
// --------------------------------------------------
function snapshotFor(playerId) {
  const me = STATE.players.get(playerId);
  if (!me) return null;

  const roomName = me.room;
  const roomDef = ROOM_TEMPLATES[roomName];
  const tNow = now();

  const itemsInRoom = STATE.roomItems[roomName] || [];
  const allTrapsInRoom = STATE.roomTraps[roomName] || [];

  // only send traps you own (invisibility to others)
  const visibleTraps = allTrapsInRoom
    .filter(tr => tr.owner === me.id)
    .map(tr => ({
      id: tr.id,
      x: tr.x,
      y: tr.y,
      owner: tr.owner
    }));

  // players in same room
  const visiblePlayers = [];
  STATE.players.forEach((p) => {
    if (p.room === roomName) {
      visiblePlayers.push({
        id: p.id,
        shortId: p.shortId,
        room: p.room,
        x: Math.round(p.x),
        y: Math.round(p.y),
        color: p.color,
        isStunned: p.stunnedUntil > tNow,
        stunMsRemaining: Math.max(p.stunnedUntil - tNow, 0),
        score: p.score
      });
    }
  });

  return {
    t: "snapshot",
    tick: STATE.tick,
    you: me.id,
    room: me.room,
    roomW: roomDef.w,
    roomH: roomDef.h,

    doors: roomDef.doors.map(d => ({
      x: d.x,
      y: d.y,
      w: d.w,
      h: d.h
    })),

    items: itemsInRoom.map(it => ({
      id: it.id,
      x: it.x,
      y: it.y,
      label: it.label
    })),

    traps: visibleTraps,

    players: visiblePlayers,

    yourInventory: me.inventory.map(it => ({
      id: it.id,
      label: it.label
    })),

    youScore: me.score,
    scoreTarget: SCORE_TARGET,

    winner: STATE.winner
      ? { id: STATE.winner.id, type: STATE.winner.type }
      : null
  };
}

function sendSnapshot(ws) {
  const player = [...STATE.players.values()].find(p => p._ws === ws);
  if (!player) return;
  const payload = snapshotFor(player.id);
  if (!payload) return;
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastSnapshots() {
  STATE.players.forEach((p) => {
    const ws = p._ws;
    if (!ws || ws.readyState !== 1) return;

    const payload = snapshotFor(p.id);
    if (!payload) return;

    ws.send(JSON.stringify(payload));
  });
}

// --------------------------------------------------
// Main loop
// --------------------------------------------------
let last = now();
setInterval(() => {
  const t = now();
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;

  step(dt);
  broadcastSnapshots();
}, 1000 / TICK_HZ);

// --------------------------------------------------
function randColor() {
  const palette = [
    "#ff5555",
    "#55ff55",
    "#5599ff",
    "#ffff55",
    "#ff55ff",
    "#55ffff",
    "#ffffff"
  ];
  return palette[Math.floor(Math.random() * palette.length)];
}

// --------------------------------------------------
// Start server
// --------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
