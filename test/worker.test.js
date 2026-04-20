import assert from "node:assert/strict";
import test from "node:test";
import { parseGameRoute } from "../workers/game/src/index.js";

test("parseGameRoute recognizes game API routes", () => {
  assert.deepEqual(parseGameRoute("/game/join"), { roomId: "BOARD", action: "join" });
  assert.deepEqual(parseGameRoute("/game/move"), { roomId: "BOARD", action: "move" });
  assert.deepEqual(parseGameRoute("/game/rack"), { roomId: "BOARD", action: "rack" });
  assert.deepEqual(parseGameRoute("/game/reset"), { roomId: "BOARD", action: "reset" });
  assert.deepEqual(parseGameRoute("/game/state"), { roomId: "BOARD", action: "state" });
  assert.deepEqual(parseGameRoute("/game/stream"), { roomId: "BOARD", action: "stream" });
  assert.deepEqual(parseGameRoute("/game/abc123/join"), { roomId: "ABC123", action: "join" });
  assert.deepEqual(parseGameRoute("/game/ABC123/move"), { roomId: "ABC123", action: "move" });
  assert.deepEqual(parseGameRoute("/game/ABC123/rack"), { roomId: "ABC123", action: "rack" });
  assert.deepEqual(parseGameRoute("/game/ABC123/reset"), { roomId: "ABC123", action: "reset" });
  assert.deepEqual(parseGameRoute("/game/ABC123/state"), { roomId: "ABC123", action: "state" });
  assert.deepEqual(parseGameRoute("/game/ABC123/stream"), { roomId: "ABC123", action: "stream" });
  assert.equal(parseGameRoute("/api/groups/ABC123/sync"), null);
});
