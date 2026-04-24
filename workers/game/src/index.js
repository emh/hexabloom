import { GLOBAL_ROOM_ID, GameRuleError, RACK_SIZE, applyMove, createGameState, joinGame, normalizePlayerName, normalizeRoomId, normalizeWord, removePlayerFromGame as removePlayerFromGameState, resetGameState } from "../../../app/model.js";
import { DICTIONARY_WORDS } from "./dictionary.generated.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SYNC_CACHE_TTL_DAYS = 30;
const DEFAULT_LINK_CODE_TTL_HOURS = 24;
const GAME_STORAGE_KEY = "game";
const CACHE_META_STORAGE_KEY = "cacheMeta";
const INBOX_STORAGE_KEY = "inboxes";
const USERS_STORAGE_KEY = "users";
const LINK_CODES_STORAGE_KEY = "linkCodes";
const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LINK_CODE_LENGTH = 8;

const MOVE_VALIDATION = {
  isWordAllowed: word => DICTIONARY_WORDS.has(normalizeWord(word))
};

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.game = null;
    this.hasStoredGame = false;
    this.cacheExpiresAt = "";
    this.ready = this.initialize();
  }

  async initialize() {
    const [storedGame, cacheMeta] = await Promise.all([
      this.state.storage.get(GAME_STORAGE_KEY),
      this.state.storage.get(CACHE_META_STORAGE_KEY)
    ]);
    this.cacheExpiresAt = validDateString(cacheMeta?.expiresAt) ? cacheMeta.expiresAt : "";
    if (storedGame?.id && this.cacheExpiresAt && isExpired(this.cacheExpiresAt)) {
      await this.purgeCache();
      return;
    }

    this.hasStoredGame = Boolean(storedGame?.id);
    this.game = createGameState(storedGame);
    if (this.hasStoredGame && !this.cacheExpiresAt) await this.touchCache();
    if (hasOversizedRacks(storedGame)) await this.save();
  }

  async fetch(request) {
    await this.ready;
    const cors = corsHeaders(request, this.env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!isAllowedOrigin(request, this.env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    await this.expireCacheIfNeeded();

    const internalRemoveMatch = /^\/internal\/players\/([^/]+)\/?$/.exec(url.pathname);
    if (internalRemoveMatch && (request.method === "DELETE" || request.method === "POST")) {
      return await this.removePlayerInternal(decodeURIComponent(internalRemoveMatch[1]), cors);
    }

    const route = parseGameRoute(url.pathname);
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

      if (route.action === "remove-player" && request.method === "POST") {
        return await this.removePlayer(request, route.roomId, cors);
      }

      if (route.action === "resign" && request.method === "POST") {
        return await this.resign(request, route.roomId, cors);
      }

      if (route.action === "delete" && request.method === "POST") {
        return await this.deleteGame(request, route.roomId, cors);
      }

      if (route.action === "state" && request.method === "GET") {
        this.ensureStoredRoom(route.roomId);
        await this.touchCache();
        return json({ state: this.game }, 200, cors);
      }

      if (route.action === "exists" && request.method === "GET") {
        if (this.gameExists(route.roomId)) await this.touchCache();
        return json({ exists: this.gameExists(route.roomId) }, 200, cors);
      }

      if (route.action === "stream" && request.method === "GET") {
        this.ensureStoredRoom(route.roomId);
        await this.touchCache();
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
    await rememberGameMemberships(this.env, this.game, Object.values(this.game.players), invited, joined.player);
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

  async removePlayer(request, roomId, cors) {
    this.ensureRoom(roomId);
    const body = await readJson(request);
    const ownerId = normalizePlayerId(body.ownerId || body.actorId);
    if (!ownerId || ownerId !== this.game.ownerId) {
      throw statusError("Only the board owner can remove players", 403);
    }

    const playerId = normalizePlayerId(body.playerId || body.targetPlayerId);
    const result = removePlayerFromGameState(this.game, { playerId });
    this.game = result.state;
    await this.save();
    await removeGameMembership(this.env, this.game.id, result.player.id);
    this.broadcast(null, { type: "state", state: this.game, removedPlayer: result.player });
    return json({ state: this.game, removedPlayer: result.player }, 200, cors);
  }

  async removePlayerInternal(playerIdInput, cors) {
    const playerId = normalizePlayerId(playerIdInput);
    if (!playerId) throw statusError("Player ID is required", 400);
    if (!this.game?.players?.[playerId]) {
      return json({ removed: false, playerId, gameId: this.game?.id || "" }, 200, cors);
    }

    const result = removePlayerFromGameState(this.game, {
      playerId,
      allowOwnerRemoval: true,
      redactPlayerData: true
    });
    const gameId = this.game.id;
    this.game = result.state;
    if (!Object.keys(this.game.players || {}).length) {
      await this.purgeCache();
      this.broadcast(null, { type: "deleted", gameId });
      return json({ removed: true, deleted: true, playerId, gameId }, 200, cors);
    }

    await this.save();
    this.broadcast(null, { type: "state", state: this.game, removedPlayer: result.player });
    return json({ removed: true, playerId, gameId: this.game.id, state: this.game }, 200, cors);
  }

  async resign(request, roomId, cors) {
    this.ensureStoredRoom(roomId);
    const body = await readJson(request);
    const playerId = normalizePlayerId(body.playerId);
    if (!playerId) throw statusError("Player ID is required", 400);
    if (!this.game.players[playerId]) throw statusError("Player is not in this board", 404);

    const result = removePlayerFromGameState(this.game, { playerId, allowOwnerRemoval: true });
    const gameId = this.game.id;
    this.game = result.state;

    if (!Object.keys(this.game.players || {}).length) {
      await this.purgeCache();
      await removeGameMemberships(this.env, gameId);
      this.broadcast(null, { type: "deleted", gameId });
      return json({ resigned: true, deleted: true, gameId, removedPlayer: result.player }, 200, cors);
    }

    await this.save();
    await removeGameMembership(this.env, gameId, result.player.id);
    this.broadcast(null, { type: "state", state: this.game, removedPlayer: result.player });
    return json({ resigned: true, deleted: false, gameId, state: this.game, removedPlayer: result.player }, 200, cors);
  }

  async deleteGame(request, roomId, cors) {
    this.ensureStoredRoom(roomId);
    const body = await readJson(request);
    const ownerId = normalizePlayerId(body.ownerId || body.actorId);
    if (!ownerId || ownerId !== this.game.ownerId) {
      throw statusError("Only the board owner can delete this game", 403);
    }

    const gameId = this.game.id;
    await this.purgeCache();
    await removeGameMemberships(this.env, gameId);
    this.broadcast(null, { type: "deleted", gameId });
    return json({ deleted: true, gameId }, 200, cors);
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
    await this.state.storage.put(GAME_STORAGE_KEY, this.game);
    this.hasStoredGame = Boolean(this.game?.id);
    if (this.hasStoredGame) await this.touchCache();
  }

  gameExists(roomId) {
    const normalized = normalizeRoomId(roomId);
    return Boolean(this.hasStoredGame && normalized && this.game?.id === normalized);
  }

  ensureStoredRoom(roomId) {
    const normalized = normalizeRoomId(roomId);
    if (!normalized) throw statusError("Board is required", 400);
    if (!this.gameExists(normalized)) throw statusError("Board not found", 404);
  }

  ensureRoom(roomId, options = {}) {
    const normalized = normalizeRoomId(roomId);
    if (!normalized) throw statusError("Board is required", 400);
    if (this.game.id && this.game.id !== normalized) throw statusError("Board mismatch", 409);
    if (!this.game.id) {
      const seedState = createSeedGameState(options.state, normalized);
      this.game = createGameState({
        ...(seedState || this.game),
        id: normalized,
        tileBagCount: options.tileBagCount || seedState?.tileBagCount || this.game.tileBagCount
      });
    }
  }

  async touchCache() {
    if (!this.hasStoredGame && !this.game?.id) return;
    this.cacheExpiresAt = expiresAtFromNow(this.env);
    await Promise.all([
      this.state.storage.put(CACHE_META_STORAGE_KEY, { expiresAt: this.cacheExpiresAt }),
      setStorageAlarm(this.state.storage, this.cacheExpiresAt)
    ]);
  }

  async expireCacheIfNeeded(now = Date.now()) {
    if (!this.hasStoredGame || !this.cacheExpiresAt || !isExpired(this.cacheExpiresAt, now)) return false;
    await this.purgeCache();
    return true;
  }

  async purgeCache() {
    await Promise.all([
      this.state.storage.delete(GAME_STORAGE_KEY),
      this.state.storage.delete(CACHE_META_STORAGE_KEY),
      deleteStorageAlarm(this.state.storage)
    ]);
    this.game = createGameState();
    this.hasStoredGame = false;
    this.cacheExpiresAt = "";
  }

  async alarm() {
    await this.ready;
    await this.expireCacheIfNeeded();
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
    this.users = null;
    this.linkCodes = null;
    this.ready = this.initialize();
  }

  async initialize() {
    const [inboxes, users, linkCodes] = await Promise.all([
      this.state.storage.get(INBOX_STORAGE_KEY),
      this.state.storage.get(USERS_STORAGE_KEY),
      this.state.storage.get(LINK_CODES_STORAGE_KEY)
    ]);
    this.inboxes = normalizeStoredInboxes(inboxes, this.env);
    this.users = normalizeStoredUsers(users, this.inboxes);
    this.linkCodes = normalizeStoredLinkCodes(linkCodes, this.env);
    await Promise.all([
      this.state.storage.put(INBOX_STORAGE_KEY, this.inboxes),
      this.state.storage.put(USERS_STORAGE_KEY, this.users),
      this.state.storage.put(LINK_CODES_STORAGE_KEY, this.linkCodes)
    ]);
    await this.sweepExpiredRefs();
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
    await this.sweepExpiredRefs();

    try {
      if ((url.pathname === "/internal/games" || url.pathname === "/internal/invite") && request.method === "POST") {
        const body = await readJson(request);
        await this.addGameRefs(body);
        return json({ ok: true }, 200, cors);
      }

      if (url.pathname === "/internal/admin/users" && request.method === "GET") {
        return json({ users: this.listUsers() }, 200, cors);
      }

      const removeGameRefMatch = /^\/internal\/games\/([A-Za-z0-9]+)\/players\/([^/]+)\/?$/.exec(url.pathname);
      if (removeGameRefMatch && (request.method === "DELETE" || request.method === "POST")) {
        const result = await this.removeGameRef(removeGameRefMatch[1], decodeURIComponent(removeGameRefMatch[2]));
        return json(result, 200, cors);
      }

      const removeGameRefsMatch = /^\/internal\/games\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
      if (removeGameRefsMatch && (request.method === "DELETE" || request.method === "POST")) {
        const result = await this.removeGameRefs(removeGameRefsMatch[1]);
        return json(result, 200, cors);
      }

      const linkRoute = parseLinkRoute(url.pathname);
      if (linkRoute?.action === "create" && request.method === "POST") {
        const body = await readJson(request).catch(() => ({}));
        return json(await this.createLinkCode(body), 200, cors);
      }

      if (linkRoute?.action === "redeem" && request.method === "POST") {
        const body = await readJson(request).catch(() => ({}));
        return json(await this.redeemLinkCode(body), 200, cors);
      }

      const route = parsePlayerRoute(url.pathname);
      if (!route) return json({ error: "Not found" }, 404, cors);

      if (route.action === "games" && request.method === "GET") {
        return json({ games: this.playerGames(route.playerId) }, 200, cors);
      }

      if (route.action === "invites" && request.method === "GET") {
        return json({ invites: this.playerGames(route.playerId) }, 200, cors);
      }

      if (route.action === "delete" && (request.method === "DELETE" || request.method === "POST")) {
        const body = await readJson(request).catch(() => ({}));
        return json(await this.deletePlayer(route.playerId, body), 200, cors);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      return json({ error: messageFromError(error) }, error?.status || 400, cors);
    }
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
    const expiresAt = expiresAtFromNow(this.env);
    const players = normalizeInvites(input.players || input.invites, 100);
    const invitedIds = new Set(normalizeInvites(input.invites).map(invite => invite.playerId));

    for (const player of players) {
      this.inboxes[player.playerId] ||= {};
      const previous = this.inboxes[player.playerId][gameId] || {};
      this.inboxes[player.playerId][gameId] = {
        ...previous,
        gameId,
        updatedAt,
        joinedAt: previous.joinedAt || updatedAt,
        expiresAt
      };

      if (invitedIds.has(player.playerId)) {
        this.inboxes[player.playerId][gameId].invitedAt = invitedAt;
        this.inboxes[player.playerId][gameId].invitedBy = inviter;
      }

      this.rememberUser(player, gameId, this.inboxes[player.playerId][gameId].joinedAt, updatedAt);
    }

    await Promise.all([
      this.state.storage.put(INBOX_STORAGE_KEY, this.inboxes),
      this.state.storage.put(USERS_STORAGE_KEY, this.users),
      this.scheduleAlarm()
    ]);
  }

  playerGames(playerId) {
    const inbox = this.inboxes[normalizePlayerId(playerId)] || {};
    return Object.values(inbox).sort((left, right) => Date.parse(right.updatedAt || right.invitedAt || "") - Date.parse(left.updatedAt || left.invitedAt || ""));
  }

  async createLinkCode(input = {}) {
    const playerId = normalizePlayerId(input.playerId || input.id);
    if (!playerId) throw statusError("Player ID is required", 400);

    const user = this.userSummary(playerId);
    const playerName = normalizePlayerName(input.name || input.playerName) || user?.name || "Player";
    const gameId = normalizeRoomId(input.gameId || input.roomId);
    const gameIds = normalizeGameIds([
      gameId,
      ...normalizeGameIds(input.gameIds),
      ...this.playerGames(playerId).map(ref => ref.gameId)
    ]);
    const code = this.generateUniqueLinkCode();
    const expiresAt = linkCodeExpiresAtFromNow(this.env);
    this.linkCodes[code] = {
      code,
      playerId,
      playerName,
      gameId,
      gameIds,
      createdAt: new Date().toISOString(),
      expiresAt
    };

    await Promise.all([
      this.state.storage.put(LINK_CODES_STORAGE_KEY, this.linkCodes),
      this.scheduleAlarm()
    ]);

    return {
      code: formatLinkCode(code),
      expiresAt
    };
  }

  async redeemLinkCode(input = {}) {
    const code = normalizeLinkCode(input.code || input.linkCode);
    if (!code) throw statusError("Link code is required", 400);

    const link = this.linkCodes[code];
    if (!link || isExpired(link.expiresAt)) {
      if (link) {
        delete this.linkCodes[code];
        await Promise.all([
          this.state.storage.put(LINK_CODES_STORAGE_KEY, this.linkCodes),
          this.scheduleAlarm()
        ]);
      }
      throw statusError("Link code not found", 404);
    }

    delete this.linkCodes[code];

    const user = this.userSummary(link.playerId);
    const recentGameIds = this.playerGames(link.playerId).map(ref => ref.gameId);
    const storedGameIds = normalizeGameIds(link.gameIds);
    const gameId = normalizeRoomId(link.gameId) || recentGameIds[0] || storedGameIds[0] || "";
    const gameIds = normalizeGameIds([gameId, ...recentGameIds, ...storedGameIds]);

    await Promise.all([
      this.state.storage.put(LINK_CODES_STORAGE_KEY, this.linkCodes),
      this.scheduleAlarm()
    ]);

    return {
      playerId: link.playerId,
      playerName: normalizePlayerName(link.playerName) || user?.name || "Player",
      gameId,
      gameIds
    };
  }

  generateUniqueLinkCode() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = generateLinkCode();
      if (!this.linkCodes[code]) return code;
    }
    throw statusError("Unable to create a link code right now", 503);
  }

  rememberUser(player, gameId, createdAt, updatedAt) {
    const id = normalizePlayerId(player?.playerId || player?.id);
    if (!id) return;

    const previous = this.users[id] || {};
    const gameIds = new Set([
      ...normalizeGameIds(previous.gameIds),
      ...gameIdsFromInbox(this.inboxes[id]),
      gameId
    ].filter(Boolean));
    const now = new Date().toISOString();
    this.users[id] = {
      id,
      name: normalizePlayerName(player?.name) || previous.name || "Player",
      createdAt: validDateString(previous.createdAt) ? previous.createdAt : validDateString(createdAt) ? createdAt : now,
      updatedAt: validDateString(updatedAt) ? updatedAt : now,
      gameIds: [...gameIds].sort()
    };
  }

  listUsers() {
    const ids = new Set([...Object.keys(this.users || {}), ...Object.keys(this.inboxes || {})]);
    return [...ids]
      .map(id => this.userSummary(id))
      .filter(Boolean)
      .sort(compareAdminUsers);
  }

  userSummary(playerId) {
    const id = normalizePlayerId(playerId);
    if (!id) return null;

    const user = this.users[id] || {};
    const inbox = this.inboxes[id] || {};
    const gameIds = [...new Set([
      ...normalizeGameIds(user.gameIds),
      ...gameIdsFromInbox(inbox)
    ])].sort();
    const createdAt = validDateString(user.createdAt) ? user.createdAt : firstMembershipAt(inbox);
    const updatedAt = validDateString(user.updatedAt) ? user.updatedAt : lastMembershipAt(inbox) || createdAt;

    return {
      id,
      name: normalizePlayerName(user.name),
      signupAt: createdAt || "",
      createdAt: createdAt || "",
      updatedAt: updatedAt || "",
      gameCount: gameIds.length,
      gameIds
    };
  }

  async removeGameRef(gameIdInput, playerIdInput) {
    const gameId = normalizeRoomId(gameIdInput);
    const playerId = normalizePlayerId(playerIdInput);
    if (!gameId) throw statusError("Board is required", 400);
    if (!playerId) throw statusError("Player ID is required", 400);

    const inbox = this.inboxes[playerId] || {};
    const removed = Boolean(inbox[gameId]);
    delete inbox[gameId];
    if (Object.keys(inbox).length) {
      this.inboxes[playerId] = inbox;
    } else {
      delete this.inboxes[playerId];
    }

    if (this.users[playerId]) {
      this.users[playerId] = {
        ...this.users[playerId],
        gameIds: normalizeGameIds(this.users[playerId].gameIds).filter(id => id !== gameId)
      };
    }

    await Promise.all([
      this.state.storage.put(INBOX_STORAGE_KEY, this.inboxes),
      this.state.storage.put(USERS_STORAGE_KEY, this.users),
      this.scheduleAlarm()
    ]);

    return { removed, gameId, playerId };
  }

  async removeGameRefs(gameIdInput) {
    const gameId = normalizeRoomId(gameIdInput);
    if (!gameId) throw statusError("Board is required", 400);

    let removed = 0;
    for (const [playerId, inbox] of Object.entries(this.inboxes || {})) {
      if (inbox[gameId]) {
        delete inbox[gameId];
        removed += 1;
      }

      if (Object.keys(inbox).length) {
        this.inboxes[playerId] = inbox;
      } else {
        delete this.inboxes[playerId];
        delete this.users[playerId];
      }
    }

    for (const [playerId, record] of Object.entries(this.users || {})) {
      this.users[playerId] = {
        ...record,
        gameIds: normalizeGameIds(record.gameIds).filter(id => id !== gameId)
      };
      if (!this.users[playerId].gameIds.length) delete this.users[playerId];
    }

    await Promise.all([
      this.state.storage.put(INBOX_STORAGE_KEY, this.inboxes),
      this.state.storage.put(USERS_STORAGE_KEY, this.users),
      this.scheduleAlarm()
    ]);

    return { removed, gameId };
  }

  async deletePlayer(playerIdInput, input = {}) {
    const playerId = normalizePlayerId(playerIdInput);
    if (!playerId) throw statusError("Player ID is required", 400);

    const user = this.userSummary(playerId);
    const gameIds = [...new Set([
      ...(user?.gameIds || []),
      ...normalizeGameIds(input.gameIds)
    ])].sort();
    const games = [];

    for (const gameId of gameIds) {
      games.push(await removePlayerFromGame(this.env, gameId, playerId));
    }

    const failed = games.filter(game => game.ok === false || game.error);
    if (failed.length) throw statusError("Failed to remove player from one or more boards", 502);

    delete this.inboxes[playerId];
    delete this.users[playerId];
    this.removeLinkCodesForPlayer(playerId);

    await Promise.all([
      this.state.storage.put(INBOX_STORAGE_KEY, this.inboxes),
      this.state.storage.put(USERS_STORAGE_KEY, this.users),
      this.state.storage.put(LINK_CODES_STORAGE_KEY, this.linkCodes),
      this.scheduleAlarm()
    ]);

    return {
      deleted: true,
      playerId,
      user,
      gameCount: gameIds.length,
      games
    };
  }

  removeLinkCodesForPlayer(playerIdInput) {
    const playerId = normalizePlayerId(playerIdInput);
    if (!playerId) return 0;

    let removed = 0;
    for (const [code, link] of Object.entries(this.linkCodes || {})) {
      if (normalizePlayerId(link?.playerId) !== playerId) continue;
      delete this.linkCodes[code];
      removed += 1;
    }
    return removed;
  }

  async sweepExpiredRefs(now = Date.now()) {
    let changed = false;

    for (const [playerId, inbox] of Object.entries(this.inboxes || {})) {
      for (const [gameId, ref] of Object.entries(inbox || {})) {
        if (isExpired(ref?.expiresAt, now)) {
          delete inbox[gameId];
          changed = true;
        }
      }

      if (!Object.keys(inbox).length) {
        delete this.inboxes[playerId];
        changed = true;
      }
    }

    for (const [code, link] of Object.entries(this.linkCodes || {})) {
      if (!isExpired(link?.expiresAt, now)) continue;
      delete this.linkCodes[code];
      changed = true;
    }

    for (const [playerId, record] of Object.entries(this.users || {})) {
      const gameIds = gameIdsFromInbox(this.inboxes[playerId]);
      if (!gameIds.length) {
        delete this.users[playerId];
        changed = true;
        continue;
      }

      const previous = normalizeGameIds(record.gameIds);
      if (!sameStringSet(previous, gameIds)) {
        this.users[playerId] = { ...record, gameIds };
        changed = true;
      }
    }

    if (changed) {
      await Promise.all([
        this.state.storage.put(INBOX_STORAGE_KEY, this.inboxes),
        this.state.storage.put(USERS_STORAGE_KEY, this.users),
        this.state.storage.put(LINK_CODES_STORAGE_KEY, this.linkCodes)
      ]);
    }

    await this.scheduleAlarm();
    return changed;
  }

  async scheduleAlarm() {
    const next = earliestExpiry(nextInboxExpiry(this.inboxes), nextLinkCodeExpiry(this.linkCodes));
    if (next) {
      await setStorageAlarm(this.state.storage, next);
    } else {
      await deleteStorageAlarm(this.state.storage);
    }
  }

  async alarm() {
    await this.ready;
    await this.sweepExpiredRefs();
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
    const adminRoute = parseAdminRoute(pathname);
    if (adminRoute) {
      return await handleAdminRequest(request, env, adminRoute, cors);
    }

    const playerRoute = parsePlayerRoute(pathname);
    if (playerRoute) {
      const id = env.INVITE_INBOX.idFromName("invites");
      const inbox = env.INVITE_INBOX.get(id);
      return inbox.fetch(request);
    }

    const linkRoute = parseLinkRoute(pathname);
    if (linkRoute) {
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
  const globalMatch = /^\/game\/(delete|exists|join|move|rack|remove-player|resign|reset|state|stream)\/?$/.exec(pathname);
  if (globalMatch) {
    return {
      roomId: GLOBAL_ROOM_ID,
      action: globalMatch[1]
    };
  }

  const match = /^\/game\/([A-Za-z0-9]+)\/(delete|exists|join|move|rack|remove-player|resign|reset|state|stream)\/?$/.exec(pathname);
  if (!match) return null;
  return {
    roomId: normalizeRoomId(match[1]),
    action: match[2]
  };
}

export function parsePlayerRoute(pathname) {
  const match = /^\/player\/([^/]+)\/(delete|games|invites)\/?$/.exec(pathname);
  if (!match) return null;
  return {
    playerId: normalizePlayerId(decodeURIComponent(match[1])),
    action: match[2]
  };
}

export function parseLinkRoute(pathname) {
  if (/^\/link\/?$/.test(pathname)) return { action: "create" };
  if (/^\/link\/redeem\/?$/.test(pathname)) return { action: "redeem" };
  return null;
}

export function parseAdminRoute(pathname) {
  if (/^\/admin\/users\/?$/.test(pathname)) return { action: "users" };
  return null;
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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token",
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

function normalizePlayerId(value) {
  return String(value || "").trim().slice(0, 128);
}

function normalizeInvites(input = [], limit = 20) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const invites = [];

  for (const item of input) {
    const playerId = normalizePlayerId(item?.playerId || item?.id);
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

function createSeedGameState(input, roomId) {
  if (!input || typeof input !== "object") return null;
  const state = createGameState({ ...input, id: roomId });
  if (!Object.keys(state.players).length && !Object.keys(state.board).length && !state.moves.length) return null;
  return state;
}

async function handleAdminRequest(request, env, route, cors) {
  const authError = requireAdmin(request, env, cors);
  if (authError) return authError;
  if (!env.INVITE_INBOX) return json({ error: "Invite inbox binding is unavailable" }, 500, cors);

  const id = env.INVITE_INBOX.idFromName("invites");
  const inbox = env.INVITE_INBOX.get(id);

  if (route.action === "users" && request.method === "GET") {
    const response = await inbox.fetch("https://invite-inbox/internal/admin/users", { method: "GET" });
    return await relayJsonResponse(response, cors);
  }

  return json({ error: "Not found" }, 404, cors);
}

function requireAdmin(request, env, cors) {
  const expected = normalizeAdminToken(env?.ADMIN_TOKEN);
  if (!expected) return json({ error: "Admin token is not configured" }, 503, cors);

  const actual = normalizeAdminToken(adminTokenFromRequest(request));
  if (!actual || actual !== expected) return json({ error: "Unauthorized" }, 401, cors);
  return null;
}

function adminTokenFromRequest(request) {
  const header = request.headers.get("Authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) return bearer[1];
  return request.headers.get("X-Admin-Token") || "";
}

function normalizeAdminToken(value) {
  return String(value || "").trim();
}

function syncCacheTtlMs(env = {}) {
  const configuredMs = Number.parseInt(env.SYNC_CACHE_TTL_MS, 10);
  if (Number.isFinite(configuredMs) && configuredMs > 0) return configuredMs;

  const configuredDays = Number.parseFloat(env.SYNC_CACHE_TTL_DAYS);
  if (Number.isFinite(configuredDays) && configuredDays > 0) return Math.round(configuredDays * DAY_MS);

  return DEFAULT_SYNC_CACHE_TTL_DAYS * DAY_MS;
}

function linkCodeTtlMs(env = {}) {
  const configuredMs = Number.parseInt(env.LINK_CODE_TTL_MS, 10);
  if (Number.isFinite(configuredMs) && configuredMs > 0) return configuredMs;

  const configuredHours = Number.parseFloat(env.LINK_CODE_TTL_HOURS);
  if (Number.isFinite(configuredHours) && configuredHours > 0) return Math.round(configuredHours * 60 * 60 * 1000);

  return DEFAULT_LINK_CODE_TTL_HOURS * 60 * 60 * 1000;
}

function expiresAtFromNow(env = {}, now = Date.now()) {
  return new Date(now + syncCacheTtlMs(env)).toISOString();
}

function linkCodeExpiresAtFromNow(env = {}, now = Date.now()) {
  return new Date(now + linkCodeTtlMs(env)).toISOString();
}

function isExpired(value, now = Date.now()) {
  return validDateString(value) && Date.parse(value) <= now;
}

async function setStorageAlarm(storage, expiresAt) {
  if (typeof storage?.setAlarm !== "function") return;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) return;
  await storage.setAlarm(timestamp);
}

async function deleteStorageAlarm(storage) {
  if (typeof storage?.deleteAlarm !== "function") return;
  await storage.deleteAlarm();
}

async function relayJsonResponse(response, cors) {
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "application/json",
      ...cors
    }
  });
}

function normalizeStoredInboxes(input = {}, env = {}) {
  const inboxes = {};
  if (!input || typeof input !== "object") return inboxes;

  const fallbackExpiresAt = expiresAtFromNow(env);
  for (const [rawPlayerId, rawInbox] of Object.entries(input)) {
    const playerId = normalizePlayerId(rawPlayerId);
    if (!playerId || !rawInbox || typeof rawInbox !== "object") continue;

    for (const [rawGameId, rawRef] of Object.entries(rawInbox)) {
      const gameId = normalizeRoomId(rawRef?.gameId || rawGameId);
      if (!gameId || !rawRef || typeof rawRef !== "object") continue;
      inboxes[playerId] ||= {};
      inboxes[playerId][gameId] = {
        ...rawRef,
        gameId,
        updatedAt: validDateString(rawRef.updatedAt) ? rawRef.updatedAt : new Date().toISOString(),
        joinedAt: validDateString(rawRef.joinedAt) ? rawRef.joinedAt : validDateString(rawRef.updatedAt) ? rawRef.updatedAt : "",
        expiresAt: validDateString(rawRef.expiresAt) ? rawRef.expiresAt : fallbackExpiresAt
      };
    }
  }

  return inboxes;
}

async function removePlayerFromGame(env, gameId, playerId) {
  const normalizedGameId = normalizeRoomId(gameId);
  const normalizedPlayerId = normalizePlayerId(playerId);
  if (!normalizedGameId || !normalizedPlayerId) {
    return { gameId: normalizedGameId, playerId: normalizedPlayerId, removed: false, ok: false, error: "Board and player are required" };
  }

  if (!env.GAME_ROOM) {
    return { gameId: normalizedGameId, playerId: normalizedPlayerId, removed: false, ok: false, error: "Game room binding is unavailable" };
  }

  try {
    const id = env.GAME_ROOM.idFromName(normalizedGameId);
    const room = env.GAME_ROOM.get(id);
    const response = await room.fetch(`https://game-room/internal/players/${encodeURIComponent(normalizedPlayerId)}`, {
      method: "DELETE"
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    return {
      gameId: normalizedGameId,
      playerId: normalizedPlayerId,
      removed: Boolean(payload.removed),
      ok: response.ok,
      status: response.status
    };
  } catch (error) {
    return { gameId: normalizedGameId, playerId: normalizedPlayerId, removed: false, ok: false, error: messageFromError(error) };
  }
}

function normalizeStoredUsers(input = {}, inboxes = {}) {
  const users = {};
  if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(input)) {
      const id = normalizePlayerId(value?.id || key);
      if (!id) continue;
      const inbox = inboxes[id] || {};
      const createdAt = validDateString(value?.createdAt) ? value.createdAt : firstMembershipAt(inbox);
      const updatedAt = validDateString(value?.updatedAt) ? value.updatedAt : lastMembershipAt(inbox) || createdAt;
      users[id] = {
        id,
        name: normalizePlayerName(value?.name),
        createdAt: createdAt || "",
        updatedAt: updatedAt || "",
        gameIds: [...new Set([
          ...normalizeGameIds(value?.gameIds),
          ...gameIdsFromInbox(inbox)
        ])].sort()
      };
    }
  }

  for (const [playerId, inbox] of Object.entries(inboxes || {})) {
    const id = normalizePlayerId(playerId);
    if (!id || users[id]) continue;
    const createdAt = firstMembershipAt(inbox);
    users[id] = {
      id,
      name: "",
      createdAt: createdAt || "",
      updatedAt: lastMembershipAt(inbox) || createdAt || "",
      gameIds: gameIdsFromInbox(inbox)
    };
  }

  return users;
}

function normalizeStoredLinkCodes(input = {}, env = {}) {
  const linkCodes = {};
  if (!input || typeof input !== "object") return linkCodes;

  const fallbackExpiresAt = linkCodeExpiresAtFromNow(env);
  const fallbackCreatedAt = new Date().toISOString();
  for (const [rawCode, value] of Object.entries(input)) {
    const code = normalizeLinkCode(value?.code || rawCode);
    const playerId = normalizePlayerId(value?.playerId || value?.id);
    if (!code || !playerId || !value || typeof value !== "object") continue;

    const gameId = normalizeRoomId(value?.gameId || value?.roomId);
    linkCodes[code] = {
      code,
      playerId,
      playerName: normalizePlayerName(value?.playerName || value?.name) || "Player",
      gameId,
      gameIds: normalizeGameIds([gameId, ...normalizeGameIds(value?.gameIds)]),
      createdAt: validDateString(value?.createdAt) ? value.createdAt : fallbackCreatedAt,
      expiresAt: validDateString(value?.expiresAt) ? value.expiresAt : fallbackExpiresAt
    };
  }

  return linkCodes;
}

function normalizeGameIds(input = []) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const gameIds = [];
  for (const value of input) {
    const gameId = normalizeRoomId(value);
    if (!gameId || seen.has(gameId)) continue;
    seen.add(gameId);
    gameIds.push(gameId);
  }
  return gameIds;
}

function gameIdsFromInbox(inbox = {}) {
  if (!inbox || typeof inbox !== "object") return [];
  return Object.keys(inbox).map(normalizeRoomId).filter(Boolean).sort();
}

function nextInboxExpiry(inboxes = {}) {
  let next = Infinity;
  for (const inbox of Object.values(inboxes || {})) {
    for (const ref of Object.values(inbox || {})) {
      const timestamp = Date.parse(ref?.expiresAt || "");
      if (Number.isFinite(timestamp) && timestamp < next) next = timestamp;
    }
  }
  return Number.isFinite(next) ? new Date(next).toISOString() : "";
}

function nextLinkCodeExpiry(linkCodes = {}) {
  let next = Infinity;
  for (const link of Object.values(linkCodes || {})) {
    const timestamp = Date.parse(link?.expiresAt || "");
    if (Number.isFinite(timestamp) && timestamp < next) next = timestamp;
  }
  return Number.isFinite(next) ? new Date(next).toISOString() : "";
}

function earliestExpiry(...values) {
  let next = Infinity;
  for (const value of values) {
    const timestamp = Date.parse(value || "");
    if (Number.isFinite(timestamp) && timestamp < next) next = timestamp;
  }
  return Number.isFinite(next) ? new Date(next).toISOString() : "";
}

function firstMembershipAt(inbox = {}) {
  return membershipDates(inbox)[0] || "";
}

function lastMembershipAt(inbox = {}) {
  const dates = membershipDates(inbox);
  return dates[dates.length - 1] || "";
}

function membershipDates(inbox = {}) {
  if (!inbox || typeof inbox !== "object") return [];
  return Object.values(inbox)
    .flatMap(ref => [ref?.joinedAt, ref?.invitedAt, ref?.updatedAt])
    .filter(validDateString)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
}

function validDateString(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function normalizeLinkCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32);
}

function formatLinkCode(value) {
  const code = normalizeLinkCode(value);
  return code.match(/.{1,4}/g)?.join("-") || "";
}

function generateLinkCode(length = LINK_CODE_LENGTH) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += LINK_CODE_ALPHABET[byte % LINK_CODE_ALPHABET.length];
  }
  return code;
}

function compareAdminUsers(left, right) {
  const leftTime = Date.parse(left.signupAt || left.createdAt || "");
  const rightTime = Date.parse(right.signupAt || right.createdAt || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(rightTime) ? 1 : -1;
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
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

async function removeGameMembership(env, gameId, playerId) {
  const normalizedGameId = normalizeRoomId(gameId);
  const normalizedPlayerId = normalizePlayerId(playerId);
  if (!env.INVITE_INBOX || !normalizedGameId || !normalizedPlayerId) return;

  try {
    const id = env.INVITE_INBOX.idFromName("invites");
    const inbox = env.INVITE_INBOX.get(id);
    await inbox.fetch(`https://invite-inbox/internal/games/${encodeURIComponent(normalizedGameId)}/players/${encodeURIComponent(normalizedPlayerId)}`, {
      method: "DELETE"
    });
  } catch {
    // Game state is still authoritative if the membership relay is temporarily unavailable.
  }
}

async function removeGameMemberships(env, gameId) {
  const normalizedGameId = normalizeRoomId(gameId);
  if (!env.INVITE_INBOX || !normalizedGameId) return;

  try {
    const id = env.INVITE_INBOX.idFromName("invites");
    const inbox = env.INVITE_INBOX.get(id);
    await inbox.fetch(`https://invite-inbox/internal/games/${encodeURIComponent(normalizedGameId)}`, {
      method: "DELETE"
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
