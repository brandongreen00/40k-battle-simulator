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
  wargear?: string[]; // chosen options
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
  /** Optional human note (e.g. transcription assumption). */
  note?: string;
}

export interface Layout {
  id: string; // "ca2025-hammer-and-anvil-1"
  name?: string;
  boardWidth: number; // 60
  boardHeight: number; // 44
  deployment: string; // "Hammer and Anvil"
  terrain: TerrainPiece[];
  objectives: Vec2[]; // marker centres (40mm markers)
  deploymentZones: { player: Vec2[]; opponent: Vec2[] }; // polygons
}

// ── Live game state (skeleton; grows in later stages) ────────────────────────
export type Side = 'player' | 'ai';

export interface ModelInstance {
  id: string;
  unitId: string;
  pos: Vec2;
  wounds: number;
  alive: boolean;
}

export interface UnitInstance {
  id: string;
  owner: Side;
  datasheetId: string;
  models: ModelInstance[];
  // status flags (battle-shock, under-order, etc.) added in later stages
}

export interface GameState {
  layout: Layout;
  units: UnitInstance[];
  round: number;
  activePlayer: Side;
  phase: string; // kept as data, not hard-coded into UI (architecture rule #4)
  cp: { player: number; ai: number };
  score: { player: number; ai: number };
}
