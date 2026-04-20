import {
  GLOBAL_ROOM_ID,
  GameRuleError,
  applyMove,
  boardWithPlacements,
  createGameState,
  createId,
  createMove,
  hexKey,
  isWithinBounds,
  joinGame,
  normalizePlayerName,
  orderedPlayers,
  resetGameState,
  validateMove
} from "./model.js";
import { loadAppState, saveAppState } from "./storage.js";
import { GameSync, joinRemoteGame } from "./sync.js";

const HEX_SIZE = 34;
const MIN_SCALE = 0.35;
const MAX_SCALE = 2.4;
const SQRT3 = Math.sqrt(3);
const CURRENT_PLAYER_COLOR = "#0072b2";
const OTHER_PLAYER_COLOR = "#d55e00";

const appState = loadAppState();
applyLinkedSessionFromUrl(appState);
const ui = {
  screen: appState.session?.playerName ? null : "setup",
  leaderboardOpen: false,
  historyOpen: false,
  syncStatus: "idle",
  localOnly: false,
  staged: [],
  hoverHex: null,
  dragging: null,
  pan: null,
  gesture: null,
  pointers: new Map(),
  flushing: false,
  resetting: false,
  drawQueued: false,
  resizeQueued: false,
  canvasSize: { width: 0, height: 0 },
  camera: appState.camera || { x: 0, y: 0, scale: 1 }
};

if (appState.game?.id && appState.game.id !== GLOBAL_ROOM_ID) {
  appState.game = null;
  appState.pendingMoves = [];
}

let game = createGameState(appState.game || { id: GLOBAL_ROOM_ID });
let sync = null;
let toastTimer = null;

const $ = id => document.getElementById(id);
const canvas = $("board-canvas");
const ctx = canvas.getContext("2d");

function save() {
  appState.game = game;
  appState.camera = ui.camera;
  saveAppState(appState);
}

function currentPlayer() {
  const id = appState.session?.playerId;
  return id ? game.players[id] || null : null;
}

function activeTileIds() {
  const ids = new Set(ui.staged.map(placement => placement.tileId));
  for (const move of appState.pendingMoves) {
    for (const placement of move.placements || []) ids.add(placement.tileId);
  }
  return ids;
}

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2200);
}

async function copyText(value) {
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Copy failed");
}

function renderAll() {
  const showSetup = Boolean(ui.screen);
  $("setup-screen").classList.toggle("active", showSetup);
  $("leaderboard-screen").classList.toggle("active", ui.leaderboardOpen && !showSetup);
  $("history-screen").classList.toggle("active", ui.historyOpen && !showSetup);
  $("app").hidden = showSetup || !appState.session;

  if (showSetup) {
    ui.leaderboardOpen = false;
    ui.historyOpen = false;
    $("leaderboard-screen").classList.remove("active");
    $("history-screen").classList.remove("active");
    document.body.classList.add("no-scroll");
    renderSetup();
    return;
  }

  document.body.classList.toggle("no-scroll", ui.leaderboardOpen || ui.historyOpen);
  renderHud();
  renderTray();
  renderPreview();
  renderLeaderboard();
  renderHistory();
  queueResizeCanvas();
}

function renderSetup() {
  const name = appState.session?.playerName || "";
  const hasSession = Boolean(appState.session?.playerId);
  const accountLink = hasSession ? getAccountLink(name) : "";

  $("setup-content").innerHTML = `
    <h1>hexabloom</h1>
    <p>${hasSession ? "your name" : "choose your name"}</p>
    <label class="field-label" for="setup-name">Your name</label>
    <input type="text" class="field-input setup-input" id="setup-name" value="${esc(name)}" placeholder="Name" autocomplete="off" spellcheck="false">
    ${hasSession ? `
      <label class="field-label" for="account-link">Account link</label>
      <div class="copy-field">
        <input type="text" class="field-input copy-input" id="account-link" value="${esc(accountLink)}" readonly>
        <button class="action-link" type="button" data-action="copy-account-link">Copy</button>
      </div>
    ` : ""}
    <div class="detail-actions setup-actions">
      <button class="action-link primary" type="button" data-action="join-board">${hasSession ? "OK" : "Join"}</button>
      ${hasSession ? '<button class="action-link muted" type="button" data-action="close-setup">Cancel</button>' : ""}
    </div>
  `;
  setTimeout(() => $("setup-name")?.focus(), 0);
}

function getAccountLink(name = appState.session?.playerName || "") {
  const playerId = appState.session?.playerId || "";
  const playerName = normalizePlayerName(name) || appState.session?.playerName || "";
  const url = new URL(globalThis.location?.href || "http://localhost:8031/");
  url.search = "";
  url.hash = "";
  url.searchParams.set("player", playerId);
  url.searchParams.set("name", playerName);
  return url.toString();
}

function applyLinkedSessionFromUrl(state) {
  if (!globalThis.location?.search) return;

  const params = new URLSearchParams(globalThis.location.search);
  const playerId = normalizeLinkedPlayerId(params.get("player") || params.get("playerId"));
  const playerName = normalizePlayerName(params.get("name") || params.get("playerName"));
  if (!playerId || !playerName) return;

  const changedAccount = state.session?.playerId !== playerId;
  state.session = { roomId: GLOBAL_ROOM_ID, playerId, playerName };
  if (changedAccount) state.pendingMoves = [];
  saveAppState(state);

  params.delete("player");
  params.delete("playerId");
  params.delete("name");
  params.delete("playerName");
  const cleaned = `${globalThis.location.pathname}${params.toString() ? `?${params}` : ""}${globalThis.location.hash}`;
  globalThis.history?.replaceState?.({}, "", cleaned);
}

function normalizeLinkedPlayerId(value) {
  return String(value || "").trim().slice(0, 128);
}

function renderHud() {
  const player = currentPlayer();
  const players = orderedPlayers(game.players);
  const leader = players[0];
  const occupied = Object.keys(game.board).length;
  const playerLabel = `${players.length} ${players.length === 1 ? "player" : "players"}`;

  $("room-line").innerHTML = `
    <span>${occupied} tiles</span>
    <span>·</span>
    <button class="inline-link" type="button" data-action="open-leaderboard">${esc(playerLabel)}</button>
    <span>·</span>
    <button class="inline-link" type="button" data-action="open-history">history</button>
  `;
  $("switch-session-btn").textContent = player ? player.name : "join";
  $("switch-session-btn").hidden = false;

  const status = ui.localOnly ? "local" : ui.syncStatus;
  const dot = $("sync-dot");
  dot.className = `sync-dot ${status}`;
  dot.title = status;
  dot.setAttribute("aria-label", status);

  $("stats-row").innerHTML = `
    <span>${player ? `score ${player.score}` : "score 0"}</span>
    <span>${leader ? `leader ${esc(leader.name)} ${leader.score}` : "leader -"}</span>
  `;
}

function renderLeaderboard() {
  const players = leaderboardPlayers();
  const rows = players.length ? players.map((player, index) => `
    <div class="leaderboard-row">
      <span>${index + 1}</span>
      <strong>${esc(player.name)}</strong>
      <span>${player.turnCount}</span>
      <span>${player.score}</span>
    </div>
  `).join("") : '<p class="leaderboard-empty">No players yet.</p>';

  $("leaderboard-content").innerHTML = `
    <div class="overlay-header">
      <h2>leaderboard</h2>
      <button class="action-link muted" type="button" data-action="close-leaderboard">Close</button>
    </div>
    <div class="leaderboard-table" role="table" aria-label="Leaderboard">
      <div class="leaderboard-row leaderboard-heading" role="row">
        <span>#</span>
        <span>player</span>
        <span>turns</span>
        <span>score</span>
      </div>
      ${rows}
    </div>
  `;
}

function renderHistory() {
  const entries = moveHistoryEntries();
  const rows = entries.length ? entries.map(entry => `
    <div class="history-row">
      <span>${entry.index}</span>
      <strong>${esc(entry.primary)}</strong>
      <span>${esc(entry.playerName)}</span>
      <span>${entry.additional.length ? esc(entry.additional.join(", ")) : "-"}</span>
      <span>${entry.score}</span>
    </div>
  `).join("") : '<p class="leaderboard-empty">No words yet.</p>';

  $("history-content").innerHTML = `
    <div class="overlay-header">
      <h2>history</h2>
      <button class="action-link muted" type="button" data-action="close-history">Close</button>
    </div>
    <div class="history-table" role="table" aria-label="Word history">
      <div class="history-row history-heading" role="row">
        <span>#</span>
        <span>word</span>
        <span>player</span>
        <span>also</span>
        <span>points</span>
      </div>
      ${rows}
    </div>
  `;
}

function moveHistoryEntries() {
  return (game.moves || []).map((move, index) => {
    const words = moveWords(move);
    const primaryIndex = primaryWordIndex(move, words);
    const player = game.players?.[move.playerId];

    return {
      index: index + 1,
      primary: words[primaryIndex]?.text || "single tile",
      additional: words.filter((_, wordIndex) => wordIndex !== primaryIndex).map(word => word.text),
      playerName: move.playerName || player?.name || "unknown",
      score: Math.max(0, Number.parseInt(move.score, 10) || 0)
    };
  }).reverse();
}

function moveWords(move) {
  return Array.isArray(move.words)
    ? move.words
      .map(word => ({
        text: String(word?.text || ""),
        keys: Array.isArray(word?.keys) ? word.keys.map(String) : []
      }))
      .filter(word => word.text)
    : [];
}

function primaryWordIndex(move, words) {
  if (!words.length) return -1;

  const placementKeys = (move.placements || []).map(placement => hexKey(placement.q, placement.r));
  if (placementKeys.length) {
    const index = words.findIndex(word => placementKeys.every(key => word.keys.includes(key)));
    if (index >= 0) return index;
  }

  return 0;
}

function leaderboardPlayers() {
  const turnCounts = new Map();
  for (const move of game.moves || []) {
    turnCounts.set(move.playerId, (turnCounts.get(move.playerId) || 0) + 1);
  }

  return orderedPlayers(game.players).map(player => ({
    ...player,
    turnCount: turnCounts.get(player.id) || 0
  }));
}

function renderTray() {
  const player = currentPlayer();
  const hiddenIds = activeTileIds();
  const tray = $("tile-tray");

  if (!player) {
    $("rack-label").textContent = "rack";
    $("pending-label").textContent = "";
    tray.innerHTML = "";
    return;
  }

  const drag = ui.dragging;
  const draggedTileId = drag?.tileId || "";
  const hideDraggedTile = drag && (drag.source === "board" || (drag.source === "tray" && drag.moved));

  if (hideDraggedTile) hiddenIds.add(draggedTileId);

  const items = player.rack
    .filter(tile => !hiddenIds.has(tile.id))
    .map(tile => ({ type: "tile", tile }));

  if (drag?.moved && hideDraggedTile) {
    const placeholderIndex = drag.overRack
      ? Math.min(Math.max(drag.rackDropIndex ?? items.length, 0), items.length)
      : drag.source === "tray"
        ? rackPlaceholderIndexForTile(player, hiddenIds, draggedTileId)
        : null;
    if (placeholderIndex !== null) items.splice(placeholderIndex, 0, { type: "placeholder" });
  }

  $("rack-label").textContent = `${player.remainingBag.length} letters left`;
  $("pending-label").textContent = appState.pendingMoves.length ? `${appState.pendingMoves.length} pending` : "";

  tray.innerHTML = items.map(item => item.type === "placeholder"
    ? '<div class="rack-tile rack-placeholder" aria-hidden="true"></div>'
    : renderRackTile(item.tile)).join("");
}

function renderRackTile(tile) {
  return `
    <button class="rack-tile" type="button" data-tile-id="${esc(tile.id)}" aria-label="${esc(tile.letter)} tile, ${tile.value} points">
      <span>${esc(tile.letter)}</span>
      <small>${tile.value}</small>
    </button>
  `;
}

function rackPlaceholderIndexForTile(player, hiddenIds, tileId) {
  let index = 0;
  for (const tile of player.rack) {
    if (tile.id === tileId) return index;
    if (!hiddenIds.has(tile.id)) index += 1;
  }
  return null;
}

function renderPreview() {
  const preview = getPreview();
  const strip = $("preview-strip");
  strip.hidden = !preview.valid;
  strip.classList.toggle("valid", preview.valid);
  strip.classList.toggle("invalid", false);
  strip.innerHTML = `
    <span>${esc(preview.message)}</span>
    <span>${preview.detail ? esc(preview.detail) : ""}</span>
  `;
  $("commit-btn").disabled = !preview.valid || ui.flushing;
}

function getPreview() {
  const player = currentPlayer();
  if (!player) return { valid: false, message: "Choose a name", detail: "" };
  if (!ui.staged.length) return { valid: false, message: "", detail: "" };

  const move = createMove(player.id, ui.staged, Date.now());
  try {
    const validation = validateMove(game, move);
    const words = validation.words.map(word => word.text).join(", ");
    return {
      valid: true,
      validation,
      message: words || "Single tile",
      detail: `+${validation.score}`
    };
  } catch (error) {
    return {
      valid: false,
      message: error instanceof GameRuleError ? error.message : "Move is not valid",
      detail: ""
    };
  }
}

async function enterRoom(nameInput) {
  const roomId = GLOBAL_ROOM_ID;
  const playerName = normalizePlayerName(nameInput);
  if (!playerName) {
    ui.screen = "setup";
    renderAll();
    toast("enter a name");
    return;
  }

  const playerId = appState.session?.playerId || createId();
  ui.syncStatus = "syncing";
  renderAll();

  try {
    const payload = await joinRemoteGame({ roomId, playerId, name: playerName });
    game = createGameState(payload.state);
    appState.session = { roomId, playerId, playerName };
    ui.localOnly = false;
    ui.screen = null;
    save();
    startSync();
    renderAll();
    toast(payload.created ? "joined board" : "saved");
  } catch (error) {
    const base = createGameState(game.id === roomId ? game : { id: roomId });
    const joined = joinGame(base, { playerId, name: playerName });
    game = joined.state;
    appState.session = { roomId, playerId, playerName };
    ui.localOnly = true;
    ui.syncStatus = "local";
    ui.screen = null;
    save();
    renderAll();
    toast(joined.created ? `local board: ${error.message}` : "saved");
  }
}

function startSync() {
  if (!appState.session || ui.localOnly) return;
  sync?.stop();
  sync = new GameSync({
    roomId: appState.session.roomId,
    playerId: appState.session.playerId,
    onState: state => {
      game = createGameState(state);
      pruneStagedTiles();
      save();
      renderAll();
      flushPending();
    },
    onStatus: status => {
      ui.syncStatus = appState.pendingMoves.length && status === "synced" ? "pending" : status;
      renderHud();
      renderPreview();
    },
    onError: error => {
      ui.syncStatus = "offline";
      renderHud();
      if (error?.message) toast(error.message);
    }
  });
  sync.start();
  sync.fetchState().catch(() => {});
  flushPending();
}

async function flushPending() {
  if (ui.localOnly || ui.flushing || !sync || !appState.pendingMoves.length) return;
  ui.flushing = true;
  renderPreview();

  while (appState.pendingMoves.length) {
    const move = appState.pendingMoves[0];
    try {
      const payload = await sync.submitMove(move);
      if (payload.state) game = createGameState(payload.state);
      appState.pendingMoves.shift();
      save();
      renderAll();
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        appState.pendingMoves.shift();
        save();
        toast(error.message || "Move rejected");
        renderAll();
        continue;
      }
      ui.syncStatus = "offline";
      toast("move queued");
      break;
    }
  }

  ui.flushing = false;
  renderAll();
}

async function hardResetBoard() {
  if (ui.resetting) return;
  ui.resetting = true;
  appState.pendingMoves = [];
  ui.staged = [];
  stopDragging();
  renderAll();

  if (ui.localOnly || !sync) {
    game = resetGameState(game);
    save();
    ui.resetting = false;
    renderAll();
    toast("board reset");
    return;
  }

  try {
    const payload = await sync.resetBoard();
    if (payload.state) game = createGameState(payload.state);
    save();
    toast("board reset");
  } catch (error) {
    toast(error.message || "Reset failed");
  } finally {
    ui.resetting = false;
    renderAll();
  }
}

function pruneStagedTiles() {
  const player = currentPlayer();
  if (!player) {
    ui.staged = [];
    return;
  }
  const rackIds = new Set(player.rack.map(tile => tile.id));
  ui.staged = ui.staged.filter(placement => rackIds.has(placement.tileId) && !game.board[hexKey(placement.q, placement.r)]);
}

function commitStaged() {
  const player = currentPlayer();
  if (!player || !ui.staged.length) return;
  const move = createMove(player.id, ui.staged, Date.now());

  try {
    validateMove(game, move);
  } catch (error) {
    toast(error.message || "Move is not valid");
    renderPreview();
    return;
  }

  if (ui.localOnly) {
    try {
      const result = applyMove(game, move);
      game = result.state;
      ui.staged = [];
      save();
      renderAll();
      toast(`played +${result.score}`);
    } catch (error) {
      toast(error.message || "Move rejected");
    }
    return;
  }

  appState.pendingMoves.push(move);
  ui.staged = [];
  save();
  renderAll();
  flushPending();
}

function resetStaged() {
  ui.staged = [];
  stopDragging();
  renderAll();
}

function shuffleRack() {
  const player = currentPlayer();
  if (!player) return;
  for (let index = player.rack.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [player.rack[index], player.rack[swapIndex]] = [player.rack[swapIndex], player.rack[index]];
  }
  save();
  renderAll();
  syncRackOrder();
}

function startDraggingTile(tileId, clientX, clientY, source = "tray", origin = null) {
  const tile = findTile(tileId);
  if (!tile) return;

  ui.dragging = {
    tileId,
    source,
    origin,
    startX: clientX,
    startY: clientY,
    moved: false,
    x: clientX,
    y: clientY,
    valid: false,
    overRack: false,
    rackDropIndex: null
  };
  updateDrag(clientX, clientY);
  renderTray();
}

function updateDrag(clientX, clientY) {
  if (!ui.dragging) return;
  const wasMoved = ui.dragging.moved;
  const wasOverRack = ui.dragging.overRack;
  const previousRackDropIndex = ui.dragging.rackDropIndex;
  if (Math.hypot(clientX - ui.dragging.startX, clientY - ui.dragging.startY) > 8) {
    ui.dragging.moved = true;
  }
  ui.dragging.x = clientX;
  ui.dragging.y = clientY;
  const hex = hexFromClient(clientX, clientY);
  const rackIndex = rackDropIndexFromClient(clientX, clientY);
  ui.dragging.overRack = rackIndex !== null;
  ui.dragging.rackDropIndex = rackIndex;
  ui.hoverHex = hex;
  ui.dragging.valid = Boolean((hex && canStageAt(hex, ui.dragging.tileId)) || rackIndex !== null);
  if (
    (ui.dragging.source === "tray" || ui.dragging.source === "board") &&
    (wasMoved !== ui.dragging.moved || wasOverRack !== ui.dragging.overRack || previousRackDropIndex !== rackIndex)
  ) {
    renderTray();
  }
  updateGhost();
  scheduleDraw();
}

function finishDrag() {
  if (!ui.dragging) return;
  const { tileId, origin, source, moved } = ui.dragging;
  const target = ui.hoverHex;
  const rackIndex = rackDropIndexFromClient(ui.dragging.x, ui.dragging.y);

  if (target && canStageAt(target, tileId)) {
    ui.staged.push({ q: target.q, r: target.r, tileId });
  } else if ((source === "tray" || source === "board") && moved && rackIndex !== null) {
    reorderRackTile(tileId, rackIndex);
  } else if (origin) {
    ui.staged.push({ ...origin, tileId });
  }

  stopDragging();
  renderAll();
}

function stopDragging() {
  ui.dragging = null;
  ui.hoverHex = null;
  $("drag-ghost").hidden = true;
}

function findTile(tileId) {
  const player = currentPlayer();
  return player?.rack.find(tile => tile.id === tileId) || null;
}

function canStageAt(hex, tileId) {
  if (!isWithinBounds(hex, game.bounds)) return false;
  const key = hexKey(hex.q, hex.r);
  if (game.board[key]) return false;
  return !ui.staged.some(placement => placement.tileId !== tileId && hexKey(placement.q, placement.r) === key);
}

function rackDropIndexFromClient(clientX, clientY) {
  const tray = $("tile-tray");
  const trayRect = tray.getBoundingClientRect();
  if (
    clientX < trayRect.left - 20 ||
    clientX > trayRect.right + 20 ||
    clientY < trayRect.top - 20 ||
    clientY > trayRect.bottom + 20
  ) {
    return null;
  }

  const entries = [...tray.querySelectorAll(".rack-tile:not(.rack-placeholder)")]
    .map(element => ({ element, rect: element.getBoundingClientRect() }))
    .sort((left, right) => Math.abs(left.rect.top - right.rect.top) > 8
      ? left.rect.top - right.rect.top
      : left.rect.left - right.rect.left);

  if (!entries.length) return 0;

  const rows = [];
  for (const entry of entries) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.top - entry.rect.top) <= 8) {
      row.items.push(entry);
      row.bottom = Math.max(row.bottom, entry.rect.bottom);
    } else {
      rows.push({ top: entry.rect.top, bottom: entry.rect.bottom, items: [entry] });
    }
  }

  let start = 0;
  for (const row of rows) {
    row.start = start;
    start += row.items.length;
  }

  const row = rows.reduce((closest, candidate) => {
    const center = candidate.top + (candidate.bottom - candidate.top) / 2;
    const distance = Math.abs(clientY - center);
    return distance < closest.distance ? { row: candidate, distance } : closest;
  }, { row: rows[0], distance: Infinity }).row;
  const column = row.items.findIndex(entry => clientX < entry.rect.left + entry.rect.width / 2);
  return row.start + (column >= 0 ? column : row.items.length);
}

function reorderRackTile(tileId, visibleIndex) {
  const player = currentPlayer();
  if (!player) return false;

  const hiddenIds = activeTileIds();
  const visibleIds = player.rack.filter(tile => tile.id !== tileId && !hiddenIds.has(tile.id)).map(tile => tile.id);
  const targetId = visibleIds[visibleIndex] || "";
  if (targetId === tileId) return false;

  const currentIndex = player.rack.findIndex(tile => tile.id === tileId);
  if (currentIndex < 0) return false;

  const [tile] = player.rack.splice(currentIndex, 1);

  if (targetId) {
    const insertIndex = player.rack.findIndex(candidate => candidate.id === targetId);
    player.rack.splice(insertIndex >= 0 ? insertIndex : player.rack.length, 0, tile);
  } else {
    const visibleAfter = player.rack.filter(candidate => !hiddenIds.has(candidate.id));
    const lastVisible = visibleAfter[visibleAfter.length - 1];
    const insertIndex = lastVisible ? player.rack.findIndex(candidate => candidate.id === lastVisible.id) + 1 : player.rack.length;
    player.rack.splice(insertIndex, 0, tile);
  }

  save();
  syncRackOrder();
  return true;
}

function syncRackOrder() {
  const player = currentPlayer();
  if (!player || ui.localOnly || !sync) return;
  sync.reorderRack(player.rack.map(tile => tile.id)).catch(error => {
    toast(error.message || "Rack order not saved");
  });
}

function updateGhost() {
  const ghost = $("drag-ghost");
  const tile = findTile(ui.dragging?.tileId);
  if (!ui.dragging || !tile) {
    ghost.hidden = true;
    return;
  }
  ghost.hidden = false;
  ghost.classList.toggle("invalid", !ui.dragging.valid);
  ghost.innerHTML = `<span>${esc(tile.letter)}</span><small>${tile.value}</small>`;
  ghost.style.transform = `translate(${ui.dragging.x - 26}px, ${ui.dragging.y - 30}px)`;
}

function scheduleDraw() {
  if (ui.drawQueued) return;
  ui.drawQueued = true;
  requestAnimationFrame(() => {
    ui.drawQueued = false;
    drawBoard();
  });
}

function queueResizeCanvas() {
  if (ui.resizeQueued) return;
  ui.resizeQueued = true;
  requestAnimationFrame(() => {
    ui.resizeQueued = false;
    resizeCanvas();
  });
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = window.devicePixelRatio || 1;
  const wasZeroSized = ui.canvasSize.width === 0 || ui.canvasSize.height === 0;
  ui.canvasSize = { width: rect.width, height: rect.height };
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!appState.camera || wasZeroSized) {
    ui.camera.x = rect.width / 2;
    ui.camera.y = rect.height / 2;
    ui.camera.scale = Math.min(1.05, Math.max(0.72, rect.width / 460));
  }

  scheduleDraw();
}

function drawBoard() {
  const { width, height } = ui.canvasSize;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfff8";
  ctx.fillRect(0, 0, width, height);

  const preview = getPreview();
  const previewKeys = new Set(preview.validation?.words.flatMap(word => word.keys) || []);
  const draftBoard = preview.validation?.draftBoard || boardWithStaged();

  ctx.save();
  ctx.translate(ui.camera.x, ui.camera.y);
  ctx.scale(ui.camera.scale, ui.camera.scale);

  drawGrid(previewKeys);
  drawCells(draftBoard, previewKeys);

  if (ui.hoverHex && (!ui.dragging || ui.dragging.valid)) {
    drawHex(ui.hoverHex, {
      fill: "rgba(139, 0, 0, 0.08)",
      stroke: "#8b0000",
      lineWidth: 1.4
    });
  }

  ctx.restore();
}

function drawGrid(previewKeys) {
  const bounds = game.bounds;
  for (let q = bounds.minQ; q <= bounds.maxQ; q += 1) {
    for (let r = bounds.minR; r <= bounds.maxR; r += 1) {
      const hex = { q, r };
      if (!isWithinBounds(hex, bounds)) continue;
      const point = hexToPixel(hex);
      const screen = worldToScreen(point);
      if (screen.x < -60 || screen.x > ui.canvasSize.width + 60 || screen.y < -60 || screen.y > ui.canvasSize.height + 60) {
        continue;
      }
      const key = hexKey(q, r);
      drawHex(hex, {
        fill: previewKeys.has(key) ? "rgba(35, 122, 59, 0.08)" : "rgba(255, 255, 255, 0.5)",
        stroke: previewKeys.has(key) ? "rgba(35, 122, 59, 0.42)" : "rgba(17, 17, 17, 0.18)",
        lineWidth: 1
      });
    }
  }
}

function drawCells(board, previewKeys) {
  const cells = Object.values(board).sort((left, right) => left.timestamp - right.timestamp);
  for (const cell of cells) {
    const staged = ui.staged.some(placement => placement.tileId === cell.tileId);
    drawTileCell(cell, { staged, highlighted: previewKeys.has(hexKey(cell.q, cell.r)) });
  }
}

function drawTileCell(cell, options = {}) {
  const color = tileOwnerColor(cell.playerId);
  const fill = options.staged ? "#fffffc" : colorToRgba(color, options.highlighted ? 0.18 : 0.11);
  const stroke = color;
  const point = hexToPixel(cell);

  ctx.save();
  if (options.staged) {
    ctx.shadowColor = "rgba(17, 17, 17, 0.16)";
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
  }
  drawHexPath(point.x, point.y, HEX_SIZE * 0.88);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = options.staged ? 2 : 1.4;
  ctx.stroke();

  ctx.fillStyle = "#111";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "600 28px 'Crimson Pro', Georgia, serif";
  ctx.fillText(cell.letter, point.x, point.y - 1);
  ctx.fillStyle = "rgba(17, 17, 17, 0.62)";
  ctx.font = "10px 'SF Mono', Menlo, monospace";
  ctx.fillText(String(cell.value), point.x, point.y + 18);
  ctx.restore();
}

function drawHex(hex, { fill, stroke, lineWidth }) {
  const point = hexToPixel(hex);
  drawHexPath(point.x, point.y, HEX_SIZE * 0.9);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth / ui.camera.scale;
  ctx.stroke();
}

function drawHexPath(x, y, radius) {
  ctx.beginPath();
  for (let index = 0; index < 6; index += 1) {
    const angle = Math.PI / 180 * (60 * index - 30);
    const px = x + radius * Math.cos(angle);
    const py = y + radius * Math.sin(angle);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function boardWithStaged() {
  const player = currentPlayer();
  if (!player || !ui.staged.length) return game.board;
  const tilesById = new Map(player.rack.map(tile => [tile.id, tile]));
  const move = createMove(player.id, ui.staged, Date.now());
  return boardWithPlacements(game.board, ui.staged, player, tilesById, move);
}

function tileOwnerColor(playerId) {
  return playerId && playerId === appState.session?.playerId ? CURRENT_PLAYER_COLOR : OTHER_PLAYER_COLOR;
}

function colorToRgba(hex, alpha) {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexToPixel(hex) {
  return {
    x: HEX_SIZE * SQRT3 * (hex.q + hex.r / 2),
    y: HEX_SIZE * 1.5 * hex.r
  };
}

function pixelToHex(point) {
  const q = (SQRT3 / 3 * point.x - 1 / 3 * point.y) / HEX_SIZE;
  const r = (2 / 3 * point.y) / HEX_SIZE;
  return roundHex(q, r);
}

function roundHex(q, r) {
  let x = q;
  let z = r;
  let y = -x - z;
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  return { q: rx, r: rz };
}

function screenToWorld(point) {
  return {
    x: (point.x - ui.camera.x) / ui.camera.scale,
    y: (point.y - ui.camera.y) / ui.camera.scale
  };
}

function worldToScreen(point) {
  return {
    x: point.x * ui.camera.scale + ui.camera.x,
    y: point.y * ui.camera.scale + ui.camera.y
  };
}

function canvasPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function hexFromClient(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
  return pixelToHex(screenToWorld(canvasPoint(clientX, clientY)));
}

function stagedAtClient(clientX, clientY) {
  const hex = hexFromClient(clientX, clientY);
  if (!hex) return -1;
  return ui.staged.findIndex(placement => placement.q === hex.q && placement.r === hex.r);
}

function clampCamera() {
  ui.camera.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, ui.camera.scale));
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function midpoint(left, right) {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function updateTouchGesture() {
  const touches = [...ui.pointers.values()].filter(pointer => pointer.type === "touch");
  if (touches.length < 2) return;
  const [first, second] = touches;
  const mid = midpoint(first, second);
  const dist = distance(first, second);

  if (!ui.gesture) {
    ui.gesture = {
      startMid: mid,
      startDistance: dist || 1,
      camera: { ...ui.camera }
    };
    return;
  }

  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, ui.gesture.camera.scale * (dist / ui.gesture.startDistance)));
  const worldAtStart = {
    x: (ui.gesture.startMid.x - ui.gesture.camera.x) / ui.gesture.camera.scale,
    y: (ui.gesture.startMid.y - ui.gesture.camera.y) / ui.gesture.camera.scale
  };
  ui.camera.scale = scale;
  ui.camera.x = mid.x - worldAtStart.x * scale;
  ui.camera.y = mid.y - worldAtStart.y * scale;
  save();
  scheduleDraw();
}

function wireEvents() {
  window.addEventListener("keydown", event => {
    if (!isHardResetHotkey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    hardResetBoard();
  }, true);

  $("setup-screen").addEventListener("click", event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;

    if (action === "copy-account-link") {
      const link = getAccountLink($("setup-name")?.value || appState.session?.playerName || "");
      const input = $("account-link");
      if (input) input.value = link;
      copyText(link)
        .then(() => toast("copied"))
        .catch(() => toast("copy failed"));
      return;
    }

    if (action === "close-setup") {
      if (!appState.session) return;
      ui.screen = null;
      startSync();
      renderAll();
      return;
    }

    if (action === "join-board") {
      enterRoom($("setup-name").value);
    }
  });

  $("setup-screen").addEventListener("keydown", event => {
    if (event.key === "Enter" && event.target.id === "setup-name") {
      enterRoom($("setup-name").value);
    }
  });

  $("setup-screen").addEventListener("input", event => {
    if (event.target.id !== "setup-name") return;
    const accountLink = $("account-link");
    if (accountLink) accountLink.value = getAccountLink(event.target.value);
  });

  $("room-line").addEventListener("click", event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "open-leaderboard") {
      ui.leaderboardOpen = true;
      ui.historyOpen = false;
      renderAll();
    }

    if (action === "open-history") {
      ui.historyOpen = true;
      ui.leaderboardOpen = false;
      renderAll();
    }
  });

  $("leaderboard-screen").addEventListener("click", event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "close-leaderboard" || event.target.id === "leaderboard-screen") {
      ui.leaderboardOpen = false;
      renderAll();
    }
  });

  $("history-screen").addEventListener("click", event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "close-history" || event.target.id === "history-screen") {
      ui.historyOpen = false;
      renderAll();
    }
  });

  $("switch-session-btn").addEventListener("click", () => {
    sync?.stop();
    ui.screen = "setup";
    ui.leaderboardOpen = false;
    ui.historyOpen = false;
    renderAll();
  });

  $("commit-btn").addEventListener("click", commitStaged);
  $("reset-btn").addEventListener("click", resetStaged);
  $("shuffle-btn").addEventListener("click", shuffleRack);

  $("tile-tray").addEventListener("pointerdown", event => {
    const tile = event.target.closest("[data-tile-id]");
    if (!tile) return;
    event.preventDefault();
    tile.setPointerCapture?.(event.pointerId);
    startDraggingTile(tile.dataset.tileId, event.clientX, event.clientY, "tray");
  });

  canvas.addEventListener("pointerdown", event => {
    canvas.setPointerCapture?.(event.pointerId);
    ui.pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY, type: event.pointerType });

    if (event.pointerType === "touch" && ui.pointers.size >= 2) {
      ui.pan = null;
      updateTouchGesture();
      return;
    }

    const stagedIndex = stagedAtClient(event.clientX, event.clientY);
    if (stagedIndex >= 0) {
      event.preventDefault();
      const [placement] = ui.staged.splice(stagedIndex, 1);
      startDraggingTile(placement.tileId, event.clientX, event.clientY, "board", { q: placement.q, r: placement.r });
      return;
    }

    ui.pan = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      camera: { ...ui.camera }
    };
  });

  canvas.addEventListener("pointermove", event => {
    if (ui.dragging) {
      updateDrag(event.clientX, event.clientY);
      return;
    }

    if (ui.pointers.has(event.pointerId)) {
      ui.pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY, type: event.pointerType });
    }

    if (event.pointerType === "touch" && ui.pointers.size >= 2) {
      ui.pan = null;
      updateTouchGesture();
      return;
    }

    if (ui.pan?.pointerId === event.pointerId) {
      ui.camera.x = ui.pan.camera.x + (event.clientX - ui.pan.x);
      ui.camera.y = ui.pan.camera.y + (event.clientY - ui.pan.y);
      save();
      scheduleDraw();
    }
  });

  canvas.addEventListener("pointerup", event => {
    ui.pointers.delete(event.pointerId);
    if (ui.dragging) finishDrag();
    if (ui.pan?.pointerId === event.pointerId) ui.pan = null;
    if (ui.pointers.size < 2) ui.gesture = null;
  });

  canvas.addEventListener("pointercancel", event => {
    ui.pointers.delete(event.pointerId);
    if (ui.dragging) finishDrag();
    if (ui.pan?.pointerId === event.pointerId) ui.pan = null;
    if (ui.pointers.size < 2) ui.gesture = null;
  });

  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const point = canvasPoint(event.clientX, event.clientY);
    const before = screenToWorld(point);
    const factor = Math.exp(-event.deltaY * 0.001);
    ui.camera.scale *= factor;
    clampCamera();
    ui.camera.x = point.x - before.x * ui.camera.scale;
    ui.camera.y = point.y - before.y * ui.camera.scale;
    save();
    scheduleDraw();
  }, { passive: false });

  window.addEventListener("pointermove", event => {
    if (ui.dragging) updateDrag(event.clientX, event.clientY);
  });

  window.addEventListener("pointerup", () => {
    if (ui.dragging) finishDrag();
  });

  window.addEventListener("resize", resizeCanvas);
}

function isHardResetHotkey(event) {
  const isR = event.code === "KeyR" || event.key?.toLowerCase() === "r";
  const hasCommandChord = event.metaKey || event.ctrlKey;

  return (
    !event.repeat &&
    isR &&
    event.shiftKey &&
    event.altKey &&
    (hasCommandChord || !event.target?.matches?.("input, textarea, select, [contenteditable='true']"))
  );
}

wireEvents();
renderAll();
if (appState.session?.playerName) {
  enterRoom(appState.session.playerName);
}
