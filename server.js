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
const STUN_MS = 2000;       // floor trap stun
const DOOR_TRAP_STUN_MS = 3000; // NEW: stronger stun for door traps
const TRIGGER_RADIUS = 32;  // trap radius
const PROJECTILE_SPEED = 300; // px/sec
const PROJECTILE_RADIUS = 8;
const SHOTS_TO_KILL = 3;
const FIRE_RATE_MS = 500;   // half-second between shots
const PICK_RADIUS = 20;     // pickup distance
const DOOR_ARM_RADIUS = 24; // NEW: how close you must be to arm a door with SPRING
const WIN_RADIUS = 24;      // distance to exit pad to escape
const ROUND_END_FREEZE_MS = 3000; // pause before new round
const SCORE_PER_WIN = 1;
const SCORE_TARGET = 5;

const DISGUISE_DURATION_MS = 6000;   // NEW
const RADAR_DURATION_MS = 5000;      // NEW

function now() { return Date.now(); }

// --------------------------------------------------
// ROOM TEMPLATES
// --------------------------------------------------
const ROOM_TEMPLATES = {
  ARMORY: {
    w: 320, h: 200,
    items: [
      { id: "bomb",   x: 80,  y: 100, label: "BOMB" },
      { id: "spring", x: 120, y: 140, label: "SPRING" } // NEW: door trap tool
    ],
    doors: [
      { x:300, y:80, w:20, h:40, targetRoom:"CONTROL", targetX:20,  targetY:100 }
    ]
  },

  CONTROL: {
    w: 320, h: 200,
    items: [
      { id: "map",  x:160, y:60,  label:"MAP" },              // NEW: radar intel
      { id: "wire", x:220, y:120, label:"WIRE CUTTER" }       // future: disarm traps
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
      { id: "paint", x:80,  y:60,  label:"DISGUISE" }, // NEW: lets you hide ID
      { id: "trap",  x:200, y:120, label:"TRAP KIT" }  // our floor trap
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
// PLAYER SPAWNS
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
const TRAP_ROOMS_FOR_RESPAWN = [ "WORKSHOP", "CONTROL", "ARMORY", "INTEL" ];

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

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --------------------------------------------------
// GLOBAL STATE
// --------------------------------------------------
const STATE = {
  tick: 0,
  players: new Map(),    // id -> player
  roomItems: {},         // roomName -> [{id,x,y,label}, ...]
  roomTraps: {},         // roomName -> [{id,x,y,owner,armed}, ...]  (floor traps)
  roomDoorTraps: {},     // NEW: roomName -> [{doorIndex, owner, armed, type}]
  roomProjectiles: {},   // roomName -> [{id,owner,x,y,vx,vy}, ...]
  roundOver: false,
  winner: null,          // { id, type }
  roundResetAt: 0
};

resetRooms();

// --------------------------------------------------
// Reset helpers
// --------------------------------------------------
function resetRooms() {
  STATE.roomItems = {};
  STATE.roomTraps = {};
  STATE.roomDoorTraps = {};
  STATE.roomProjectiles = {};

  for (const roomName of Object.keys(ROOM_TEMPLATES)) {
    const tmpl = ROOM_TEMPLATES[roomName];
    STATE.roomItems[roomName] = tmpl.items.map(it => ({ ...it }));
    STATE.roomTraps[roomName] = [];
    STATE.roomDoorTraps[roomName] = [];
    STATE.roomProjectiles[roomName] = [];
  }
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
  p.disguisedUntil = 0;       // NEW: clear disguise
  p.radarRevealUntil = 0;     // NEW: clear radar
  p.health = SHOTS_TO_KILL;
  p.lastShotTime = 0;
}

// --------------------------------------------------
// Connection
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

    score: 0,

    lastSeq: 0,
    lastHeard: now(),

    inventory: [],
    stunnedUntil: 0,

    health: SHOTS_TO_KILL,
    lastShotTime: 0,

    disguisedUntil: 0,       // NEW
    radarRevealUntil: 0,     // NEW

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
      return; // ignore input during round end freeze
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
    if (m.t === "useItem") { // NEW
      console.log(`[server] ${player.id} requests USE ITEM idx=${m.which}`);
      handleUseItem(player, m.which);
    }
    if (m.t === "shoot") {
      console.log(`[server] ${player.id} requests SHOOT`);
      handleShoot(player);
    }
  });

  ws.on("close", () => {
    console.log(`[server] player disconnected ${id}`);
    STATE.players.delete(id);
  });
});

// --------------------------------------------------
// Input / Move
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

// --------------------------------------------------
// Pickup logic
// --------------------------------------------------
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

      // remove from floor
      itemsInRoom.splice(i, 1);

      // If they took the TRAP KIT, respawn a new one in a random room
      if (pickedTrapKit) {
        respawnTrapKitElsewhere(roomName);
      }

      break;
    }
  }
}

function respawnTrapKitElsewhere(prevRoomName) {
  // choose random allowed room that is NOT the room we just grabbed from
  let pool = TRAP_ROOMS_FOR_RESPAWN.filter(r => r !== prevRoomName);
  if (!pool.length) {
    pool = TRAP_ROOMS_FOR_RESPAWN.slice();
  }

  const newRoom = pick(pool);
  const spot = pick(TRAP_RESPAWN_SPOTS[newRoom]);

  if (!STATE.roomItems[newRoom]) STATE.roomItems[newRoom] = [];
  STATE.roomItems[newRoom].push({
    id: "trap",
    label: "TRAP KIT",
    x: spot.x,
    y: spot.y
  });

  console.log(`[server] TRAP KIT respawned in ${newRoom} at (${spot.x},${spot.y})`);
}

// --------------------------------------------------
// Using power-ups (MAP, DISGUISE, SPRING)
// --------------------------------------------------
function handleUseItem(player, whichIndexRaw) {
  // whichIndexRaw might be undefined or null if client didn't send it
  // In that case we just ignore.
  const whichIndex = (typeof whichIndexRaw === "number")
    ? whichIndexRaw
    : null;

  if (whichIndex === null) {
    console.log(`[server] ${player.id} tried USE with no index`);
    return;
  }

  const inv = player.inventory;
  if (whichIndex < 0 || whichIndex >= inv.length) {
    console.log(`[server] ${player.id} tried USE invalid index ${whichIndex}`);
    return;
  }

  const item = inv[whichIndex];
  if (!item) {
    console.log(`[server] ${player.id} tried USE missing item at ${whichIndex}`);
    return;
  }

  const nowMs = now();

  // normalize id/label for easier matching
  const name = (item.id || item.label || "").toUpperCase();

  // TRAP KIT
  if (name.includes("TRAP")) {
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
      `[server] ${player.id} PLACED FLOOR TRAP ${newTrap.id} in ${roomName} at (${newTrap.x},${newTrap.y})`
    );

    // consume the kit
    inv.splice(whichIndex, 1);
    return;
  }

  // DISGUISE (aka "paint" / "DISGUISE")
  if (name.includes("DISGUISE") || name === "PAINT") {
    console.log(`[server] ${player.id} USED DISGUISE from slot ${whichIndex}`);
    player.disguisedUntil = nowMs + DISGUISE_DURATION_MS;
    // consume item
    inv.splice(whichIndex, 1);
    return;
  }

  // MAP (radar intel)
  if (name.includes("MAP")) {
    console.log(`[server] ${player.id} USED MAP/RADAR from slot ${whichIndex}`);
    player.radarRevealUntil = nowMs + RADAR_DURATION_MS;
    inv.splice(whichIndex, 1);
    return;
  }

  // SPRING (door trap)
  if (name.includes("SPRING")) {
    const armed = tryArmDoorTrap(player);
    if (armed) {
      console.log(`[server] ${player.id} ARMED DOOR SPRING TRAP via slot ${whichIndex}`);
      inv.splice(whichIndex, 1);
    } else {
      console.log(`[server] ${player.id} tried SPRING but no door in range`);
    }
    return;
  }

  // default fallback: unhandled item
  console.log(`[server] ${player.id} tried USE on ${item.label} but no effect implemented`);
}


// --------------------------------------------------
// Door trap arming (SPRING)
// --------------------------------------------------
function tryArmDoorTrap(player) {
  const roomName = player.room;
  const roomDef = ROOM_TEMPLATES[roomName];
  if (!roomDef || !roomDef.doors) return false;

  // find closest door the spy is standing near
  let bestDoorIndex = -1;
  let bestDist = Infinity;

  roomDef.doors.forEach((door, i) => {
    // center of door rect
    const cx = door.x + door.w / 2;
    const cy = door.y + door.h / 2;
    const d = Math.hypot(player.x - cx, player.y - cy);
    if (d < bestDist) {
      bestDist = d;
      bestDoorIndex = i;
    }
  });

  if (bestDoorIndex === -1 || bestDist > DOOR_ARM_RADIUS) {
    return false;
  }

  if (!STATE.roomDoorTraps[player.room]) {
    STATE.roomDoorTraps[player.room] = [];
  }

  STATE.roomDoorTraps[player.room].push({
    doorIndex: bestDoorIndex,
    owner: player.id,
    armed: true,
    type: "SPRING"
  });

  return true;
}

// --------------------------------------------------
// Shooting
// --------------------------------------------------
function handleShoot(player) {
  const tNow = now();
  if (player.stunnedUntil > tNow) return;
  if (tNow - player.lastShotTime < FIRE_RATE_MS) return;

  player.lastShotTime = tNow;

  // projectile starts at player's center
  const px = player.x;
  const py = player.y;

  // velocity is based on player's current movement direction, or a default if still
  let pvx = player.vx;
  let pvy = player.vy;
  if (pvx === 0 && pvy === 0) {
    pvx = 1; // default to shooting right
  }
  const mag = Math.hypot(pvx, pvy) || 1;

  const proj = {
    id: "proj-" + crypto.randomUUID().slice(0, 8),
    owner: player.id,
    x: px,
    y: py,
    vx: (pvx / mag) * PROJECTILE_SPEED,
    vy: (pvy / mag) * PROJECTILE_SPEED,
    spawnedAt: tNow
  };

  const roomName = player.room;
  if (!STATE.roomProjectiles[roomName]) {
    STATE.roomProjectiles[roomName] = [];
  }
  STATE.roomProjectiles[roomName].push(proj);

  console.log(`[server] ${player.id} FIRED projectile ${proj.id} in ${roomName}`);
}

// --------------------------------------------------
// Simulation step
// --------------------------------------------------
function step(dt) {
  const tNow = now();

  if (STATE.roundOver) {
    // lock everyone in celebration
    STATE.players.forEach((p) => {
      p.vx = 0;
      p.vy = 0;
    });
  }

  STATE.players.forEach((p) => {
    // movement
    if (!STATE.roundOver && p.stunnedUntil <= tNow) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    } else {
      p.vx = 0;
      p.vy = 0;
    }

    // clamp
    const def = ROOM_TEMPLATES[p.room];
    p.x = Math.max(16, Math.min(def.w - 16, p.x));
    p.y = Math.max(16, Math.min(def.h - 16, p.y));

    // door teleport
    if (!STATE.roundOver && p.stunnedUntil <= tNow) {
      for (let dIndex = 0; dIndex < def.doors.length; dIndex++) {
        const door = def.doors[dIndex];
        const inside =
          p.x > door.x &&
          p.x < door.x + door.w &&
          p.y > door.y &&
          p.y < door.y + door.h;
        if (inside) {
          // check door traps BEFORE teleport:
          maybeTriggerDoorTrap(p, p.room, dIndex, tNow);

          // after trap check, still teleport
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
      applyFloorTrapIfHit(p, tNow);
    }
  });

  // move projectiles and check for hits
  for (const roomName of Object.keys(STATE.roomProjectiles)) {
    const projectilesInRoom = STATE.roomProjectiles[roomName];
    if (!projectilesInRoom || !projectilesInRoom.length) continue;

    const roomDef = ROOM_TEMPLATES[roomName];

    for (let i = projectilesInRoom.length - 1; i >= 0; i--) {
      const proj = projectilesInRoom[i];
      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;

      // remove if out of bounds
      if (proj.x < 0 || proj.x > roomDef.w || proj.y < 0 || proj.y > roomDef.h) {
        projectilesInRoom.splice(i, 1);
        continue;
      }

      // check for player hits
      for (const p of STATE.players.values()) {
        if (p.room !== roomName || p.id === proj.owner) continue;

        const dist = Math.hypot(p.x - proj.x, p.y - proj.y);
        if (dist < PROJECTILE_RADIUS * 2) { // using 2*radius for easier hits
          console.log(`[server] projectile ${proj.id} HIT player ${p.id}`);
          p.health--;

          // remove projectile
          projectilesInRoom.splice(i, 1);

          if (p.health <= 0) {
            console.log(`[server] player ${p.id} KILLED by ${proj.owner}`);
            const killer = STATE.players.get(proj.owner);
            if (killer) {
              killer.score++;
            }
            respawnPlayer(p);
          }
          break; // projectile is gone, stop checking this projectile
        }
      }
    }
  }

  if (!STATE.roundOver) {
    checkWinCondition();
  } else {
    maybeResetRound();
  }

  STATE.tick++;
}

// --------------------------------------------------
// Door trap trigger
// --------------------------------------------------
function maybeTriggerDoorTrap(player, roomName, doorIndex, tNow) {
  const trapsInRoom = STATE.roomDoorTraps[roomName];
  if (!trapsInRoom || !trapsInRoom.length) return;

  for (let i = 0; i < trapsInRoom.length; i++) {
    const trap = trapsInRoom[i];
    if (!trap.armed) continue;
    if (trap.doorIndex !== doorIndex) continue;

    // don't trigger your own
    if (trap.owner === player.id) {
      // owner is safe
      continue;
    }

    // trigger!
    console.log(
      `[server] DOOR TRAP TRIGGER: door ${doorIndex} in ${roomName} hit ${player.id}`
    );

    trap.armed = false;

    // punish victim: longer stun
    player.stunnedUntil = tNow + DOOR_TRAP_STUN_MS;
    player.vx = 0;
    player.vy = 0;

    // OPTIONAL: drop one random inventory item on the floor as loot
    if (player.inventory.length > 0) {
      const dropIdx = Math.floor(Math.random() * player.inventory.length);
      const dropped = player.inventory.splice(dropIdx, 1)[0];
      if (dropped) {
        // drop into this room at player's current position (pre-teleport)
        if (!STATE.roomItems[roomName]) STATE.roomItems[roomName] = [];
        STATE.roomItems[roomName].push({
          id: dropped.id,
          label: dropped.label,
          x: player.x,
          y: player.y
        });
        console.log(
          `[server] ${player.id} dropped ${dropped.label} in ${roomName}`
        );
      }
    }

    // remove the trap from the list entirely
    trapsInRoom.splice(i, 1);
    break;
  }
}

// --------------------------------------------------
// Floor trap trigger (TRAP KIT)
// --------------------------------------------------
function applyFloorTrapIfHit(player, tNow) {
  const roomName = player.room;
  const traps = STATE.roomTraps[roomName];
  if (!traps || !traps.length) return;

  for (let i = 0; i < traps.length; i++) {
    const tr = traps[i];
    if (!tr.armed) continue;

    const dist = Math.hypot(player.x - tr.x, player.y - tr.y);

    if (dist < TRIGGER_RADIUS * 2) {
      console.log(
        `[server] checking floor trap ${tr.id} vs player ${player.id} in ${roomName}: dist=${dist.toFixed(
          1
        )}, radius=${TRIGGER_RADIUS}`
      );
    }

    if (player.id === tr.owner) {
      if (dist <= TRIGGER_RADIUS) {
        console.log(
          `[server] ${player.id} is standing on their OWN floor trap ${tr.id} (safe)`
        );
      }
      continue;
    }

    if (dist <= TRIGGER_RADIUS) {
      console.log(
        `[server] FLOOR TRAP TRIGGERED ${tr.id} on player ${player.id} in ${roomName} at (${tr.x},${tr.y})`
      );

      tr.armed = false;

      player.stunnedUntil = tNow + STUN_MS;
      player.vx = 0;
      player.vy = 0;

      traps.splice(i, 1);
      break;
    }
  }
}

// --------------------------------------------------
// Win / Round reset
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

    // optional: first to SCORE_TARGET wins overall
    // if (p.score >= SCORE_TARGET) {...}
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

  // hard reset items, traps, door traps
  resetRooms();

  // respawn all players (keep score/color)
  STATE.players.forEach((p) => {
    respawnPlayer(p);
  });

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

  const tNow = now();
  const roomName = me.room;
  const roomDef = ROOM_TEMPLATES[roomName];

  const itemsInRoom = STATE.roomItems[roomName] || [];
  const floorTrapsInRoom = STATE.roomTraps[roomName] || [];
  const projectilesInRoom = STATE.roomProjectiles[roomName] || [];

  // Only show YOUR floor traps
  const visibleFloorTraps = floorTrapsInRoom
    .filter(tr => tr.owner === me.id)
    .map(tr => ({
      id: tr.id,
      x: tr.x,
      y: tr.y,
      owner: tr.owner
    }));

  // build visiblePlayers (this is where disguise is enforced)
  const visiblePlayers = [];
  STATE.players.forEach((p) => {
    if (p.room !== roomName) return;

    const disguised = (p.disguisedUntil > tNow);

    // If THEY are disguised and I'm NOT them, I should see fake info.
    // If it's me, or disguise expired, send real info.
    const iAmThisSpy = (p.id === me.id);
    let sendColor = p.color;
    let sendShortId = p.shortId;

    if (disguised && !iAmThisSpy) {
      sendColor = "#aaaaaa";   // generic grey
      sendShortId = "????";
    }

    visiblePlayers.push({
      id: p.id,
      shortId: sendShortId,
      room: p.room,
      x: Math.round(p.x),
      y: Math.round(p.y),
      color: sendColor,
      isStunned: p.stunnedUntil > tNow,
      stunMsRemaining: Math.max(p.stunnedUntil - tNow, 0),
      score: p.score
    });
  });

  // Radar intel (only if *I* have radarRevealUntil active)
  let intelLocation = null;
  let keyLocation = null;
  let trapKitLocation = null;

  if (me.radarRevealUntil > tNow) {
    intelLocation = findItemLocation("brief", "INTEL");
    keyLocation = findItemLocation("key", "KEY");
    trapKitLocation = findItemLocation("trap", "TRAP KIT");
  }

  return {
    t: "snapshot",
    tick: STATE.tick,
    you: me.id,

    room: me.room,
    roomW: roomDef.w,
    roomH: roomDef.h,

    doors: roomDef.doors.map((d) => ({
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

    projectiles: projectilesInRoom.map(p => ({
      id: p.id,
      x: p.x,
      y: p.y
    })),

    traps: visibleFloorTraps,

    players: visiblePlayers,

    yourInventory: me.inventory.map(it => ({
      id: it.id,
      label: it.label
    })),

    youScore: me.score,
    scoreTarget: SCORE_TARGET,
    yourHealth: me.health,
    shotsToKill: SHOTS_TO_KILL,

    // who just won the round (for banner / freeze)
    winner: STATE.winner
      ? { id: STATE.winner.id, type: STATE.winner.type }
      : null,

    // NEW: intel from radar (client will display if non-null)
    intelLocation,
    keyLocation,
    trapKitLocation
  };
}

// helper: search where a certain item currently is
function findItemLocation(idMatch, labelMatch) {
  for (const roomName of Object.keys(STATE.roomItems)) {
    const arr = STATE.roomItems[roomName];
    for (const it of arr) {
      if (it.id === idMatch || it.label === labelMatch) {
        return { room: roomName };
      }
    }
  }
  return null;
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
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
