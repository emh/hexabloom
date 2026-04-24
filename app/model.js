export const EDGE_BUFFER = 6;
export const INITIAL_RADIUS = 5;
export const RACK_SIZE = 11;
export const GLOBAL_ROOM_ID = "BOARD";
export const DEFAULT_GAME_LENGTH = "short";
export const BLOOM_BONUS = 12;

export const GAME_LENGTHS = Object.freeze({
  short: Object.freeze({ key: "short", label: "Short", tileBagCount: 1 }),
  medium: Object.freeze({ key: "medium", label: "Medium", tileBagCount: 3 }),
  long: Object.freeze({ key: "long", label: "Long", tileBagCount: 5 })
});

export const BONUS_TYPES = Object.freeze({
  DOUBLE_LETTER: "double-letter",
  TRIPLE_LETTER: "triple-letter",
  DOUBLE_WORD: "double-word",
  TRIPLE_WORD: "triple-word"
});

export const DIRECTIONS = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 }
];

export const AXES = [
  { q: 1, r: 0 },
  { q: 0, r: 1 },
  { q: 1, r: -1 }
];

export const LETTER_VALUES = {
  A: 1,
  B: 3,
  C: 3,
  D: 2,
  E: 1,
  F: 4,
  G: 2,
  H: 4,
  I: 1,
  J: 8,
  K: 5,
  L: 1,
  M: 3,
  N: 1,
  O: 1,
  P: 3,
  Q: 10,
  R: 1,
  S: 1,
  T: 1,
  U: 1,
  V: 4,
  W: 4,
  X: 8,
  Y: 4,
  Z: 10
};

export const LETTER_DISTRIBUTION = {
  A: 9,
  B: 2,
  C: 2,
  D: 4,
  E: 12,
  F: 2,
  G: 3,
  H: 2,
  I: 9,
  J: 1,
  K: 1,
  L: 4,
  M: 2,
  N: 6,
  O: 8,
  P: 2,
  Q: 1,
  R: 6,
  S: 4,
  T: 6,
  U: 4,
  V: 2,
  W: 2,
  X: 1,
  Y: 2,
  Z: 1
};

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class GameRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = "GameRuleError";
    this.status = 400;
  }
}

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createDeviceId() {
  return createId();
}

export function randomRoomId(length = 6) {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, byte => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join("");
}

export function normalizeRoomId(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

export function normalizePlayerName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
}

export function normalizeGameLength(value) {
  const key = String(value || "").trim().toLowerCase();
  if (GAME_LENGTHS[key]) return key;
  return DEFAULT_GAME_LENGTH;
}

export function normalizeTileBagCount(value) {
  const count = Math.max(1, Number.parseInt(value, 10) || 1);
  const match = Object.values(GAME_LENGTHS).find(length => length.tileBagCount === count);
  return match ? match.tileBagCount : GAME_LENGTHS[DEFAULT_GAME_LENGTH].tileBagCount;
}

export function gameLengthFromTileBagCount(value) {
  const count = normalizeTileBagCount(value);
  return Object.values(GAME_LENGTHS).find(length => length.tileBagCount === count)?.key || DEFAULT_GAME_LENGTH;
}

export function hexKey(q, r) {
  return `${q},${r}`;
}

export function parseHexKey(key) {
  const [q, r] = String(key).split(",").map(Number);
  return { q, r };
}

export function hexS(q, r) {
  return -q - r;
}

export function addHex(hex, delta) {
  return { q: hex.q + delta.q, r: hex.r + delta.r };
}

export function scaleHex(delta, scale) {
  return { q: delta.q * scale, r: delta.r * scale };
}

export function initialBounds(radius = INITIAL_RADIUS) {
  return {
    minQ: -radius,
    maxQ: radius,
    minR: -radius,
    maxR: radius,
    minS: -radius,
    maxS: radius
  };
}

export function isWithinBounds(hex, bounds) {
  const s = hexS(hex.q, hex.r);
  return (
    hex.q >= bounds.minQ &&
    hex.q <= bounds.maxQ &&
    hex.r >= bounds.minR &&
    hex.r <= bounds.maxR &&
    s >= bounds.minS &&
    s <= bounds.maxS
  );
}

export function createTileBag(seed = createId(), tileBagCount = 1) {
  const tiles = [];
  let index = 0;
  const bagCount = normalizeTileBagCount(tileBagCount);

  for (let bag = 0; bag < bagCount; bag += 1) {
    for (const [letter, count] of Object.entries(LETTER_DISTRIBUTION)) {
      for (let copy = 0; copy < count; copy += 1) {
        tiles.push({
          id: `${seed}-${index.toString(36)}`,
          letter,
          value: LETTER_VALUES[letter] || 1
        });
        index += 1;
      }
    }
  }

  return shuffleWithSeed(tiles, seed);
}

export function createPlayer(input = {}) {
  const id = String(input.id || createId());
  const name = normalizePlayerName(input.name) || "Player";
  let rack;
  let remainingBag;

  if (Array.isArray(input.rack)) {
    rack = normalizeTiles(input.rack);
    remainingBag = Array.isArray(input.remainingBag) ? normalizeTiles(input.remainingBag) : [];
    ({ rack, remainingBag } = returnOverflowRackTiles(rack, remainingBag, `${id}:${name}`));
  } else {
    const bag = Array.isArray(input.remainingBag)
      ? normalizeTiles(input.remainingBag)
      : createTileBag(input.seed || `${id}:${name}`, input.tileBagCount || input.bagCount);
    rack = bag.splice(0, RACK_SIZE);
    remainingBag = bag;
  }

  const player = {
    id,
    name,
    rack,
    remainingBag,
    score: Math.max(0, Number.parseInt(input.score, 10) || 0),
    isFinished: Boolean(input.isFinished)
  };

  if (!player.isFinished) drawRack(player);
  player.isFinished = player.rack.length === 0 && player.remainingBag.length === 0;
  return player;
}

export function createGameState(input = {}) {
  const board = normalizeBoard(input.board);
  const players = {};
  const removedPlayers = normalizeRemovedPlayers(input.removedPlayers);
  const tileBagCount = normalizeTileBagCount(
    input.tileBagCount ?? input.bagCount ?? GAME_LENGTHS[normalizeGameLength(input.gameLength)].tileBagCount
  );
  const createdAt = typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString();
  const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : createdAt;

  if (input.players && typeof input.players === "object") {
    for (const player of Object.values(input.players)) {
      const normalized = createPlayer(player);
      players[normalized.id] = normalized;
    }
  }

  const ownerId = normalizeOwnerId(input.ownerId, players);
  const bounds = recomputeBoardBounds(board);
  const bonusSeed = normalizeBonusSeed(input.bonusSeed, input.id, createdAt);
  const hasStoredBonusSpaces = Object.prototype.hasOwnProperty.call(input || {}, "bonusSpaces");
  const bonusSpaces = normalizeBonusSpaces(input.bonusSpaces, board, bounds);
  if (!hasStoredBonusSpaces && !Object.keys(board).length) {
    Object.assign(bonusSpaces, generateBonusSpacesForBounds(bounds, board, bonusSeed));
  }
  const blooms = normalizeBlooms(input.blooms, board, bounds);

  return {
    id: normalizeRoomId(input.id),
    ownerId,
    tileBagCount,
    gameLength: gameLengthFromTileBagCount(tileBagCount),
    board,
    bonusSeed,
    bonusSpaces,
    blooms,
    players,
    removedPlayers,
    moves: Array.isArray(input.moves) ? input.moves.map(normalizeMoveRecord).filter(Boolean) : [],
    bounds,
    createdAt,
    updatedAt
  };
}

export function resetGameState(inputState, options = {}) {
  const state = createGameState(inputState);
  const seed = String(options.seed || createId());
  const players = {};

  for (const player of Object.values(state.players)) {
    const bag = createTileBag(`${seed}:${player.id}:${player.name}`, state.tileBagCount);
    const rack = bag.splice(0, RACK_SIZE);
    const resetPlayer = createPlayer({
      id: player.id,
      name: player.name,
      rack,
      remainingBag: bag,
      score: 0,
      isFinished: false
    });
    players[resetPlayer.id] = resetPlayer;
  }

  return createGameState({
    id: state.id,
    ownerId: state.ownerId,
    tileBagCount: state.tileBagCount,
    bonusSeed: createId(),
    players,
    removedPlayers: state.removedPlayers,
    createdAt: state.createdAt,
    updatedAt: new Date().toISOString()
  });
}

export function joinGame(inputState, input = {}) {
  const state = createGameState(inputState);
  const id = String(input.playerId || input.id || createId());
  const name = normalizePlayerName(input.name) || "Player";
  const existing = state.players[id];

  if (!existing && state.removedPlayers[id]) {
    throw new GameRuleError("Player has been removed from this board");
  }

  if (existing) {
    existing.name = name;
    drawRack(existing);
    existing.isFinished = existing.rack.length === 0 && existing.remainingBag.length === 0;
    return { state, player: existing, created: false };
  }

  if (isGameComplete(state)) throw new GameRuleError("Game is complete");

  const player = createPlayer({
    id,
    name,
    tileBagCount: state.tileBagCount,
    seed: playerSeedForGame(state, id)
  });
  state.players[player.id] = player;
  if (!state.ownerId) state.ownerId = player.id;
  state.updatedAt = new Date().toISOString();
  return { state, player, created: true };
}

export function removePlayerFromGame(inputState, input = {}) {
  const state = createGameState(inputState);
  const playerId = String(input.playerId || input.targetPlayerId || "").trim().slice(0, 128);
  if (!playerId) throw new GameRuleError("Player is required");
  if (!state.players[playerId]) throw new GameRuleError("Player is not in this board");
  if (playerId === state.ownerId && !input.allowOwnerRemoval) throw new GameRuleError("Board owner cannot be removed");

  const player = state.players[playerId];
  delete state.players[playerId];
  if (playerId === state.ownerId) state.ownerId = Object.keys(state.players)[0] || "";
  state.removedPlayers[playerId] = {
    id: player.id,
    name: input.redactPlayerData ? "" : player.name,
    removedAt: new Date().toISOString()
  };
  if (input.redactPlayerData) redactPlayerDataFromGame(state, playerId);
  state.updatedAt = new Date().toISOString();
  return { state, player };
}

export function createMove(playerId, placements, timestamp = Date.now()) {
  return {
    id: createId(),
    playerId,
    placements: placements.map(placement => ({
      q: Number(placement.q),
      r: Number(placement.r),
      tileId: String(placement.tileId)
    })),
    timestamp
  };
}

export function applyMove(inputState, inputMove, options = {}) {
  const state = createGameState(inputState);
  const duplicate = state.moves.find(move => move.id === inputMove?.id);
  if (duplicate) return { state, move: duplicate, accepted: false, duplicate: true };

  const validation = validateMove(state, inputMove, options);
  const player = state.players[validation.move.playerId];
  const usedTileIds = new Set(validation.move.placements.map(placement => placement.tileId));
  const previousBounds = state.bounds;

  for (const placement of validation.move.placements) {
    const tile = validation.tilesById.get(placement.tileId);
    const key = hexKey(placement.q, placement.r);
    state.board[key] = {
      q: placement.q,
      r: placement.r,
      letter: tile.letter,
      value: tile.value,
      playerId: player.id,
      tileId: tile.id,
      moveId: validation.move.id,
      timestamp: validation.move.timestamp
    };
  }

  player.rack = player.rack.filter(tile => !usedTileIds.has(tile.id));
  drawRack(player);
  player.score += validation.score;
  player.isFinished = player.rack.length === 0 && player.remainingBag.length === 0;

  const moveRecord = {
    ...validation.move,
    playerName: player.name,
    score: validation.score,
    blooms: validation.newBlooms.map(bloom => ({
      q: bloom.q,
      r: bloom.r,
      key: bloom.key,
      playerId: bloom.playerId,
      moveId: bloom.moveId,
      createdAt: bloom.createdAt
    })),
    words: validation.words.map(word => ({
      text: word.text,
      value: word.value,
      keys: word.keys,
      score: word.score,
      bonuses: word.bonuses,
      reverseText: word.reverseText
    })),
    scoreBreakdown: validation.scoreBreakdown
  };

  for (const placement of validation.move.placements) {
    delete state.blooms[hexKey(placement.q, placement.r)];
  }
  state.moves.push(moveRecord);
  for (const bloom of validation.newBlooms) {
    state.blooms[bloom.key] = bloom;
  }
  state.bounds = recomputeBoardBounds(state.board);
  state.bonusSpaces = advanceBonusSpaces(
    state.bonusSpaces,
    validation.move.placements,
    state.board,
    previousBounds,
    state.bounds,
    state.bonusSeed
  );
  state.updatedAt = new Date().toISOString();

  return {
    state,
    move: moveRecord,
    words: validation.words,
    score: validation.score,
    scoreBreakdown: validation.scoreBreakdown,
    accepted: true,
    duplicate: false
  };
}

export function validateMove(inputState, inputMove, options = {}) {
  const state = createGameState(inputState);
  const move = normalizeMove(inputMove);
  const player = state.players[move.playerId];

  if (!player) throw new GameRuleError("Player is not in this board");
  if (player.isFinished) throw new GameRuleError("Player has no tiles left");
  if (!move.placements.length) throw new GameRuleError("Place at least one tile");
  if (move.placements.length > RACK_SIZE) throw new GameRuleError(`A move can use at most ${RACK_SIZE} tiles`);

  const seenCells = new Set();
  const seenTiles = new Set();
  const tilesById = new Map(player.rack.map(tile => [tile.id, tile]));

  for (const placement of move.placements) {
    if (!Number.isInteger(placement.q) || !Number.isInteger(placement.r)) {
      throw new GameRuleError("Tiles must snap to a hex");
    }

    const key = hexKey(placement.q, placement.r);
    if (seenCells.has(key)) throw new GameRuleError("Two tiles cannot occupy the same hex");
    if (seenTiles.has(placement.tileId)) throw new GameRuleError("A tile can only be used once");
    if (!isWithinBounds(placement, state.bounds)) throw new GameRuleError("That hex is outside the current bloom");
    if (state.board[key]) throw new GameRuleError("That hex is already occupied");
    if (!tilesById.has(placement.tileId)) throw new GameRuleError("That tile is no longer in your rack");

    seenCells.add(key);
    seenTiles.add(placement.tileId);
  }

  const axis = placementAxis(move.placements, state.board);
  const boardHasTiles = Object.keys(state.board).length > 0;
  const connected = move.placements.some(placement => neighbors(placement).some(hex => state.board[hexKey(hex.q, hex.r)]));
  const draftBoard = boardWithPlacements(state.board, move.placements, player, tilesById, move);
  const words = findFormedWords(draftBoard, move.placements);

  if (boardHasTiles && !connected) {
    throw new GameRuleError("Place next to the existing bloom");
  }

  if (boardHasTiles && !words.some(word => word.cells.some(cell => cell.playerId !== player.id))) {
    throw new GameRuleError("At least one word must use another player's tile");
  }

  validateDictionaryWords(words, options);

  const newBlooms = findNewBlooms(state.board, draftBoard, move.placements, state.blooms, move, player);
  const scoring = scoreMove(words, move.placements, tilesById, state.bonusSpaces, newBlooms, options);

  return {
    move,
    player,
    axis,
    words: scoring.words,
    score: scoring.score,
    scoreBreakdown: scoring.scoreBreakdown,
    tilesById,
    draftBoard,
    newBlooms
  };
}

export function placementAxis(placements, board = {}) {
  if (placements.length <= 1) return null;

  for (let axisIndex = 0; axisIndex < AXES.length; axisIndex += 1) {
    const invariant = lineInvariant(placements[0], axisIndex);
    if (!placements.every(hex => lineInvariant(hex, axisIndex) === invariant)) continue;

    const positions = placements.map(hex => linePosition(hex, axisIndex)).sort((left, right) => left - right);
    const placedPositions = new Set(positions);
    if (placedPositions.size !== positions.length) continue;

    let contiguous = true;
    for (let position = positions[0]; position <= positions[positions.length - 1]; position += 1) {
      const hex = hexOnLine(axisIndex, invariant, position);
      if (!placedPositions.has(position) && !board[hexKey(hex.q, hex.r)]) {
        contiguous = false;
        break;
      }
    }

    if (contiguous) {
      return {
        index: axisIndex,
        direction: AXES[axisIndex],
        invariant,
        positions
      };
    }
  }

  throw new GameRuleError("Tiles must be played in a straight line.");
}

export function findFormedWords(board, placements) {
  const words = new Map();

  for (const placement of placements) {
    for (let axisIndex = 0; axisIndex < AXES.length; axisIndex += 1) {
      const word = findWordAt(board, placement, AXES[axisIndex]);
      if (word.cells.length < 2) continue;
      words.set(word.keys.join("|"), word);
    }
  }

  return Array.from(words.values());
}

export function findWordAt(board, hex, axis) {
  let start = { q: hex.q, r: hex.r };
  const backward = scaleHex(axis, -1);

  while (board[hexKey(start.q + backward.q, start.r + backward.r)]) {
    start = addHex(start, backward);
  }

  const cells = [];
  let cursor = start;

  while (board[hexKey(cursor.q, cursor.r)]) {
    const key = hexKey(cursor.q, cursor.r);
    cells.push({ key, ...board[key] });
    cursor = addHex(cursor, axis);
  }

  return {
    cells,
    keys: cells.map(cell => cell.key),
    text: cells.map(cell => cell.letter).join(""),
    value: cells.reduce((sum, cell) => sum + (Number(cell.value) || LETTER_VALUES[cell.letter] || 1), 0)
  };
}

export function normalizeWord(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
}

export function recomputeBoardBounds(board) {
  const cells = Object.values(board || {});
  if (!cells.length) return initialBounds();

  let minQ = Infinity;
  let maxQ = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;
  let minS = Infinity;
  let maxS = -Infinity;

  for (const cell of cells) {
    const q = Number(cell.q);
    const r = Number(cell.r);
    const s = hexS(q, r);
    minQ = Math.min(minQ, q);
    maxQ = Math.max(maxQ, q);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
    minS = Math.min(minS, s);
    maxS = Math.max(maxS, s);
  }

  return {
    minQ: minQ - EDGE_BUFFER,
    maxQ: maxQ + EDGE_BUFFER,
    minR: minR - EDGE_BUFFER,
    maxR: maxR + EDGE_BUFFER,
    minS: minS - EDGE_BUFFER,
    maxS: maxS + EDGE_BUFFER
  };
}

export function neighbors(hex) {
  return DIRECTIONS.map(direction => addHex(hex, direction));
}

export function orderedPlayers(players) {
  return Object.values(players || {}).sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.name.localeCompare(right.name);
  });
}

export function playerTilesLeft(player = {}) {
  return (Array.isArray(player.rack) ? player.rack.length : 0) +
    (Array.isArray(player.remainingBag) ? player.remainingBag.length : 0);
}

export function isGameComplete(state = {}) {
  const players = Object.values(state.players || {});
  return players.length > 0 && players.every(player => player.isFinished || playerTilesLeft(player) === 0);
}

export function boardWithPlacements(board, placements, player, tilesById, move) {
  const draft = { ...(board || {}) };

  for (const placement of placements) {
    const tile = tilesById.get(placement.tileId);
    draft[hexKey(placement.q, placement.r)] = {
      q: placement.q,
      r: placement.r,
      letter: tile.letter,
      value: tile.value,
      playerId: player.id,
      tileId: tile.id,
      moveId: move.id,
      timestamp: move.timestamp
    };
  }

  return draft;
}

export function drawRack(player) {
  while (player.rack.length < RACK_SIZE && player.remainingBag.length) {
    player.rack.push(player.remainingBag.shift());
  }
}

function returnOverflowRackTiles(rack, remainingBag, seed) {
  if (rack.length <= RACK_SIZE) return { rack, remainingBag };

  const overflowCount = rack.length - RACK_SIZE;
  const rackIds = rack.map(tile => tile.id).join(",");
  const shuffledIndexes = shuffleWithSeed(rack.map((_, index) => index), `${seed}:rack-overflow:${rackIds}`);
  const returnedIndexes = new Set(shuffledIndexes.slice(0, overflowCount));
  const keptRack = [];
  const returnedTiles = [];

  for (let index = 0; index < rack.length; index += 1) {
    if (returnedIndexes.has(index)) {
      returnedTiles.push(rack[index]);
    } else {
      keptRack.push(rack[index]);
    }
  }

  return {
    rack: keptRack,
    remainingBag: insertTilesIntoBag(remainingBag, returnedTiles, `${seed}:bag-overflow:${rackIds}`)
  };
}

function insertTilesIntoBag(bag, tiles, seed) {
  const result = bag.slice();
  const random = seededRandom(hashString(seed));

  for (const tile of shuffleWithSeed(tiles, `${seed}:order`)) {
    const index = Math.floor(random() * (result.length + 1));
    result.splice(index, 0, tile);
  }

  return result;
}

function normalizeMove(input = {}) {
  return {
    id: String(input.id || createId()),
    playerId: String(input.playerId || ""),
    placements: Array.isArray(input.placements)
      ? input.placements.map(placement => ({
        q: Number(placement.q),
        r: Number(placement.r),
        tileId: String(placement.tileId || "")
      }))
      : [],
    timestamp: Number.isFinite(Number(input.timestamp)) ? Number(input.timestamp) : Date.now()
  };
}

function normalizeMoveRecord(input = {}) {
  if (!input || typeof input !== "object" || !input.id) return null;
  return {
    ...normalizeMove(input),
    playerName: normalizePlayerName(input.playerName),
    score: Math.max(0, Number.parseInt(input.score, 10) || 0),
    blooms: Array.isArray(input.blooms) ? input.blooms.map(normalizeBloomRecord).filter(Boolean) : [],
    words: Array.isArray(input.words) ? input.words.map(normalizeMoveWordRecord).filter(Boolean) : [],
    scoreBreakdown: normalizeScoreBreakdown(input.scoreBreakdown, input.score)
  };
}

function normalizeOwnerId(input, players = {}) {
  const id = typeof input === "string" ? input.trim().slice(0, 128) : "";
  if (id && players[id]) return id;
  return Object.keys(players)[0] || "";
}

function normalizeRemovedPlayers(input = {}) {
  const removed = {};
  if (!input || typeof input !== "object") return removed;

  const values = Array.isArray(input) ? input : Object.values(input);
  for (const player of values) {
    const id = String(player?.id || player?.playerId || "").trim().slice(0, 128);
    if (!id) continue;
    removed[id] = {
      id,
      name: normalizePlayerName(player?.name),
      removedAt: typeof player?.removedAt === "string" ? player.removedAt : ""
    };
  }

  return removed;
}

function redactPlayerDataFromGame(state, playerId) {
  for (const cell of Object.values(state.board)) {
    if (cell.playerId !== playerId) continue;
    cell.playerId = "";
    cell.tileId = "";
  }

  for (const bloom of Object.values(state.blooms || {})) {
    if (bloom.playerId !== playerId) continue;
    bloom.playerId = "";
  }

  for (const move of state.moves) {
    if (move.playerId !== playerId) continue;
    move.playerId = "";
    move.playerName = "deleted player";
    for (const bloom of move.blooms || []) {
      bloom.playerId = "";
    }
    for (const placement of move.placements || []) {
      placement.tileId = "";
    }
  }
}

function normalizeBoard(input = {}) {
  const board = {};
  if (!input || typeof input !== "object") return board;

  for (const [rawKey, rawCell] of Object.entries(input)) {
    const q = Number.isFinite(Number(rawCell?.q)) ? Number(rawCell.q) : parseHexKey(rawKey).q;
    const r = Number.isFinite(Number(rawCell?.r)) ? Number(rawCell.r) : parseHexKey(rawKey).r;
    if (!Number.isInteger(q) || !Number.isInteger(r)) continue;

    const letter = normalizeLetter(rawCell.letter);
    if (!letter) continue;

    board[hexKey(q, r)] = {
      q,
      r,
      letter,
      value: Math.max(1, Number.parseInt(rawCell.value, 10) || LETTER_VALUES[letter] || 1),
      playerId: String(rawCell.playerId || ""),
      tileId: String(rawCell.tileId || ""),
      moveId: String(rawCell.moveId || ""),
      timestamp: Number.isFinite(Number(rawCell.timestamp)) ? Number(rawCell.timestamp) : 0
    };
  }

  return board;
}

function normalizeTiles(input = []) {
  return input
    .map(tile => {
      const letter = normalizeLetter(tile?.letter);
      if (!letter) return null;
      return {
        id: String(tile.id || createId()),
        letter,
        value: Math.max(1, Number.parseInt(tile.value, 10) || LETTER_VALUES[letter] || 1)
      };
    })
    .filter(Boolean);
}

function normalizeLetter(value) {
  const letter = String(value || "").trim().toUpperCase()[0] || "";
  return /^[A-Z]$/.test(letter) ? letter : "";
}

export function bonusCode(type) {
  if (type === BONUS_TYPES.DOUBLE_LETTER) return "2L";
  if (type === BONUS_TYPES.TRIPLE_LETTER) return "3L";
  if (type === BONUS_TYPES.DOUBLE_WORD) return "2W";
  if (type === BONUS_TYPES.TRIPLE_WORD) return "3W";
  return "";
}

function normalizeBonusSeed(value, gameId, createdAt) {
  const seed = String(value || `${normalizeRoomId(gameId)}:${createdAt}`).trim();
  return seed || `BOARD:${createdAt}`;
}

function playerSeedForGame(state, playerId) {
  return `${normalizeRoomId(state?.id)}:${state?.createdAt || ""}:${String(playerId || "").trim()}`;
}

function normalizeBonusSpaces(input = {}, board = {}, bounds = initialBounds()) {
  const bonusSpaces = {};
  if (!input || typeof input !== "object") return bonusSpaces;

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const { q, r } = parseHexKey(rawKey);
    if (!Number.isInteger(q) || !Number.isInteger(r)) continue;
    const key = hexKey(q, r);
    if (board[key]) continue;
    if (!isWithinBounds({ q, r }, bounds)) continue;

    const type = normalizeBonusType(rawValue?.type ?? rawValue);
    if (!type) continue;
    bonusSpaces[key] = type;
  }

  return bonusSpaces;
}

function normalizeBlooms(input = {}, board = {}, bounds = initialBounds()) {
  const blooms = {};
  if (!input || typeof input !== "object") return blooms;

  const entries = Array.isArray(input)
    ? input.map(bloom => [bloom?.key || hexKey(bloom?.q, bloom?.r), bloom])
    : Object.entries(input);
  for (const [rawKey, bloom] of entries) {
    const normalized = normalizeBloomRecord({ key: rawKey, ...bloom }, board, bounds);
    if (!normalized) continue;
    blooms[normalized.key] = normalized;
  }

  return blooms;
}

function normalizeBonusType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (type === BONUS_TYPES.DOUBLE_LETTER) return BONUS_TYPES.DOUBLE_LETTER;
  if (type === BONUS_TYPES.TRIPLE_LETTER) return BONUS_TYPES.TRIPLE_LETTER;
  if (type === BONUS_TYPES.DOUBLE_WORD) return BONUS_TYPES.DOUBLE_WORD;
  if (type === BONUS_TYPES.TRIPLE_WORD) return BONUS_TYPES.TRIPLE_WORD;
  return "";
}

function generateBonusSpacesForBounds(bounds, board, bonusSeed, previousBounds = null) {
  const bonusSpaces = {};

  for (let q = bounds.minQ; q <= bounds.maxQ; q += 1) {
    for (let r = bounds.minR; r <= bounds.maxR; r += 1) {
      const hex = { q, r };
      if (!isWithinBounds(hex, bounds)) continue;
      if (previousBounds && isWithinBounds(hex, previousBounds)) continue;

      const key = hexKey(q, r);
      if (board[key]) continue;

      const type = rollBonusType(key, bonusSeed);
      if (!type) continue;
      bonusSpaces[key] = type;
    }
  }

  return bonusSpaces;
}

function rollBonusType(key, bonusSeed) {
  const roll = hashString(`${bonusSeed}:${key}`) % 1000;
  if (roll < 925) return "";
  if (roll < 965) return BONUS_TYPES.DOUBLE_LETTER;
  if (roll < 985) return BONUS_TYPES.TRIPLE_LETTER;
  if (roll < 995) return BONUS_TYPES.DOUBLE_WORD;
  return BONUS_TYPES.TRIPLE_WORD;
}

function advanceBonusSpaces(currentBonusSpaces = {}, placements, board, previousBounds, nextBounds, bonusSeed) {
  const nextBonusSpaces = { ...(currentBonusSpaces || {}) };

  for (const placement of placements) {
    delete nextBonusSpaces[hexKey(placement.q, placement.r)];
  }

  Object.assign(nextBonusSpaces, generateBonusSpacesForBounds(nextBounds, board, bonusSeed, previousBounds));
  return normalizeBonusSpaces(nextBonusSpaces, board, nextBounds);
}

function scoreMove(words, placements, tilesById, bonusSpaces = {}, newBlooms = [], options = {}) {
  const bloomBonus = newBlooms.length * BLOOM_BONUS;
  if (words.length) {
    const placementKeys = new Set(placements.map(placement => hexKey(placement.q, placement.r)));
    const scoredWords = words.map(word => scoreWord(word, placementKeys, bonusSpaces, options));
    const multiWordBonus = multiWordPlayBonus(scoredWords.length);
    const bonuses = scoredWords.flatMap(word => word.bonuses);
    for (let index = 0; index < newBlooms.length; index += 1) bonuses.push(`+${BLOOM_BONUS} bloom`);
    if (multiWordBonus) bonuses.push(`+${multiWordBonus} combo`);

    const score = scoredWords.reduce((sum, word) => sum + word.score, 0) + multiWordBonus + bloomBonus;
    return {
      words: scoredWords,
      score,
      scoreBreakdown: {
        total: score,
        multiWordBonus,
        bloomBonus,
        bonuses,
        reverseWords: scoredWords
          .filter(word => word.reverseText)
          .map(word => ({ word: word.text, reverse: word.reverseText }))
      }
    };
  }

  const placement = placements[0];
  const key = placement ? hexKey(placement.q, placement.r) : "";
  const tile = placement ? tilesById.get(placement.tileId) : null;
  const bonusType = key ? normalizeBonusType(bonusSpaces[key]) : "";
  const bonuses = [];
  let score = tile?.value || 0;

  if (bonusType) {
    bonuses.push(bonusCode(bonusType));
    score *= bonusMultiplier(bonusType);
  }
  for (let index = 0; index < newBlooms.length; index += 1) bonuses.push(`+${BLOOM_BONUS} bloom`);
  score += bloomBonus;

  return {
    words: [],
    score,
    scoreBreakdown: {
      total: score,
      multiWordBonus: 0,
      bloomBonus,
      bonuses,
      reverseWords: []
    }
  };
}

function scoreWord(word, placementKeys, bonusSpaces, options) {
  let letterScore = 0;
  let wordMultiplier = 1;
  const bonuses = [];

  for (const cell of word.cells) {
    const cellValue = Number(cell.value) || LETTER_VALUES[cell.letter] || 1;
    const bonusType = placementKeys.has(cell.key) ? normalizeBonusType(bonusSpaces[cell.key]) : "";
    let scoredLetter = cellValue;

    if (bonusType) bonuses.push(bonusCode(bonusType));
    if (bonusType === BONUS_TYPES.DOUBLE_LETTER || bonusType === BONUS_TYPES.TRIPLE_LETTER) {
      scoredLetter *= bonusMultiplier(bonusType);
    }
    if (bonusType === BONUS_TYPES.DOUBLE_WORD || bonusType === BONUS_TYPES.TRIPLE_WORD) {
      wordMultiplier *= bonusMultiplier(bonusType);
    }

    letterScore += scoredLetter;
  }

  let score = letterScore * wordMultiplier;
  const longWordBonus = longWordPlayBonus(word.text.length);
  if (longWordBonus) {
    bonuses.push(`+${longWordBonus}`);
    score += longWordBonus;
  }

  const reverseText = reverseWordMatch(word.text, options);
  if (reverseText) score *= 2;

  return {
    ...word,
    score,
    bonuses,
    reverseText
  };
}

function bonusMultiplier(type) {
  if (type === BONUS_TYPES.DOUBLE_LETTER || type === BONUS_TYPES.DOUBLE_WORD) return 2;
  if (type === BONUS_TYPES.TRIPLE_LETTER || type === BONUS_TYPES.TRIPLE_WORD) return 3;
  return 1;
}

function longWordPlayBonus(length) {
  return length >= 5 ? 2 ** (length - 5) : 0;
}

function multiWordPlayBonus(wordCount) {
  return wordCount >= 2 ? 2 ** (wordCount - 2) : 0;
}

function reverseWordMatch(text, options = {}) {
  const word = normalizeWord(text);
  if (word.length < 2) return "";

  const reversed = [...word].reverse().join("");
  if (typeof options.getReverseWord === "function") {
    const match = normalizeWord(options.getReverseWord(word, reversed));
    return match || "";
  }
  if (typeof options.isReversibleWord === "function") {
    return options.isReversibleWord(word, reversed) ? reversed : "";
  }
  if (typeof options.isWordAllowed === "function") {
    return options.isWordAllowed(reversed) ? reversed : "";
  }
  return "";
}

function normalizeMoveWordRecord(input = {}) {
  const text = String(input?.text || "").trim();
  if (!text) return null;
  return {
    text,
    value: Math.max(0, Number.parseInt(input?.value, 10) || 0),
    keys: Array.isArray(input?.keys) ? input.keys.map(String) : [],
    score: Math.max(0, Number.parseInt(input?.score, 10) || 0),
    bonuses: Array.isArray(input?.bonuses)
      ? input.bonuses.map(value => String(value || "").trim()).filter(Boolean)
      : [],
    reverseText: normalizeWord(input?.reverseText || input?.reverse)
  };
}

function normalizeScoreBreakdown(input = {}, fallbackScore = 0) {
  return {
    total: Math.max(0, Number.parseInt(input?.total, 10) || Number.parseInt(fallbackScore, 10) || 0),
    multiWordBonus: Math.max(0, Number.parseInt(input?.multiWordBonus, 10) || 0),
    bloomBonus: Math.max(0, Number.parseInt(input?.bloomBonus, 10) || 0),
    bonuses: Array.isArray(input?.bonuses)
      ? input.bonuses.map(value => String(value || "").trim()).filter(Boolean)
      : [],
    reverseWords: Array.isArray(input?.reverseWords)
      ? input.reverseWords.map(normalizeReverseWordRecord).filter(Boolean)
      : []
  };
}

function normalizeReverseWordRecord(input = {}) {
  const word = normalizeWord(input?.word);
  const reverse = normalizeWord(input?.reverse);
  if (!word || !reverse) return null;
  return { word, reverse };
}

function normalizeBloomRecord(input = {}, board = null, bounds = null) {
  const q = Number.isFinite(Number(input?.q)) ? Number(input.q) : parseHexKey(input?.key || "").q;
  const r = Number.isFinite(Number(input?.r)) ? Number(input.r) : parseHexKey(input?.key || "").r;
  if (!Number.isInteger(q) || !Number.isInteger(r)) return null;

  const key = hexKey(q, r);
  if (bounds && !isWithinBounds({ q, r }, bounds)) return null;
  if (board && board[key]) return null;

  return {
    q,
    r,
    key,
    playerId: String(input?.playerId || "").trim().slice(0, 128),
    moveId: String(input?.moveId || "").trim().slice(0, 128),
    createdAt: typeof input?.createdAt === "string" ? input.createdAt : ""
  };
}

function findNewBlooms(previousBoard = {}, nextBoard = {}, placements = [], existingBlooms = {}, move = {}, player = {}) {
  const newBlooms = [];
  const seen = new Set();

  for (const placement of placements) {
    for (const center of neighbors(placement)) {
      const key = hexKey(center.q, center.r);
      if (seen.has(key)) continue;
      seen.add(key);
      if (existingBlooms?.[key]) continue;
      if (nextBoard[key]) continue;
      if (!isBloomCenter(nextBoard, center)) continue;
      if (isBloomCenter(previousBoard, center)) continue;

      newBlooms.push({
        q: center.q,
        r: center.r,
        key,
        playerId: String(player?.id || "").trim().slice(0, 128),
        moveId: String(move?.id || "").trim().slice(0, 128),
        createdAt: new Date(Number(move?.timestamp) || Date.now()).toISOString()
      });
    }
  }

  return newBlooms.sort((left, right) => left.q - right.q || left.r - right.r);
}

function isBloomCenter(board = {}, center = {}) {
  if (!center || board[hexKey(center.q, center.r)]) return false;
  return neighbors(center).every(hex => Boolean(board[hexKey(hex.q, hex.r)]));
}

function validateDictionaryWords(words, options = {}) {
  if (typeof options.isWordAllowed !== "function") return;

  for (const word of words) {
    const text = normalizeWord(word.text);
    if (!text || options.isWordAllowed(text)) continue;
    throw new GameRuleError(`${text} is not in the dictionary`);
  }
}

function lineInvariant(hex, axisIndex) {
  if (axisIndex === 0) return hex.r;
  if (axisIndex === 1) return hex.q;
  return hex.q + hex.r;
}

function linePosition(hex, axisIndex) {
  if (axisIndex === 1) return hex.r;
  return hex.q;
}

function hexOnLine(axisIndex, invariant, position) {
  if (axisIndex === 0) return { q: position, r: invariant };
  if (axisIndex === 1) return { q: invariant, r: position };
  return { q: position, r: invariant - position };
}

function shuffleWithSeed(items, seedValue) {
  const result = items.slice();
  const random = seededRandom(hashString(seedValue));

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed || 1;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
