import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const app = express();
app.use(express.static("public"));

const server = createServer(app);
const wss = new WebSocketServer({ server });

const SPEED = 140;        // px/sec
const TICK_HZ = 15;       // server tickrate (Hz)
const STUN_MS = 2000;     // trap stun length
const SCORE_TO_WIN = 5;   // score race target
const WIN_BANNER_MS = 3000; // ms to show winner before reset

function now() { return Date.now(); }

// ---------------------------------------------------------------------
// ROOM DEFINITIONS (TEMPLATES)
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// GLOBAL RUNTIME STATE
// ---------------------------------------------------------------------

const STATE = {
  tick: 0,
  players: new Map(),   // id -> player
  roomItems: {},        // roomName -> [ {id,x,y,label}, ... ]
  roomTraps: {},        // roomName -> [ {id,x,y,owner,armed}, ... ]

  // winner: { id, type, until } OR null
  winner: null
};

// initialize room items/traps from template
function resetRoomsAndItems() {
  STATE.roomItems = {};
  STATE.roomTraps = {};
  for (const roomName of Object.keys(ROOM_TEMPLATES)) {
    const tmpl = ROOM_TEMPLATES[roomName];
    STATE.roomItems[roomName] = tmpl.items.map(it => ({ ...it }));
    STATE.roomTraps[roomName] = [];
  }
}

// full round reset after banner timeout
function hardResetRound() {
  console.log("[server] HARD RESET ROUND");

  // reset rooms
  resetRoomsAndItems();

  // wipe winner BEFORE resuming play
  STATE.winner = null;

  // respawn/reset every player
  STATE.players.forEach((p) => {
    const s = spawnPos();
    p.room = s.room;
    p.x = s.x;
    p.y = s.y;
    p.vx = 0;
    p.vy = 0;
    p.inventory = [];
    p.stunnedUntil = 0;
    p.score = 0;
  });
}

// boot-time init
resetRoomsAndItems();

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------

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

// Are we currently in "winner freeze" time?
function inWinnerFreeze() {
  if (!STATE.winner) return false;
  return now() < STATE.winner.until;
}

// After freeze ends, trigger a hard reset (one time)
function maybeEndWinnerFreeze() {
  if (!STATE.winner) return;
  if (now() >= STATE.winner.until) {
    // freeze is over, do hard reset round
    hardResetRound();
  }
}

// ---------------------------------------------------------------------
// NEW CONNECTION
// ---------------------------------------------------------------------

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  const start = spawnPos();

  const player = {
    id,
    room: start.room,
    x: start.x,
    y: start.y,
    vx: 0,
    vy: 0,
    color: randColor(),

    lastSeq: 0,
    lastHeard: now(),

    inventory: [],     // [{id,label}]
    stunnedUntil: 0,   // timestamp (ms)
    score: 0,          // trap points

    _ws: ws
  };

  STATE.players.set(id, player);

  console.log(`[server] player connected ${id} in ${player.room} (${player.x},${player.y})`);

  ws.send(JSON.stringify({ t: "welcome", id, tick: STATE.tick }));
  sendSnapshot(ws);

  ws.on("message", (buf) => {
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

// ---------------------------------------------------------------------
// INPUT / ACTION
// ---------------------------------------------------------------------

function handleInput(player, m) {
  // If we're in freeze OR they're stunned, ignore movement
  if (inWinnerFreeze() || player.stunnedUntil > now()) {
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

// pick up closest item in the room
function handlePickup(player) {
  // You shouldn't be able to pick stuff up during freeze either
  if (inWinnerFreeze()) return;

  const roomName = player.room;
  const itemsInRoom = STATE.roomItems[roomName];
  if (!itemsInRoom || !itemsInRoom.length) return;

  const PICK_RADIUS = 20;

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

// place a trap in the current room if you have TRAP KIT
function handlePlaceTrap(player) {
  if (inWinnerFreeze()) return;

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

  player.inventory.splice(trapIndex, 1);
}

// ---------------------------------------------------------------------
// SIMULATION STEP
// ---------------------------------------------------------------------

function step(dt) {
  const tNow = now();

  STATE.players.forEach((p) => {
    // During winner freeze, no movement at all
    if (inWinnerFreeze()) {
      p.vx = 0;
      p.vy = 0;
    } else if (p.stunnedUntil > tNow) {
      // stunned, no movement
      p.vx = 0;
      p.vy = 0;
    } else {
      // normal movement
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    // Clamp inside room
    const def = ROOM_TEMPLATES[p.room];
    p.x = Math.max(16, Math.min(def.w - 16, p.x));
    p.y = Math.max(16, Math.min(def.h - 16, p.y));

    // Door teleport (only if not frozen)
    if (!inWinnerFreeze()) {
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

    // Trap trigger (AFTER door travel, not during freeze)
    if (!inWinnerFreeze()) {
      applyTrapIfHit(p, tNow);
    }
  });

  // Only check win conditions (and maybe start freeze) if we're not already frozen
  if (!inWinnerFreeze()) {
    checkWinByEscape();
    checkWinByScore();
  } else {
    // If freeze time expired, reset round
    maybeEndWinnerFreeze();
  }

  STATE.tick++;
}

// trap collision check
function applyTrapIfHit(victim, tNow) {
  const roomName = victim.room;
  const traps = STATE.roomTraps[roomName];
  if (!traps || !traps.length) return;

  const TRIGGER_RADIUS = 32;

  for (let i = 0; i < traps.length; i++) {
    const tr = traps[i];
    if (!tr.armed) continue;

    const dist = Math.hypot(victim.x - tr.x, victim.y - tr.y);

    if (dist < TRIGGER_RADIUS * 2) {
      console.log(
        `[server] checking trap ${tr.id} vs player ${victim.id} in ${roomName}: dist=${dist.toFixed(
          1
        )}, radius=${TRIGGER_RADIUS}`
      );
    }

    // owner is immune
    if (victim.id === tr.owner) {
      if (dist <= TRIGGER_RADIUS) {
        console.log(
          `[server] ${victim.id} is standing on their OWN trap ${tr.id} (safe)`
        );
      }
      continue;
    }

    // victim triggers it
    if (dist <= TRIGGER_RADIUS) {
      console.log(
        `[server] TRAP TRIGGERED ${tr.id} on player ${victim.id} in ${roomName} at (${tr.x},${tr.y})`
      );

      tr.armed = false;

      // stun victim
      victim.stunnedUntil = tNow + STUN_MS;
      victim.vx = 0;
      victim.vy = 0;

      // score for owner
      const ownerPlayer = STATE.players.get(tr.owner);
      if (ownerPlayer) {
        ownerPlayer.score = (ownerPlayer.score || 0) + 1;
        console.log(`[server] ${tr.owner} SCORE +1 => ${ownerPlayer.score}`);
      }

      // remove trap from room
      traps.splice(i, 1);

      break;
    }
  }
}

// ---------------------------------------------------------------------
// WIN CONDITIONS
// ---------------------------------------------------------------------

function startWinnerFreeze(winnerId, typeStr) {
  STATE.winner = {
    id: winnerId,
    type: typeStr,       // "escape" or "score"
    until: now() + WIN_BANNER_MS
  };
  console.log(`[server] WINNER (${typeStr.toUpperCase()}) IS ${winnerId}`);
}

function checkWinByEscape() {
  // "escape" win: intel+key+exit
  if (STATE.winner) return;

  STATE.players.forEach((p) => {
    const hasIntel = p.inventory.some(
      it => it.id === "brief" || it.label === "INTEL"
    );
    const hasKey   = p.inventory.some(
      it => it.id === "key"   || it.label === "KEY"
    );
    if (!hasIntel || !hasKey) return;
    if (p.room !== "EXIT") return;

    const exitAnchor = ROOM_TEMPLATES.EXIT.items.find(
      it => it.id === "escape"
    );
    if (!exitAnchor) return;

    const distToExit = Math.hypot(p.x - exitAnchor.x, p.y - exitAnchor.y);
    const WIN_RADIUS = 24;

    if (distToExit <= WIN_RADIUS) {
      startWinnerFreeze(p.id, "escape");
    }
  });
}

function checkWinByScore() {
  // "score" win: first to SCORE_TO_WIN
  if (STATE.winner) return;

  STATE.players.forEach((p) => {
    if (p.score >= SCORE_TO_WIN) {
      startWinnerFreeze(p.id, "score");
    }
  });
}

// ---------------------------------------------------------------------
// SNAPSHOT
// ---------------------------------------------------------------------

function snapshotFor(playerId) {
  const me = STATE.players.get(playerId);
  if (!me) return null;

  const roomName = me.room;
  const roomDef = ROOM_TEMPLATES[roomName];

  const itemsInRoom = STATE.roomItems[roomName] || [];
  const trapsInRoom = STATE.roomTraps[roomName] || [];

  const tNow = now();

  // players in same room + add shortId for nameplate
  const visiblePlayers = [];
  STATE.players.forEach((p) => {
    if (p.room === me.room) {
      visiblePlayers.push({
        id: p.id,
        shortId: p.id.slice(0,4),
        room: p.room,
        x: Math.round(p.x),
        y: Math.round(p.y),
        color: p.color,
        isStunned: p.stunnedUntil > tNow,
        stunMsRemaining: Math.max(p.stunnedUntil - tNow, 0),
        score: p.score || 0
      });
    }
  });

  // only show YOUR traps to YOU
  const visibleTraps = trapsInRoom
    .filter(tr => tr.owner === me.id)
    .map(tr => ({
      id: tr.id,
      x: tr.x,
      y: tr.y,
      owner: tr.owner
    }));

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

    youScore: me.score || 0,
    scoreTarget: SCORE_TO_WIN,

    // If we're frozen, we still send winner so client can keep banner visible
    winner: STATE.winner
      ? { id: STATE.winner.id, type: STATE.winner.type }
      : null
  };
}

// send one snapshot to one socket
function sendSnapshot(ws) {
  const player = [...STATE.players.values()].find(p => p._ws === ws);
  if (!player) return;

  const payload = snapshotFor(player.id);
  if (!payload) return;

  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

// broadcast snapshots to all connected
function broadcastSnapshots() {
  STATE.players.forEach((p) => {
    const ws = p._ws;
    if (!ws || ws.readyState !== 1) return;

    const payload = snapshotFor(p.id);
    if (!payload) return;

    ws.send(JSON.stringify(payload));
  });
}

// ---------------------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------------------

let last = now();
setInterval(() => {
  const t = now();
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;

  step(dt);
  broadcastSnapshots();
}, 1000 / TICK_HZ);

// ---------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
