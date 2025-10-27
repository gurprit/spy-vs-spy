/* global Phaser */

// DOM refs
const gameHolder = document.getElementById("game-canvas-holder");
const hudScoreEl = document.getElementById("hud-score");
const hudExitHintEl = document.getElementById("hud-exit-hint");
const invListEl = document.getElementById("inv-list");
const winBannerEl = document.getElementById("win-banner");

// The visible "game area" is only the top section now
function getGameAreaSize() {
  const rect = gameHolder.getBoundingClientRect();
  return {
    w: rect.width || window.innerWidth || 900,
    h: rect.height || window.innerHeight * 0.5 || 400
  };
}

// dynamic view size (for Phaser canvas)
let { w: viewW, h: viewH } = getGameAreaSize();

const WS_URL = (typeof location !== "undefined" && location.origin)
  ? location.origin.replace(/^http/, "ws")
  : "ws://localhost:3000";

let ws;
let myId = null;
let seq = 0;

// virtual input state (mobile dpad)
let virtualDX = 0;
let virtualDY = 0;
// tap vs hold timer for action button
let actionTouchStartTime = 0;

let latest = {
  room: null,
  roomW: 320,
  roomH: 200,
  doors: [],
  items: [],
  traps: [],         // {id,x,y,owner} only mine visible
  players: [],       // {id,shortId,x,y,color,isStunned,stunMsRemaining,score}
  yourInventory: [],
  youScore: 0,
  scoreTarget: 5,
  winner: null
};

const renderPlayers = new Map(); // id -> { gfx, alertText, nameText, x, y }
let sceneRef = null;

// Phaser config, but instead of attaching to <body> we tell Phaser which parent to use.
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: gameHolder, // mount canvas into our div
  backgroundColor: "#0d0f14",
  scale: {
    width: viewW,
    height: viewH,
    mode: Phaser.Scale.RESIZE
  },
  physics: { default: "arcade" },
  scene: { create, update }
});

function create() {
  const scene = this;
  sceneRef = scene;

  // gameplay ONLY layers now
  scene.roomLayer = scene.add.layer();
  scene.doorLayer = scene.add.layer();
  scene.itemLayer = scene.add.layer();
  scene.trapLayer = scene.add.layer();
  scene.playerLayer = scene.add.layer();

  // Keyboard input (desktop fallback)
  scene.cursors = scene.input.keyboard.createCursorKeys();
  scene.keys = scene.input.keyboard.addKeys("W,A,S,D,E,SPACE,T");

  // Mobile controls hookup
  setupMobileControls();

  // WebSocket
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
      updateHUD(latest);
      updateWinnerBanner(latest.winner);
    }
  };

  ws.onerror = (err) => console.warn("[client] ws error", err);
  ws.onclose  = () => console.warn("[client] ws closed");

  // handle resize of the GAME AREA section
  window.addEventListener("resize", handleResize);
  // mobile browsers sometimes resize on orientationchange etc:
  window.addEventListener("orientationchange", handleResize);
}

function handleResize() {
  const size = getGameAreaSize();
  viewW = size.w;
  viewH = size.h;
  if (sceneRef && sceneRef.scale) {
    sceneRef.scale.resize(viewW, viewH);
  }

  // make sure player placeholders aren't way off
  renderPlayers.forEach((rp) => {
    if (rp.x == null) rp.x = viewW / 2;
    if (rp.y == null) rp.y = viewH / 2;
  });

  // redraw winner banner position (HUD is DOM so it's fine)
  updateWinnerBanner(latest.winner);
}

function update(time, delta) {
  const scene = this;
  const dt = delta / 1000;

  // collect input
  let dx = 0, dy = 0;

  // keyboard first
  if (scene.cursors.left.isDown || scene.keys.A.isDown) dx -= 1;
  if (scene.cursors.right.isDown || scene.keys.D.isDown) dx += 1;
  if (scene.cursors.up.isDown || scene.keys.W.isDown) dy -= 1;
  if (scene.cursors.down.isDown || scene.keys.S.isDown) dy += 1;

  // fallback to touch
  if (dx === 0 && dy === 0) {
    dx = virtualDX;
    dy = virtualDY;
  }

  // send movement
  seq++;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "input", seq, dx, dy }));
  }

  // desktop pickup / trap
  if ((scene.keys.SPACE.isDown || scene.keys.E.isDown) && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "pickup" }));
  }
  if (scene.keys.T.isDown && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "placeTrap" }));
  }

  // render players (circles, stun, nameplates)
  const seen = new Set();
  (latest.players || []).forEach(p => {
    const rp = ensurePlayer(scene, p.id, p.shortId);

    const stunned = p.isStunned;
    const drawColor = stunned ? "#ff3333" : p.color;
    const radius = stunned ? 12 : 8;

    tintPlayerCircle(rp.gfx, drawColor, radius);

    const { sx, sy } = roomToScreen(p.x, p.y, latest.roomW, latest.roomH);

    rp.x = Phaser.Math.Linear(rp.x ?? sx, sx, 0.4);
    rp.y = Phaser.Math.Linear(rp.y ?? sy, sy, 0.4);
    rp.gfx.setPosition(rp.x, rp.y);

    // stun "!!"
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

    // nameplate under player
    if (!rp.nameText) {
      rp.nameText = scene.add.text(
        rp.x,
        rp.y + radius + 4,
        p.shortId || "????",
        { fontSize: "10px", color: "#ffffff" }
      ).setOrigin(0.5, 0);
      scene.playerLayer.add(rp.nameText);
    }
    rp.nameText.setText(p.shortId || "????");
    rp.nameText.setPosition(rp.x, rp.y + radius + 4);
    rp.nameText.setVisible(true);

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

// -------------------------------------------------
// Mobile controls (D-pad + A button in DOM)
// -------------------------------------------------

function setupMobileControls() {
  const dpadEl = document.getElementById("dpad");
  const actionBtn = document.getElementById("action-btn");

  if (!dpadEl || !actionBtn) return;

  actionBtn.addEventListener("contextmenu", e => e.preventDefault());

  const activeDirs = { up:false, down:false, left:false, right:false };

  function recomputeVirtualDir() {
    let dx = 0;
    let dy = 0;
    if (activeDirs.left)  dx -= 1;
    if (activeDirs.right) dx += 1;
    if (activeDirs.up)    dy -= 1;
    if (activeDirs.down)  dy += 1;
    virtualDX = dx;
    virtualDY = dy;
  }

  function bindDir(btnEl, dirName) {
    if (!btnEl) return;

    btnEl.addEventListener("pointerdown", e => {
      e.preventDefault();
      activeDirs[dirName] = true;
      recomputeVirtualDir();
    });

    btnEl.addEventListener("pointerup", e => {
      e.preventDefault();
      activeDirs[dirName] = false;
      recomputeVirtualDir();
    });

    btnEl.addEventListener("pointercancel", e => {
      activeDirs[dirName] = false;
      recomputeVirtualDir();
    });
  }

  bindDir(dpadEl.querySelector('[data-dir="up"]'), "up");
  bindDir(dpadEl.querySelector('[data-dir="down"]'), "down");
  bindDir(dpadEl.querySelector('[data-dir="left"]'), "left");
  bindDir(dpadEl.querySelector('[data-dir="right"]'), "right");

  // tap = pickup, hold >=250ms = trap
  actionBtn.addEventListener("pointerdown", e => {
    e.preventDefault();
    actionTouchStartTime = performance.now();
  });

  actionBtn.addEventListener("pointerup", e => {
    e.preventDefault();
    if (!ws || ws.readyState !== 1) return;
    const heldFor = performance.now() - actionTouchStartTime;
    if (heldFor >= 250) {
      ws.send(JSON.stringify({ t: "placeTrap" }));
    } else {
      ws.send(JSON.stringify({ t: "pickup" }));
    }
  });

  actionBtn.addEventListener("pointercancel", e => {
    e.preventDefault();
  });
}

// -------------------------------------------------
// Draw gameplay layers (room, doors, items, traps)
// -------------------------------------------------

function drawRoom(scene, snap) {
  scene.roomLayer.removeAll(true);
  scene.doorLayer.removeAll(true);
  scene.itemLayer.removeAll(true);
  scene.trapLayer.removeAll(true);

  const box = getRoomScreenBox(snap.roomW, snap.roomH);

  // room background
  const roomGfx = scene.add.graphics();
  roomGfx.fillStyle(0x1e2535, 1);
  roomGfx.fillRect(box.roomX, box.roomY, box.roomW, box.roomH);
  roomGfx.lineStyle(2, 0xffffff, 1);
  roomGfx.strokeRect(box.roomX, box.roomY, box.roomW, box.roomH);
  scene.roomLayer.add(roomGfx);

  // room label at top-left of room instead of global HUD
  const title = scene.add.text(
    box.roomX + box.roomW / 2,
    box.roomY + 8,
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

  // items (green pills)
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

  // traps ("T" marker). Server only sends yours so it's secret
  (snap.traps || []).forEach(tr => {
    const { sx, sy } = roomToScreen(tr.x, tr.y, snap.roomW, snap.roomH);

    const trapText = scene.add.text(
      sx,
      sy,
      "T",
      { fontSize: "20px", color: "#ff3333", fontStyle: "bold" }
    ).setOrigin(0.5);
    scene.trapLayer.add(trapText);

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

// -------------------------------------------------
// HUD is now DOM, not Phaser
// -------------------------------------------------

function updateHUD(snap) {
  // score
  const scoreNow = snap.youScore || 0;
  const scoreTarget = snap.scoreTarget || 5;
  hudScoreEl.textContent = `SCORE: ${scoreNow} / ${scoreTarget}`;

  // inventory list
  const inv = snap.yourInventory || [];
  if (!inv.length) {
    invListEl.innerHTML = `<span class="empty">(empty)</span>`;
  } else {
    invListEl.innerHTML = inv
      .map(it => `<div>- ${it.label}</div>`)
      .join("");
  }

  // exit hint visible?
  const hasIntel = inv.some(it => it.label === "INTEL");
  const hasKey   = inv.some(it => it.label === "KEY");
  if (hasIntel && hasKey) {
    hudExitHintEl.style.display = "block";
  } else {
    hudExitHintEl.style.display = "none";
  }
}

// -------------------------------------------------
// Winner banner is also DOM now
// -------------------------------------------------

function updateWinnerBanner(winner) {
  if (!winner) {
    winBannerEl.style.display = "none";
    return;
  }

  let textStr;
  if (winner.id === myId) {
    textStr = winner.type === "escape"
      ? "YOU ESCAPED!"
      : "YOU WON THE ROUND!";
  } else {
    const shortId = winner.id.slice(0,4);
    textStr = winner.type === "escape"
      ? `PLAYER ${shortId} ESCAPED!`
      : `PLAYER ${shortId} WON THE ROUND!`;
  }

  winBannerEl.textContent = textStr;
  winBannerEl.style.display = "block";
}

// -------------------------------------------------
// player rendering helpers
// -------------------------------------------------

function ensurePlayer(scene, id, shortId) {
  if (renderPlayers.has(id)) return renderPlayers.get(id);

  const gfx = scene.add.graphics();
  gfx.fillStyle(0xffffff, 1);
  gfx.fillCircle(0, 0, 8);
  scene.playerLayer.add(gfx);

  const entry = {
    x: viewW / 2,
    y: viewH / 2,
    gfx,
    alertText: null,
    nameText: null
  };

  entry.nameText = scene.add.text(
    entry.x,
    entry.y + 12,
    shortId || id.slice(0,4),
    { fontSize: "10px", color: "#ffffff" }
  ).setOrigin(0.5, 0);
  scene.playerLayer.add(entry.nameText);

  renderPlayers.set(id, entry);
  return entry;
}

function tintPlayerCircle(gfx, colorHexStr, radiusPx) {
  gfx.clear();
  const col = Phaser.Display.Color.HexStringToColor(colorHexStr).color;
  gfx.fillStyle(col, 1);
  gfx.fillCircle(0, 0, radiusPx);
}

// -------------------------------------------------
// world -> screen helpers
// -------------------------------------------------

function getRoomScreenBox(roomW, roomH) {
  // Fit room inside game area's current size (viewW/viewH),
  // leaving 10% margin to avoid hugging the edges.
  const maxW = viewW * 0.9;
  const maxH = viewH * 0.9;
  const scale = Math.min(maxW / roomW, maxH / roomH);

  const drawnW = roomW * scale;
  const drawnH = roomH * scale;

  const offX = (viewW - drawnW) / 2;
  const offY = (viewH - drawnH) / 2;

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
