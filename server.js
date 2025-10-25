import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const app = express();
app.use(express.static("public"));

const server = createServer(app);
const wss = new WebSocketServer({ server });

const SPEED = 140;
const TICK_HZ = 15;

function now() { return Date.now(); }

// --- ROOM DEFINITIONS -------------------------------------------------
// Each room has: width/height (for clamping), and doors.
// Doors say: if you're inside this rect, move to targetRoom at targetPos.
const ROOMS = {
  ARMORY: {
    w: 320, h: 200,
    doors: [
      {
        x: 300, y: 80, w: 20, h: 40, // right edge door
        targetRoom: "CONTROL",
        targetX: 20, targetY: 100
      }
    ]
  },
  CONTROL: {
    w: 320, h: 200,
    doors: [
      {
        x: 0, y: 80, w: 20, h: 40, // left door to ARMORY
        targetRoom: "ARMORY",
        targetX: 300, targetY: 100
      },
      {
        x: 140, y: 180, w: 40, h: 20, // bottom door to INTEL
        targetRoom: "INTEL",
        targetX: 160, targetY: 20
      }
    ]
  },
  INTEL: {
    w: 320, h: 200,
    doors: [
      {
        x: 140, y: 0, w: 40, h: 20, // top -> CONTROL
        targetRoom: "CONTROL",
        targetX: 160, targetY: 180
      },
      {
        x: 300, y: 80, w: 20, h: 40, // right -> WORKSHOP
        targetRoom: "WORKSHOP",
        targetX: 20, targetY: 100
      },
      {
        x: 140, y: 180, w: 40, h: 20, // bottom -> EXIT
        targetRoom: "EXIT",
        targetX: 160, targetY: 20
      }
    ]
  },
  WORKSHOP: {
    w: 320, h: 200,
    doors: [
      {
        x: 0, y: 80, w: 20, h: 40, // left -> INTEL
        targetRoom: "INTEL",
        targetX: 300, targetY: 100
      }
    ]
  },
  EXIT: {
    w: 320, h: 200,
    doors: [
      {
        x: 140, y: 0, w: 40, h: 20, // top -> INTEL
        targetRoom: "INTEL",
        targetX: 160, targetY: 180
      }
    ]
  }
};

// pick a starting room/pos
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

// Game state
const ROOM_STATE = {
  tick: 0,
  players: new Map() // id -> player
};

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
    _ws: ws
  };
  ROOM_STATE.players.set(id, player);

  ws.send(JSON.stringify({ t: "welcome", id, tick: ROOM_STATE.tick }));

  sendSnapshot(ws);

  ws.on("message", (buf) => {
    try {
      const m = JSON.parse(buf);
      if (m.t === "input") {
        if (m.seq <= player.lastSeq) return;
        player.lastSeq = m.seq;
        const { dx = 0, dy = 0 } = m;
        let mag = Math.hypot(dx, dy) || 1;
        player.vx = (dx / mag) * SPEED;
        player.vy = (dy / mag) * SPEED;
        player.lastHeard = now();
      }
    } catch {}
  });

  ws.on("close", () => {
    ROOM_STATE.players.delete(id);
  });
});

function step(dt) {
  ROOM_STATE.players.forEach((p) => {
    // apply velocity in local room space
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // clamp inside room bounds
    const def = ROOMS[p.room];
    p.x = Math.max(16, Math.min(def.w - 16, p.x));
    p.y = Math.max(16, Math.min(def.h - 16, p.y));

    // check door overlaps: if touching a door rect, teleport
    for (const door of def.doors) {
      if (
        p.x > door.x &&
        p.x < door.x + door.w &&
        p.y > door.y &&
        p.y < door.y + door.h
      ) {
        p.room = door.targetRoom;
        p.x = door.targetX;
        p.y = door.targetY;
        break;
      }
    }
  });

  ROOM_STATE.tick++;
}

// Only send players that are in the same room to each client
// so you can't "see" through walls/other rooms.
function snapshotFor(playerId) {
  const me = ROOM_STATE.players.get(playerId);
  if (!me) return null;

  const visiblePlayers = [];
  ROOM_STATE.players.forEach((p) => {
    if (p.room === me.room) {
      visiblePlayers.push({
        id: p.id,
        room: p.room,
        x: Math.round(p.x),
        y: Math.round(p.y),
        color: p.color
      });
    }
  });

  const roomInfo = ROOMS[me.room];
  return {
    t: "snapshot",
    tick: ROOM_STATE.tick,
    you: me.id,
    room: me.room,
    roomW: roomInfo.w,
    roomH: roomInfo.h,
    doors: roomInfo.doors.map(d => ({
      x: d.x,
      y: d.y,
      w: d.w,
      h: d.h
    })),
    players: visiblePlayers
  };
}

function sendSnapshot(ws) {
  // find which player this ws is
  const player = [...ROOM_STATE.players.values()].find(p => p._ws === ws);
  if (!player) return;
  const payload = snapshotFor(player.id);
  if (!payload) return;
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function broadcastSnapshots() {
  ROOM_STATE.players.forEach((p) => {
    const ws = p._ws;
    if (!ws || ws.readyState !== 1) return;
    const payload = snapshotFor(p.id);
    if (!payload) return;
    ws.send(JSON.stringify(payload));
  });
}

let last = now();
setInterval(() => {
  const t = now();
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;

  step(dt);
  broadcastSnapshots();
}, 1000 / TICK_HZ);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
