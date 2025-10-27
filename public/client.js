/* global Phaser */

// --------------------------------------------------
// DOM refs
// --------------------------------------------------
const holderEl = document.getElementById("game-canvas-holder");
const winBannerEl = document.getElementById("win-banner");

const hudScoreEl = document.getElementById("hud-score");
const hudExitHintEl = document.getElementById("hud-exit-hint");
const invListEl = document.getElementById("inv-list");

const radarBoxEl = document.getElementById("radar-box");
const radarIntelEl = document.getElementById("radar-intel");
const radarKeyEl = document.getElementById("radar-key");
const radarTrapkitEl = document.getElementById("radar-trapkit");

const dpadEl = document.getElementById("dpad");
const actionBtnEl = document.getElementById("action-btn");

// --------------------------------------------------
// Canvas size taken from holder
// --------------------------------------------------
const VIEW_W = holderEl.clientWidth || 480;
const VIEW_H = holderEl.clientHeight || 360;

// crude mobile detection
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// --------------------------------------------------
// Networking
// --------------------------------------------------
const WS_URL = (typeof location !== "undefined" && location.origin)
  ? location.origin.replace(/^http/, "ws")
  : "ws://localhost:3000";

let ws;
let myId = null;
let seq = 0;

// --------------------------------------------------
// Latest snapshot from server
// --------------------------------------------------
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

// for local input state on mobile dpad
let dirInput = { up:false, down:false, left:false, right:false };

// --------------------------------------------------
// Phaser game instance
// --------------------------------------------------
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

// We'll store layers & refs in closure so update() can reach them
let sceneRef = null;
const renderPlayers = new Map(); // id -> { gfx, nameText, alertText, x, y }

// --------------------------------------------------
// Phaser scene: create()
// --------------------------------------------------
function create() {
  const scene = this;
  sceneRef = scene;

  // layers for drawing
  scene.roomLayer = scene.add.layer();
  scene.doorLayer = scene.add.layer();
  scene.itemLayer = scene.add.layer();
  scene.trapLayer = scene.add.layer();
  scene.playerLayer = scene.add.layer();

  // keyboard input (desktop)
  scene.cursors = scene.input.keyboard.createCursorKeys();
  scene.keys = scene.input.keyboard.addKeys("W,A,S,D,E,SPACE,T,F");

  // WebSocket setup
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
      // draw world in Phaser
      drawRoom(scene, latest);

      // update HUD DOM
      updateHUD(latest);

      // update win banner DOM
      updateWinBanner(latest.winner);
    }
  };

  ws.onerror = (err) => console.warn("[client] ws error", err);
  ws.onclose  = () => console.warn("[client] ws closed");

  // touch controls (mobile only)
  if (IS_MOBILE) {
    setupMobileDpad();
    setupMobileActionButton();
  }
}

// --------------------------------------------------
// Phaser scene: update()
// --------------------------------------------------
function update(time, delta) {
  const scene = this;
  const dt = delta / 1000;

  // figure out directional input
  let dx = 0, dy = 0;

  // desktop keys
  if (!IS_MOBILE) {
    if (scene.cursors.left.isDown || scene.keys.A.isDown) dx -= 1;
    if (scene.cursors.right.isDown || scene.keys.D.isDown) dx += 1;
    if (scene.cursors.up.isDown || scene.keys.W.isDown) dy -= 1;
    if (scene.cursors.down.isDown || scene.keys.S.isDown) dy += 1;
  }

  // mobile dpad
  if (IS_MOBILE) {
    if (dirInput.left) dx -= 1;
    if (dirInput.right) dx += 1;
    if (dirInput.up) dy -= 1;
    if (dirInput.down) dy += 1;
  }

  // send movement
  seq++;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "input", seq, dx, dy }));
  }

  // desktop-only actions:
  if (!IS_MOBILE) {
    // tap pickup
    if ((scene.keys.SPACE.isDown || scene.keys.E.isDown) && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "pickup" }));
    }
    // place trap
    if (scene.keys.T.isDown && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "placeTrap" }));
    }
    // use item (disguise/map/spring)
    if (scene.keys.F.isDown && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "useItem" }));
    }
  }

  // Render players
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

    // Nameplate (shortId)
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

    // "!!" if stunned
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

  // cleanup missing players
  for (const [id, rp] of renderPlayers.entries()) {
    if (!seen.has(id)) {
      if (rp.alertText) rp.alertText.destroy();
      if (rp.nameText) rp.nameText.destroy();
      rp.gfx.destroy();
      renderPlayers.delete(id);
    }
  }
}

// --------------------------------------------------
// Draw room, doors, items, traps inside Phaser canvas
// --------------------------------------------------
function drawRoom(scene, snap) {
  scene.roomLayer.removeAll(true);
  scene.doorLayer.removeAll(true);
  scene.itemLayer.removeAll(true);
  scene.trapLayer.removeAll(true);

  const { roomX, roomY, roomW, roomH } = getRoomScreenBox(snap.roomW, snap.roomH);

  // background box
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

  // draw doors (yellow)
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

  // draw items (green)
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

  // draw traps that YOU placed (red squares w/ "T")
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

// --------------------------------------------------
// HUD DOM updater
// --------------------------------------------------
function updateHUD(snap) {
  // score / target
  hudScoreEl.textContent = `SCORE: ${snap.youScore} / ${snap.scoreTarget}`;

  // exit hint on/off
  const hasIntel = snap.yourInventory?.some(it => it.label === "INTEL" || it.id === "brief");
  const hasKey = snap.yourInventory?.some(it => it.label === "KEY" || it.id === "key");
  if (hasIntel && hasKey) {
    hudExitHintEl.style.display = "block";
  } else {
    hudExitHintEl.style.display = "none";
  }

  // inventory list
  invListEl.innerHTML = "";
  if (!snap.yourInventory || !snap.yourInventory.length) {
    const span = document.createElement("span");
    span.className = "empty";
    span.textContent = "(empty)";
    invListEl.appendChild(span);
  } else {
    snap.yourInventory.forEach(it => {
      const line = document.createElement("div");
      line.textContent = "- " + it.label;
      invListEl.appendChild(line);
    });
  }

  // radar info (only shown if any field is non-null)
  const intelRoom = snap.intelLocation?.room;
  const keyRoom = snap.keyLocation?.room;
  const trapRoom = snap.trapKitLocation?.room;

  if (intelRoom || keyRoom || trapRoom) {
    radarBoxEl.style.display = "block";
    radarIntelEl.textContent = "INTEL: " + (intelRoom || "?");
    radarKeyEl.textContent = "KEY: " + (keyRoom || "?");
    radarTrapkitEl.textContent = "TRAP KIT: " + (trapRoom || "?");
  } else {
    radarBoxEl.style.display = "none";
  }
}

// --------------------------------------------------
// Winner banner DOM updater
// --------------------------------------------------
function updateWinBanner(winner) {
  if (!winner) {
    winBannerEl.style.display = "none";
    return;
  }
  const textStr = (winner.id === myId)
    ? "YOU ESCAPED!"
    : "WINNER: " + winner.id.slice(0, 4).toUpperCase();
  winBannerEl.textContent = textStr;
  winBannerEl.style.display = "block";
}

// --------------------------------------------------
// Player render helpers
// --------------------------------------------------
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

// --------------------------------------------------
// Coords helpers
// --------------------------------------------------
function getRoomScreenBox(roomW, roomH) {
  // We try to keep room view near top of the canvas, with some margin
  const maxW = VIEW_W * 0.9;
  const maxH = VIEW_H * 0.8;
  const scale = Math.min(maxW / roomW, maxH / roomH);

  const drawnW = roomW * scale;
  const drawnH = roomH * scale;

  // offset near top-middle
  const offX = (VIEW_W - drawnW) / 2;
  const offY = 16;

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

// --------------------------------------------------
// Mobile controls implementation
// --------------------------------------------------
function setupMobileDpad() {
  // We'll listen to touchstart/touchend on each .dpad-btn
  // and set dirInput flags accordingly.

  if (!dpadEl) return;

  const btns = dpadEl.querySelectorAll(".dpad-btn");
  btns.forEach(btn => {
    const dir = btn.getAttribute("data-dir");
    btn.addEventListener("touchstart", (ev) => {
      ev.preventDefault();
      setDir(dir, true);
    }, { passive:false });
    btn.addEventListener("touchend", (ev) => {
      ev.preventDefault();
      setDir(dir, false);
    }, { passive:false });
    btn.addEventListener("touchcancel", (ev) => {
      ev.preventDefault();
      setDir(dir, false);
    }, { passive:false });
  });

  function setDir(dir, val) {
    if (dir === "up") dirInput.up = val;
    if (dir === "down") dirInput.down = val;
    if (dir === "left") dirInput.left = val;
    if (dir === "right") dirInput.right = val;
  }
}

// mobile action button behavior:
// - quick tap  => pickup
// - long press => placeTrap
// - double tap => useItem
function setupMobileActionButton() {
  if (!actionBtnEl) return;

  let tapTimer = null;
  let pressStart = 0;
  let lastTapTime = 0;

  // helper sends
  function sendPickup() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "pickup" }));
    }
  }
  function sendTrap() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "placeTrap" }));
    }
  }
  function sendUse() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "useItem" }));
    }
  }

  actionBtnEl.addEventListener("touchstart", (ev) => {
    ev.preventDefault();
    const nowMs = performance.now();
    pressStart = nowMs;

    // check double-tap window (e.g. within 250ms)
    if (nowMs - lastTapTime < 250) {
      // interpret as USE ITEM
      sendUse();
      // reset so we don't also run pickup
      lastTapTime = 0;
      if (tapTimer) {
        clearTimeout(tapTimer);
        tapTimer = null;
      }
    } else {
      // not yet sure if tap or hold, we set/refresh the timer
      lastTapTime = nowMs;
      tapTimer = setTimeout(() => {
        tapTimer = null;
        // if still holding after 400ms => TRAP
        const heldFor = performance.now() - pressStart;
        if (heldFor >= 400) {
          sendTrap();
        }
      }, 400);
    }
  }, { passive:false });

  actionBtnEl.addEventListener("touchend", (ev) => {
    ev.preventDefault();
    const heldFor = performance.now() - pressStart;

    // If we released before 400ms and we didn't already double tap => PICKUP
    if (heldFor < 400) {
      // but only if we didn't consume it as double tap (we zero lastTapTime on double)
      if (lastTapTime !== 0 && tapTimer) {
        sendPickup();
      }
    }

    if (tapTimer) {
      clearTimeout(tapTimer);
      tapTimer = null;
    }
  }, { passive:false });

  actionBtnEl.addEventListener("touchcancel", (ev) => {
    ev.preventDefault();
    if (tapTimer) {
      clearTimeout(tapTimer);
      tapTimer = null;
    }
  }, { passive:false });
}
