import { GLOBAL_ROOM_ID, createGameState } from "./model.js";
import { loadSettings } from "./storage.js";

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;

export class GameSync {
  constructor({ playerId, onState, onStatus, onError }) {
    this.roomId = GLOBAL_ROOM_ID;
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
    const response = await fetch(getGameEndpoint(this.settings.apiBaseUrl, "/state"));
    if (!response.ok) throw await responseError(response);
    const payload = await response.json();
    this.handleStatePayload(payload);
    this.setStatus("synced");
    return payload;
  }

  async submitMove(move) {
    this.setStatus("syncing");
    const response = await fetch(getGameEndpoint(this.settings.apiBaseUrl, "/move"), {
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
    const response = await fetch(getGameEndpoint(this.settings.apiBaseUrl, "/reset"), {
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
    const response = await fetch(getGameEndpoint(this.settings.apiBaseUrl, "/rack"), {
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

export async function joinRemoteGame({ playerId, name }, settings = loadSettings()) {
  const response = await fetch(getGameEndpoint(settings.apiBaseUrl, "/join"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId, name })
  });

  if (!response.ok) throw await responseError(response);
  const payload = await response.json();
  return {
    ...payload,
    state: createGameState(payload.state)
  };
}

function getEndpoint(apiBaseUrl, path) {
  const base = apiBaseUrl.replace(/\/+$/, "");
  return new URL(path, `${base}/`).toString();
}

function getGameEndpoint(apiBaseUrl, path) {
  return getEndpoint(apiBaseUrl, `/game${path}`);
}

function getWebSocketUrl(apiBaseUrl) {
  const url = new URL("/game/stream", `${apiBaseUrl.replace(/\/+$/, "")}/`);
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
