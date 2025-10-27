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
      // We'll still seed one TRAP KIT here at round start.
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
// SPAWN POINTS FOR PLAYERS (unchanged)
// --------------------------------------------------
const SPAWNS = [
  { room: "CONTROL",  x:160, y:100 },
  { room: "ARMORY",   x:200, y:120 },
  { room: "INTEL",    x:80,  y:140 },
  { room: "WORKSHOP", x:260, y:100 }
];

function randSpawn() {
  const base = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
  const jitterX = (Math.random() * 20 - 10);
  const jitterY = (Math.random() * 20 - 10);
  return {
    room: base.room,
    x: base.x + jitterX,
    y: base.y + jitterY
  };
}

// --------------------------------------------------
// TRAP KIT RESPAWN CONFIG
// --------------------------------------------------

// NEW: valid rooms where trap kit is allowed to respawn
// (leaving out EXIT for fairness)
const TRAP_ROOMS_FOR_RESPAWN = [ "WORKSHOP", "CONTROL", "ARMORY", "INTEL" ];

// NEW: per-room candidate spawn points for the trap kit.
// You can tweak / add more so it feels good.
const TRAP_RESPAWN_SPOTS = {
  WORKSHOP: [
    { x: 60,  y: 60  },
    { x: 200, y: 120 },
    { x: 260, y: 150 },
    { x: 140, y: 100 }
  ],
  CONTROL: [
    { x: 80,  y: 80  },
    { x: 200, y: 120 },
    { x: 260, y: 60  }
  ],
  ARMORY: [
    { x: 60,  y: 120 },
    { x: 140, y: 80  },
    { x: 220, y: 140 }
  ],
  INTEL: [
    { x: 80,  y: 140 },
    { x: 160, y: 60  },
    { x: 260, y: 160 }
  ]
};

// helper to pick a random array element
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --------------------------------------------------
// GLOBAL RUNTIME STATE
// --------------------------------------------------
const STATE = {
  tick: 0,
  players: new Map(),    // id -> player
  roomItems: {},         // roomName -> [{id,x,y,label},...]
  roomTraps: {},         // roomName -> [{id,x,y,owner,armed},...]
  roundOver: false,
  winner: null,          // { id, type }
  roundResetAt: 0
};

// build initial per-room state
resetRooms();

// --------------------------------------------------
// Round / room reset
// --------------------------------------------------
function resetRooms() {
  STATE.roomItems = {};
  STATE.roomTraps = {};

  for (const roomName of Object.keys(ROOM_TEMPLATES)) {
    const tmpl = ROOM_TEMPLATES[roomName];
    STATE.roomItems[roomName] = tmpl.items.map(it => ({ ...it }));
    STATE.roomTraps[roomName] = [];
  }

  // At round start, yes there will be exactly 1 TRAP KIT in WORKSHOP,
  // because WORKSHOP template includes it. After someone grabs it,
  // we won't just respawn in WORKSHOP any more. We'll respawn it somewhere random.
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
      return; // freeze inputs during round end
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

// pickup nearby item
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

      const pickedTrapKit = (it.id === "trap" || it.label === "TRAP KIT");

      // remove from the room floor
      itemsInRoom.splice(i, 1);

      // if we just picked TRAP KIT, spawn a NEW trap kit somewhere else:
      if (pickedTrapKit) {
        respawnTrapKitElsewhere(roomName);
      }

      break;
    }
  }
}

// NEW: respawn trap kit in a random allowed room, NOT necessarily the same one
function respawnTrapKitElsewhere(prevRoomName) {
  // choose a random room from TRAP_ROOMS_FOR_RESPAWN
  // (could be the same as prevRoomName, but if you *never*
  // want same room twice, we can filter it out)
  let pool = TRAP_ROOMS_FOR_RESPAWN.slice();

  // optional: don't respawn in the same room we just picked it up from
  pool = pool.filter(r => r !== prevRoomName);
  if (pool.length === 0) {
    // fallback just in case, shouldn't really happen
    pool = TRAP_ROOMS_FOR_RESPAWN.slice();
  }

  const newRoom = pick(pool);
  const spot = pick(TRAP_RESPAWN_SPOTS[newRoom]);

  // sanity: make sure roomItems array exists
  if (!STATE.roomItems[newRoom]) {
    STATE.roomItems[newRoom] = [];
  }

  STATE.roomItems[newRoom].push({
    id: "trap",
    label: "TRAP KIT",
    x: spot.x,
    y: spot.y
  });

  console.log(`[server] TRAP KIT respawned in ${newRoom} at (${spot.x},${spot.y})`);
}

function handlePlaceTrap(player) {
  // see if player has trap kit
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

  // consume trap kit from inventory
  player.inventory.splice(trapIndex, 1);
}

// --------------------------------------------------
// Simulation tick
// --------------------------------------------------
function step(dt) {
  const tNow = now();

  if (STATE.roundOver) {
    // lock everyone
    STATE.players.forEach((p) => {
      p.vx = 0;
      p.vy = 0;
    });
  }

  STATE.players.forEach((p) => {
    if (!STATE.roundOver && p.stunnedUntil <= tNow) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    } else {
      p.vx = 0;
      p.vy = 0;
    }

    // clamp position inside room
    const def = ROOM_TEMPLATES[p.room];
    p.x = Math.max(16, Math.min(def.w - 16, p.x));
    p.y = Math.max(16, Math.min(def.h - 16, p.y));

    // door teleport if allowed
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

    // can't trigger your own
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

      // remove trap from map
      traps.splice(i, 1);
      break;
    }
  }
}

// --------------------------------------------------
// Win / Round-over / Reset
// --------------------------------------------------
function checkWinCondition() {
  if (STATE.roundOver) return;

  STATE.players.forEach((p) => {
    if (canEscape(p)) {
      console.log(`[server] WINNER (escape) IS ${p.id}`);
      p.score += SCORE_PER_WIN;
      startRoundOver(p.id, "escape");
      return;
    }

    // future: score race -> first to SCORE_TARGET
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

  // freeze everyone (also marks them stunned client-side)
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

  // reset room items/traps for a fresh round
  resetRooms();

  // respawn all players, but keep score/color
  STATE.players.forEach((p) => {
    respawnPlayer(p);
  });

  STATE.roundOver = false;
  STATE.winner = null;
  STATE.roundResetAt = 0;

  console.log("[server] round reset complete");
}

// --------------------------------------------------
// Snapshot to each client
// --------------------------------------------------
function snapshotFor(playerId) {
  const me = STATE.players.get(playerId);
  if (!me) return null;

  const roomName = me.room;
  const roomDef = ROOM_TEMPLATES[roomName];
  const tNow = now();

  const itemsInRoom = STATE.roomItems[roomName] || [];
  const allTrapsInRoom = STATE.roomTraps[roomName] || [];

  // only send traps you own so others can't see them
  const visibleTraps = allTrapsInRoom
    .filter(tr => tr.owner === me.id)
    .map(tr => ({
      id: tr.id,
      x: tr.x,
      y: tr.y,
      owner: tr.owner
    }));

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
// Game loop
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
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
