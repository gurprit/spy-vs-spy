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
const ROUND_END_FREEZE_MS = 3000; // freeze/celebrate before reset
const SCORE_PER_WIN = 1;    // how much you get for escaping
const SCORE_TARGET = 5;     // first to this wins overall (future use)

// --------------------------------------------------
function now() { return Date.now(); }

// --------------------------------------------------
// ROOM TEMPLATES (static "blueprint" for reset)
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
// GLOBAL RUNTIME STATE
// --------------------------------------------------
const STATE = {
  tick: 0,
  players: new Map(),    // id -> player
  roomItems: {},         // live items per room
  roomTraps: {},         // live traps per room
  roundOver: false,      // are we in the post-win freeze?
  winner: null,          // { id, type } once someone wins a round
  roundResetAt: 0        // timestamp when we should reset round
};

// initialize per-room live state (items, traps)
function resetRooms() {
  STATE.roomItems = {};
  STATE.roomTraps = {};
  for (const roomName of Object.keys(ROOM_TEMPLATES)) {
    const tmpl = ROOM_TEMPLATES[roomName];
    STATE.roomItems[roomName] = tmpl.items.map(it => ({ ...it }));
    STATE.roomTraps[roomName] = [];
  }
}

// initial fill
resetRooms();

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function spawnPos() {
  return {
    room: "CONTROL",
    x: 160,
    y: 100
  };
}

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

// wipe player for new round but keep their score/color
function respawnPlayer(p) {
  const start = spawnPos();
  p.room = start.room;
  p.x = start.x;
  p.y = start.y;
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
  const start = spawnPos();

  const player = {
    id,
    shortId: id.slice(0,4),
    room: start.room,
    x: start.x,
    y: start.y,
    vx: 0,
    vy: 0,
    color: randColor(),

    score: 0,          // persistent between rounds

    lastSeq: 0,
    lastHeard: now(),

    inventory: [],     // [{id,label}]
    stunnedUntil: 0,   // ms timestamp
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
      // during roundOver we're frozen, ignore actions
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
// Player input handlers
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

// attempt pickup of closest item in room
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
      itemsInRoom.splice(i, 1);
      break;
    }
  }
}

// place a trap if you have TRAP KIT
function handlePlaceTrap(player) {
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
// Simulation / step
// --------------------------------------------------

function step(dt) {
  const tNow = now();

  // If roundOver: freeze everybody totally
  if (STATE.roundOver) {
    STATE.players.forEach((p) => {
      p.vx = 0;
      p.vy = 0;
    });
  }

  STATE.players.forEach((p) => {
    // regular movement if not stunned and not roundOver
    if (!STATE.roundOver && p.stunnedUntil <= tNow) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    } else {
      // freeze
      p.vx = 0;
      p.vy = 0;
    }

    // clamp in room
    const def = ROOM_TEMPLATES[p.room];
    p.x = Math.max(16, Math.min(def.w - 16, p.x));
    p.y = Math.max(16, Math.min(def.h - 16, p.y));

    // door teleport (only if not stunned and not roundOver)
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

    // trap check (after possible door change)
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

// trap collision
function applyTrapIfHit(player, tNow) {
  const roomName = player.room;
  const traps = STATE.roomTraps[roomName];
  if (!traps || !traps.length) return;

  for (let i = 0; i < traps.length; i++) {
    const tr = traps[i];
    if (!tr.armed) continue;

    const dist = Math.hypot(player.x - tr.x, player.y - tr.y);

    // debug-ish
    if (dist < TRIGGER_RADIUS * 2) {
      console.log(
        `[server] checking trap ${tr.id} vs player ${player.id} in ${roomName}: dist=${dist.toFixed(
          1
        )}, radius=${TRIGGER_RADIUS}`
      );
    }

    // don't trigger your own trap
    if (player.id === tr.owner) {
      if (dist <= TRIGGER_RADIUS) {
        console.log(
          `[server] ${player.id} is standing on their OWN trap ${tr.id} (safe)`
        );
      }
      continue;
    }

    // trigger someone else's trap
    if (dist <= TRIGGER_RADIUS) {
      console.log(
        `[server] TRAP TRIGGERED ${tr.id} on player ${player.id} in ${roomName} at (${tr.x},${tr.y})`
      );

      tr.armed = false;

      // stun victim
      player.stunnedUntil = tNow + STUN_MS;
      player.vx = 0;
      player.vy = 0;

      // remove trap
      traps.splice(i, 1);
      break;
    }
  }
}

// --------------------------------------------------
// Win / Round over / Reset
// --------------------------------------------------

// check if someone satisfies escape condition
function checkWinCondition() {
  // already handled in roundOver
  if (STATE.roundOver) return;

  const tNow = now();

  STATE.players.forEach((p) => {
    // Win path 1: Escape (has INTEL+KEY and stands on EXIT PAD)
    if (canEscape(p)) {
      console.log(`[server] WINNER (escape) IS ${p.id}`);

      // award score
      p.score += SCORE_PER_WIN;

      startRoundOver(p.id, "escape");
      return;
    }

    // Win path 2: Score race (optional future):
    // if (p.score >= SCORE_TARGET) {
    //   console.log(`[server] WINNER (score) IS ${p.id}`);
    //   startRoundOver(p.id, "score");
    // }
  });
}

// helper: does player meet escape condition right now?
function canEscape(p) {
  // need intel + key
  const hasIntel = p.inventory.some(
    it => it.id === "brief" || it.label === "INTEL"
  );
  const hasKey = p.inventory.some(
    it => it.id === "key" || it.label === "KEY"
  );
  if (!(hasIntel && hasKey)) return false;

  // must be in EXIT room near EXIT PAD
  if (p.room !== "EXIT") return false;
  const exitAnchor = ROOM_TEMPLATES.EXIT.items.find(
    it => it.id === "escape"
  );
  if (!exitAnchor) return false;

  const distToExit = Math.hypot(p.x - exitAnchor.x, p.y - exitAnchor.y);
  return distToExit <= WIN_RADIUS;
}

// mark round as over, freeze players, schedule reset
function startRoundOver(winnerId, type) {
  STATE.roundOver = true;
  STATE.winner = { id: winnerId, type };
  STATE.roundResetAt = now() + ROUND_END_FREEZE_MS;

  // hard-freeze everyone immediately
  STATE.players.forEach((p) => {
    p.vx = 0;
    p.vy = 0;
    // also "stun" for visuals client-side
    p.stunnedUntil = STATE.roundResetAt;
  });
}

// after freeze time, reset round
function maybeResetRound() {
  const tNow = now();
  if (!STATE.roundOver) return;
  if (tNow < STATE.roundResetAt) return;

  // 1. reset rooms (items respawn, traps cleared)
  resetRooms();

  // 2. respawn players but KEEP score/color
  STATE.players.forEach((p) => {
    respawnPlayer(p);
  });

  // 3. clear roundOver
  STATE.roundOver = false;
  STATE.winner = null;
  STATE.roundResetAt = 0;

  console.log("[server] round reset complete");
}

// --------------------------------------------------
// Snapshot per player -> send to that player only
// --------------------------------------------------
function snapshotFor(playerId) {
  const me = STATE.players.get(playerId);
  if (!me) return null;

  const roomName = me.room;
  const roomDef = ROOM_TEMPLATES[roomName];
  const tNow = now();

  // items in YOUR current room
  const itemsInRoom = STATE.roomItems[roomName] || [];
  // traps in YOUR current room
  // IMPORTANT: we only send traps that YOU own so other players can't see them
  const allTrapsInRoom = STATE.roomTraps[roomName] || [];
  const visibleTraps = allTrapsInRoom
    .filter(tr => tr.owner === me.id)
    .map(tr => ({
      id: tr.id,
      x: tr.x,
      y: tr.y,
      owner: tr.owner
    }));

  // players in your room
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
// Start server
// --------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
