/* global Phaser */
const WS_URL = (typeof location !== "undefined" && location.origin)
  ? location.origin.replace(/^http/, "ws")
  : "ws://localhost:3000";

const VIEW_W = 900;
const VIEW_H = 640;

let ws;
let myId = null;
let seq = 0;

// latest snapshot from server
let latest = {
  room: null,
  roomW: 320,
  roomH: 200,
  players: [],
  doors: []
};

// render cache
const renderPlayers = new Map(); // id -> {x,y,gfx,color}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  backgroundColor: "#0d0f14",
  scale: {
    width: VIEW_W,
    height: VIEW_H,
    mode: Phaser.Scale.NONE
  },
  physics: { default: "arcade" },
  scene: { create, update }
});

function create() {
  const scene = this;

  // graphics layers
  scene.roomLayer = scene.add.layer();
  scene.doorLayer = scene.add.layer();
  scene.playerLayer = scene.add.layer();

  // keyboard
  scene.cursors = scene.input.keyboard.createCursorKeys();
  scene.keys = scene.input.keyboard.addKeys("W,A,S,D");

  // connect ws
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[client] ws open");
  };

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "welcome") {
      myId = m.id;
      return;
    }
    if (m.t === "snapshot") {
      latest = m;
      // we rebuild the room each snapshot (cheap for now)
      drawRoom(scene, latest);
    }
  };

  ws.onerror = (err) => console.warn("[client] ws error", err);
  ws.onclose  = () => console.warn("[client] ws closed");
}

function update(time, delta) {
  const scene = this;
  const dt = delta / 1000;

  // send movement
  let dx = 0, dy = 0;
  if (scene.cursors.left.isDown || scene.keys.A.isDown) dx -= 1;
  if (scene.cursors.right.isDown || scene.keys.D.isDown) dx += 1;
  if (scene.cursors.up.isDown || scene.keys.W.isDown) dy -= 1;
  if (scene.cursors.down.isDown || scene.keys.S.isDown) dy += 1;

  seq++;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "input", seq, dx, dy }));
  }

  // interpolate players in this room
  const seen = new Set();
  (latest.players || []).forEach(p => {
    const rp = ensurePlayer(scene, p.id, p.color);
    // room coords need to be scaled into view coords
    // We will letterbox the room in the middle of VIEW_W x VIEW_H
    const { sx, sy } = roomToScreen(p.x, p.y, latest.roomW, latest.roomH);

    // interpolate
    rp.x = Phaser.Math.Linear(rp.x, sx, 0.4);
    rp.y = Phaser.Math.Linear(rp.y, sy, 0.4);
    rp.gfx.setPosition(rp.x, rp.y);

    seen.add(p.id);
  });

  // cleanup missing players
  for (const [id, rp] of renderPlayers.entries()) {
    if (!seen.has(id)) {
      rp.gfx.destroy();
      renderPlayers.delete(id);
    }
  }
}

// drawRoom: redraws background room box + door rectangles
function drawRoom(scene, snap) {
  scene.roomLayer.removeAll(true);
  scene.doorLayer.removeAll(true);

  const roomColor = 0x1e2535;
  const borderColor = 0xffffff;
  const doorColor = 0xffcc33;

  // scale room to fit the view and center it
  const scaled = getRoomScale(snap.roomW, snap.roomH);
  const roomX = scaled.offsetX;
  const roomY = scaled.offsetY;
  const roomW = scaled.w;
  const roomH = scaled.h;

  // room rectangle
  const roomGfx = scene.add.graphics();
  roomGfx.fillStyle(roomColor, 1);
  roomGfx.fillRect(roomX, roomY, roomW, roomH);
  roomGfx.lineStyle(2, borderColor, 1);
  roomGfx.strokeRect(roomX, roomY, roomW, roomH);

  scene.roomLayer.add(roomGfx);

  // label room name
  const label = scene.add.text(
    roomX + roomW / 2,
    roomY + 12,
    snap.room || "???",
    { fontSize: "12px", color: "#ffffff" }
  ).setOrigin(0.5, 0);
  scene.roomLayer.add(label);

  // doors
  (snap.doors || []).forEach(d => {
    const { sx, sy } = roomToScreen(d.x, d.y, snap.roomW, snap.roomH);
    const { sx: sx2, sy: sy2 } = roomToScreen(d.x + d.w, d.y + d.h, snap.roomW, snap.roomH);

    const doorGfx = scene.add.graphics();
    doorGfx.fillStyle(doorColor, 1);
    doorGfx.fillRect(sx, sy, sx2 - sx, sy2 - sy);
    scene.doorLayer.add(doorGfx);
  });
}

// helper: store & create a circle sprite for a player
function ensurePlayer(scene, id, color = "#ffffff") {
  if (renderPlayers.has(id)) return renderPlayers.get(id);

  const g = scene.add.graphics();
  const phaserColor = Phaser.Display.Color.HexStringToColor(color).color;
  g.fillStyle(phaserColor, 1);
  g.fillCircle(0, 0, 8); // smaller circle, scaled for this view

  scene.playerLayer.add(g);

  const entry = { x: VIEW_W / 2, y: VIEW_H / 2, gfx: g, color };
  renderPlayers.set(id, entry);
  return entry;
}

// --- room coordinate -> screen coordinate mapping --------------------
// We want to draw the logical room (snap.roomW x snap.roomH) centered
// inside VIEW_W x VIEW_H with uniform scaling.
function getRoomScale(roomW, roomH) {
  const maxW = VIEW_W * 0.8;
  const maxH = VIEW_H * 0.8;
  const scale = Math.min(maxW / roomW, maxH / roomH);

  const w = roomW * scale;
  const h = roomH * scale;

  const offsetX = (VIEW_W - w) / 2;
  const offsetY = (VIEW_H - h) / 2;

  return { scale, w, h, offsetX, offsetY };
}

function roomToScreen(x, y, roomW, roomH) {
  const scaled = getRoomScale(roomW, roomH);
  return {
    sx: scaled.offsetX + x * scaled.scale,
    sy: scaled.offsetY + y * scaled.scale
  };
}
