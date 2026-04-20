import { GLOBAL_ROOM_ID, createDeviceId, createGameState } from "./model.js";

export const STATE_STORAGE_KEY = "hexabloom_v1";
export const SCHEMA_VERSION = 1;

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
      game: state.game || null,
      pendingMoves: Array.isArray(state.pendingMoves) ? state.pendingMoves : [],
      camera: state.camera || null
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
    game: null,
    pendingMoves: [],
    camera: null
  };
}

export function normalizeStoredState(input = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId: typeof input.deviceId === "string" && input.deviceId ? input.deviceId : createDeviceId(),
    session: normalizeSession(input.session),
    game: input.game ? createGameState(input.game) : null,
    pendingMoves: Array.isArray(input.pendingMoves) ? input.pendingMoves.filter(isQueuedMove) : [],
    camera: normalizeCamera(input.camera)
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
  return { roomId: GLOBAL_ROOM_ID, playerId, playerName };
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
