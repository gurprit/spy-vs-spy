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
const WIN_RADIUS = 24;      // distance to exit door to escape
const ROUND_END_FREEZE_MS = 3000; // pause before new round
const SCORE_PER_WIN = 1;
const SCORE_TARGET = 5;

const BOMB_TRIGGER_RADIUS = 28;
const BOMB_ARM_DELAY_MS = 400; // grace period before it can detonate
const SEARCHABLE_LOOT = [
  { id: "bomb", label: "BOMB" },
  { id: "trap", label: "TRAP KIT" },
  { id: "spring", label: "SPRING" },
  { id: "map", label: "MAP" },
  { id: "paint", label: "DISGUISE" }
];

const DISGUISE_DURATION_MS = 6000;   // NEW
const RADAR_DURATION_MS = 5000;      // NEW

function now() { return Date.now(); }

// --------------------------------------------------
// MAP VARIANTS
// --------------------------------------------------
const MAP_VARIANTS = [
  {
    name: "Classic Compound",
    exitRoom: "EXIT",
    rooms: {
      ARMORY: {
        w: 320, h: 200,
        items: [
          { id: "bomb",   x: 80,  y: 100, label: "BOMB" },
          { id: "spring", x: 120, y: 140, label: "SPRING" }
        ],
        searchables: [
          { id: "armory-locker", label: "LOCKER", x: 250, y: 80 }
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
        searchables: [
          { id: "control-desk", label: "DESK", x: 70, y: 120 },
          { id: "control-cabinet", label: "CABINET", x: 260, y: 60 }
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
        searchables: [
          { id: "intel-filecab", label: "FILE CABINET", x: 70, y: 60 }
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
        searchables: [
          { id: "workshop-bench", label: "WORKBENCH", x: 260, y: 150 }
        ],
        doors: [
          { x:0, y:80, w:20, h:40, targetRoom:"INTEL", targetX:300, targetY:100 }
        ]
      },

      EXIT: {
        w: 320, h: 200,
        items: [
          { id: "escape", x:160, y:100, label:"EXIT DOOR" }
        ],
        searchables: [
          { id: "exit-crate", label: "CRATE", x: 60, y: 160 }
        ],
        doors: [
          { x:140, y:0, w:40, h:20, targetRoom:"INTEL", targetX:160, targetY:180 }
        ]
      }
    },
    spawns: [
      { room: "CONTROL",  x:160, y:100 },
      { room: "ARMORY",   x:200, y:120 },
      { room: "INTEL",    x:80,  y:140 },
      { room: "WORKSHOP", x:260, y:100 }
    ],
    trapRespawns: {
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
    }
  },

  {
    name: "North Wing",
    exitRoom: "EXIT",
    rooms: {
      CONTROL: {
        w: 320, h: 200,
        items: [
          { id: "map", x: 60, y: 80, label: "MAP" }
        ],
        searchables: [
          { id: "control-archive", label: "ARCHIVE", x: 240, y: 120 }
        ],
        doors: [
          { x:300, y:80, w:20, h:40, targetRoom:"HALL_A", targetX:20,  targetY:100 },
          { x:140, y:0,  w:40, h:20, targetRoom:"HALL_B", targetX:160, targetY:180 }
        ]
      },

      HALL_A: {
        w: 320, h: 200,
        items: [],
        searchables: [
          { id: "hall-a-locker", label: "LOCKER", x: 100, y: 140 }
        ],
        doors: [
          { x:0,   y:80, w:20, h:40, targetRoom:"CONTROL", targetX:300, targetY:100 },
          { x:300, y:80, w:20, h:40, targetRoom:"ARMORY",  targetX:20,  targetY:100 },
          { x:140, y:180, w:40, h:20, targetRoom:"EXIT",    targetX:160, targetY:20 }
        ]
      },

      HALL_B: {
        w: 320, h: 200,
        items: [],
        searchables: [
          { id: "hall-b-crate", label: "CRATE", x: 240, y: 60 }
        ],
        doors: [
          { x:140, y:180, w:40, h:20, targetRoom:"CONTROL",  targetX:160, targetY:20 },
          { x:140, y:0,   w:40, h:20, targetRoom:"HALL_C",    targetX:160, targetY:180 }
        ]
      },

      HALL_C: {
        w: 320, h: 200,
        items: [],
        searchables: [
          { id: "hall-c-shelf", label: "SHELF", x: 160, y: 100 }
        ],
        doors: [
          { x:140, y:180, w:40, h:20, targetRoom:"HALL_B", targetX:160, targetY:20 },
          { x:300, y:80,  w:20, h:40, targetRoom:"LAB",    targetX:20,  targetY:100 }
        ]
      },

      ARMORY: {
        w: 320, h: 200,
        items: [
          { id: "bomb", x: 200, y: 120, label: "BOMB" },
          { id: "spring", x: 80, y: 60, label: "SPRING" }
        ],
        searchables: [
          { id: "armory-rack", label: "WEAPON RACK", x: 240, y: 150 }
        ],
        doors: [
          { x:0, y:80, w:20, h:40, targetRoom:"HALL_A", targetX:300, targetY:100 }
        ]
      },

      LAB: {
        w: 320, h: 200,
        items: [
          { id: "paint", x: 220, y: 140, label: "DISGUISE" }
        ],
        searchables: [
          { id: "lab-bench", label: "LAB BENCH", x: 80, y: 80 }
        ],
        doors: [
          { x:0,   y:80, w:20, h:40, targetRoom:"HALL_C",   targetX:300, targetY:100 },
          { x:300, y:80, w:20, h:40, targetRoom:"STORAGE", targetX:20,  targetY:100 }
        ]
      },

      STORAGE: {
        w: 320, h: 200,
        items: [
          { id: "trap", x: 80, y: 150, label: "TRAP KIT" }
        ],
        searchables: [
          { id: "storage-crates", label: "CRATES", x: 200, y: 80 }
        ],
        doors: [
          { x:0, y:80, w:20, h:40, targetRoom:"LAB",  targetX:300, targetY:100 },
          { x:300, y:80, w:20, h:40, targetRoom:"EXIT", targetX:20,  targetY:100 }
        ]
      },

      EXIT: {
        w: 320, h: 200,
        items: [
          { id: "escape", x: 160, y: 100, label: "EXIT DOOR" }
        ],
        searchables: [
          { id: "exit-locker", label: "LOCKER", x: 260, y: 60 }
        ],
        doors: [
          { x:0, y:80, w:20, h:40, targetRoom:"STORAGE", targetX:300, targetY:100 },
          { x:140, y:0, w:40, h:20, targetRoom:"HALL_A",  targetX:160, targetY:180 }
        ]
      }
    },
    spawns: [
      { room: "CONTROL", x: 100, y: 140 },
      { room: "HALL_A",  x: 220, y: 120 },
      { room: "HALL_B",  x: 80,  y: 100 },
      { room: "LAB",     x: 200, y: 120 }
    ],
    trapRespawns: {
      CONTROL: [
        { x: 220, y: 120 },
        { x: 120, y: 80 }
      ],
      HALL_A: [
        { x: 160, y: 120 },
        { x: 260, y: 80 }
      ],
      ARMORY: [
        { x: 180, y: 100 },
        { x: 80,  y: 140 }
      ],
      LAB: [
        { x: 120, y: 140 },
        { x: 240, y: 80 }
      ],
      STORAGE: [
        { x: 220, y: 160 }
      ]
    }
  },

  {
    name: "Looping Lair",
    exitRoom: "EXIT",
    rooms: {
      ATRIUM: {
        w: 320, h: 200,
        items: [
          { id: "map", x: 160, y: 60, label: "MAP" }
        ],
        searchables: [
          { id: "atrium-planter", label: "PLANTER", x: 80, y: 140 }
        ],
        doors: [
          { x:0, y:80, w:20, h:40, targetRoom:"WEST_CORRIDOR", targetX:300, targetY:100 },
          { x:300, y:80, w:20, h:40, targetRoom:"EAST_CORRIDOR", targetX:20, targetY:100 }
        ]
      },

      WEST_CORRIDOR: {
        w: 320, h: 200,
        items: [],
        searchables: [
          { id: "west-locker", label: "LOCKER", x: 120, y: 100 }
        ],
        doors: [
          { x:0, y:80, w:20, h:40, targetRoom:"ARMORY", targetX:300, targetY:100 },
          { x:300, y:80, w:20, h:40, targetRoom:"ATRIUM", targetX:20, targetY:100 }
        ]
      },

      EAST_CORRIDOR: {
        w: 320, h: 200,
        items: [],
        searchables: [
          { id: "east-cabinet", label: "CABINET", x: 200, y: 140 }
        ],
        doors: [
          { x:0, y:80, w:20, h:40, targetRoom:"ATRIUM", targetX:300, targetY:100 },
          { x:300, y:80, w:20, h:40, targetRoom:"WORKSHOP", targetX:20, targetY:100 }
        ]
      },

      ARMORY: {
        w: 320, h: 200,
        items: [
          { id: "bomb", x: 220, y: 140, label: "BOMB" }
        ],
        searchables: [
          { id: "armory-chest", label: "CHEST", x: 80, y: 60 }
        ],
        doors: [
          { x:0, y:80, w:20, h:40, targetRoom:"VAULT", targetX:300, targetY:100 },
          { x:300, y:80, w:20, h:40, targetRoom:"WEST_CORRIDOR", targetX:20, targetY:100 }
        ]
      },

      VAULT: {
        w: 320, h: 200,
        items: [
          { id: "brief", x: 160, y: 100, label: "INTEL" },
          { id: "key", x: 240, y: 60, label: "KEY" }
        ],
        searchables: [
          { id: "vault-safe", label: "SAFE", x: 100, y: 150 }
        ],
        doors: [
          { x:0, y:80, w:20, h:40, targetRoom:"ARMORY", targetX:300, targetY:100 },
          { x:300, y:80, w:20, h:40, targetRoom:"EXIT", targetX:20, targetY:100 }
        ]
      },

      WORKSHOP: {
        w: 320, h: 200,
        items: [
          { id: "trap", x: 200, y: 120, label: "TRAP KIT" },
          { id: "paint", x: 80, y: 80, label: "DISGUISE" }
        ],
        searchables: [
          { id: "workshop-shelf", label: "SHELF", x: 260, y: 150 }
        ],
        doors: [
          { x:0, y:80, w:20, h:40, targetRoom:"EAST_CORRIDOR", targetX:300, targetY:100 },
          { x:300, y:80, w:20, h:40, targetRoom:"EXIT", targetX:20, targetY:100 }
        ]
      },

      EXIT: {
        w: 320, h: 200,
        items: [
          { id: "escape", x: 160, y: 100, label: "EXIT DOOR" }
        ],
        searchables: [
          { id: "exit-cache", label: "CACHE", x: 260, y: 60 }
        ],
        doors: [
          { x:0, y:80, w:20, h:40, targetRoom:"WORKSHOP", targetX:300, targetY:100 },
          { x:300, y:80, w:20, h:40, targetRoom:"VAULT", targetX:20, targetY:100 }
        ]
      }
    },
    spawns: [
      { room: "ATRIUM", x: 160, y: 150 },
      { room: "WEST_CORRIDOR", x: 160, y: 100 },
      { room: "EAST_CORRIDOR", x: 160, y: 100 },
      { room: "WORKSHOP", x: 140, y: 120 }
    ],
    trapRespawns: {
      ATRIUM: [
        { x: 240, y: 120 }
      ],
      WEST_CORRIDOR: [
        { x: 200, y: 100 }
      ],
      ARMORY: [
        { x: 120, y: 140 }
      ],
      WORKSHOP: [
        { x: 220, y: 150 }
      ],
      VAULT: [
        { x: 200, y: 160 }
      ]
    }
  }
];

function cloneRooms(defs) {
  const rooms = {};
  for (const [name, def] of Object.entries(defs)) {
    rooms[name] = {
      w: def.w,
      h: def.h,
      items: def.items.map(it => ({ ...it })),
      doors: def.doors.map(d => ({ ...d })),
      searchables: def.searchables ? def.searchables.map(s => ({ ...s, used: !!s.used })) : []
    };
  }
  return rooms;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

let CURRENT_MAP = null;
let ROOM_TEMPLATES = {};
let SPAWNS = [];
let TRAP_RESPAWN_SPOTS = {};

function chooseNewMapVariant(previousName = null) {
  let pool = MAP_VARIANTS;
  if (previousName) {
    const filtered = MAP_VARIANTS.filter(v => v.name !== previousName);
    if (filtered.length) {
      pool = filtered;
    }
  }

  const variant = pick(pool);
  CURRENT_MAP = variant;
  ROOM_TEMPLATES = cloneRooms(variant.rooms);
  SPAWNS = variant.spawns.map(sp => ({ ...sp }));
  TRAP_RESPAWN_SPOTS = {};
  for (const [roomName, spots] of Object.entries(variant.trapRespawns || {})) {
    TRAP_RESPAWN_SPOTS[roomName] = spots.map(s => ({ ...s }));
  }
  console.log(`[server] Map set to ${variant.name}`);
}

function randSpawn() {
  if (!SPAWNS.length) {
    return { room: Object.keys(ROOM_TEMPLATES)[0], x: 160, y: 100 };
  }
  const base = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
  const jitterX = (Math.random() * 20 - 10);
  const jitterY = (Math.random() * 20 - 10);
  return {
    room: base.room,
    x: base.x + jitterX,
    y: base.y + jitterY
  };
}

chooseNewMapVariant();

// --------------------------------------------------
// GLOBAL STATE
// --------------------------------------------------
const STATE = {
  tick: 0,
  players: new Map(),    // id -> player
  roomItems: {},         // roomName -> [{id,x,y,label}, ...]
  roomSearchables: {},   // roomName -> [{id,label,x,y,used}, ...]
  roomTraps: {},         // roomName -> [{id,x,y,owner,armed}, ...]  (floor traps)
  roomDoorTraps: {},     // NEW: roomName -> [{doorIndex, owner, armed, type}]
  roomBombs: {},         // roomName -> [{id,x,y,owner,armedAt}]
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
  STATE.roomSearchables = {};
  STATE.roomTraps = {};
  STATE.roomDoorTraps = {};
  STATE.roomBombs = {};
  STATE.roomProjectiles = {};

  for (const roomName of Object.keys(ROOM_TEMPLATES)) {
    const tmpl = ROOM_TEMPLATES[roomName];
    STATE.roomItems[roomName] = tmpl.items.map(it => ({ ...it }));
    STATE.roomSearchables[roomName] = (tmpl.searchables || []).map(s => ({ ...s, used: false }));
    STATE.roomTraps[roomName] = [];
    STATE.roomDoorTraps[roomName] = [];
    STATE.roomBombs[roomName] = [];
    STATE.roomProjectiles[roomName] = [];
  }
}

function dropInventory(player) {
  const items = player.inventory || [];
  if (!items.length) return;

  const roomName = player.room;
  if (!STATE.roomItems[roomName]) {
    STATE.roomItems[roomName] = [];
  }

  const roomDef = ROOM_TEMPLATES[roomName];
  const baseX = player.x;
  const baseY = player.y;
  const scatterRadius = 12;

  items.forEach((item, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(items.length, 1);
    let dropX = baseX + Math.cos(angle) * scatterRadius;
    let dropY = baseY + Math.sin(angle) * scatterRadius;

    if (roomDef) {
      dropX = Math.max(16, Math.min(roomDef.w - 16, dropX));
      dropY = Math.max(16, Math.min(roomDef.h - 16, dropY));
    }

    STATE.roomItems[roomName].push({
      id: item.id,
      label: item.label,
      x: dropX,
      y: dropY
    });

    console.log(
      `[server] ${player.id} dropped ${item.label} in ${roomName} at (${dropX.toFixed(1)},${dropY.toFixed(1)})`
    );
  });

  player.inventory = [];
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
    lastAimX: 1,
    lastAimY: 0,
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
      handleShoot(player, m);
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
  const magnitude = Math.hypot(dx, dy);

  if (magnitude > 0.0001) {
    const nx = dx / magnitude;
    const ny = dy / magnitude;
    player.vx = nx * SPEED;
    player.vy = ny * SPEED;
    player.lastAimX = nx;
    player.lastAimY = ny;
  } else {
    player.vx = 0;
    player.vy = 0;
  }
  player.lastHeard = now();
}

// --------------------------------------------------
// Pickup logic
// --------------------------------------------------
function handlePickup(player) {
  const roomName = player.room;
  const itemsInRoom = STATE.roomItems[roomName] || [];
  let interacted = false;

  for (let i = 0; i < itemsInRoom.length; i++) {
    const it = itemsInRoom[i];
    const dist = Math.hypot(player.x - it.x, player.y - it.y);

    if (dist <= PICK_RADIUS) {
      if (pickupItemFromRoom(player, roomName, itemsInRoom, i)) {
        interacted = true;
      }
      break;
    }
  }

  if (interacted) return;

  const searchables = STATE.roomSearchables[roomName] || [];
  for (const obj of searchables) {
    if (obj.used) continue;
    const dist = Math.hypot(player.x - obj.x, player.y - obj.y);
    if (dist <= PICK_RADIUS) {
      obj.used = true;
      const lootOptions = [...SEARCHABLE_LOOT, null, null];
      const found = pick(lootOptions);
      if (found) {
        player.inventory.push({ id: found.id, label: found.label });
        console.log(
          `[server] ${player.id} searched ${obj.label} in ${roomName} and found ${found.label}`
        );
      } else {
        console.log(
          `[server] ${player.id} searched ${obj.label} in ${roomName} but found nothing`
        );
      }
      interacted = true;
      break;
    }
  }
}

function pickupItemFromRoom(player, roomName, itemsInRoom, index, opts = {}) {
  if (!itemsInRoom || index < 0 || index >= itemsInRoom.length) return false;

  const item = itemsInRoom[index];
  if (!item) return false;

  const allowEscape = opts.allowEscape !== false;
  if (!allowEscape && item.id === "escape") {
    return false;
  }

  console.log(
    `[server] ${player.id} PICKED UP ${item.label} in ${roomName} at (${item.x},${item.y})`
  );

  player.inventory.push({ id: item.id, label: item.label });

  itemsInRoom.splice(index, 1);

  const pickedTrapKit = (item.id === "trap" || item.label === "TRAP KIT");
  if (pickedTrapKit) {
    respawnTrapKitElsewhere(roomName);
  }

  return true;
}

function autoPickupNearbyItems(player, tNow) {
  if (player.stunnedUntil > tNow) return;

  const roomName = player.room;
  const itemsInRoom = STATE.roomItems[roomName];
  if (!itemsInRoom || !itemsInRoom.length) return;

  for (let i = itemsInRoom.length - 1; i >= 0; i--) {
    const it = itemsInRoom[i];
    if (!it) continue;
    const dist = Math.hypot(player.x - it.x, player.y - it.y);
    if (dist <= PICK_RADIUS) {
      pickupItemFromRoom(player, roomName, itemsInRoom, i, { allowEscape: false });
    }
  }
}

function respawnTrapKitElsewhere(prevRoomName) {
  const rooms = Object.keys(TRAP_RESPAWN_SPOTS);
  if (!rooms.length) return;

  let pool = rooms.filter(r => r !== prevRoomName);
  if (!pool.length) {
    pool = rooms.slice();
  }

  const newRoom = pick(pool);
  const spots = TRAP_RESPAWN_SPOTS[newRoom] || [];
  if (!spots.length) return;
  const spot = pick(spots);

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

  // BOMB (lethal floor trap)
  if (name.includes("BOMB")) {
    const roomName = player.room;
    if (!STATE.roomBombs[roomName]) STATE.roomBombs[roomName] = [];
    const bomb = {
      id: "bomb-" + crypto.randomUUID().slice(0, 8),
      owner: player.id,
      x: player.x,
      y: player.y,
      armedAt: nowMs + BOMB_ARM_DELAY_MS
    };
    STATE.roomBombs[roomName].push(bomb);
    console.log(
      `[server] ${player.id} DROPPED BOMB ${bomb.id} in ${roomName} at (${bomb.x},${bomb.y})`
    );
    inv.splice(whichIndex, 1);
    return;
  }

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
function handleShoot(player, message) {
  const tNow = now();
  if (player.stunnedUntil > tNow) return;
  if (tNow - player.lastShotTime < FIRE_RATE_MS) return;

  player.lastShotTime = tNow;

  // projectile starts at player's center
  const px = player.x;
  const py = player.y;

  // velocity is based on the last aim direction, not necessarily movement
  let pvx = player.lastAimX;
  let pvy = player.lastAimY;

  if (message) {
    const { aimX, aimY } = message;
    if (typeof aimX === "number" && typeof aimY === "number") {
      const aimMag = Math.hypot(aimX, aimY);
      if (aimMag > 0.0001) {
        pvx = aimX / aimMag;
        pvy = aimY / aimMag;
        player.lastAimX = pvx;
        player.lastAimY = pvy;
      }
    }
  }

  if (pvx === 0 && pvy === 0) {
    pvx = 1;
    pvy = 0;
    player.lastAimX = pvx;
    player.lastAimY = pvy;
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
  p.lastAimX = 1;
  p.lastAimY = 0;
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

    autoPickupNearbyItems(p, tNow);

    if (!STATE.roundOver) {
      applyFloorTrapIfHit(p, tNow);
      applyBombsIfHit(p, tNow);
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
            dropInventory(p);
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

function applyBombsIfHit(player, tNow) {
  const roomName = player.room;
  const bombs = STATE.roomBombs[roomName];
  if (!bombs || !bombs.length) return;

  for (let i = bombs.length - 1; i >= 0; i--) {
    const bomb = bombs[i];
    if (tNow < bomb.armedAt) continue;

    const dist = Math.hypot(player.x - bomb.x, player.y - bomb.y);
    if (dist > BOMB_TRIGGER_RADIUS) continue;

    if (player.id === bomb.owner) {
      continue;
    }

    bombs.splice(i, 1);

    console.log(
      `[server] BOMB ${bomb.id} detonated on ${player.id} in ${roomName}`
    );

    const owner = STATE.players.get(bomb.owner);
    if (owner) {
      owner.score++;
    }

    dropInventory(player);
    respawnPlayer(player);
    break;
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

  const exitRoomName = (CURRENT_MAP && CURRENT_MAP.exitRoom) ? CURRENT_MAP.exitRoom : "EXIT";
  if (p.room !== exitRoomName) return false;

  const exitRoomDef = ROOM_TEMPLATES[exitRoomName];
  if (!exitRoomDef) return false;

  const exitAnchor = exitRoomDef.items.find(
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
  const previousMapName = CURRENT_MAP ? CURRENT_MAP.name : null;
  chooseNewMapVariant(previousMapName);
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
  const searchablesInRoom = STATE.roomSearchables[roomName] || [];
  const bombsInRoom = STATE.roomBombs[roomName] || [];

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
    mapName: CURRENT_MAP ? CURRENT_MAP.name : "",

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

    searchables: searchablesInRoom.map(obj => ({
      id: obj.id,
      x: obj.x,
      y: obj.y,
      label: obj.label,
      used: !!obj.used
    })),

    projectiles: projectilesInRoom.map(p => ({
      id: p.id,
      x: p.x,
      y: p.y
    })),

    bombs: bombsInRoom.map(b => ({
      id: b.id,
      x: b.x,
      y: b.y,
      owner: b.owner,
      armed: tNow >= b.armedAt
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

  // If not on the floor, see if a player is carrying it.
  for (const player of STATE.players.values()) {
    const hasItem = player.inventory.some((it) => {
      return it.id === idMatch || it.label === labelMatch;
    });
    if (hasItem) {
      return {
        room: player.room,
        carriedBy: player.shortId
      };
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
