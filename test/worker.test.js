import assert from "node:assert/strict";
import test from "node:test";
import { GameRoom, InviteInbox, parseAdminRoute, parseGameRoute, parseLinkRoute, parsePlayerRoute } from "../workers/game/src/index.js";

test("parseGameRoute recognizes game API routes", () => {
  assert.deepEqual(parseGameRoute("/game/join"), { roomId: "BOARD", action: "join" });
  assert.deepEqual(parseGameRoute("/game/exists"), { roomId: "BOARD", action: "exists" });
  assert.deepEqual(parseGameRoute("/game/move"), { roomId: "BOARD", action: "move" });
  assert.deepEqual(parseGameRoute("/game/rack"), { roomId: "BOARD", action: "rack" });
  assert.deepEqual(parseGameRoute("/game/remove-player"), { roomId: "BOARD", action: "remove-player" });
  assert.deepEqual(parseGameRoute("/game/resign"), { roomId: "BOARD", action: "resign" });
  assert.deepEqual(parseGameRoute("/game/delete"), { roomId: "BOARD", action: "delete" });
  assert.deepEqual(parseGameRoute("/game/reset"), { roomId: "BOARD", action: "reset" });
  assert.deepEqual(parseGameRoute("/game/state"), { roomId: "BOARD", action: "state" });
  assert.deepEqual(parseGameRoute("/game/stream"), { roomId: "BOARD", action: "stream" });
  assert.deepEqual(parseGameRoute("/game/abc123/join"), { roomId: "ABC123", action: "join" });
  assert.deepEqual(parseGameRoute("/game/abc123/exists"), { roomId: "ABC123", action: "exists" });
  assert.deepEqual(parseGameRoute("/game/ABC123/move"), { roomId: "ABC123", action: "move" });
  assert.deepEqual(parseGameRoute("/game/ABC123/rack"), { roomId: "ABC123", action: "rack" });
  assert.deepEqual(parseGameRoute("/game/ABC123/remove-player"), { roomId: "ABC123", action: "remove-player" });
  assert.deepEqual(parseGameRoute("/game/ABC123/resign"), { roomId: "ABC123", action: "resign" });
  assert.deepEqual(parseGameRoute("/game/ABC123/delete"), { roomId: "ABC123", action: "delete" });
  assert.deepEqual(parseGameRoute("/game/ABC123/reset"), { roomId: "ABC123", action: "reset" });
  assert.deepEqual(parseGameRoute("/game/ABC123/state"), { roomId: "ABC123", action: "state" });
  assert.deepEqual(parseGameRoute("/game/ABC123/stream"), { roomId: "ABC123", action: "stream" });
  assert.equal(parseGameRoute("/api/groups/ABC123/sync"), null);
});

test("parsePlayerRoute recognizes player sync routes", () => {
  assert.deepEqual(parsePlayerRoute("/player/p1/games"), { playerId: "p1", action: "games" });
  assert.deepEqual(parsePlayerRoute("/player/p1/invites"), { playerId: "p1", action: "invites" });
  assert.deepEqual(parsePlayerRoute("/player/p1/delete"), { playerId: "p1", action: "delete" });
  assert.deepEqual(parsePlayerRoute("/player/player%201/invites"), { playerId: "player 1", action: "invites" });
  assert.equal(parsePlayerRoute("/player/p1/friends"), null);
});

test("parseLinkRoute recognizes device link routes", () => {
  assert.deepEqual(parseLinkRoute("/link"), { action: "create" });
  assert.deepEqual(parseLinkRoute("/link/"), { action: "create" });
  assert.deepEqual(parseLinkRoute("/link/redeem"), { action: "redeem" });
  assert.deepEqual(parseLinkRoute("/link/redeem/"), { action: "redeem" });
  assert.equal(parseLinkRoute("/link/p1"), null);
});

test("parseAdminRoute recognizes admin user list route", () => {
  assert.deepEqual(parseAdminRoute("/admin/users"), { action: "users" });
  assert.deepEqual(parseAdminRoute("/admin/users/"), { action: "users" });
  assert.equal(parseAdminRoute("/admin/users/p1"), null);
});

test("InviteInbox tracks users and removes a player game ref", async () => {
  const storage = new MemoryStorage();
  const inbox = new InviteInbox({ storage }, {});
  await inbox.ready;

  await inbox.addGameRefs({
    gameId: "ABC123",
    players: [
      { id: "p1", name: "Ada" },
      { id: "p2", name: "Ben" }
    ],
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  await inbox.addGameRefs({
    gameId: "DEF456",
    players: [{ id: "p1", name: "Ada" }],
    updatedAt: "2026-01-02T00:00:00.000Z"
  });

  assert.deepEqual(inbox.listUsers().map(user => ({
    id: user.id,
    name: user.name,
    gameCount: user.gameCount
  })), [
    { id: "p1", name: "Ada", gameCount: 2 },
    { id: "p2", name: "Ben", gameCount: 1 }
  ]);

  const removed = await inbox.removeGameRef("ABC123", "p2");
  assert.deepEqual(removed, { removed: true, gameId: "ABC123", playerId: "p2" });
  assert.deepEqual(inbox.playerGames("p2"), []);
  assert.equal(inbox.userSummary("p2").gameCount, 0);
});

test("InviteInbox account deletion removes player from known and supplied games", async () => {
  const storage = new MemoryStorage();
  const removedGames = [];
  const inbox = new InviteInbox({ storage }, {
    GAME_ROOM: {
      idFromName: gameId => gameId,
      get: gameId => ({
        fetch: async (url, init = {}) => {
          removedGames.push({ gameId, method: init.method, url: String(url) });
          return new Response(JSON.stringify({ removed: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      })
    }
  });
  await inbox.ready;

  await inbox.addGameRefs({
    gameId: "ABC123",
    players: [{ id: "p1", name: "Ada" }],
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  const result = await inbox.deletePlayer("p1", { gameIds: ["DEF456"] });

  assert.equal(result.deleted, true);
  assert.equal(result.playerId, "p1");
  assert.equal(result.gameCount, 2);
  assert.deepEqual(removedGames.map(game => game.gameId).sort(), ["ABC123", "DEF456"]);
  assert.deepEqual(removedGames.map(game => game.method), ["DELETE", "DELETE"]);
  assert.deepEqual(inbox.playerGames("p1"), []);
  assert.equal(inbox.userSummary("p1").gameCount, 0);
});

test("InviteInbox can remove all refs for a game", async () => {
  const storage = new MemoryStorage();
  const inbox = new InviteInbox({ storage }, {});
  await inbox.ready;

  await inbox.addGameRefs({
    gameId: "ABC123",
    players: [
      { id: "p1", name: "Ada" },
      { id: "p2", name: "Ben" }
    ],
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  const result = await inbox.removeGameRefs("ABC123");

  assert.deepEqual(result, { removed: 2, gameId: "ABC123" });
  assert.deepEqual(inbox.playerGames("p1"), []);
  assert.deepEqual(inbox.playerGames("p2"), []);
  assert.deepEqual(inbox.listUsers(), []);
});

test("InviteInbox link codes redeem with latest server game refs and only work once", async () => {
  const storage = new MemoryStorage();
  const inbox = new InviteInbox({ storage }, {});
  await inbox.ready;

  await inbox.addGameRefs({
    gameId: "ABC123",
    players: [{ id: "p1", name: "Ada" }],
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  const created = await inbox.createLinkCode({
    playerId: "p1",
    name: "Ada",
    gameId: "ABC123",
    gameIds: ["ABC123"]
  });

  assert.match(created.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  await inbox.addGameRefs({
    gameId: "DEF456",
    players: [{ id: "p1", name: "Ada" }],
    updatedAt: "2026-01-02T00:00:00.000Z"
  });

  const redeemed = await inbox.redeemLinkCode({ code: created.code });

  assert.deepEqual(redeemed, {
    playerId: "p1",
    playerName: "Ada",
    gameId: "ABC123",
    gameIds: ["ABC123", "DEF456"]
  });

  await assert.rejects(
    () => inbox.redeemLinkCode({ code: created.code }),
    error => error?.status === 404
  );
});

test("GameRoom expires cached game state and can rehydrate from client state", async () => {
  const storage = new MemoryStorage();
  const env = { SYNC_CACHE_TTL_MS: "10" };
  const room = new GameRoom({ storage, getWebSockets: () => [] }, env);
  await room.ready;

  const joinResponse = await room.fetch(new Request("https://game.test/game/ABC123/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: "p1", name: "Ada" })
  }));
  assert.equal(joinResponse.status, 200);
  assert.equal(await storage.get("cacheMeta").then(meta => Boolean(meta?.expiresAt)), true);

  await room.expireCacheIfNeeded(Date.now() + 20);
  assert.equal(room.gameExists("ABC123"), false);
  assert.equal(await storage.get("game"), undefined);

  const stateResponse = await room.fetch(new Request("https://game.test/game/ABC123/state"));
  assert.equal(stateResponse.status, 404);

  const rehydrateResponse = await room.fetch(new Request("https://game.test/game/ABC123/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      playerId: "p1",
      name: "Ada",
      state: {
        id: "ABC123",
        players: {
          p1: { id: "p1", name: "Ada", rack: [], remainingBag: [], score: 7 }
        },
        board: {
          "0,0": { q: 0, r: 0, letter: "A", value: 1, playerId: "p1", tileId: "a", timestamp: 1 }
        }
      }
    })
  }));
  const payload = await rehydrateResponse.json();
  assert.equal(rehydrateResponse.status, 200);
  assert.equal(payload.state.players.p1.score, 7);
  assert.equal(payload.state.board["0,0"].letter, "A");
});

test("GameRoom resign transfers ownership and deletes when last player leaves", async () => {
  const storage = new MemoryStorage();
  const room = new GameRoom({ storage, getWebSockets: () => [] }, {});
  await room.ready;

  await room.fetch(new Request("https://game.test/game/ABC123/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      playerId: "p1",
      name: "Ada",
      invites: [{ id: "p2", name: "Ben" }]
    })
  }));

  const ownerResignResponse = await room.fetch(new Request("https://game.test/game/ABC123/resign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: "p1" })
  }));
  const ownerResign = await ownerResignResponse.json();
  assert.equal(ownerResignResponse.status, 200);
  assert.equal(ownerResign.deleted, false);
  assert.equal(ownerResign.state.ownerId, "p2");
  assert.equal(ownerResign.state.players.p1, undefined);

  const lastResignResponse = await room.fetch(new Request("https://game.test/game/ABC123/resign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: "p2" })
  }));
  const lastResign = await lastResignResponse.json();
  assert.equal(lastResignResponse.status, 200);
  assert.equal(lastResign.deleted, true);
  assert.equal(room.gameExists("ABC123"), false);
  assert.equal(await storage.get("game"), undefined);
});

test("GameRoom delete requires the owner and purges cache", async () => {
  const storage = new MemoryStorage();
  const room = new GameRoom({ storage, getWebSockets: () => [] }, {});
  await room.ready;

  await room.fetch(new Request("https://game.test/game/ABC123/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: "p1", name: "Ada" })
  }));

  const forbidden = await room.fetch(new Request("https://game.test/game/ABC123/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerId: "p2" })
  }));
  assert.equal(forbidden.status, 403);

  const deleted = await room.fetch(new Request("https://game.test/game/ABC123/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerId: "p1" })
  }));
  assert.equal(deleted.status, 200);
  assert.equal(room.gameExists("ABC123"), false);
});

test("InviteInbox expires old membership refs", async () => {
  const storage = new MemoryStorage();
  const inbox = new InviteInbox({ storage }, { SYNC_CACHE_TTL_MS: "10" });
  await inbox.ready;

  await inbox.addGameRefs({
    gameId: "ABC123",
    players: [{ id: "p1", name: "Ada" }],
    updatedAt: "2026-01-01T00:00:00.000Z"
  });

  assert.equal(inbox.playerGames("p1").length, 1);
  await inbox.sweepExpiredRefs(Date.now() + 20);
  assert.deepEqual(inbox.playerGames("p1"), []);
  assert.deepEqual(inbox.listUsers(), []);
});

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.alarm = null;
  }

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async setAlarm(value) {
    this.alarm = value;
  }

  async deleteAlarm() {
    this.alarm = null;
  }
}
