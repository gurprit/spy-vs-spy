/* global Phaser */

const WS_URL = (typeof location !== "undefined" && location.origin)
  ? location.origin.replace(/^http/, "ws")
  : "ws://localhost:3000";

const VIEW_W_DESKTOP = 900;
const VIEW_H_DESKTOP = 600;

let VIEW_W = VIEW_W_DESKTOP;
let VIEW_H = VIEW_H_DESKTOP;

// crude mobile check for layout tweaks
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if (IS_MOBILE) {
  VIEW_W = window.innerWidth;
  VIEW_H = window.innerHeight;
}

let ws;
let myId = null;
let seq = 0;

let latest = {
  room: null,
  roomW: 320,
  roomH: 200,

  doors: [],
  items: [],
  traps: [],

  players: [],        // [{id,shortId,x,y,color,isStunned,stunMsRemaining,score}]
  yourInventory: [],
  winner: null,
  youScore: 0,
  scoreTarget: 5,

  intelLocation: null,     // NEW
  keyLocation: null,       // NEW
  trapKitLocation: null    // NEW
};

const renderPlayers = new Map(); // id -> { gfx, nameText, alertText, x, y }
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
  scene.keys = scene.input.keyboard.addKeys("W,A,S,D,E,SPACE,T,F"); // NEW: F for useItem

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
      drawInventory(scene, latest);
      drawWinner(scene, latest.winner);
    }
  };

  ws.onerror = (err) => console.warn("[client] ws error", err);
  ws.onclose  = () => console.warn("[client] ws closed");

  // --- MOBILE CONTROLS ---
  // We'll create virtual controls on mobile only.
  if (IS_MOBILE) {
    setupMobileControls(scene);
  }
}

function update(time, delta) {
  const scene = this;
  const dt = delta / 1000;

  // Movement input
  let dx = 0, dy = 0;

  // keyboard movement
  if (scene.cursors.left.isDown || scene.keys.A.isDown) dx -= 1;
  if (scene.cursors.right.isDown || scene.keys.D.isDown) dx += 1;
  if (scene.cursors.up.isDown || scene.keys.W.isDown) dy -= 1;
  if (scene.cursors.down.isDown || scene.keys.S.isDown) dy += 1;

  // mobile joystick adds to dx/dy if present
  if (IS_MOBILE && scene.joyVec) {
    dx += scene.joyVec.x;
    dy += scene.joyVec.y;
  }

  seq++;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "input", seq, dx, dy }));
  }

  // Desktop: Pickup item (E / SPACE)
  if (!IS_MOBILE) {
    if ((scene.keys.SPACE.isDown || scene.keys.E.isDown) && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "pickup" }));
    }
  }

  // Desktop: Place trap (T)
  if (!IS_MOBILE) {
    if (scene.keys.T.isDown && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "placeTrap" }));
    }
  }

  // Desktop: Use item (F)  // NEW
  if (!IS_MOBILE) {
    if (scene.keys.F.isDown && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "useItem" }));
    }
  }

  // Render players
  const seen = new Set();
  (latest.players || []).forEach(p => {
    const rp = ensurePlayer(scene, p.id);

    // stunned?
    const stunned = p.isStunned;
    const radius = stunned ? 12 : 8;

    tintPlayerCircle(rp.gfx, p.color, radius);

    const { sx, sy } = roomToScreen(p.x, p.y, latest.roomW, latest.roomH);

    rp.x = Phaser.Math.Linear(rp.x, sx, 0.4);
    rp.y = Phaser.Math.Linear(rp.y, sy, 0.4);
    rp.gfx.setPosition(rp.x, rp.y);

    // nameplate (shortId)
    if (!rp.nameText) {
      rp.nameText = scene.add.text(
        rp.x,
        rp.y - radius - 14,
        p.shortId || "??",
        { fontSize: "10px", color: "#ffffff" }
      ).setOrigin(0.5);
      scene.playerLayer.add(rp.nameText);
    }
    rp.nameText.setText(p.shortId || "??");
    rp.nameText.setPosition(rp.x, rp.y - radius - 14);

    // alert text (!! when stunned)
    if (stunned && p.stunMsRemaining > 0) {
      if (!rp.alertText) {
        rp.alertText = scene.add.text(
          rp.x,
          rp.y - radius - 26,
          "!!",
          { fontSize: "12px", color: "#ff3333" }
        ).setOrigin(0.5);
        scene.playerLayer.add(rp.alertText);
      }
      rp.alertText.setPosition(rp.x, rp.y - radius - 26);
      rp.alertText.setVisible(true);
    } else {
      if (rp.alertText) {
        rp.alertText.setVisible(false);
      }
    }

    seen.add(p.id);
  });

  // Cleanup players that vanished
  for (const [id, rp] of renderPlayers.entries()) {
    if (!seen.has(id)) {
      if (rp.alertText) rp.alertText.destroy();
      if (rp.nameText) rp.nameText.destroy();
      rp.gfx.destroy();
      renderPlayers.delete(id);
    }
  }
}

// -----------------------------------------------------
// Mobile controls setup
// -----------------------------------------------------
function setupMobileControls(scene) {
  // super lightweight touch joystick + buttons

  scene.joyVec = { x: 0, y: 0 };

  // Virtual joystick area (bottom left)
  const joyBase = scene.add.circle(80, VIEW_H - 100, 40, 0x444444, 0.4)
    .setScrollFactor(0)
    .setInteractive({ draggable: true });
  const joyKnob = scene.add.circle(80, VIEW_H - 100, 20, 0xffffff, 0.6)
    .setScrollFactor(0);

  joyBase.on('drag', (pointer, dragX, dragY) => {
    // clamp knob to radius ~40
    const dx = dragX - 80;
    const dy = dragY - (VIEW_H - 100);
    const mag = Math.hypot(dx, dy) || 1;
    const norm = Math.min(mag, 40);
    const nx = (dx / mag) * norm;
    const ny = (dy / mag) * norm;
    joyKnob.x = 80 + nx;
    joyKnob.y = (VIEW_H - 100) + ny;

    // normalised for movement input
    scene.joyVec.x = nx / 40;
    scene.joyVec.y = ny / 40;
  });

  joyBase.on('dragend', () => {
    scene.joyVec.x = 0;
    scene.joyVec.y = 0;
    joyKnob.x = 80;
    joyKnob.y = VIEW_H - 100;
  });

  // Buttons on bottom right:
  // PICK (pickup), TRAP (place), USE (useItem)
  const btnY = VIEW_H - 90;
  const spacing = 60;
  const startX = VIEW_W - 60;

  function makeBtn(label, offsetX, onTap) {
    const x = startX - offsetX;
    const bg = scene.add.rectangle(x, btnY, 50, 50, 0x222222, 0.6)
      .setStrokeStyle(2, 0xffffff)
      .setScrollFactor(0)
      .setInteractive({ useHandCursor: true })
      .on("pointerdown", onTap);
    const txt = scene.add.text(
      x, btnY,
      label,
      { fontSize: "10px", color: "#ffffff", align: "center" }
    ).setOrigin(0.5);
    scene.uiLayer.add(bg);
    scene.uiLayer.add(txt);
  }

  makeBtn("PICK", 0, () => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "pickup" }));
    }
  });

  makeBtn("TRAP", spacing, () => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "placeTrap" }));
    }
  });

  // NEW: USE button
  makeBtn("USE", spacing * 2, () => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "useItem" }));
    }
  });
}

// -----------------------------------------------------
// Draw room / doors / items / traps
// -----------------------------------------------------
function drawRoom(scene, snap) {
  scene.roomLayer.removeAll(true);
  scene.doorLayer.removeAll(true);
  scene.itemLayer.removeAll(true);
  scene.trapLayer.removeAll(true);

  const { roomX, roomY, roomW, roomH } = getRoomScreenBox(snap.roomW, snap.roomH);

  // background
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

    const boxW = 50;
    const boxH = 20;
    const itemGfx = scene.add.graphics();
    itemGfx.fillStyle(0x4caf50, 1);
    itemGfx.fillRect(sx - boxW/2, sy - boxH/2, boxW, boxH);
    itemGfx.lineStyle(1, 0x000000, 1);
    itemGfx.strokeRect(sx - boxW/2, sy - boxH/2, boxW, boxH);
    scene.itemLayer.add(itemGfx);

    const labelText = scene.add.text(
      sx,
      sy,
      it.label,
      { fontSize: "8px", color: "#000000", align: "center" }
    ).setOrigin(0.5);
    scene.itemLayer.add(labelText);
  });

  // visible traps YOU placed (red squares)
  ;(snap.traps || []).forEach(tr => {
    const { sx, sy } = roomToScreen(tr.x, tr.y, snap.roomW, snap.roomH);

    const size = 24;
    const trapGfx = scene.add.graphics();
    trapGfx.fillStyle(0xff3333, 1);
    trapGfx.fillRect(sx - size/2, sy - size/2, size, size);
    trapGfx.lineStyle(1, 0x000000, 1);
    trapGfx.strokeRect(sx - size/2, sy - size/2, size, size);
    scene.trapLayer.add(trapGfx);

    const trapLabel = scene.add.text(
      sx,
      sy,
      "T",
      { fontSize: "10px", color: "#000000", align: "center" }
    ).setOrigin(0.5);
    scene.trapLayer.add(trapLabel);
  });
}

// -----------------------------------------------------
// HUD / Inventory / Radar
// -----------------------------------------------------
function drawInventory(scene, snap) {
  scene.uiLayer.removeAll(true);

  // HUD box bg
  // On mobile, we leave gameplay at top and stack HUD and controls below,
  // but we're already drawing buttons in setupMobileControls, so here
  // we just draw HUD near upper/middle-ish.
  const padX = 8;
  const padY = IS_MOBILE ? (VIEW_H * 0.4) : (VIEW_H - 8 - 80);
  const w = IS_MOBILE ? Math.min(VIEW_W - 16, 260) : 260;
  const h = 80;

  const bg = scene.add.graphics();
  bg.fillStyle(0x000000, 0.6);
  bg.fillRect(padX, padY, w, h);
  bg.lineStyle(1, 0xffffff, 0.8);
  bg.strokeRect(padX, padY, w, h);
  scene.uiLayer.add(bg);

  // top line: score
  const scoreLine = scene.add.text(
    padX + 6,
    padY + 4,
    `SCORE ${snap.youScore} / ${snap.scoreTarget}`,
    { fontSize: "10px", color: "#ffffff" }
  );
  scene.uiLayer.add(scoreLine);

  // inventory header
  const invHeader = scene.add.text(
    padX + 6,
    padY + 18,
    "INV  (PICK:E/SPACE  TRAP:T  USE:F)",
    { fontSize: "10px", color: "#ffffff" }
  );
  scene.uiLayer.add(invHeader);

  // inventory list
  if (!snap.yourInventory || !snap.yourInventory.length) {
    const empty = scene.add.text(
      padX + 6,
      padY + 32,
      "(empty)",
      { fontSize: "10px", color: "#aaaaaa" }
    );
    scene.uiLayer.add(empty);
  } else {
    snap.yourInventory.forEach((it, idx) => {
      const line = scene.add.text(
        padX + 6,
        padY + 32 + idx * 12,
        `- ${it.label}`,
        { fontSize: "10px", color: "#ffffff" }
      );
      scene.uiLayer.add(line);
    });
  }

  // Radar intel (if present)
  // We'll just list rooms where key/intel/trap kit are seen.
  let radarY = padY + h + 4;
  if (snap.intelLocation || snap.keyLocation || snap.trapKitLocation) {
    const box2 = scene.add.graphics();
    const rw = w;
    const rh = 50;
    box2.fillStyle(0x000000, 0.6);
    box2.fillRect(padX, radarY, rw, rh);
    box2.lineStyle(1, 0x33ff33, 0.8);
    box2.strokeRect(padX, radarY, rw, rh);
    scene.uiLayer.add(box2);

    const radarHeader = scene.add.text(
      padX + 6,
      radarY + 4,
      "RADAR",
      { fontSize: "10px", color: "#33ff33" }
    );
    scene.uiLayer.add(radarHeader);

    const intelRoom = snap.intelLocation ? snap.intelLocation.room : "?";
    const keyRoom = snap.keyLocation ? snap.keyLocation.room : "?";
    const trapRoom = snap.trapKitLocation ? snap.trapKitLocation.room : "?";

    const intelLine = scene.add.text(
      padX + 6,
      radarY + 18,
      `INTEL: ${intelRoom}`,
      { fontSize: "10px", color: "#ffffff" }
    );
    const keyLine = scene.add.text(
      padX + 100,
      radarY + 18,
      `KEY: ${keyRoom}`,
      { fontSize: "10px", color: "#ffffff" }
    );
    const trapLine = scene.add.text(
      padX + 6,
      radarY + 32,
      `TRAP KIT: ${trapRoom}`,
      { fontSize: "10px", color: "#ffffff" }
    );

    scene.uiLayer.add(intelLine);
    scene.uiLayer.add(keyLine);
    scene.uiLayer.add(trapLine);
  }
}

// -----------------------------------------------------
// Winner banner
// -----------------------------------------------------
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

// -----------------------------------------------------
// Player entity helpers
// -----------------------------------------------------
function ensurePlayer(scene, id) {
  if (renderPlayers.has(id)) return renderPlayers.get(id);

  const gfx = scene.add.graphics();
  gfx.fillStyle(0xffffff, 1);
  gfx.fillCircle(0, 0, 8);
  scene.playerLayer.add(gfx);

  const entry = {
    x: VIEW_W / 2,
    y: VIEW_H / 2,
    gfx,
    nameText: null,
    alertText: null
  };
  renderPlayers.set(id, entry);
  return entry;
}

function tintPlayerCircle(gfx, colorHexStr, radiusPx) {
  gfx.clear();
  const col = Phaser.Display.Color.HexStringToColor(colorHexStr).color;
  gfx.fillStyle(col, 1);
  gfx.fillCircle(0, 0, radiusPx);
}

// -----------------------------------------------------
// Room/screen coord math
// -----------------------------------------------------
function getRoomScreenBox(roomW, roomH) {
  const maxW = VIEW_W * 0.8;
  const maxH = VIEW_H * 0.5; // slightly shallower so HUD fits on mobile
  const scale = Math.min(maxW / roomW, maxH / roomH);

  const drawnW = roomW * scale;
  const drawnH = roomH * scale;

  // gameplay area sits near top on mobile
  const offX = (VIEW_W - drawnW) / 2;
  const offY = IS_MOBILE ? 20 : (VIEW_H - drawnH) / 2;

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
