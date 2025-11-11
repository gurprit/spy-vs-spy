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
const btnAction      = document.getElementById("btn-action");

// show mobile action bar if mobile
if (IS_MOBILE && mobileControls) {
  mobileControls.style.display = "flex";
} else if (mobileControls) {
  mobileControls.style.display = "none";
}

// ----- LOCAL UI STATE -----
let selectedInvIndex = null;
let currentAction = { type: null, enabled: false }; // e.g. { type: "PICK", enabled: true }

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
  searchables: [],
  traps: [],
  projectiles: [],
  bombs: [],

  players: [],
  yourInventory: [],
  winner: null,

  youScore: 0,
  scoreTarget: 5,
  yourHealth: 3,
  shotsToKill: 3,

  mapName: "",

  intelLocation: null,
  keyLocation: null,
  trapKitLocation: null
};

// Phaser: keep references to players
const renderPlayers = new Map();
let sceneRef = null;

// pointer / tap movement + firing state
let moveTarget = null; // { x, y, room }
let autoFireInterval = null;
let autoFirePointerId = null;
let autoFirePointerType = null;
let longPressTimer = null;
let longPressPointerId = null;
let lastTapTime = 0;
let lastTapPointerType = null;
const lastTapPos = { x: 0, y: 0 };
const longPressStartPos = { x: 0, y: 0 };
const lastAimDir = { x: 1, y: 0 };

const DOUBLE_TAP_MAX_MS = 300;
const DOUBLE_TAP_MAX_DIST = 28;
const LONG_PRESS_DELAY_MS = 450;
const AUTO_FIRE_INTERVAL_MS = 520;
const LONG_PRESS_MOVE_CANCEL_DIST = 24;

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
  scene.searchableLayer = scene.add.layer();
  scene.itemLayer = scene.add.layer();
  scene.trapLayer = scene.add.layer();
  scene.bombLayer = scene.add.layer();
  scene.playerLayer = scene.add.layer();
  scene.projectileLayer = scene.add.layer();
  scene.winLayer = scene.add.layer();

  // movement input
  scene.cursors = scene.input.keyboard.createCursorKeys();
  scene.keys = scene.input.keyboard.addKeys("W,A,S,D,ENTER,SPACE");

  if (scene.input.mouse) {
    scene.input.mouse.disableContextMenu();
  }

  scene.input.on("pointerdown", handlePointerDown);
  scene.input.on("pointerup", handlePointerUp);
  scene.input.on("pointerupoutside", handlePointerUp);
  scene.input.on("pointercancel", handlePointerUp);
  scene.input.on("pointermove", handlePointerMove);
  scene.input.on("gameout", () => {
    stopAutoFire();
    cancelLongPress();
  });

  if (btnAction) {
    setupActionButton(btnAction, handleAction);
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

  const me = (latest.players || []).find(p => p.id === myId);
  if (!me) {
    moveTarget = null;
  } else if (moveTarget) {
    if (moveTarget.room && moveTarget.room !== me.room) {
      moveTarget = null;
    } else {
      const tx = moveTarget.x - me.x;
      const ty = moveTarget.y - me.y;
      const dist = Math.hypot(tx, ty);
      if (dist > 4) {
        dx += tx / dist;
        dy += ty / dist;
      } else {
        moveTarget = null;
      }
    }
  }

  const aimMag = Math.hypot(dx, dy);
  if (aimMag > 0.0001) {
    lastAimDir.x = dx / aimMag;
    lastAimDir.y = dy / aimMag;
  }

  seq++;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "input", seq, dx, dy }));
  }

  // desktop action keys
  if (!IS_MOBILE) {
    if (Phaser.Input.Keyboard.JustDown(scene.keys.SPACE)) {
      if (currentAction.type === "PICK" && currentAction.enabled) {
        ws.send(JSON.stringify({ t: "pickup" }));
      } else {
        handleFire();
      }
    }
    if (Phaser.Input.Keyboard.JustDown(scene.keys.ENTER)) {
      if (currentAction.type === "USE" && currentAction.enabled) {
        if (selectedInvIndex !== null) {
          ws.send(JSON.stringify({ t: "useItem", which: selectedInvIndex }));
        }
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
// Pointer / tap controls
// ---------------------------------------------------------
function handlePointerDown(pointer) {
  cancelLongPress();

  if (pointer.pointerType === "mouse" && pointer.rightButtonDown()) {
    startAutoFire(pointer);
    return;
  }

  const now = performance.now ? performance.now() : Date.now();
  const dist = Phaser.Math.Distance.Between(pointer.x, pointer.y, lastTapPos.x, lastTapPos.y);
  const isDouble = (
    lastTapPointerType === pointer.pointerType &&
    (now - lastTapTime) <= DOUBLE_TAP_MAX_MS &&
    dist <= DOUBLE_TAP_MAX_DIST
  );

  updateAimFromPointer(pointer);

  if (isDouble) {
    lastTapTime = 0;
    lastTapPointerType = null;
    handleFire();
    stopAutoFire();
    return;
  }

  setMoveTargetFromPointer(pointer);

  lastTapTime = now;
  lastTapPointerType = pointer.pointerType;
  lastTapPos.x = pointer.x;
  lastTapPos.y = pointer.y;

  if (pointer.pointerType === "touch") {
    scheduleLongPress(pointer);
  }
}

function handlePointerMove(pointer) {
  if (pointer.pointerType === "mouse" && pointer.isDown && pointer.leftButtonDown()) {
    setMoveTargetFromPointer(pointer);
  } else if (pointer.pointerType === "touch" && pointer.isDown) {
    setMoveTargetFromPointer(pointer);
    if (pointer.id === longPressPointerId) {
      const dist = Phaser.Math.Distance.Between(pointer.x, pointer.y, longPressStartPos.x, longPressStartPos.y);
      if (dist > LONG_PRESS_MOVE_CANCEL_DIST) {
        cancelLongPress();
      }
    }
  }
}

function handlePointerUp(pointer) {
  if (pointer.pointerType === "mouse" && pointer.button === 2) {
    stopAutoFire(pointer);
  }

  if (pointer.pointerType === "touch") {
    stopAutoFire(pointer);
  }

  if (pointer.id === longPressPointerId) {
    cancelLongPress();
  }
}

function setMoveTargetFromPointer(pointer) {
  if (!latest || !latest.roomW || !latest.roomH) return;
  const coords = screenToRoom(pointer.x, pointer.y, latest.roomW, latest.roomH);
  if (!coords) return;
  const me = (latest.players || []).find(p => p.id === myId);
  updateAimToward(me, coords.rx, coords.ry);
  moveTarget = {
    x: coords.rx,
    y: coords.ry,
    room: me ? me.room : (latest.room || null)
  };
}

function updateAimToward(me, targetX, targetY) {
  if (!me) return;
  const dx = targetX - me.x;
  const dy = targetY - me.y;
  const mag = Math.hypot(dx, dy);
  if (mag > 0.0001) {
    lastAimDir.x = dx / mag;
    lastAimDir.y = dy / mag;
  }
}

function updateAimFromPointer(pointer) {
  if (!pointer || !latest || !latest.roomW || !latest.roomH) return;
  const coords = screenToRoom(pointer.x, pointer.y, latest.roomW, latest.roomH);
  if (!coords) return;
  const me = (latest.players || []).find(p => p.id === myId);
  updateAimToward(me, coords.rx, coords.ry);
}

function scheduleLongPress(pointer) {
  cancelLongPress();
  longPressPointerId = pointer.id;
  longPressStartPos.x = pointer.x;
  longPressStartPos.y = pointer.y;
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    startAutoFire(pointer);
  }, LONG_PRESS_DELAY_MS);
}

function cancelLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressPointerId = null;
}

function startAutoFire(pointer) {
  if (autoFireInterval) return;
  if (pointer) {
    updateAimFromPointer(pointer);
  }
  autoFirePointerId = pointer ? pointer.id : null;
  autoFirePointerType = pointer ? pointer.pointerType : null;
  handleFire();
  autoFireInterval = setInterval(() => handleFire(), AUTO_FIRE_INTERVAL_MS);
}

function stopAutoFire(pointer) {
  if (!autoFireInterval) return;
  if (pointer) {
    if (autoFirePointerId !== null && pointer.id !== autoFirePointerId) return;
    if (autoFirePointerType && pointer.pointerType !== autoFirePointerType) return;
  }
  clearInterval(autoFireInterval);
  autoFireInterval = null;
  autoFirePointerId = null;
  autoFirePointerType = null;
}

function setupActionButton(button, handler) {
  if (!button) return;

  const onTouchStart = (e) => {
    handler();
    e.preventDefault();
  };

  button.addEventListener("touchstart", onTouchStart, { passive: false });
  button.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    handler();
  });
}

// ---------------------------------------------------------
// Action handlers
// ---------------------------------------------------------
function handleFire() {
  if (ws && ws.readyState === 1) {
    const payload = { t: "shoot" };
    const aimMag = Math.hypot(lastAimDir.x, lastAimDir.y);
    if (aimMag > 0.0001) {
      payload.aimX = lastAimDir.x;
      payload.aimY = lastAimDir.y;
    }
    ws.send(JSON.stringify(payload));
  }
}

function handleAction() {
  if (!ws || ws.readyState !== 1 || !currentAction.enabled) return;

  switch (currentAction.type) {
    case "PICK":
      ws.send(JSON.stringify({ t: "pickup" }));
      break;
    case "USE":
      if (selectedInvIndex !== null) {
        ws.send(JSON.stringify({ t: "useItem", which: selectedInvIndex }));
      }
      break;
  }
}

// ---------------------------------------------------------
// Draw room (Phaser)
// ---------------------------------------------------------
function drawRoom(scene, snap) {
  scene.roomLayer.removeAll(true);
  scene.doorLayer.removeAll(true);
  scene.searchableLayer.removeAll(true);
  scene.itemLayer.removeAll(true);
  scene.trapLayer.removeAll(true);
  scene.bombLayer.removeAll(true);
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
    if (it.id === "escape") {
      const doorW = 40;
      const doorH = 70;
      const topY = sy - doorH / 2;
      const doorGfx = scene.add.graphics();
      doorGfx.fillStyle(0x1f2a44, 1);
      doorGfx.fillRect(sx - doorW / 2, topY, doorW, doorH);
      doorGfx.lineStyle(2, 0xffcc33, 1);
      doorGfx.strokeRect(sx - doorW / 2, topY, doorW, doorH);
      doorGfx.fillStyle(0xffcc33, 1);
      doorGfx.fillCircle(sx + doorW / 4, sy, 3);
      scene.itemLayer.add(doorGfx);

      const exitLabel = scene.add.text(
        sx,
        topY - 12,
        "EXIT",
        { fontSize: "14px", color: "#ffcc33", fontStyle: "bold" }
      ).setOrigin(0.5);
      scene.itemLayer.add(exitLabel);
      return;
    }

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
      { fontSize: "15px", color: "#FFFFFF", align: "center" }
    ).setOrigin(0.5);
    scene.itemLayer.add(labelText);
  });

  // searchables (desks, lockers...)
  (snap.searchables || []).forEach(obj => {
    const { sx, sy } = roomToScreen(obj.x, obj.y, snap.roomW, snap.roomH);
    const boxW = 60;
    const boxH = 24;
    const gfx = scene.add.graphics();
    const fillColor = obj.used ? 0x30363f : 0x3a6ea5;
    gfx.fillStyle(fillColor, 1);
    gfx.fillRect(sx - boxW/2, sy - boxH/2, boxW, boxH);
    gfx.lineStyle(1, 0x000000, 1);
    gfx.strokeRect(sx - boxW/2, sy - boxH/2, boxW, boxH);
    gfx.setAlpha(obj.used ? 0.5 : 1);
    scene.searchableLayer.add(gfx);

    const label = scene.add.text(
      sx,
      sy,
      obj.label,
      { fontSize: "12px", color: "#ffffff", align: "center", wordWrap: { width: boxW - 4 } }
    ).setOrigin(0.5);
    if (obj.used) label.setAlpha(0.5);
    scene.searchableLayer.add(label);
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
      { fontSize: "12px", color: "#000000", align: "center" }
    ).setOrigin(0.5);
    scene.trapLayer.add(trapLabel);
  });

  // bombs (shown to everyone)
  (snap.bombs || []).forEach(b => {
    const { sx, sy } = roomToScreen(b.x, b.y, snap.roomW, snap.roomH);
    const radius = 10;
    const bombGfx = scene.add.graphics();
    const fillColor = b.armed ? 0xff3333 : 0xffaa33;
    bombGfx.fillStyle(fillColor, 1);
    bombGfx.fillCircle(sx, sy, radius);
    bombGfx.lineStyle(2, 0x000000, 1);
    bombGfx.strokeCircle(sx, sy, radius);
    bombGfx.setAlpha(b.armed ? 1 : 0.6);
    scene.bombLayer.add(bombGfx);

    const bombText = scene.add.text(
      sx,
      sy,
      "B",
      { fontSize: "12px", color: "#000000", fontStyle: "bold" }
    ).setOrigin(0.5);
    bombText.setAlpha(b.armed ? 1 : 0.6);
    scene.bombLayer.add(bombText);
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
  updateActionControl(snap);

  // --- score line ---
  const yourHealth = typeof snap.yourHealth === 'number' ? snap.yourHealth : 3;
  const shotsToKill = typeof snap.shotsToKill === 'number' ? snap.shotsToKill : 3;
  const newScore = `Score: ${snap.youScore} / ${snap.scoreTarget} | Health: ${yourHealth} / ${shotsToKill}`;
  if (newScore !== lastScoreRendered) {
    scoreLineEl.textContent = newScore;
    lastScoreRendered = newScore;
  }

  // --- legend ---
  const mapPrefix = snap.mapName ? `Map: ${snap.mapName}\n` : "";
  const desiredLegend = mapPrefix + (
    IS_MOBILE
      ? "Tap to move.\nDouble tap to fire.\nLong press to auto-fire.\nACTION handles PICK/USE."
      : "Click to move. Right-click to fire (hold for auto-fire).\nSPACE=SHOOT/PICK, ENTER=USE ITEM"
  );
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
    intel: snap.intelLocation || null,
    key: snap.keyLocation || null,
    trap: snap.trapKitLocation || null
  };
  const radarJson = JSON.stringify(radarData);
  if (radarJson !== lastRadarRendered) {
    const hasIntel = !!radarData.intel;
    const hasKey = !!radarData.key;
    const hasTrap = !!radarData.trap;
    if (hasIntel || hasKey || hasTrap) {
      const formatRadarLine = (label, loc) => {
        if (!loc) return `${label}: ?`;
        const roomStr = loc.room || "?";
        if (loc.carriedBy) {
          return `${label}: ${roomStr} (carried by ${loc.carriedBy})`;
        }
        return `${label}: ${roomStr}`;
      };

      radarBoxEl.style.display = "block";
      radarBoxEl.textContent = [
        "RADAR:",
        formatRadarLine("Intel", radarData.intel),
        formatRadarLine("Key", radarData.key),
        formatRadarLine("Trap Kit", radarData.trap)
      ].join("\n");
    } else {
      radarBoxEl.style.display = "none";
    }
    lastRadarRendered = radarJson;
  }
}

// ---------------------------------------------------------
// Helpers for HUD
// ---------------------------------------------------------
const PICK_RADIUS_SQR = 22 * 22; // client-side check radius (sq)

function updateActionControl(snap) {
  const button = btnAction;
  const me = (snap.players || []).find(p => p.id === myId);
  if (!me) {
    currentAction = { type: null, enabled: false };
    if (button) {
      button.textContent = "ACTION";
      button.classList.add("disabled");
    }
    return;
  }

  // Check for nearby items/searchables
  let actionContext = null; // "item" or "searchable"
  let closestDistSq = Infinity;

  if (snap.items && snap.items.length > 0) {
    for (const item of snap.items) {
      const dx = me.x - item.x;
      const dy = me.y - item.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < PICK_RADIUS_SQR && distSq < closestDistSq) {
        closestDistSq = distSq;
        actionContext = "item";
      }
    }
  }

  if (snap.searchables && snap.searchables.length > 0) {
    for (const obj of snap.searchables) {
      if (obj.used) continue;
      const dx = me.x - obj.x;
      const dy = me.y - obj.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < PICK_RADIUS_SQR && distSq < closestDistSq) {
        closestDistSq = distSq;
        actionContext = "searchable";
      }
    }
  }

  if (actionContext) {
    currentAction = { type: "PICK", enabled: true, context: actionContext };
    if (button) {
      button.textContent = actionContext === "searchable" ? "SEARCH" : "PICK";
      button.classList.remove("disabled");
    }
  } else {
    // Context is USE/DROP
    if (selectedInvIndex !== null && snap.yourInventory && snap.yourInventory.length > 0) {
      currentAction = { type: "USE", enabled: true };
      const item = snap.yourInventory[selectedInvIndex];
      const name = (item.label || item.id || "").toUpperCase();
      // more specific label for trap kits
      if (button) {
        if (name.includes("TRAP")) {
          button.textContent = "PLACE";
        } else if (name.includes("BOMB")) {
          button.textContent = "DROP";
        } else {
          button.textContent = "USE";
        }
        button.classList.remove("disabled");
      }
    } else {
      currentAction = { type: "USE", enabled: false };
      if (button) {
        button.textContent = "ACTION";
        button.classList.add("disabled");
      }
    }
  }
}


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
  if (name.includes("BOMB")) {
    return "BOMB:\nDrop to create a lethal trap. Detonates on enemies who touch it.";
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

function screenToRoom(sx, sy, roomW, roomH) {
  const box = getRoomScreenBox(roomW, roomH);
  if (!box || box.scale <= 0) return null;
  const rx = (sx - box.roomX) / box.scale;
  const ry = (sy - box.roomY) / box.scale;
  return {
    rx: Phaser.Math.Clamp(rx, 0, roomW),
    ry: Phaser.Math.Clamp(ry, 0, roomH),
    inside: sx >= box.roomX && sx <= (box.roomX + box.roomW) && sy >= box.roomY && sy <= (box.roomY + box.roomH)
  };
}
