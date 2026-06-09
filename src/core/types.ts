// Shared types for the rules core. PURE — no React, no DOM, no I/O.
// Starting point from CLAUDE.md §5; extend fields as later stages need them, but keep the
// core/UI boundary and the inch-based coordinate system intact.

// ── Geometry — all distances in inches ───────────────────────────────────────
export interface Vec2 {
  x: number;
  y: number;
}

/** Model base footprint. Circle uses `radius`; oval uses `rx`/`ry` (semi-axes). Inches. */
export interface BaseShape {
  kind: 'circle' | 'oval';
  radius?: number; // circle, inches
  rx?: number; // oval semi-axis along x, inches
  ry?: number; // oval semi-axis along y, inches
}

// ── Static game data (from Wahapedia conversion) ─────────────────────────────
export interface ModelProfile {
  name: string;
  M: number; // Move, inches
  T: number; // Toughness
  Sv: number; // Save, e.g. 3 means 3+
  invuln?: number; // invulnerable save, e.g. 4 means 4++
  W: number; // Wounds
  Ld: number; // Leadership
  OC: number; // Objective Control
}

export interface WeaponProfile {
  name: string;
  type: 'ranged' | 'melee';
  range?: number; // inches; omit for melee
  attacks: string; // "20" | "D6" | "2D6" — parse at use
  skill: number; // BS/WS, e.g. 3 means 3+
  S: number; // Strength
  AP: number; // Armour Penetration, stored as negative or 0
  D: string; // Damage: "1" | "D6" | "D3+1"
  keywords: string[]; // ["Rapid Fire 1","Torrent","Melta 2", ...]
}

/** A points tier: a unit of `models` size costs `cost` points. */
export interface PointsTier {
  models: number;
  cost: number;
  note?: string; // e.g. "Assigned Agent", "Agents of the Imperium Detachment"
}

/** A wargear swap option: a lead-in rule sentence plus the choices it offers. */
export interface WargearOption {
  text: string; // e.g. "Up to 2 Shock Troopers can each have their lasgun replaced with:"
  choices: string[]; // e.g. ["1 flamer", "1 grenade launcher", ...] ([] for a single swap)
}

export interface Datasheet {
  id: string;
  name: string;
  faction: string;
  role?: string; // "Characters" | "Battleline" | "Dedicated Transports" | "Fortifications" | "Other"
  loadout?: string; // default wargear loadout (plain text)
  models: ModelProfile[]; // multi-profile units allowed
  weapons: WeaponProfile[];
  baseShape: BaseShape;
  keywords: string[]; // INFANTRY, VEHICLE, TITANIC, CHARACTER, ...
  abilityIds: string[]; // resolved later by the ability system
  points?: PointsTier[]; // cost per model-count tier
  composition?: string[]; // valid unit compositions (plain text)
  wargearOptions?: WargearOption[]; // weapon swap options
  wargearNotes?: string[]; // footnotes constraining the options
  canLead?: string[]; // datasheet ids this CHARACTER can attach to
  canBeLedBy?: string[]; // CHARACTER datasheet ids that can attach to this unit
}

/** An enhancement: points upgrade for a CHARACTER, scoped to one detachment. */
export interface Enhancement {
  id: string;
  name: string;
  faction: string;
  cost: number;
  detachment: string;
  detachmentId: string;
  description: string;
}

// ── Roster (an owned army list) ──────────────────────────────────────────────
export interface RosterUnit {
  datasheetId: string;
  modelCount: number;
  wargear?: string[]; // chosen options (legacy free-text)
  /** Wargear as an item→count map (e.g. {"Astartes shield": 2}). Drives per-model saves in-game. */
  wargearCounts?: Record<string, number>;
  enhancementId?: string;
  attachedCharacterId?: string; // leader attachment
  /** Set when the source list named a unit we could not resolve to a datasheet. */
  unresolved?: boolean;
  /** Free-text label preserved from the source list (helpful while data is incomplete). */
  displayName?: string;
}

export interface Roster {
  name: string; // "Bane", "Imperialis Fleet", ...
  faction: string;
  detachment: string; // "Grizzled Company", "Imperialis Fleet"
  points: number;
  units: RosterUnit[];
  /** Free-text note (e.g. provenance, "awaiting list file", or "demo — not an owned list"). */
  note?: string;
  /** True for non-canonical demo rosters used only to exercise the board. */
  sample?: boolean;
}

// ── Terrain & board ──────────────────────────────────────────────────────────
export type TerrainType = 'ruin_blocking' | 'area_cover' | 'obstacle';

export interface TerrainPiece {
  id: string;
  type: TerrainType;
  polygon: Vec2[]; // footprint, inches, board coords
  /** Tall = blocks line of sight (grey ruin); low = ≤2" area terrain (blue). */
  height?: 'tall' | 'low';
  /** Provenance of the footprint, e.g. "L 12x6" (labrador feature + dimensions). */
  source?: string;
  /** Optional human note (e.g. transcription assumption). */
  note?: string;
}

export interface Layout {
  id: string; // "ca2025-hammer-and-anvil-1"
  name?: string;
  boardWidth: number; // 60
  boardHeight: number; // 44
  deployment: string; // "Hammer and Anvil"
  /** Stable deployment id from the source pack, e.g. "hammer-and-anvil-sf-2025". */
  deploymentId?: string;
  /** Where the layout came from (e.g. labrador.dev + extractor). */
  source?: string;
  terrain: TerrainPiece[];
  objectives: Vec2[]; // marker centres
  /** Objective marker diameter in inches (40mm ≈ 1.575"). Uniform across GW maps. */
  objectiveMarkerDiameterIn?: number;
  /** Horizontal objective-control range in inches (3" in Pariah Nexus / Chapter Approved). */
  objectiveControlRadiusIn?: number;
  deploymentZones: { player: Vec2[]; opponent: Vec2[] }; // polygons (attacker→player, defender→opponent)
}

// ── Live game state (skeleton; grows in later stages) ────────────────────────
export type Side = 'player' | 'ai';

export interface ModelInstance {
  id: string;
  unitId: string;
  pos: Vec2;
  wounds: number;
  alive: boolean;
  /** Wargear items this specific model carries (e.g. ["Astartes shield"]). Drives per-model saves. */
  wargear?: string[];
  /** Position this model started its current Movement-phase activation from (for the M" clamp). */
  moveStart?: Vec2;
}

/** Per-unit, per-turn activation + status flags. Reset at the points the rules dictate. */
export interface UnitStatus {
  moved?: boolean; // made a normal move this turn
  advanced?: boolean; // Advanced this turn (affects shooting/charge)
  fellBack?: boolean; // Fell Back this turn
  remainedStationary?: boolean; // did not move (Heavy bonus)
  hasShot?: boolean; // already shot this turn
  charged?: boolean; // completed a charge this turn (Lance, Fights First)
  hasFought?: boolean; // already fought this turn
  battleShocked?: boolean; // failed a Battle-shock test this round
  /** Active ability/Order/Stratagem effect ids (see core/effects.ts). Expire at turn reset. */
  activeEffects?: string[];
  // ── Movement-phase activation (transient; set by BeginMove, cleared by EndMove/turn) ──
  /** The move mode chosen for the current activation. Undefined when not moving. */
  moveMode?: import('./movement').MoveMode;
  /** Inches each model may move this activation (M, or M+D6 for an Advance). */
  moveBudget?: number;
}

export interface UnitInstance {
  id: string;
  owner: Side;
  datasheetId: string;
  models: ModelInstance[];
  /** Model count at deployment, for Below-Half-strength / Battle-shock tests. */
  startingModels: number;
  status: UnitStatus;
  /** Held in Reserves (Deep Strike / Strategic Reserves) — off the board until it arrives. */
  inReserves?: boolean;
  /** Battle round this unit arrived from Reserves (undefined if deployed normally). */
  arrivedRound?: number;
  /** Leader attachment: the Bodyguard unit id this CHARACTER unit is attached to. */
  attachedTo?: string;
  /** Leader attachment: Leader unit ids attached to this Bodyguard unit. */
  leaderUnitIds?: string[];
}

/** A resolved Battle-shock test, kept on the state so the UI can render its 2D6 as dice. */
export interface BattleShockReport {
  unitId: string;
  unitName: string;
  roll: [number, number];
  total: number;
  ld: number;
  passed: boolean;
}

// ── Pre-battle setup / deployment ────────────────────────────────────────────
export type Stage = 'setup' | 'battle' | 'done';

/** Steps of the pre-battle sequence (mission pack order). */
export type DeployStep = 'roll_roles' | 'deploy' | 'roll_first_turn' | 'ready';

export interface RollOff {
  player: number;
  ai: number;
  winner: Side;
}

export interface SetupState {
  step: DeployStep;
  /** Roll-off that set Attacker/Defender (for the dice display). */
  roleRoll?: RollOff;
  attacker?: Side;
  defender?: Side;
  /** Whose turn it is to place a unit during alternating deployment (Defender first). */
  toDeploy?: Side;
  /** Roll-off that set the first turn (for the dice display). */
  firstTurnRoll?: RollOff;
  firstTurn?: Side;
}

export interface GameState {
  layout: Layout;
  units: UnitInstance[];
  /** 'setup' = pre-battle deployment; 'battle' = the five-phase rounds; 'done' = finished. */
  stage: Stage;
  /** Pre-battle deployment sub-state (present while `stage === 'setup'`). */
  setup?: SetupState;
  round: number; // 1..5
  /** Which side took the first turn of the battle (rounds alternate starting with this side). */
  firstPlayer: Side;
  activePlayer: Side;
  phase: string; // kept as data, not hard-coded into UI (architecture rule #4)
  cp: { player: number; ai: number };
  score: { player: number; ai: number };
  /** Battle has reached the end of round 5's second turn. */
  ended: boolean;
  /** Human-readable event/dice log, newest last. */
  log: string[];
  /** Battle-shock tests from the most recent Command phase (for the dice display). */
  lastBattleShock?: BattleShockReport[];
}
