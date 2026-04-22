import { GLOBAL_ROOM_ID, GameRuleError, RACK_SIZE, applyMove, createGameState, joinGame, normalizePlayerName, normalizeRoomId, normalizeWord, resetGameState } from "../../../app/model.js";
import { DICTIONARY_WORDS } from "./dictionary.generated.js";

const MOVE_VALIDATION = {
  isWordAllowed: word => DICTIONARY_WORDS.has(normalizeWord(word))
};

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.game = null;
    this.hasStoredGame = false;
    this.ready = this.initialize();
  }

  async initialize() {
    const storedGame = await this.state.storage.get("game") || {};
    this.hasStoredGame = Boolean(storedGame?.id);
    this.game = createGameState(storedGame);
    if (hasOversizedRacks(storedGame)) await this.save();
  }

  async fetch(request) {
    await this.ready;
    const cors = corsHeaders(request, this.env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!isAllowedOrigin(request, this.env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    const route = parseGameRoute(new URL(request.url).pathname);
    if (!route) return json({ error: "Not found" }, 404, cors);

    try {
      if (route.action === "join" && request.method === "POST") {
        return await this.join(request, route.roomId, cors);
      }

      if (route.action === "move" && request.method === "POST") {
        return await this.move(request, route.roomId, cors);
      }

      if (route.action === "reset" && request.method === "POST") {
        return await this.reset(request, route.roomId, cors);
      }

      if (route.action === "rack" && request.method === "POST") {
        return await this.reorderRack(request, route.roomId, cors);
      }

      if (route.action === "state" && request.method === "GET") {
        this.ensureRoom(route.roomId);
        return json({ state: this.game }, 200, cors);
      }

      if (route.action === "exists" && request.method === "GET") {
        return json({ exists: this.gameExists(route.roomId) }, 200, cors);
      }

      if (route.action === "stream" && request.method === "GET") {
        this.ensureRoom(route.roomId);
        return this.stream(request);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      return json({ error: messageFromError(error) }, error?.status || 400, cors);
    }
  }

  async join(request, roomId, cors) {
    const body = await readJson(request);
    this.ensureRoom(roomId, body);
    const joined = joinGame(this.game, {
      playerId: body.playerId,
      name: body.name
    });
    this.game = joined.state;
    const invited = [];
    for (const invite of normalizeInvites(body.invites)) {
      if (invite.playerId === joined.player.id) continue;
      const result = joinGame(this.game, invite);
      this.game = result.state;
      invited.push(result.player);
    }
    await this.save();
    await rememberGameMemberships(this.env, this.game, [joined.player, ...invited], invited, joined.player);
    this.broadcast(null, { type: "state", state: this.game });
    return json({ state: this.game, player: joined.player, invited, created: joined.created }, 200, cors);
  }

  async move(request, roomId, cors) {
    this.ensureRoom(roomId);
    const body = await readJson(request);
    const result = applyMove(this.game, body.move || body, MOVE_VALIDATION);
    this.game = result.state;
    await this.save();
    this.broadcast(null, { type: "state", state: this.game, move: result.move });
    return json({
      accepted: result.accepted,
      duplicate: result.duplicate,
      state: this.game,
      move: result.move,
      score: result.score || result.move?.score || 0,
      words: result.words || result.move?.words || []
    }, 200, cors);
  }

  async reset(request, roomId, cors) {
    this.ensureRoom(roomId);
    await readJson(request).catch(() => ({}));
    this.game = resetGameState(this.game);
    await this.save();
    this.broadcast(null, { type: "state", state: this.game, reset: true });
    return json({ state: this.game, reset: true }, 200, cors);
  }

  async reorderRack(request, roomId, cors) {
    this.ensureRoom(roomId);
    const body = await readJson(request);
    const player = this.game.players[String(body.playerId || "")];
    if (!player) throw new GameRuleError("Player is not in this board");

    const tileIds = Array.isArray(body.tileIds) ? body.tileIds.map(String) : [];
    const currentIds = player.rack.map(tile => tile.id);
    if (!sameStringSet(tileIds, currentIds)) {
      throw new GameRuleError("Rack order does not match your current tiles");
    }

    const tilesById = new Map(player.rack.map(tile => [tile.id, tile]));
    player.rack = tileIds.map(id => tilesById.get(id));
    this.game.updatedAt = new Date().toISOString();
    await this.save();
    this.broadcast(null, { type: "state", state: this.game });
    return json({ state: this.game }, 200, cors);
  }

  stream(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected WebSocket upgrade" }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "state", state: this.game }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, raw) {
    await this.ready;

    try {
      const message = parseSocketMessage(raw);

      if (message.type === "sync") {
        socket.send(JSON.stringify({ type: "state", state: this.game }));
        return;
      }

      if (message.type === "move") {
        const result = applyMove(this.game, message.move, MOVE_VALIDATION);
        this.game = result.state;
        await this.save();
        socket.send(JSON.stringify({
          type: "state",
          state: this.game,
          move: result.move,
          accepted: result.accepted
        }));
        this.broadcast(socket, { type: "state", state: this.game, move: result.move });
        return;
      }

      if (message.type === "reset") {
        this.game = resetGameState(this.game);
        await this.save();
        socket.send(JSON.stringify({ type: "state", state: this.game, reset: true }));
        this.broadcast(socket, { type: "state", state: this.game, reset: true });
        return;
      }

      socket.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: messageFromError(error) }));
    }
  }

  webSocketClose() {}

  webSocketError() {}

  async save() {
    await this.state.storage.put("game", this.game);
    this.hasStoredGame = Boolean(this.game?.id);
  }

  gameExists(roomId) {
    const normalized = normalizeRoomId(roomId);
    return Boolean(this.hasStoredGame && normalized && this.game?.id === normalized);
  }

  ensureRoom(roomId, options = {}) {
    const normalized = normalizeRoomId(roomId);
    if (!normalized) throw statusError("Board is required", 400);
    if (this.game.id && this.game.id !== normalized) throw statusError("Board mismatch", 409);
    if (!this.game.id) {
      this.game = createGameState({
        ...this.game,
        id: normalized,
        tileBagCount: options.tileBagCount || this.game.tileBagCount
      });
    }
  }

  broadcast(sender, message) {
    const raw = JSON.stringify(message);
    for (const socket of this.state.getWebSockets()) {
      if (socket === sender) continue;
      try {
        socket.send(raw);
      } catch {
        // The runtime will close dead sockets.
      }
    }
  }
}

export class InviteInbox {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.inboxes = null;
    this.ready = this.initialize();
  }

  async initialize() {
    this.inboxes = await this.state.storage.get("inboxes") || {};
  }

  async fetch(request) {
    await this.ready;
    const cors = corsHeaders(request, this.env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!isAllowedOrigin(request, this.env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    const url = new URL(request.url);

    if ((url.pathname === "/internal/games" || url.pathname === "/internal/invite") && request.method === "POST") {
      const body = await readJson(request);
      await this.addGameRefs(body);
      return json({ ok: true }, 200, cors);
    }

    const route = parsePlayerRoute(url.pathname);
    if (!route) return json({ error: "Not found" }, 404, cors);

    if (route.action === "games" && request.method === "GET") {
      return json({ games: this.playerGames(route.playerId) }, 200, cors);
    }

    if (route.action === "invites" && request.method === "GET") {
      return json({ invites: this.playerGames(route.playerId) }, 200, cors);
    }

    return json({ error: "Not found" }, 404, cors);
  }

  async addGameRefs(input = {}) {
    const gameId = normalizeRoomId(input.gameId);
    if (!gameId) return;

    const inviter = {
      id: String(input.invitedBy?.id || "").trim().slice(0, 128),
      name: normalizePlayerName(input.invitedBy?.name) || "Player"
    };
    const now = new Date().toISOString();
    const invitedAt = typeof input.invitedAt === "string" ? input.invitedAt : now;
    const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : now;
    const players = normalizeInvites(input.players || input.invites, 100);
    const invitedIds = new Set(normalizeInvites(input.invites).map(invite => invite.playerId));

    for (const player of players) {
      this.inboxes[player.playerId] ||= {};
      const previous = this.inboxes[player.playerId][gameId] || {};
      this.inboxes[player.playerId][gameId] = {
        ...previous,
        gameId,
        updatedAt,
        joinedAt: previous.joinedAt || updatedAt
      };

      if (invitedIds.has(player.playerId)) {
        this.inboxes[player.playerId][gameId].invitedAt = invitedAt;
        this.inboxes[player.playerId][gameId].invitedBy = inviter;
      }
    }

    await this.state.storage.put("inboxes", this.inboxes);
  }

  playerGames(playerId) {
    const inbox = this.inboxes[String(playerId || "").trim().slice(0, 128)] || {};
    return Object.values(inbox).sort((left, right) => Date.parse(right.updatedAt || right.invitedAt || "") - Date.parse(left.updatedAt || left.invitedAt || ""));
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!isAllowedOrigin(request, env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    const pathname = new URL(request.url).pathname;
    const playerRoute = parsePlayerRoute(pathname);
    if (playerRoute) {
      const id = env.INVITE_INBOX.idFromName("invites");
      const inbox = env.INVITE_INBOX.get(id);
      return inbox.fetch(request);
    }

    const route = parseGameRoute(pathname);
    if (!route) return json({ error: "Not found" }, 404, cors);

    const id = env.GAME_ROOM.idFromName(route.roomId);
    const room = env.GAME_ROOM.get(id);
    return room.fetch(request);
  }
};

export function parseGameRoute(pathname) {
  const globalMatch = /^\/game\/(exists|join|move|rack|reset|state|stream)\/?$/.exec(pathname);
  if (globalMatch) {
    return {
      roomId: GLOBAL_ROOM_ID,
      action: globalMatch[1]
    };
  }

  const match = /^\/game\/([A-Za-z0-9]+)\/(exists|join|move|rack|reset|state|stream)\/?$/.exec(pathname);
  if (!match) return null;
  return {
    roomId: normalizeRoomId(match[1]),
    action: match[2]
  };
}

export function parsePlayerRoute(pathname) {
  const match = /^\/player\/([^/]+)\/(games|invites)\/?$/.exec(pathname);
  if (!match) return null;
  return {
    playerId: decodeURIComponent(match[1]).trim().slice(0, 128),
    action: match[2]
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new GameRuleError("Request body must be JSON");
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins(env);
  const allowOrigin = origin && (allowed.includes("*") || allowed.includes(origin)) ? origin : "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
  return headers;
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = allowedOrigins(env);
  return allowed.includes("*") || allowed.includes(origin) || isPrivateDevOrigin(origin);
}

function allowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  return configured.length ? configured : ["*"];
}

function sameStringSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(value => rightSet.has(value)) && new Set(left).size === rightSet.size;
}

function hasOversizedRacks(game) {
  return Object.values(game?.players || {}).some(player => Array.isArray(player?.rack) && player.rack.length > RACK_SIZE);
}

function normalizeInvites(input = [], limit = 20) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const invites = [];

  for (const item of input) {
    const playerId = String(item?.playerId || item?.id || "").trim().slice(0, 128);
    if (!playerId || seen.has(playerId)) continue;
    seen.add(playerId);
    invites.push({
      playerId,
      name: normalizePlayerName(item?.name) || "Player"
    });
    if (invites.length >= limit) break;
  }

  return invites;
}

async function rememberGameMemberships(env, game, players, invites = [], invitedBy = null) {
  if (!env.INVITE_INBOX || !game?.id || !players?.length) return;

  try {
    const id = env.INVITE_INBOX.idFromName("invites");
    const inbox = env.INVITE_INBOX.get(id);
    await inbox.fetch("https://invite-inbox/internal/games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gameId: game.id,
        players,
        invites,
        invitedBy,
        invitedAt: new Date().toISOString(),
        updatedAt: game.updatedAt
      })
    });
  } catch {
    // Game state is still authoritative if the membership relay is temporarily unavailable.
  }
}

function isPrivateDevOrigin(origin) {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return (
      url.protocol === "http:" &&
      url.port === "8031" &&
      (
        host === "localhost" ||
        host === "127.0.0.1" ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      )
    );
  } catch {
    return false;
  }
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}

function parseSocketMessage(raw) {
  if (typeof raw === "string") return JSON.parse(raw);
  return JSON.parse(new TextDecoder().decode(raw));
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function messageFromError(error) {
  return error instanceof Error ? error.message : String(error);
}
