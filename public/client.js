/* global Phaser */

const WS_URL = (typeof location !== "undefined" && location.origin)
  ? location.origin.replace(/^http/, "ws")
  : "ws://localhost:3000";

const VIEW_W_DESKTOP = 900;
const VIEW_H_DESKTOP = 600;

let VIEW_W = VIEW_W_DESKTOP;
let VIEW_H = VIEW_H_DESKTOP;

// crude mobile detect
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if (IS_MOBILE) {
  VIEW_W = window.innerWidth;
  VIEW_H = window.innerHeight;
}

// which inventory index the player has selected
let selectedInvIndex = null;

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

  intelLocation: null,
  keyLocation: null,
  trapKitLocation: null
};

const renderPlayers = new Map(); // id -> { gfx, nameText, alertText, x, y }
let sceneRef = null;

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game-canvas-holder", // IMPORTANT: attach canvas to the holder div
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

  // These layer refs get re-drawn every snapshot
  scene.roomLayer = scene.add.layer();
  scene.doorLayer = scene.add.layer();
  scene.itemLayer = scene.add.layer();
  scene.trapLayer = scene.add.layer();
  scene.playerLayer = scene.add.layer();
  scene.uiLayer = scene.add.layer();    // inventory + radar
  scene.winLayer = scene.add.layer();

  // We'll keep the joystick/buttons also in uiLayer, but we won't
  // wipe joystick/buttons every frame.
  scene.fixedUiLayer = scene.add.layer();

  // We'll track HUD objects here so we can clean/rebuild them every snapshot
  scene.hudObjects = [];

  // For clickable inventory text objects
  scene.invTextEntries = [];

  // Movement keys etc
  scene.cursors = scene.input.keyboard.createCursorKeys();
  scene.keys = scene.input.keyboard.addKeys("W,A,S,D,E,SPACE,T,ACTION,USE,AKEY");

  // We'll map:
  //  - Pickup: SPACE/E
  //  - Place trap: T
  //  - Use selected item: AKEY (this is actually 'A')
  // Phaser quirk: We can't bind a key literally called "A" twice,
  // so we check .A or .AKEY. We'll set it up like this:
  scene.keys.AKEY = scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A);

  // WebSocket
  ws = new WebSocket(WS_URL);
  ws.onopen = () => console.log("[client] ws open");
  ws.onerror = (err) => console.warn("[client] ws error", err);
  ws.onclose  = () => console.warn("[client] ws closed");

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
      drawHUD(scene, latest);   // <- replaces old drawInventory
      drawWinner(scene, latest.winner);
    }
  };

  // Mobile overlay controls (joystick/buttons)
  scene.joyVec = { x: 0, y: 0 };
  if (IS_MOBILE) {
    setupMobileControls(scene);
  }
}

function update(time, delta) {
  const scene = this;
  const dt = delta / 1000;

  // ---- movement input ----
  let dx = 0, dy = 0;

  if (scene.cursors.left.isDown || scene.keys.A.isDown) dx -= 1;
  if (scene.cursors.right.isDown || scene.keys.D.isDown) dx += 1;
  if (scene.cursors.up.isDown || scene.keys.W.isDown) dy -= 1;
  if (scene.cursors.down.isDown || scene.keys.S.isDown) dy += 1;

  if (IS_MOBILE && scene.joyVec) {
    dx += scene.joyVec.x;
    dy += scene.joyVec.y;
  }

  seq++;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "input", seq, dx, dy }));
  }

  // Desktop action buttons
  if (!IS_MOBILE) {
    // PICKUP (E / SPACE)
    if ((scene.keys.SPACE.isDown || scene.keys.E.isDown) && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "pickup" }));
    }
    // PLACE TRAP (T)
    if (scene.keys.T.isDown && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "placeTrap" }));
    }
    // USE SELECTED ITEM (A)
    if (scene.keys.AKEY.isDown && ws.readyState === 1) {
      sendUseSelectedItem();
    }
  }

  // Render players each frame (interp positions)
  const seen = new Set();
  (latest.players || []).forEach(p => {
    const rp = ensurePlayer(scene, p.id);

    const stunned = p.isStunned;
    const radius = stunned ? 12 : 8;

    tintPlayerCircle(rp.gfx, p.color, radius);

    const { sx, sy } = roomToScreen(p.x, p.y, latest.roomW, latest.roomH);

    rp.x = Phaser.Math.Linear(rp.x, sx, 0.4);
    rp.y = Phaser.Math.Linear(rp.y, sy, 0.4);
    rp.gfx.setPosition(rp.x, rp.y);

    // nameplate
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

    // stun alert "!!"
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
    } else if (rp.alertText) {
      rp.alertText.setVisible(false);
    }

    seen.add(p.id);
  });

  // Cleanup missing players
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
// Mobile controls
// -----------------------------------------------------
function setupMobileControls(scene) {
  const joyCenterX = 80;
  const joyCenterY = VIEW_H - 100;
  const joyRadius = 40;

  const base = scene.add.circle(joyCenterX, joyCenterY, joyRadius, 0x444444, 0.4)
    .setScrollFactor(0)
    .setInteractive({ draggable: true });
  const knob = scene.add.circle(joyCenterX, joyCenterY, 20, 0xffffff, 0.6)
    .setScrollFactor(0);

  base.on("drag", (pointer, dragX, dragY) => {
    const dx = dragX - joyCenterX;
    const dy = dragY - joyCenterY;
    const mag = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(mag, joyRadius);
    const nx = (dx / mag) * clamped;
    const ny = (dy / mag) * clamped;

    knob.x = joyCenterX + nx;
    knob.y = joyCenterY + ny;

    scene.joyVec.x = nx / joyRadius;
    scene.joyVec.y = ny / joyRadius;
  });

  base.on("dragend", () => {
    scene.joyVec.x = 0;
    scene.joyVec.y = 0;
    knob.x = joyCenterX;
    knob.y = joyCenterY;
  });

  // Mobile buttons: PICK, TRAP, USE
  const btnY = VIEW_H - 90;
  const spacing = 60;
  const startX = VIEW_W - 60;

  function makeBtn(label, offset, onTap) {
    const x = startX - offset;
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

    scene.fixedUiLayer.add(bg);
    scene.fixedUiLayer.add(txt);
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

  makeBtn("USE", spacing * 2, () => {
    sendUseSelectedItem();
  });
}

// helper to send "use selected" to server
function sendUseSelectedItem() {
  if (!ws || ws.readyState !== 1) return;
  if (selectedInvIndex === null) return;
  ws.send(JSON.stringify({ t: "useItem", which: selectedInvIndex }));
}

// -----------------------------------------------------
// Room + objects rendering
// -----------------------------------------------------
function drawRoom(scene, snap) {
  scene.roomLayer.removeAll(true);
  scene.doorLayer.removeAll(true);
  scene.itemLayer.removeAll(true);
  scene.trapLayer.removeAll(true);

  const { roomX, roomY, roomW, roomH } = getRoomScreenBox(snap.roomW, snap.roomH);

  // background panel
  const roomGfx = scene.add.graphics();
  roomGfx.fillStyle(0x1e2535, 1);
  roomGfx.fillRect(roomX, roomY, roomW, roomH);
  roomGfx.lineStyle(2, 0xffffff, 1);
  roomGfx.strokeRect(roomX, roomY, roomW, roomH);
  scene.roomLayer.add(roomGfx);

  // room title
  const title = scene.add.text(
    roomX + roomW / 2,
    roomY + 8,
    snap.room || "???",
    { fontSize: "12px", color: "#ffffff" }
  ).setOrigin(0.5, 0);
  scene.roomLayer.add(title);

  // doors
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

  // items in room
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

  // traps YOU placed (red squares with "T")
  (snap.traps || []).forEach(tr => {
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
// HUD / Inventory / Radar / Selection
// -----------------------------------------------------
function drawHUD(scene, snap) {
  // wipe old HUD elements (NOT joystick/buttons)
  scene.hudObjects.forEach(o => o.destroy());
  scene.hudObjects = [];
  scene.invTextEntries = [];

  // base box for inv + score
  const padX = 8;
  const padY = IS_MOBILE ? (VIEW_H * 0.4) : (VIEW_H - 8 - 110);
  const w = IS_MOBILE ? Math.min(VIEW_W - 16, 280) : 280;
  const h = 110;

  const bg = scene.add.graphics();
  bg.fillStyle(0x000000, 0.6);
  bg.fillRect(padX, padY, w, h);
  bg.lineStyle(1, 0xffffff, 0.8);
  bg.strokeRect(padX, padY, w, h);
  scene.uiLayer.add(bg);
  scene.hudObjects.push(bg);

  // Score line
  const scoreText = scene.add.text(
    padX + 6,
    padY + 4,
    `SCORE ${snap.youScore} / ${snap.scoreTarget}`,
    { fontSize: "10px", color: "#ffffff" }
  );
  scene.uiLayer.add(scoreText);
  scene.hudObjects.push(scoreText);

  // legend
  const legend = IS_MOBILE
    ? "Tap item below,\nUSE=button"
    : "Click an item,\nA=USE  T=TRAP  E/SPACE=PICK";
  const legendText = scene.add.text(
    padX + 150,
    padY + 4,
    legend,
    { fontSize: "9px", color: "#aaaaaa" }
  );
  scene.uiLayer.add(legendText);
  scene.hudObjects.push(legendText);

  // inventory header
  const invHeader = scene.add.text(
    padX + 6,
    padY + 22,
    "INVENTORY:",
    { fontSize: "10px", color: "#ffffff" }
  );
  scene.uiLayer.add(invHeader);
  scene.hudObjects.push(invHeader);

  // inventory list, each clickable
  const invListStartY = padY + 36;

  if (!snap.yourInventory || !snap.yourInventory.length) {
    const emptyLine = scene.add.text(
      padX + 6,
      invListStartY,
      "(empty)",
      { fontSize: "10px", color: "#aaaaaa" }
    );
    scene.uiLayer.add(emptyLine);
    scene.hudObjects.push(emptyLine);
  } else {
    snap.yourInventory.forEach((it, idx) => {
      const isSelected = (idx === selectedInvIndex);

      const lineColor = isSelected ? "#ffcc33" : "#ffffff";
      const line = scene.add.text(
        padX + 6,
        invListStartY + idx * 12,
        `${idx}: ${it.label}`,
        { fontSize: "10px", color: lineColor }
      )
      .setInteractive({ useHandCursor: true })
      .on("pointerdown", () => {
        selectedInvIndex = idx;
        // redraw HUD so highlight + description refresh
        drawHUD(scene, latest);
      });

      scene.uiLayer.add(line);
      scene.hudObjects.push(line);
      scene.invTextEntries.push(line);
    });
  }

  // item description box (based on selectedInvIndex)
  const descBoxY = padY + h + 4;
  const descH = 44;
  const descBg = scene.add.graphics();
  descBg.fillStyle(0x000000, 0.6);
  descBg.fillRect(padX, descBoxY, w, descH);
  descBg.lineStyle(1, 0x33ff33, 0.8);
  descBg.strokeRect(padX, descBoxY, w, descH);
  scene.uiLayer.add(descBg);
  scene.hudObjects.push(descBg);

  let descStr = "No item selected.";
  if (
    selectedInvIndex !== null &&
    snap.yourInventory &&
    snap.yourInventory[selectedInvIndex]
  ) {
    const item = snap.yourInventory[selectedInvIndex];
    descStr = getItemDescription(item.label || item.id || "");
  }

  const descText = scene.add.text(
    padX + 6,
    descBoxY + 4,
    descStr,
    { fontSize: "10px", color: "#ffffff", wordWrap: { width: w - 12 } }
  );
  scene.uiLayer.add(descText);
  scene.hudObjects.push(descText);

  // radar box (if you have intel from MAP)
  if (snap.intelLocation || snap.keyLocation || snap.trapKitLocation) {
    const radarY = descBoxY + descH + 4;
    const radarH = 50;

    const radarBg = scene.add.graphics();
    radarBg.fillStyle(0x000000, 0.6);
    radarBg.fillRect(padX, radarY, w, radarH);
    radarBg.lineStyle(1, 0x33ff33, 0.8);
    radarBg.strokeRect(padX, radarY, w, radarH);
    scene.uiLayer.add(radarBg);
    scene.hudObjects.push(radarBg);

    const radarHeader = scene.add.text(
      padX + 6,
      radarY + 4,
      "RADAR:",
      { fontSize: "10px", color: "#33ff33" }
    );
    scene.uiLayer.add(radarHeader);
    scene.hudObjects.push(radarHeader);

    const intelRoom = snap.intelLocation ? snap.intelLocation.room : "?";
    const keyRoom = snap.keyLocation ? snap.keyLocation.room : "?";
    const trapRoom = snap.trapKitLocation ? snap.trapKitLocation.room : "?";

    const intelLine = scene.add.text(
      padX + 6,
      radarY + 18,
      `INTEL:${intelRoom}  KEY:${keyRoom}`,
      { fontSize: "10px", color: "#ffffff" }
    );
    const trapLine = scene.add.text(
      padX + 6,
      radarY + 32,
      `TRAP KIT:${trapRoom}`,
      { fontSize: "10px", color: "#ffffff" }
    );

    scene.uiLayer.add(intelLine);
    scene.uiLayer.add(trapLine);
    scene.hudObjects.push(intelLine, trapLine);
  }
}

// short "what does this power-up do"
function getItemDescription(nameRaw) {
  const name = nameRaw.toUpperCase();

  if (name.includes("TRAP KIT") || name === "TRAP") {
    return "TRAP KIT: Press TRAP button/T to drop a floor trap that stuns enemies.";
  }
  if (name.includes("SPRING")) {
    return "SPRING: Arm the door near you. Next enemy through that door gets stunned + drops loot. Press USE.";
  }
  if (name.includes("DISGUISE") || name.includes("PAINT")) {
    return "DISGUISE: Hide your ID and colour for a short time. Press USE.";
  }
  if (name.includes("MAP")) {
    return "MAP: Briefly shows where the Intel, Key and Trap Kit are. Press USE.";
  }
  if (name.includes("KEY")) {
    return "KEY: Needed to escape. Keep it!";
  }
  if (name.includes("INTEL") || name.includes("BRIEF")) {
    return "INTEL: Objective briefcase. Steal it and escape.";
  }
  if (name.includes("WIRE")) {
    return "WIRE CUTTER: (Future) Disarm enemy traps safely.";
  }

  return nameRaw + ": (No special action yet.)";
}

// -----------------------------------------------------
// Winner banner
// -----------------------------------------------------
function drawWinner(scene, winner) {
  scene.winLayer.removeAll(true);
  if (!winner) return;

  const textStr = (winner.id === myId)
    ? "YOU ESCAPED!"
    : "WINNER: " + winner.id.slice(0,4);

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
    bx + bw/2,
    by + bh/2,
    textStr,
    { fontSize: "16px", color: "#ffcc33" }
  ).setOrigin(0.5);
  scene.winLayer.add(t);
}

// -----------------------------------------------------
// Player render helpers
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
// Coords
// -----------------------------------------------------
function getRoomScreenBox(roomW, roomH) {
  const maxW = VIEW_W * 0.8;
  const maxH = VIEW_H * 0.5;
  const scale = Math.min(maxW / roomW, maxH / roomH);

  const drawnW = roomW * scale;
  const drawnH = roomH * scale;

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
