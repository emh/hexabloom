export const EDGE_BUFFER = 6;
export const INITIAL_RADIUS = 5;
export const RACK_SIZE = 11;
export const GLOBAL_ROOM_ID = "BOARD";
export const DEFAULT_GAME_LENGTH = "short";

export const GAME_LENGTHS = Object.freeze({
  short: Object.freeze({ key: "short", label: "Short", tileBagCount: 1 }),
  medium: Object.freeze({ key: "medium", label: "Medium", tileBagCount: 3 }),
  long: Object.freeze({ key: "long", label: "Long", tileBagCount: 5 })
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

  if (input.players && typeof input.players === "object") {
    for (const player of Object.values(input.players)) {
      const normalized = createPlayer(player);
      players[normalized.id] = normalized;
    }
  }

  const ownerId = normalizeOwnerId(input.ownerId, players);

  return {
    id: normalizeRoomId(input.id),
    ownerId,
    tileBagCount,
    gameLength: gameLengthFromTileBagCount(tileBagCount),
    board,
    players,
    removedPlayers,
    moves: Array.isArray(input.moves) ? input.moves.map(normalizeMoveRecord).filter(Boolean) : [],
    bounds: recomputeBoardBounds(board),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date().toISOString()
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

  const player = createPlayer({ id, name, tileBagCount: state.tileBagCount });
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
    words: validation.words.map(word => ({
      text: word.text,
      value: word.value,
      keys: word.keys
    }))
  };

  state.moves.push(moveRecord);
  state.bounds = recomputeBoardBounds(state.board);
  state.updatedAt = new Date().toISOString();

  return {
    state,
    move: moveRecord,
    words: validation.words,
    score: validation.score,
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

  const score = scoreWords(words, move.placements, tilesById);

  return {
    move,
    player,
    axis,
    words,
    score,
    tilesById,
    draftBoard
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
    words: Array.isArray(input.words) ? input.words : []
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

  for (const move of state.moves) {
    if (move.playerId !== playerId) continue;
    move.playerId = "";
    move.playerName = "deleted player";
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

function scoreWords(words, placements, tilesById) {
  if (words.length) return words.reduce((sum, word) => sum + word.value, 0);
  return placements.reduce((sum, placement) => sum + (tilesById.get(placement.tileId)?.value || 0), 0);
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
