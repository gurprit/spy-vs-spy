/* global Phaser */

const WS_URL = (typeof location !== "undefined" && location.origin)
  ? location.origin.replace(/^http/, "ws")
  : "ws://localhost:3000";

const VIEW_W = 900;
const VIEW_H = 600;

let ws;
let myId = null;
let seq = 0;

// virtual input state (for mobile dpad)
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
  traps: [],         // [{id,x,y,owner}] (only mine)
  players: [],       // [{id,shortId,x,y,color,isStunned,stunMsRemaining,score}]
  yourInventory: [],
  youScore: 0,
  scoreTarget: 5,
  winner: null
};

const renderPlayers = new Map(); // id -> { gfx, alertText, nameText, x, y }
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

  // Keyboard input
  scene.cursors = scene.input.keyboard.createCursorKeys();
  scene.keys = scene.input.keyboard.addKeys("W,A,S,D,E,SPACE,T");

  // Hook up mobile controls (if present in DOM)
  setupMobileControls();

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
      drawHUD(scene, latest);
      drawWinner(scene, latest.winner);
    }
  };

  ws.onerror = (err) => console.warn("[client] ws error", err);
  ws.onclose  = () => console.warn("[client] ws closed");
}

function update(time, delta) {
  const scene = this;
  const dt = delta / 1000;

  // 1. COLLECT INPUT (keyboard OR virtual)
  let dx = 0, dy = 0;

  // keyboard first
  if (scene.cursors.left.isDown || scene.keys.A.isDown) dx -= 1;
  if (scene.cursors.right.isDown || scene.keys.D.isDown) dx += 1;
  if (scene.cursors.up.isDown || scene.keys.W.isDown) dy -= 1;
  if (scene.cursors.down.isDown || scene.keys.S.isDown) dy += 1;

  // if keyboard is neutral, fall back to touch dpad
  if (dx === 0 && dy === 0) {
    dx = virtualDX;
    dy = virtualDY;
  }

  // send movement every frame, same as before
  seq++;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "input", seq, dx, dy }));
  }

  // 2. Keyboard action shortcuts (desktop)
  // Pickup (E / SPACE)
  if ((scene.keys.SPACE.isDown || scene.keys.E.isDown) && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "pickup" }));
  }

  // Place trap (T)
  if (scene.keys.T.isDown && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "placeTrap" }));
  }

  // 3. Render players (circles + nameplates + stun !!)
  const seen = new Set();
  (latest.players || []).forEach(p => {
    const rp = ensurePlayer(scene, p.id, p.shortId);

    const stunned = p.isStunned;
    const drawColor = stunned ? "#ff3333" : p.color;
    const radius = stunned ? 12 : 8;

    tintPlayerCircle(rp.gfx, drawColor, radius);

    const { sx, sy } = roomToScreen(p.x, p.y, latest.roomW, latest.roomH);

    rp.x = Phaser.Math.Linear(rp.x, sx, 0.4);
    rp.y = Phaser.Math.Linear(rp.y, sy, 0.4);
    rp.gfx.setPosition(rp.x, rp.y);

    // "!!" if stunned
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

    // nameplate under the player (shortId)
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

  // Cleanup vanished players
  for (const [id, rp] of renderPlayers.entries()) {
    if (!seen.has(id)) {
      if (rp.alertText) rp.alertText.destroy();
      if (rp.nameText) rp.nameText.destroy();
      rp.gfx.destroy();
      renderPlayers.delete(id);
    }
  }
}

// ---------------------------------------------------------------------
// MOBILE CONTROL SETUP
// ---------------------------------------------------------------------

function setupMobileControls() {
  const dpadEl = document.getElementById("dpad");
  const actionBtn = document.getElementById("action-btn");

  if (!dpadEl || !actionBtn) {
    // desktop or no overlay
    return;
  }

  // prevent context menu on long press etc.
  actionBtn.addEventListener("contextmenu", e => e.preventDefault());

  // D-PAD:
  // We listen to touchstart/mousedown and touchend/mouseup per arrow.
  // Multiple directions can be pressed, e.g. up+left => (-1,-1)
  const activeDirs = {
    up: false,
    down: false,
    left: false,
    right: false
  };

  function recomputeVirtualDir() {
    let dx = 0;
    let dy = 0;
    if (activeDirs.left)  dx -= 1;
    if (activeDirs.right) dx += 1;
    if (activeDirs.up)    dy -= 1;
    if (activeDirs.down)  dy += 1;
    // normalize diagonals a little? we don't need to; server normalizes speed.
    virtualDX = dx;
    virtualDY = dy;
  }

  // helper to attach press/release to each button
  function bindDir(btnEl, dirName) {
    if (!btnEl) return;

    // pointerdown (covers mouse+touch in modern browsers)
    btnEl.addEventListener("pointerdown", e => {
      e.preventDefault();
      activeDirs[dirName] = true;
      recomputeVirtualDir();
    });

    // pointerup on button
    btnEl.addEventListener("pointerup", e => {
      e.preventDefault();
      activeDirs[dirName] = false;
      recomputeVirtualDir();
    });

    // pointerleave / pointercancel in case finger slides off
    btnEl.addEventListener("pointercancel", e => {
      activeDirs[dirName] = false;
      recomputeVirtualDir();
    });
    btnEl.addEventListener("pointerout", e => {
      // only clear if pointer is not pressed anymore
      // but mobile sometimes fires pointerout while still down, so we'll be conservative:
      // we'll not clear here. We'll rely on pointerup/cancel.
    });
  }

  bindDir(dpadEl.querySelector('[data-dir="up"]'), "up");
  bindDir(dpadEl.querySelector('[data-dir="down"]'), "down");
  bindDir(dpadEl.querySelector('[data-dir="left"]'), "left");
  bindDir(dpadEl.querySelector('[data-dir="right"]'), "right");

  // ACTION BUTTON:
  // tap = pickup
  // hold >=250ms = placeTrap

  actionBtn.addEventListener("pointerdown", e => {
    e.preventDefault();
    actionTouchStartTime = performance.now();
  });

  actionBtn.addEventListener("pointerup", e => {
    e.preventDefault();
    if (!ws || ws.readyState !== 1) return;

    const heldFor = performance.now() - actionTouchStartTime;
    if (heldFor >= 250) {
      // long press -> place trap
      ws.send(JSON.stringify({ t: "placeTrap" }));
    } else {
      // quick tap -> pickup
      ws.send(JSON.stringify({ t: "pickup" }));
    }
  });

  actionBtn.addEventListener("pointercancel", e => {
    e.preventDefault();
  });
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

  // items (green rounded pill)
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

  // traps (you only see your own, from server)
  (snap.traps || []).forEach(tr => {
    const { sx, sy } = roomToScreen(tr.x, tr.y, snap.roomW, snap.roomH);

    // big T marker
    const trapText = scene.add.text(
      sx,
      sy,
      "T",
      { fontSize: "20px", color: "#ff3333", fontStyle: "bold" }
    ).setOrigin(0.5);
    scene.trapLayer.add(trapText);

    // owner shortID
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
// HUD (inventory + score + hints)
// ---------------------------------------------------------------------

function drawHUD(scene, snap) {
  scene.uiLayer.removeAll(true);

  const padX = 8;
  const padY = VIEW_H - 8 - 80;
  const w = 260;
  const h = 80;

  const bg = scene.add.graphics();
  bg.fillStyle(0x000000, 0.6);
  bg.fillRect(padX, padY, w, h);
  bg.lineStyle(1, 0xffffff, 0.8);
  bg.strokeRect(padX, padY, w, h);
  scene.uiLayer.add(bg);

  // Score
  const scoreLine = `SCORE: ${snap.youScore || 0} / ${snap.scoreTarget || 5}`;
  const scoreText = scene.add.text(
    padX + 6,
    padY + 4,
    scoreLine,
    { fontSize: "12px", color: "#ffff55" }
  );
  scene.uiLayer.add(scoreText);

  // Controls
  const ctrlText = scene.add.text(
    padX + 6,
    padY + 20,
    "tap A: pick / hold A: trap",
    { fontSize: "10px", color: "#ffffff" }
  );
  scene.uiLayer.add(ctrlText);

  // Inventory header
  const invHead = scene.add.text(
    padX + 6,
    padY + 34,
    "INV:",
    { fontSize: "10px", color: "#ffffff" }
  );
  scene.uiLayer.add(invHead);

  // Inventory items
  const inv = snap.yourInventory || [];
  if (!inv.length) {
    const empty = scene.add.text(
      padX + 26,
      padY + 34,
      "(empty)",
      { fontSize: "10px", color: "#aaaaaa" }
    );
    scene.uiLayer.add(empty);
  } else {
    inv.forEach((it, idx) => {
      const line = scene.add.text(
        padX + 26,
        padY + 34 + idx * 12,
        `- ${it.label}`,
        { fontSize: "10px", color: "#ffffff" }
      );
      scene.uiLayer.add(line);
    });
  }

  // EXIT hint
  const hasIntel = inv.some(it => it.label === "INTEL");
  const hasKey   = inv.some(it => it.label === "KEY");
  if (hasIntel && hasKey) {
    const hint = scene.add.text(
      padX + 6,
      padY + h - 14,
      "GET TO EXIT!",
      { fontSize: "10px", color: "#ff5555" }
    );
    scene.uiLayer.add(hint);
  }
}

// ---------------------------------------------------------------------
// WINNER BANNER
// ---------------------------------------------------------------------

function drawWinner(scene, winner) {
  scene.winLayer.removeAll(true);
  if (!winner) return;

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
    { fontSize: "16px", color: "#ffcc33", align: "center" }
  ).setOrigin(0.5);
  scene.winLayer.add(t);
}

// ---------------------------------------------------------------------
// PLAYER RENDERING
// ---------------------------------------------------------------------

function ensurePlayer(scene, id, shortId) {
  if (renderPlayers.has(id)) return renderPlayers.get(id);

  // main circle
  const gfx = scene.add.graphics();
  gfx.fillStyle(0xffffff, 1);
  gfx.fillCircle(0, 0, 8);
  scene.playerLayer.add(gfx);

  const entry = {
    x: VIEW_W/2,
    y: VIEW_H/2,
    gfx,
    alertText: null,
    nameText: null
  };

  // create name text so it's persistent
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

// ---------------------------------------------------------------------
// ROOM COORDS -> SCREEN COORDS
// ---------------------------------------------------------------------

function getRoomScreenBox(roomW, roomH) {
  const maxW = VIEW_W * 0.8;
  const maxH = VIEW_H * 0.8;
  const scale = Math.min(maxW / roomW, maxH / roomH);

  const drawnW = roomW * scale;
  const drawnH = roomH * scale;

  const offX = (window.innerWidth  || VIEW_W) / 2 - drawnW / 2;
  const offY = (window.innerHeight || VIEW_H) / 2 - drawnH / 2;

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
