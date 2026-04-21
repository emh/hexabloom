import assert from "node:assert/strict";
import test from "node:test";
import {
  GameRuleError,
  LETTER_DISTRIBUTION,
  applyMove,
  createGameState,
  createMove,
  createPlayer,
  hexKey,
  isGameComplete,
  joinGame,
  placementAxis,
  playerTilesLeft,
  resetGameState,
  validateMove
} from "../app/model.js";

function allowWords(values) {
  const words = new Set(values);
  return { isWordAllowed: word => words.has(word) };
}

function gameWithPlayers() {
  let game = createGameState({ id: "TEST01" });
  game = joinGame(game, { playerId: "p1", name: "Ada" }).state;
  game = joinGame(game, { playerId: "p2", name: "Ben" }).state;
  return game;
}

function forceRack(game, playerId, letters) {
  const player = game.players[playerId];
  player.rack = letters.map((letter, index) => ({
    id: `${playerId}-${index}`,
    letter,
    value: 1
  }));
  player.remainingBag = [];
}

const TILES_PER_BAG = Object.values(LETTER_DISTRIBUTION).reduce((sum, count) => sum + count, 0);

test("placementAxis accepts contiguous placements on one of the three hex axes", () => {
  assert.equal(placementAxis([{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }]).index, 0);
  assert.equal(placementAxis([{ q: 0, r: 0 }, { q: 0, r: 1 }, { q: 0, r: 2 }]).index, 1);
  assert.equal(placementAxis([{ q: 0, r: 0 }, { q: 1, r: -1 }, { q: 2, r: -2 }]).index, 2);
  assert.throws(() => placementAxis([{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 3, r: 0 }]), GameRuleError);
});

test("first move can be free within the initial bloom", () => {
  const game = gameWithPlayers();
  forceRack(game, "p1", ["C", "A", "T", "E", "R", "S"]);
  const move = createMove("p1", [
    { q: 0, r: 0, tileId: "p1-0" },
    { q: 1, r: 0, tileId: "p1-1" },
    { q: 2, r: 0, tileId: "p1-2" }
  ], 100);
  const result = applyMove(game, move);

  assert.equal(result.accepted, true);
  assert.equal(result.state.board[hexKey(0, 0)].letter, "C");
  assert.equal(result.state.players.p1.score, 3);
  assert.equal(result.move.playerName, "Ada");
  assert.equal(result.move.words[0].text, "CAT");
});

test("subsequent moves must connect to another player's word", () => {
  let game = gameWithPlayers();
  forceRack(game, "p1", ["C", "A", "T", "E", "R", "S"]);
  forceRack(game, "p2", ["D", "O", "G", "E", "R", "S"]);
  game = applyMove(game, createMove("p1", [
    { q: 0, r: 0, tileId: "p1-0" },
    { q: 1, r: 0, tileId: "p1-1" },
    { q: 2, r: 0, tileId: "p1-2" }
  ], 100)).state;

  assert.throws(() => validateMove(game, createMove("p2", [
    { q: -2, r: 2, tileId: "p2-0" },
    { q: -1, r: 2, tileId: "p2-1" }
  ], 101)), /existing bloom/);

  const valid = validateMove(game, createMove("p2", [
    { q: -1, r: 0, tileId: "p2-0" }
  ], 102));
  assert.equal(valid.words[0].text, "DCAT");
  assert.equal(valid.score, 4);
});

test("same-player-only extensions are rejected after the first move", () => {
  let game = gameWithPlayers();
  forceRack(game, "p1", ["C", "A", "T", "S", "E", "R"]);
  game = applyMove(game, createMove("p1", [
    { q: 0, r: 0, tileId: "p1-0" },
    { q: 1, r: 0, tileId: "p1-1" },
    { q: 2, r: 0, tileId: "p1-2" }
  ], 100)).state;

  assert.throws(() => validateMove(game, createMove("p1", [
    { q: 3, r: 0, tileId: "p1-3" }
  ], 101)), /another player's tile/);
});

test("existing board tiles can bridge gaps between placed tiles", () => {
  const game = gameWithPlayers();
  forceRack(game, "p1", ["L", "I", "E"]);
  forceRack(game, "p2", []);
  game.board = {
    "0,0": { q: 0, r: 0, letter: "F", value: 4, playerId: "p2", tileId: "f", timestamp: 1 }
  };

  const valid = validateMove(game, createMove("p1", [
    { q: -2, r: 0, tileId: "p1-0" },
    { q: -1, r: 0, tileId: "p1-1" },
    { q: 1, r: 0, tileId: "p1-2" }
  ], 101));

  assert.equal(valid.words[0].text, "LIFE");
});

test("bounds expand from occupied hexes without remapping coordinates", () => {
  let game = gameWithPlayers();
  forceRack(game, "p1", ["A", "B", "C", "D", "E", "F"]);
  const result = applyMove(game, createMove("p1", [
    { q: 5, r: 0, tileId: "p1-0" }
  ], 100));

  assert.equal(result.state.board[hexKey(5, 0)].letter, "A");
  assert.equal(result.state.bounds.maxQ, 11);
  assert.equal(result.state.bounds.minQ, -1);
});

test("dictionary validation checks every word formed across all three axes", () => {
  const game = gameWithPlayers();
  forceRack(game, "p1", ["A"]);
  game.board = {
    "-1,0": { q: -1, r: 0, letter: "C", value: 1, playerId: "p2", tileId: "c", timestamp: 1 },
    "1,0": { q: 1, r: 0, letter: "T", value: 1, playerId: "p2", tileId: "t", timestamp: 1 },
    "-1,1": { q: -1, r: 1, letter: "H", value: 1, playerId: "p2", tileId: "h", timestamp: 1 },
    "1,-1": { q: 1, r: -1, letter: "T", value: 1, playerId: "p2", tileId: "t2", timestamp: 1 },
    "0,1": { q: 0, r: 1, letter: "D", value: 1, playerId: "p2", tileId: "d", timestamp: 1 },
    "0,-1": { q: 0, r: -1, letter: "B", value: 1, playerId: "p2", tileId: "b", timestamp: 1 }
  };

  const move = createMove("p1", [{ q: 0, r: 0, tileId: "p1-0" }], 100);

  assert.throws(() => validateMove(game, move, allowWords(["CAT", "HAT"])), /BAD is not in the dictionary/);

  const valid = validateMove(game, move, allowWords(["CAT", "HAT", "BAD"]));
  assert.deepEqual(valid.words.map(word => word.text).sort(), ["BAD", "CAT", "HAT"]);
});

test("createPlayer deals eleven rack tiles and a remaining bag", () => {
  const player = createPlayer({ id: "p1", name: "Ada" });
  assert.equal(player.rack.length, 11);
  assert.ok(player.remainingBag.length > 80);
});

test("game length controls how many tile bags each player receives", () => {
  let game = createGameState({ id: "LONG01", tileBagCount: 3 });
  game = joinGame(game, { playerId: "p1", name: "Ada" }).state;

  assert.equal(game.gameLength, "medium");
  assert.equal(game.players.p1.rack.length, 11);
  assert.equal(game.players.p1.remainingBag.length, TILES_PER_BAG * 3 - 11);

  const reset = resetGameState(game, { seed: "medium-reset" });
  assert.equal(reset.tileBagCount, 3);
  assert.equal(reset.players.p1.remainingBag.length, TILES_PER_BAG * 3 - 11);
});

test("game is complete when every joined player has used all tiles", () => {
  const game = gameWithPlayers();
  game.players.p1.rack = [];
  game.players.p1.remainingBag = [];
  game.players.p1.isFinished = true;
  game.players.p2.rack = [];
  game.players.p2.remainingBag = [];
  game.players.p2.isFinished = true;

  assert.equal(playerTilesLeft(game.players.p1), 0);
  assert.equal(isGameComplete(game), true);
  assert.throws(() => joinGame(game, { playerId: "p3", name: "Cid" }), /Game is complete/);

  const rejoined = joinGame(game, { playerId: "p1", name: "Ada" });
  assert.equal(rejoined.created, false);
});

test("createPlayer returns overflow rack tiles to the bag", () => {
  const rack = Array.from({ length: 12 }, (_, index) => ({
    id: `tile-${index}`,
    letter: "A",
    value: 1
  }));
  const remainingBag = [{ id: "bag-0", letter: "B", value: 3 }];
  const player = createPlayer({ id: "p1", name: "Ada", rack, remainingBag });

  assert.equal(player.rack.length, 11);
  assert.equal(player.remainingBag.length, 2);
  assert.deepEqual(
    [...player.rack, ...player.remainingBag].map(tile => tile.id).sort(),
    [...rack, ...remainingBag].map(tile => tile.id).sort()
  );
});

test("resetGameState clears board and redeals joined players", () => {
  let game = gameWithPlayers();
  forceRack(game, "p1", ["C", "A", "T"]);
  game = applyMove(game, createMove("p1", [
    { q: 0, r: 0, tileId: "p1-0" },
    { q: 1, r: 0, tileId: "p1-1" },
    { q: 2, r: 0, tileId: "p1-2" }
  ], 100)).state;

  const reset = resetGameState(game, { seed: "test-reset" });

  assert.equal(Object.keys(reset.board).length, 0);
  assert.equal(reset.players.p1.score, 0);
  assert.equal(reset.players.p2.score, 0);
  assert.equal(reset.players.p1.rack.length, 11);
  assert.equal(reset.players.p2.rack.length, 11);
  assert.equal(reset.players.p1.remainingBag.length, 87);
});
