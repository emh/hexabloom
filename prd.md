## Product Requirements Document (PRD)

**Project:** (working) *Hex-based Alphabloom variant*
**Architecture:** Cloudflare Workers + Durable Object + CRDT client
**Core Direction:** Hex grid + organic expansion via bounding bounds (no remapping)

---

## 1. Objective

Build a real-time, multiplayer, non-turn-based word game with:

* Hex grid (6-directional adjacency)
* Unlimited concurrent players
* Asynchronous play (no turns)
* Mandatory cross-player interaction
* Dynamically expanding board
* Mobile-first interaction model
* CRDT-based synchronization

---

## 2. Core Game Model

---

### 2.1 Board Model (Hex Grid)

Use **axial coordinates**:

```ts
type Hex = {
  q: number
  r: number
}
```

Implicit:

```ts
s = -q - r
```

Each cell:

```ts
type Cell = {
  letter: string
  playerId: string
  tileId: string
  timestamp: number
}
```

Storage:

```ts
Map<string, Cell> // key = `${q},${r}`
```

---

### 2.2 Neighbor Directions

```ts
const directions = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 }
]
```

---

### 2.3 Word Definition (Critical)

Words must lie along **one of 3 axes**:

Axes:

* A: `(1,0)` ↔ `(-1,0)`
* B: `(1,-1)` ↔ `(-1,1)`
* C: `(0,-1)` ↔ `(0,1)`

A valid word:

* contiguous tiles along exactly one axis
* no gaps

---

### 2.4 Tile Model

```ts
type Tile = {
  id: string
  letter: string
  value: number
}
```

Each player:

* `rack: Tile[<=6]`  ✅ (updated)
* `remainingBag: Tile[]`

---

### 2.5 Player Model

```ts
type Player = {
  id: string
  name: string
  rack: Tile[]
  remainingBag: Tile[]
  score: number
  isFinished: boolean
}
```

---

### 2.6 Move Model

```ts
type Move = {
  id: string
  playerId: string
  placements: Array<{
    q: number
    r: number
    tileId: string
  }>
  timestamp: number
}
```

---

## 3. Board Expansion (Hex Version)

---

### 3.1 Core Rule

Define:

```ts
EDGE_BUFFER = 6
```

Track occupied bounds:

```ts
minQ, maxQ
minR, maxR
minS, maxS
```

Where:

```ts
s = -q - r
```

---

### 3.2 Required Bounds

```ts
minBoardQ = minQ - EDGE_BUFFER
maxBoardQ = maxQ + EDGE_BUFFER

minBoardR = minR - EDGE_BUFFER
maxBoardR = maxR + EDGE_BUFFER

minBoardS = minS - EDGE_BUFFER
maxBoardS = maxS + EDGE_BUFFER
```

---

### 3.3 Valid Cell Constraint

A coordinate `(q,r)` is valid if:

```ts
q ∈ [minBoardQ, maxBoardQ]
r ∈ [minBoardR, maxBoardR]
s ∈ [minBoardS, maxBoardS]
```

This defines a **hex-shaped boundary**, not a rectangle.

---

### 3.4 Expansion Behavior

After each accepted move:

* recompute occupied bounds
* if buffer violated → expand bounds
* **no tile coordinates ever change**

---

### 3.5 Initialization

Start with small hex radius:

```ts
INITIAL_RADIUS = 5
```

Equivalent to ~10-wide playable area.

---

## 4. Game Rules

---

### 4.1 Placement Rules

A move is valid if:

1. Tiles lie on a single axis
2. Tiles are contiguous (no gaps)
3. At least one tile connects to existing structure
4. **Cross-player constraint:**

   * at least one resulting word includes another player’s tile

---

### 4.2 First Move

* Free placement within bounds
* No connection required

---

### 4.3 Concurrency

* No turns
* Moves processed independently

Conflict:

* Same cell:

  * earliest timestamp wins
  * tie → playerId

---

### 4.4 Tile Exhaustion

* When bag empty and rack empty → player finished

---

## 5. Scoring

---

### 5.1 Base

* Sum of letter values

---

### 5.2 Word Detection

For each placement:

* scan along all 3 axes
* detect:

  * primary word
  * cross words (other axes)

---

## 6. Architecture

---

### 6.1 Durable Object: `GameRoom`

```ts
class GameRoom {
  state: {
    board: Map<string, Cell>
    players: Map<string, Player>
    moves: Move[]
    bounds: {
      minQ, maxQ,
      minR, maxR,
      minS, maxS
    }
  }
}
```

---

### 6.2 Responsibilities

* Validate moves
* Apply moves
* Maintain bounds
* Broadcast updates

---

### 6.3 CRDT Model

* Operation-based (moves)
* Idempotent
* Server authoritative

---

## 7. Client Requirements (New)

---

### 7.1 Mobile-first Interaction

#### Gestures

* **Two-finger pan** → move board
* **Pinch to zoom** → scale board
* Smooth inertial feel (optional)

---

### 7.2 Tile Interaction

* Drag from tray → board
* Drag from board → reposition (before commit)
* Snap to nearest hex cell

Preview:

* highlight axis
* show word before commit

---

### 7.3 Tray UI

* 6 tiles visible
* Actions:

  * **Shuffle** → randomize order
  * **Reset** → return unplaced tiles

---

### 7.4 Rendering

* Hex grid (pointy-top or flat-top, choose one and stay consistent)
* Highlight:

  * valid placements
  * connected tiles
  * axis direction

---

## 8. API

---

### Join

```http
POST /game/:id/join
```

---

### Move

```http
POST /game/:id/move
```

---

### State

```http
GET /game/:id/state
```

---

### Stream

* WebSocket / SSE

---

## 9. MVP Scope

Include:

* Hex grid placement
* Expansion via bounds
* Drag/drop interaction
* Mobile gestures
* Basic scoring

Exclude:

* Dictionary validation
* Multipliers
* Advanced animations

---

## 10. Key Design Principles

---

* Do not move tiles after placement
* Expand bounds, not data
* Keep validation deterministic
* Favor interaction density
* Optimize for touch-first UX

