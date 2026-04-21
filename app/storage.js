import { GLOBAL_ROOM_ID, createDeviceId, createGameState, normalizeRoomId } from "./model.js";

export const STATE_STORAGE_KEY = "hexabloom_v1";
export const SCHEMA_VERSION = 3;

export function loadAppState() {
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    if (raw) return normalizeStoredState(JSON.parse(raw));
  } catch {
    // Fall through to first-run state.
  }

  return createInitialState();
}

export function saveAppState(state) {
  try {
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      deviceId: state.deviceId,
      session: state.session || null,
      activeGameId: normalizeRoomId(state.activeGameId),
      linkedGameId: normalizeRoomId(state.linkedGameId),
      games: normalizeGames(state.games),
      pendingMovesByGame: normalizePendingMovesByGame(state.pendingMovesByGame),
      camerasByGame: normalizeCamerasByGame(state.camerasByGame),
      lastSeenByGame: normalizeLastSeenByGame(state.lastSeenByGame)
    }));
  } catch {
    // Local storage can fail in private windows or quota pressure.
  }
}

export function createInitialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: createDeviceId(),
    session: null,
    activeGameId: null,
    linkedGameId: null,
    games: {},
    pendingMovesByGame: {},
    camerasByGame: {},
    lastSeenByGame: {}
  };
}

export function normalizeStoredState(input = {}) {
  const games = normalizeGames(input.games);
  const legacyGame = input.game ? createGameState(input.game) : null;
  if (legacyGame?.id && !games[legacyGame.id]) games[legacyGame.id] = legacyGame;

  const activeGameId = normalizeRoomId(input.activeGameId)
    || normalizeRoomId(input.session?.roomId)
    || legacyGame?.id
    || null;
  const linkedGameId = normalizeRoomId(input.linkedGameId);
  const pendingMovesByGame = normalizePendingMovesByGame(input.pendingMovesByGame);
  if (Array.isArray(input.pendingMoves) && activeGameId && !pendingMovesByGame[activeGameId]) {
    pendingMovesByGame[activeGameId] = input.pendingMoves.filter(isQueuedMove);
  }

  const camerasByGame = normalizeCamerasByGame(input.camerasByGame);
  const legacyCamera = normalizeCamera(input.camera);
  if (legacyCamera && activeGameId && !camerasByGame[activeGameId]) {
    camerasByGame[activeGameId] = legacyCamera;
  }
  const lastSeenByGame = normalizeLastSeenByGame(input.lastSeenByGame);
  for (const [id, game] of Object.entries(games)) {
    if (!lastSeenByGame[id]) lastSeenByGame[id] = game.updatedAt;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: typeof input.deviceId === "string" && input.deviceId ? input.deviceId : createDeviceId(),
    session: normalizeSession(input.session),
    activeGameId,
    linkedGameId,
    games,
    pendingMovesByGame,
    camerasByGame,
    lastSeenByGame
  };
}

export function loadSettings() {
  return {
    apiBaseUrl: getConfiguredApiBaseUrl() || getDefaultApiBaseUrl()
  };
}

function normalizeSession(input = {}) {
  if (!input || typeof input !== "object") return null;
  const playerId = typeof input.playerId === "string" ? input.playerId : "";
  const playerName = typeof input.playerName === "string" ? input.playerName : "";
  if (!playerId) return null;
  return { roomId: normalizeRoomId(input.roomId) || GLOBAL_ROOM_ID, playerId, playerName };
}

function normalizeGames(input = {}) {
  const games = {};
  if (!input || typeof input !== "object") return games;

  for (const [key, value] of Object.entries(input)) {
    const id = normalizeRoomId(value?.id || key);
    if (!id) continue;
    const source = value && typeof value === "object" ? value : {};
    games[id] = createGameState({ ...source, id });
  }

  return games;
}

function normalizePendingMovesByGame(input = {}) {
  const movesByGame = {};
  if (!input || typeof input !== "object") return movesByGame;

  for (const [key, moves] of Object.entries(input)) {
    const id = normalizeRoomId(key);
    if (!id || !Array.isArray(moves)) continue;
    movesByGame[id] = moves.filter(isQueuedMove);
  }

  return movesByGame;
}

function normalizeCamerasByGame(input = {}) {
  const cameras = {};
  if (!input || typeof input !== "object") return cameras;

  for (const [key, camera] of Object.entries(input)) {
    const id = normalizeRoomId(key);
    const normalized = normalizeCamera(camera);
    if (id && normalized) cameras[id] = normalized;
  }

  return cameras;
}

function normalizeLastSeenByGame(input = {}) {
  const lastSeen = {};
  if (!input || typeof input !== "object") return lastSeen;

  for (const [key, value] of Object.entries(input)) {
    const id = normalizeRoomId(key);
    if (!id || typeof value !== "string" || Number.isNaN(Date.parse(value))) continue;
    lastSeen[id] = value;
  }

  return lastSeen;
}

function normalizeCamera(input = {}) {
  if (!input || typeof input !== "object") return null;
  const x = Number(input.x);
  const y = Number(input.y);
  const scale = Number(input.scale);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return null;
  return {
    x,
    y,
    scale: Math.min(2.4, Math.max(0.55, scale))
  };
}

function isQueuedMove(move) {
  return Boolean(
    move &&
    typeof move.id === "string" &&
    typeof move.playerId === "string" &&
    Array.isArray(move.placements) &&
    Number.isFinite(Number(move.timestamp))
  );
}

function getDefaultApiBaseUrl() {
  const host = globalThis.location?.hostname || "";
  const protocol = globalThis.location?.protocol || "";

  if (protocol === "file:" || !host) {
    return "http://localhost:8799";
  }

  if (isLocalDevHost(host)) {
    return `${protocol === "https:" ? "https:" : "http:"}//${host}:8799`;
  }

  return "";
}

function getConfiguredApiBaseUrl() {
  const value = globalThis.HEXABLOOM_CONFIG?.apiBaseUrl;
  if (typeof value !== "string") return "";
  if (value.includes("YOUR_")) return "";
  return value.trim().replace(/\/+$/, "");
}

function isLocalDevHost(hostname = "") {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".local") ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  );
}
