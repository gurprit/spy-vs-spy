/* global Phaser */

const WS_URL = (typeof location !== "undefined" && location.origin)
  ? location.origin.replace(/^http/, "ws")
  : "ws://localhost:3000";

const VIEW_W = 900;
const VIEW_H = 600;

let ws;
let myId = null;
let seq = 0;

let latest = {
  room: null,
  roomW: 320,
  roomH: 200,
  doors: [],
  items: [],
  traps: [],         // [{id,x,y,owner}]
  players: [],       // [{id,x,y,color,isStunned,stunMsRemaining}]
  yourInventory: [],
  winner: null
};

const renderPlayers = new Map(); // id -> { gfx, alertText, x, y }
let sceneRef = null;

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
  sceneRef = scene;

  // Layers
  scene.roomLayer = scene.add.layer();
  scene.doorLayer = scene.add.layer();
  scene.itemLayer = scene.add.layer();
  scene.trapLayer = scene.add.layer();
  scene.playerLayer = scene.add.layer();
  scene.uiLayer = scene.add.layer();
  scene.winLayer = scene.add.layer();

  // Input
  scene.cursors = scene.input.keyboard.createCursorKeys();
  scene.keys = scene.input.keyboard.addKeys("W,A,S,D,E,SPACE,T");

  // WS
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[client] ws open");
  };

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);

    if (m.t === "welcome") {
      myId = m.id;
      console.log("[client] welcome, myId=", myId);
      return;
    }

    if (m.t === "snapshot") {
      latest = m;

      drawRoom(scene, latest);
      drawInventory(scene, latest.yourInventory || []);
      drawWinner(scene, latest.winner);
    }
  };

  ws.onerror = (err) => console.warn("[client] ws error", err);
  ws.onclose  = () => console.warn("[client] ws closed");
}

function update(time, delta) {
  const scene = this;
  const dt = delta / 1000;

  // Movement input
  let dx = 0, dy = 0;
  if (scene.cursors.left.isDown || scene.keys.A.isDown) dx -= 1;
  if (scene.cursors.right.isDown || scene.keys.D.isDown) dx += 1;
  if (scene.cursors.up.isDown || scene.keys.W.isDown) dy -= 1;
  if (scene.cursors.down.isDown || scene.keys.S.isDown) dy += 1;

  seq++;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "input", seq, dx, dy }));
  }

  // Pickup item (E / SPACE)
  if ((scene.keys.SPACE.isDown || scene.keys.E.isDown) && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "pickup" }));
  }

  // Place trap (T)
  if (scene.keys.T.isDown && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "placeTrap" }));
  }

  // Render players w/ stun FX
  const seen = new Set();
  (latest.players || []).forEach(p => {
    const rp = ensurePlayer(scene, p.id);

    // stunned players: bigger + red
    const stunned = p.isStunned;
    const drawColor = stunned ? "#ff3333" : p.color;
    const radius = stunned ? 12 : 8;

    tintPlayerCircle(rp.gfx, drawColor, radius);

    const { sx, sy } = roomToScreen(p.x, p.y, latest.roomW, latest.roomH);

    rp.x = Phaser.Math.Linear(rp.x, sx, 0.4);
    rp.y = Phaser.Math.Linear(rp.y, sy, 0.4);
    rp.gfx.setPosition(rp.x, rp.y);

    // "!!" over stunned spy
    if (stunned && p.stunMsRemaining > 0) {
      if (!rp.alertText) {
        rp.alertText = scene.add.text(
          rp.x,
          rp.y - radius - 10,
          "!!",
          { fontSize: "12px", color: "#ff3333" }
        ).setOrigin(0.5);
        scene.playerLayer.add(rp.alertText);
      }
      rp.alertText.setPosition(rp.x, rp.y - radius - 10);
      rp.alertText.setVisible(true);
    } else {
      if (rp.alertText) {
        rp.alertText.setVisible(false);
      }
    }

    seen.add(p.id);
  });

  // Cleanup any players that vanished
  for (const [id, rp] of renderPlayers.entries()) {
    if (!seen.has(id)) {
      if (rp.alertText) rp.alertText.destroy();
      rp.gfx.destroy();
      renderPlayers.delete(id);
    }
  }
}

// ---------------------------------------------------------------------
// DRAW ROOM / DOORS / ITEMS / TRAPS
// ---------------------------------------------------------------------

function drawRoom(scene, snap) {
  scene.roomLayer.removeAll(true);
  scene.doorLayer.removeAll(true);
  scene.itemLayer.removeAll(true);
  scene.trapLayer.removeAll(true);

  const { roomX, roomY, roomW, roomH } = getRoomScreenBox(snap.roomW, snap.roomH);

  // Room background
  const roomGfx = scene.add.graphics();
  roomGfx.fillStyle(0x1e2535, 1);
  roomGfx.fillRect(roomX, roomY, roomW, roomH);
  roomGfx.lineStyle(2, 0xffffff, 1);
  roomGfx.strokeRect(roomX, roomY, roomW, roomH);
  scene.roomLayer.add(roomGfx);

  // room label
  const title = scene.add.text(
    roomX + roomW / 2,
    roomY + 8,
    snap.room || "???",
    { fontSize: "12px", color: "#ffffff" }
  ).setOrigin(0.5, 0);
  scene.roomLayer.add(title);

  // doors (yellow)
  (snap.doors || []).forEach(d => {
    const { sx, sy } = roomToScreen(d.x, d.y, snap.roomW, snap.roomH);
    const { sx: sx2, sy: sy2 } = roomToScreen(d.x + d.w, d.y + d.h, snap.roomW, snap.roomH);

    const doorGfx = scene.add.graphics();
    doorGfx.fillStyle(0xffcc33, 1);
    doorGfx.fillRect(sx, sy, sx2 - sx, sy2 - sy);
    scene.doorLayer.add(doorGfx);

    const doorLabel = scene.add.text(
      sx + (sx2 - sx) / 2,
      sy + (sy2 - sy) / 2,
      "DOOR",
      { fontSize: "8px", color: "#000000" }
    ).setOrigin(0.5);
    scene.doorLayer.add(doorLabel);
  });

  // items (green)
  (snap.items || []).forEach(it => {
    const { sx, sy } = roomToScreen(it.x, it.y, snap.roomW, snap.roomH);

    const itemGfx = scene.add.graphics();
    itemGfx.fillStyle(0x4caf50, 1);
    itemGfx.fillRoundedRect(sx - 24, sy - 10, 48, 20, 3);
    itemGfx.lineStyle(1, 0x000000, 1);
    itemGfx.strokeRoundedRect(sx - 24, sy - 10, 48, 20, 3);
    scene.itemLayer.add(itemGfx);

    const labelText = scene.add.text(
      sx,
      sy,
      it.label,
      { fontSize: "10px", color: "#000000", align: "center" }
    ).setOrigin(0.5);
    scene.itemLayer.add(labelText);
  });

  // traps (draw as a bold red "T" so it's super obvious)
  (snap.traps || []).forEach(tr => {
    const { sx, sy } = roomToScreen(tr.x, tr.y, snap.roomW, snap.roomH);

    // giant T
    const trapText = scene.add.text(
      sx,
      sy,
      "T",
      { fontSize: "20px", color: "#ff3333", fontStyle: "bold" }
    ).setOrigin(0.5);
    scene.trapLayer.add(trapText);

    // tiny owner id so we can debug whose trap is whose
    const ownerShort = tr.owner ? tr.owner.slice(0,4) : "????";
    const ownerText = scene.add.text(
      sx,
      sy + 14,
      ownerShort,
      { fontSize: "8px", color: "#ff3333" }
    ).setOrigin(0.5, 0);
    scene.trapLayer.add(ownerText);
  });
}

// ---------------------------------------------------------------------
// INVENTORY HUD
// ---------------------------------------------------------------------

function drawInventory(scene, inv) {
  scene.uiLayer.removeAll(true);

  const padX = 8;
  const padY = VIEW_H - 8 - 60;
  const w = 220;
  const h = 60;

  const bg = scene.add.graphics();
  bg.fillStyle(0x000000, 0.6);
  bg.fillRect(padX, padY, w, h);
  bg.lineStyle(1, 0xffffff, 0.8);
  bg.strokeRect(padX, padY, w, h);
  scene.uiLayer.add(bg);

  const title = scene.add.text(
    padX + 6,
    padY + 4,
    "INV  (E/SPACE pick, T trap)",
    { fontSize: "10px", color: "#ffffff" }
  );
  scene.uiLayer.add(title);

  if (!inv.length) {
    const empty = scene.add.text(
      padX + 6,
      padY + 26,
      "(empty)",
      { fontSize: "10px", color: "#aaaaaa" }
    );
    scene.uiLayer.add(empty);
  } else {
    inv.forEach((it, idx) => {
      const line = scene.add.text(
        padX + 6,
        padY + 24 + idx * 12,
        `- ${it.label}`,
        { fontSize: "10px", color: "#ffffff" }
      );
      scene.uiLayer.add(line);
    });
  }
}

// ---------------------------------------------------------------------
// WINNER BANNER
// ---------------------------------------------------------------------

function drawWinner(scene, winner) {
  scene.winLayer.removeAll(true);
  if (!winner) return;

  const textStr = (winner.id === myId)
    ? "YOU ESCAPED!"
    : "WINNER: " + winner.id.slice(0, 4);

  const bw = VIEW_W * 0.8;
  const bh = 60;
  const bx = (VIEW_W - bw) / 2;
  const by = (VIEW_H - bh) / 2;

  const g = scene.add.graphics();
  g.fillStyle(0x000000, 0.8);
  g.fillRect(bx, by, bw, bh);
  g.lineStyle(2, 0xffcc33, 1);
  g.strokeRect(bx, by, bw, bh);
  scene.winLayer.add(g);

  const t = scene.add.text(
    bx + bw / 2,
    by + bh / 2,
    textStr,
    { fontSize: "16px", color: "#ffcc33" }
  ).setOrigin(0.5);
  scene.winLayer.add(t);
}

// ---------------------------------------------------------------------
// PLAYER RENDERING
// ---------------------------------------------------------------------

function ensurePlayer(scene, id) {
  if (renderPlayers.has(id)) return renderPlayers.get(id);

  // main body
  const gfx = scene.add.graphics();
  gfx.fillStyle(0xffffff, 1);
  gfx.fillCircle(0, 0, 8);
  scene.playerLayer.add(gfx);

  // alert text (for stun) will be created lazily
  const entry = { x: VIEW_W/2, y: VIEW_H/2, gfx, alertText: null };
  renderPlayers.set(id, entry);
  return entry;
}

function tintPlayerCircle(gfx, colorHexStr, radiusPx) {
  gfx.clear();
  const col = Phaser.Display.Color.HexStringToColor(colorHexStr).color;
  gfx.fillStyle(col, 1);
  gfx.fillCircle(0, 0, radiusPx);
}

// ---------------------------------------------------------------------
// ROOM COORDS -> SCREEN COORDS
// ---------------------------------------------------------------------

function getRoomScreenBox(roomW, roomH) {
  const maxW = VIEW_W * 0.8;
  const maxH = VIEW_H * 0.8;
  const scale = Math.min(maxW / roomW, maxH / roomH);

  const drawnW = roomW * scale;
  const drawnH = roomH * scale;

  const offX = (VIEW_W - drawnW) / 2;
  const offY = (VIEW_H - drawnH) / 2;

  return {
    roomX: offX,
    roomY: offY,
    roomW: drawnW,
    roomH: drawnH,
    scale
  };
}

function roomToScreen(x, y, roomW, roomH) {
  const { scale, roomX, roomY } = getRoomScreenBox(roomW, roomH);
  return {
    sx: roomX + x * scale,
    sy: roomY + y * scale
  };
}
