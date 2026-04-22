import { GLOBAL_ROOM_ID, createGameState, normalizeRoomId } from "./model.js";
import { loadSettings } from "./storage.js";

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;

export class GameSync {
  constructor({ roomId = GLOBAL_ROOM_ID, playerId, onState, onStatus, onError }) {
    this.roomId = normalizeRoomId(roomId) || GLOBAL_ROOM_ID;
    this.playerId = playerId;
    this.onState = onState;
    this.onStatus = onStatus;
    this.onError = onError;
    this.settings = loadSettings();
    this.socket = null;
    this.retryTimer = null;
    this.retryDelay = RETRY_MIN_MS;
    this.stopped = false;
    this.status = "idle";
  }

  start() {
    if (!this.settings.apiBaseUrl) {
      this.setStatus("offline");
      return;
    }

    this.stopped = false;
    this.connect();
    globalThis.addEventListener?.("online", () => this.connect());
    globalThis.addEventListener?.("offline", () => this.setStatus("offline"));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  connect() {
    if (
      this.stopped ||
      !this.settings.apiBaseUrl ||
      this.socket?.readyState === WebSocket.CONNECTING ||
      this.socket?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    clearTimeout(this.retryTimer);
    this.setStatus("syncing");

    try {
      this.socket = new WebSocket(getWebSocketUrl(this.settings.apiBaseUrl, this.roomId));
    } catch (error) {
      this.onError?.(error);
      this.setStatus("offline");
      this.scheduleReconnect();
      return;
    }

    this.socket.addEventListener("open", () => {
      this.retryDelay = RETRY_MIN_MS;
      this.setStatus("synced");
      this.send({ type: "sync", playerId: this.playerId });
    });

    this.socket.addEventListener("message", event => {
      this.handleMessage(event.data);
    });

    this.socket.addEventListener("close", () => {
      this.socket = null;
      if (this.stopped) return;
      this.setStatus("offline");
      this.scheduleReconnect();
    });

    this.socket.addEventListener("error", () => {
      this.socket?.close();
    });
  }

  async fetchState() {
    this.setStatus("syncing");
    const response = await fetch(getGameEndpoint(this.settings.apiBaseUrl, this.roomId, "/state"));
    if (!response.ok) throw await responseError(response);
    const payload = await response.json();
    this.handleStatePayload(payload);
    this.setStatus("synced");
    return payload;
  }

  async submitMove(move) {
    this.setStatus("syncing");
    const response = await fetch(getGameEndpoint(this.settings.apiBaseUrl, this.roomId, "/move"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ move })
    });

    if (!response.ok) throw await responseError(response);
    const payload = await response.json();
    this.handleStatePayload(payload);
    this.setStatus("synced");
    return payload;
  }

  async resetBoard() {
    this.setStatus("syncing");
    const response = await fetch(getGameEndpoint(this.settings.apiBaseUrl, this.roomId, "/reset"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: this.playerId })
    });

    if (!response.ok) throw await responseError(response);
    const payload = await response.json();
    this.handleStatePayload(payload);
    this.setStatus("synced");
    return payload;
  }

  async reorderRack(tileIds) {
    this.setStatus("syncing");
    const response = await fetch(getGameEndpoint(this.settings.apiBaseUrl, this.roomId, "/rack"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: this.playerId, tileIds })
    });

    if (!response.ok) throw await responseError(response);
    const payload = await response.json();
    this.handleStatePayload(payload);
    this.setStatus("synced");
    return payload;
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === "state" && message.state) {
      this.handleStatePayload(message);
      this.setStatus("synced");
      return;
    }

    if (message.type === "error") {
      this.onError?.(new Error(message.message || "Sync error"));
      this.setStatus("offline");
    }
  }

  handleStatePayload(payload) {
    const state = payload.state || payload.game || payload;
    if (state?.board && state?.players) {
      this.onState?.(createGameState(state), payload);
    }
  }

  send(message) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  setStatus(status) {
    this.status = status;
    this.onStatus?.(status);
  }

  scheduleReconnect() {
    if (this.stopped || !this.settings.apiBaseUrl || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 1.6, RETRY_MAX_MS);
      this.connect();
    }, this.retryDelay);
  }
}

export async function joinRemoteGame({ roomId = GLOBAL_ROOM_ID, playerId, name, tileBagCount, invites = [] }, settings = loadSettings()) {
  const response = await fetch(getGameEndpoint(settings.apiBaseUrl, roomId, "/join"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId, name, tileBagCount, invites })
  });

  if (!response.ok) throw await responseError(response);
  const payload = await response.json();
  return {
    ...payload,
    state: createGameState(payload.state)
  };
}

export async function remoteGameExists(roomId, settings = loadSettings()) {
  if (!settings.apiBaseUrl) return false;
  const response = await fetch(getGameEndpoint(settings.apiBaseUrl, roomId, "/exists"));
  if (!response.ok) throw await responseError(response);
  const payload = await response.json();
  return Boolean(payload.exists);
}

export async function fetchRemoteGameState(roomId, settings = loadSettings()) {
  const response = await fetch(getGameEndpoint(settings.apiBaseUrl, roomId, "/state"));
  if (!response.ok) throw await responseError(response);
  const payload = await response.json();
  return createGameState(payload.state || payload.game || payload);
}

export async function fetchPlayerGameRefs(playerId, settings = loadSettings()) {
  if (!settings.apiBaseUrl || !playerId) return { games: [] };
  let response = await fetch(getPlayerEndpoint(settings.apiBaseUrl, playerId, "/games"));
  if (response.status === 404) {
    response = await fetch(getPlayerEndpoint(settings.apiBaseUrl, playerId, "/invites"));
  }
  if (!response.ok) throw await responseError(response);
  const payload = await response.json();
  return {
    games: Array.isArray(payload.games) ? payload.games : Array.isArray(payload.invites) ? payload.invites : []
  };
}

function getEndpoint(apiBaseUrl, path) {
  const base = apiBaseUrl.replace(/\/+$/, "");
  return new URL(path, `${base}/`).toString();
}

function getPlayerEndpoint(apiBaseUrl, playerId, path) {
  return getEndpoint(apiBaseUrl, `/player/${encodeURIComponent(String(playerId || ""))}${path}`);
}

function getGameEndpoint(apiBaseUrl, roomId, path) {
  const normalized = normalizeRoomId(roomId) || GLOBAL_ROOM_ID;
  const prefix = normalized === GLOBAL_ROOM_ID
    ? "/game"
    : `/game/${encodeURIComponent(normalized)}`;
  return getEndpoint(apiBaseUrl, `${prefix}${path}`);
}

function getWebSocketUrl(apiBaseUrl, roomId) {
  const normalized = normalizeRoomId(roomId) || GLOBAL_ROOM_ID;
  const path = normalized === GLOBAL_ROOM_ID
    ? "/game/stream"
    : `/game/${encodeURIComponent(normalized)}/stream`;
  const url = new URL(path, `${apiBaseUrl.replace(/\/+$/, "")}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function responseError(response) {
  let message = response.statusText || "Request failed";
  try {
    const payload = await response.json();
    if (payload?.error) message = payload.error;
  } catch {
    // Keep the status text.
  }
  const error = new Error(message);
  error.status = response.status;
  return error;
}
