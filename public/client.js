/* global Phaser */

const WS_URL = (typeof location !== "undefined" && location.origin)
  ? location.origin.replace(/^http/, "ws")
  : "ws://localhost:3000";

// very basic mobile check
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// canvas target size
let VIEW_W = IS_MOBILE ? window.innerWidth : 900;
let VIEW_H = IS_MOBILE ? Math.min(window.innerHeight * 0.6, 500) : 600;

// ----- DOM refs -----
const scoreLineEl    = document.getElementById("score-line");
const legendEl       = document.getElementById("legend");
const invListEl      = document.getElementById("inventory-list");
const itemDescEl     = document.getElementById("item-desc-box");
const radarBoxEl     = document.getElementById("radar-box");
const mobileControls = document.getElementById("mobile-controls");
const btnPick        = document.getElementById("btn-pick");
const btnTrap        = document.getElementById("btn-trap");
const btnUse         = document.getElementById("btn-use");
const btnShoot       = document.getElementById("btn-shoot");

// show mobile buttons if mobile
if (IS_MOBILE) {
  mobileControls.style.display = "flex";
} else {
  mobileControls.style.display = "none";
}

// ----- LOCAL UI STATE -----
let selectedInvIndex = null;

// these are for incremental rendering (to avoid constant reflow/recreate)
let lastInventoryRendered = [];
let lastRadarRendered = null;
let lastWinnerIdRendered = null;
let lastScoreRendered = null;
let lastLegendRendered = null;

// ----- GAME SNAPSHOT STATE -----
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
  projectiles: [],

  players: [],
  yourInventory: [],
  winner: null,

  youScore: 0,
  scoreTarget: 5,
  yourHealth: 3,
  shotsToKill: 3,

  intelLocation: null,
  keyLocation: null,
  trapKitLocation: null
};

// Phaser: keep references to players
const renderPlayers = new Map();
let sceneRef = null;

// ---------------------------------------------------------
// Phaser GAME
// ---------------------------------------------------------
const game = new Phaser.Game({
  type: Phaser.AUTO,
  backgroundColor: "#0d0f14",
  scale: {
    width: VIEW_W,
    height: VIEW_H,
    mode: Phaser.Scale.NONE,
    parent: "game-container"
  },
  physics: { default: "arcade" },
  scene: { create, update }
});

function create() {
  const scene = this;
  sceneRef = scene;

  // layers
  scene.roomLayer = scene.add.layer();
  scene.doorLayer = scene.add.layer();
  scene.itemLayer = scene.add.layer();
  scene.trapLayer = scene.add.layer();
  scene.playerLayer = scene.add.layer();
  scene.projectileLayer = scene.add.layer();
  scene.winLayer = scene.add.layer();

  // movement input
  scene.cursors = scene.input.keyboard.createCursorKeys();
  scene.keys = scene.input.keyboard.addKeys("W,A,S,D,E,SPACE,T,F");
  scene.keys.AKEY = scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A);

  // mobile joystick vector
  scene.joyVec = { x: 0, y: 0 };

  if (IS_MOBILE) {
    setupMobileJoystick(scene);

    // hook mobile HTML buttons
    btnPick.addEventListener("pointerdown", () => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ t: "pickup" }));
      }
    });
    btnTrap.addEventListener("pointerdown", () => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ t: "placeTrap" }));
      }
    });
    btnUse.addEventListener("pointerdown", () => {
      sendUseSelectedItem();
    });
    btnShoot.addEventListener("pointerdown", () => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ t: "shoot" }));
      }
    });
  }

  // websocket setup
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

      // draw world / traps / doors
      drawRoom(scene, latest);

      // winner banner (we'll let Phaser handle this but in an incremental way)
      drawWinner(scene, latest.winner);

      // update HTML HUD incrementally
      renderHUDHtml(latest);
    }
  };
}

function update(time, delta) {
  const scene = this;
  const dt = delta / 1000;

  // movement
  let dx = 0, dy = 0;

  if (!IS_MOBILE) {
    if (scene.cursors.left.isDown || scene.keys.A.isDown) dx -= 1;
    if (scene.cursors.right.isDown || scene.keys.D.isDown) dx += 1;
    if (scene.cursors.up.isDown || scene.keys.W.isDown) dy -= 1;
    if (scene.cursors.down.isDown || scene.keys.S.isDown) dy += 1;
  }

  if (IS_MOBILE && scene.joyVec) {
    dx += scene.joyVec.x;
    dy += scene.joyVec.y;
  }

  seq++;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "input", seq, dx, dy }));
  }

  // desktop action keys
  if (!IS_MOBILE) {
    if ((scene.keys.SPACE.isDown || scene.keys.E.isDown) && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "pickup" }));
    }
    if (scene.keys.T.isDown && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "placeTrap" }));
    }
    if (scene.keys.AKEY.isDown && ws.readyState === 1) {
      sendUseSelectedItem();
    }
    if (Phaser.Input.Keyboard.JustDown(scene.keys.F)) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ t: "shoot" }));
      }
    }
  }

  // render / interpolate players
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

    // stun alert
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

  // cleanup
  for (const [id, rp] of renderPlayers.entries()) {
    if (!seen.has(id)) {
      if (rp.alertText) rp.alertText.destroy();
      if (rp.nameText) rp.nameText.destroy();
      rp.gfx.destroy();
      renderPlayers.delete(id);
    }
  }
}

// ---------------------------------------------------------
// Mobile joystick
// ---------------------------------------------------------
function setupMobileJoystick(scene) {
  const joyCenterX = 80;
  const joyCenterY = VIEW_H - 80;
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
}

// ---------------------------------------------------------
// WebSocket action: use selected item
// ---------------------------------------------------------
function sendUseSelectedItem() {
  if (!ws || ws.readyState !== 1) return;
  if (selectedInvIndex === null) return;
  ws.send(JSON.stringify({ t: "useItem", which: selectedInvIndex }));
}

// ---------------------------------------------------------
// Draw room (Phaser)
// ---------------------------------------------------------
function drawRoom(scene, snap) {
  scene.roomLayer.removeAll(true);
  scene.doorLayer.removeAll(true);
  scene.itemLayer.removeAll(true);
  scene.trapLayer.removeAll(true);
  scene.projectileLayer.removeAll(true);

  const { roomX, roomY, roomW, roomH } = getRoomScreenBox(snap.roomW, snap.roomH);

  // background
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

  // items
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

  // traps (only your own traps are sent by server)
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

  // projectiles
  (snap.projectiles || []).forEach(p => {
    const { sx, sy } = roomToScreen(p.x, p.y, snap.roomW, snap.roomH);
    const size = 8;
    const pGfx = scene.add.graphics();
    pGfx.fillStyle(0xffff00, 1);
    pGfx.fillCircle(sx, sy, size/2);
    scene.projectileLayer.add(pGfx);
  });
}

// ---------------------------------------------------------
// Winner banner (incremental)
// ---------------------------------------------------------
function drawWinner(scene, winner) {
  // only change if winner changed
  const newWinnerId = winner ? winner.id : null;
  if (newWinnerId === lastWinnerIdRendered) {
    return; // no change
  }
  lastWinnerIdRendered = newWinnerId;

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

// ---------------------------------------------------------
// HTML HUD (incremental)
// ---------------------------------------------------------
function renderHUDHtml(snap) {
  // --- score line ---
  const newScore = `Score: ${snap.youScore} / ${snap.scoreTarget} | Health: ${snap.yourHealth} / ${snap.shotsToKill}`;
  if (newScore !== lastScoreRendered) {
    scoreLineEl.textContent = newScore;
    lastScoreRendered = newScore;
  }

  // --- legend ---
  const desiredLegend = IS_MOBILE
    ? "Tap item below,\nUSE button to activate.\nTRAP drops floor trap.\nPICK grabs nearby item."
    : "Click an item,\nA=USE  T=TRAP  E/SPACE=PICK  F=SHOOT";
  if (desiredLegend !== lastLegendRendered) {
    legendEl.textContent = desiredLegend;
    lastLegendRendered = desiredLegend;
  }

  // --- inventory ---
  const inv = snap.yourInventory || [];
  const invChanged = !inventoriesEqual(inv, lastInventoryRendered);

  if (invChanged) {
    invListEl.innerHTML = "";

    if (!inv.length) {
      const emptyDiv = document.createElement("div");
      emptyDiv.style.color = "#aaa";
      emptyDiv.style.fontSize = "12px";
      emptyDiv.textContent = "(empty)";
      invListEl.appendChild(emptyDiv);
    } else {
      inv.forEach((it, idx) => {
        const div = document.createElement("div");
        div.className = "inv-item" + (idx === selectedInvIndex ? " selected" : "");
        div.innerHTML = `
          <span class="inv-slot-idx">[${idx}]</span>
          <span>${it.label}</span>
        `;
        div.addEventListener("click", () => {
          selectedInvIndex = idx;
          updateInventorySelectionHighlight();
          updateItemDescription(inv);
        });
        invListEl.appendChild(div);
      });
    }

    // remember
    lastInventoryRendered = inv.map(it => ({ id: it.id, label: it.label }));
  } else {
    // only selection might have changed
    updateInventorySelectionHighlight();
  }

  // --- item description ---
  updateItemDescription(inv);

  // --- radar ---
  const radarData = {
    intel: snap.intelLocation ? snap.intelLocation.room : null,
    key: snap.keyLocation ? snap.keyLocation.room : null,
    trap: snap.trapKitLocation ? snap.trapKitLocation.room : null
  };
  const radarJson = JSON.stringify(radarData);
  if (radarJson !== lastRadarRendered) {
    if (radarData.intel || radarData.key || radarData.trap) {
      radarBoxEl.style.display = "block";
      radarBoxEl.textContent =
        `RADAR:\nIntel: ${radarData.intel || "?"}\nKey: ${radarData.key || "?"}\nTrap Kit: ${radarData.trap || "?"}`;
    } else {
      radarBoxEl.style.display = "none";
    }
    lastRadarRendered = radarJson;
  }
}

// ---------------------------------------------------------
// Helpers for HUD
// ---------------------------------------------------------
function inventoriesEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const aName = a[i].label || a[i].id || "";
    const bName = b[i].label || b[i].id || "";
    if (aName !== bName) return false;
  }
  return true;
}

function updateInventorySelectionHighlight() {
  const nodes = invListEl.querySelectorAll(".inv-item");
  nodes.forEach((node, idx) => {
    if (idx === selectedInvIndex) {
      node.classList.add("selected");
    } else {
      node.classList.remove("selected");
    }
  });
}

function updateItemDescription(inv) {
  let descStr = "No item selected.";
  if (
    selectedInvIndex !== null &&
    inv &&
    inv[selectedInvIndex]
  ) {
    const item = inv[selectedInvIndex];
    descStr = getItemDescription(item.label || item.id || "");
  }
  itemDescEl.textContent = descStr;
}

function getItemDescription(nameRaw) {
  const name = nameRaw.toUpperCase();

  if (name.includes("TRAP KIT") || name === "TRAP") {
    return "TRAP KIT:\nPress TRAP to drop a floor trap that stuns enemies.";
  }
  if (name.includes("SPRING")) {
    return "SPRING:\nRigs the nearest door. Next enemy through is stunned.";
  }
  if (name.includes("DISGUISE") || name.includes("PAINT")) {
    return "DISGUISE:\nHide your ID/colour for a short time.";
  }
  if (name.includes("MAP")) {
    return "MAP:\nShows where Intel, Key and Trap Kit are.";
  }
  if (name.includes("KEY")) {
    return "KEY:\nNeeded to unlock EXIT.";
  }
  if (name.includes("INTEL") || name.includes("BRIEF")) {
    return "INTEL:\nObjective. Escape with this to score.";
  }
  if (name.includes("WIRE")) {
    return "WIRE CUTTER:\n(soon) Disarm enemy traps.";
  }
  return nameRaw + ":\n(No special action yet.)";
}

// ---------------------------------------------------------
// Player helpers
// ---------------------------------------------------------
function ensurePlayer(scene, id) {
  if (renderPlayers.has(id)) return renderPlayers.get(id);

  const gfx = scene.add.graphics();
  gfx.fillStyle(0xffffff, 1);
  gfx.fillCircle(0, 0, 8);
  scene.playerLayer.add(gfx);

  const entry = { x: VIEW_W/2, y: VIEW_H/2, gfx, nameText: null, alertText: null };
  renderPlayers.set(id, entry);
  return entry;
}

function tintPlayerCircle(gfx, colorHexStr, radiusPx) {
  gfx.clear();
  const col = Phaser.Display.Color.HexStringToColor(colorHexStr).color;
  gfx.fillStyle(col, 1);
  gfx.fillCircle(0, 0, radiusPx);
}

// ---------------------------------------------------------
// Room <-> screen
// ---------------------------------------------------------
function getRoomScreenBox(roomW, roomH) {
  const maxW = VIEW_W * 0.9;
  const maxH = VIEW_H * 0.8;
  const scale = Math.min(maxW / roomW, maxH / roomH);

  const drawnW = roomW * scale;
  const drawnH = roomH * scale;

  const offX = (VIEW_W - drawnW) / 2;
  const offY = 20;

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
