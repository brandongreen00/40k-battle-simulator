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
  /** 'rect' = a rectangular hull footprint (rx/ry are the HALF-extents along x/y, axis-aligned —
   *  base rotation isn't tracked, same as ovals). Used for hull-measured vehicles. */
  kind: 'circle' | 'oval' | 'rect';
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
  abilityIds: string[]; // Core/Faction ability ids (resolved via abilities.json)
  /** Full ability list incl. the unit's *special* rules with their text (the per-unit specials). */
  abilities?: UnitAbility[];
  points?: PointsTier[]; // cost per model-count tier
  composition?: string[]; // valid unit compositions (plain text)
  wargearOptions?: WargearOption[]; // weapon swap options
  wargearNotes?: string[]; // footnotes constraining the options
  canLead?: string[]; // datasheet ids this CHARACTER can attach to
  canBeLedBy?: string[]; // CHARACTER datasheet ids that can attach to this unit
  /** Transport capacity rules text, verbatim from the data (e.g. "This model has a transport
   *  capacity of 12 Astra Militarum Infantry models. …"). Parsed by core/transport.ts. */
  transport?: string;
  /** Combat Patrol: the unit MUST start in Strategic Reserves and cannot arrive before this
   *  battle round; it arrives wholly within its own deployment zone (e.g. Strike from the Warp). */
  cpReserveRound?: number;
  /** The Combat Patrol this datasheet belongs to (CP datasheets are patrol-specific). */
  patrol?: string;
}

/** A datasheet ability — a Core/Faction ability (resolved from the catalog) or a unit-specific
 *  ("Datasheet") special rule with its inline rules text. */
export interface UnitAbility {
  name: string;
  description: string;
  /** 'Core' | 'Faction' | 'Datasheet' | 'Wargear' | 'Special' (Wahapedia's ability type). */
  type?: string;
  /** Per-unit value of a parameterised Core ability, verbatim — e.g. Scouts '9"', Deadly Demise
   *  'D3', Feel No Pain '5+', Firing Deck '12'. */
  parameter?: string;
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
  /** True for the fixed Combat Patrol lists (played only in Combat Patrol battles). */
  combatPatrol?: boolean;
  /** 11e recommendation: the Force Disposition this list plays best + the AI profile for it. */
  recommended?: { disposition: string; profile: string };
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

// ── 11th edition terrain areas & objectives (Event Companion layouts) ─────────
/** 11e terrain categories (13.02): exposed terrain has no rules effect and isn't drawn. */
export type TerrainCategory = 'dense' | 'light';

/** A terrain feature placed on a terrain area (a tinted footprint from the layout diagrams). */
export interface TerrainFeature {
  kind: TerrainCategory;
  polygon: Vec2[]; // footprint, inches, board coords (possibly rotated quad)
  /** Battlefields: Armageddon component letters (AB/CD/EF/GH), when identifiable. */
  letter?: string;
}

/** An 11e terrain area (13.01): the rules boundary that cover/Hidden/objectives key off. */
export interface TerrainArea {
  id: string;
  polygon: Vec2[];
  features: TerrainFeature[];
  /** Printed component letters on the Combat Patrol maps (AB/CD/EF/GH ruin labels). */
  letter?: string;
  /** Areas sharing a groupId count as ONE terrain area (the layouts' "single terrain area"
   *  eye markers merge adjacent footprints). Absent = the area stands alone. */
  groupId?: string;
}

/** An 11e objective: usually a terrain objective (the whole `areaId` terrain area, 14.01);
 *  without `areaId` it is a 40mm objective marker with 3" control range (Rules Appendix). */
export interface ObjectivePoint {
  pos: Vec2;
  kind: 'home' | 'central' | 'expansion';
  /** Home objectives belong to a battlefield role; mapped to a Side once roles are known. */
  owner?: 'attacker' | 'defender';
  areaId?: string;
}

export interface Layout {
  id: string; // "ca2025-hammer-and-anvil-1" | "ec2026-take-and-hold_vs_take-and-hold-a"
  name?: string;
  boardWidth: number; // 60 (10e) or 44 (11e vertical)
  boardHeight: number; // 44 or 60
  deployment: string; // "Hammer and Anvil" | "Take and Hold vs Purge the Foe — Layout A"
  /** Stable deployment id from the source pack, e.g. "hammer-and-anvil-sf-2025". */
  deploymentId?: string;
  /** Where the layout came from (e.g. labrador.dev / GW Event Companion + extractor). */
  source?: string;
  terrain: TerrainPiece[];
  objectives: Vec2[]; // marker centres (kept for all layouts — 11e objectives mirror into this)
  /** Objective marker diameter in inches (40mm ≈ 1.575"). Uniform across GW maps. */
  objectiveMarkerDiameterIn?: number;
  /** Horizontal objective-control range in inches (3", markers only in 11e). */
  objectiveControlRadiusIn?: number;
  deploymentZones: { player: Vec2[]; opponent: Vec2[] }; // polygons (attacker→player, defender→opponent)
  // ── 11e Event Companion extensions (absent on 10e layouts) ──
  /** 11e terrain areas with dense/light features. Presence marks a layout as 11e. */
  terrainAreas?: TerrainArea[];
  /** Typed objectives (home/central/expansion), index-aligned with `objectives`. */
  objectivePoints?: ObjectivePoint[];
  /** Attacker/Defender territory divider (a straight segment; territories = each side of it). */
  territoryDivider?: [Vec2, Vec2];
  /** Which board edge the Attacker's zone hugs. */
  attackerEdge?: 'top' | 'bottom' | 'left' | 'right';
  /** The Force Disposition pairing this layout is recommended for, plus its A/B/C letter. */
  pairing?: { dispositions: [string, string]; missions: [string, string]; letter: string };
  /** True for the Combat Patrol maps (30"×44"; picked in Combat Patrol battles). */
  combatPatrol?: boolean;
  /** Paired attacker/defender mission-marker points printed on the territory divider of the
   *  Combat Patrol maps (semantics arrive with the CP mission deck; rendered for reference). */
  dividerMarkers?: Vec2[];
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
  /** Datasheet override for this model (a merged Leader's model uses its own profile/weapons). */
  datasheetId?: string;
}

/** Per-unit, per-turn activation + status flags. Reset at the points the rules dictate. */
export interface UnitStatus {
  moved?: boolean; // made a normal move this turn
  advanced?: boolean; // Advanced this turn (affects shooting/charge)
  fellBack?: boolean; // Fell Back this turn
  remainedStationary?: boolean; // did not move (Heavy bonus)
  hasShot?: boolean; // already shot this turn
  /** Declared a charge this turn (success or fail) — a unit charges once per phase (match mode). */
  chargeAttempted?: boolean;
  charged?: boolean; // completed a charge this turn (Lance, Fights First)
  hasFought?: boolean; // already fought this turn
  /** Was engaged when the Fight step began (12.04) — an unengaged unit with this flag (or that
   *  charged) fights via an OVERRUN FIGHT (12.06). Stamped on entering the Fight phase. */
  engagedAtFightStart?: boolean;
  battleShocked?: boolean; // failed a Battle-shock test this round
  /** Resolved (or declined) its pre-battle Scouts X" move. */
  scouted?: boolean;
  /** Embarked within a transport this turn (18.04: may not disembark again the same phase). */
  justEmbarked?: boolean;
  /** Was set up on the battlefield this turn (disembark/reserves) — such a unit cannot embark. */
  setUpThisTurn?: boolean;
  /** Not eligible to declare a charge this turn (rapid/combat/emergency disembark, Overwatch…). */
  cannotCharge?: boolean;
  /** Absolute player-turn index the unit last made ranged attacks in (Hidden, 13.09). */
  lastShotOnTurn?: number;
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
  /** Full wargear item→count map from the roster (e.g. {"Meltagun": 1, "Navis shotgun": 7}).
   *  Drives how many models fire a given weapon. Absent for units spawned without loadout data. */
  wargearCounts?: Record<string, number>;
  /** The roster entry's Enhancement (Wahapedia id) — drives in-game effects (core/enhancements.ts). */
  enhancementId?: string;
  /** Deploy ability granted at Declare Battle Formations (Clandestine Operation / Combat
   *  Landers). Stamped at unit creation — setup state is cleared when the battle begins, so
   *  reserve arrivals read this instead of setup.grants. */
  deployGrant?: 'infiltrators' | 'deep_strike';
  /** Defender's casualty-allocation preference (persists; set by the owner):
   *  'shields_first' (default) — defensive-wargear bearers (4++ shields…) soak wounds first;
   *  'bodies_first' — regular models die first, preserving the wargear bearers for later. */
  allocation?: 'shields_first' | 'bodies_first';
  /** Held in Reserves (Deep Strike / Strategic Reserves) — off the board until it arrives.
   *  Also true while embarked within a transport (see `embarkedIn`). */
  inReserves?: boolean;
  /** Embarked within this friendly TRANSPORT unit id (18). Off the board while set. */
  embarkedIn?: string;
  /** Battle round this unit arrived from Reserves (undefined if deployed normally). */
  arrivedRound?: number;
  /** Leader attachment: the Bodyguard unit id this CHARACTER unit is attached to. */
  attachedTo?: string;
  /** Leader attachment: Leader unit ids attached to this Bodyguard unit. */
  leaderUnitIds?: string[];
  /** Merged-in Leaders (their models live in this unit, tagged with their datasheetId). Lets the
   *  merged unit fire the Leader's weapons and be split apart again on detach. */
  attachedLeaders?: {
    unitId: string;
    datasheetId: string;
    modelCount: number;
    wounds: number;
    /** The Leader's own wargear counts, preserved through the merge (restored on detach). */
    wargearCounts?: Record<string, number>;
    /** The Leader's Enhancement, preserved through the merge (its effects cover the led unit). */
    enhancementId?: string;
  }[];
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

// ── Secondary (Tactical) Missions ────────────────────────────────────────────
/** One card in a side's hand: the card id, the round it was drawn in (staleness), and any
 *  When-Drawn pick (Beacon's unit id / A Tempting Target's objective index). */
export interface SecondaryCardInHand {
  id: string;
  drawn: number;
  data?: string | number;
}

/** One side's Tactical Mission state (11e): a personal shuffled 18-card deck, the active hand
 *  (draw 2 per Command phase, no hand limit), the discard pile, and the secondary VP scored
 *  so far (cap 45; 15 per battle round). */
export interface SecondarySideState {
  deck: string[];
  hand: SecondaryCardInHand[];
  discard: string[];
  vp: number;
  /** Secondary VP per battle round (15/round cap). */
  roundVp?: Record<number, number>;
  /** Secondary Missions mode: 'tactical' draws from the deck (default); 'fixed' scores the two
   *  chosen FIXED cards all battle instead (no drawing). Chosen secretly before the battle. */
  mode?: 'tactical' | 'fixed';
  /** Fixed Missions mode: the two chosen FIXED-capable cards (never discarded). */
  fixed?: SecondaryCardInHand[];
  /** VP scored per fixed card (each caps at 20 — FIXED_CARD_CAP). */
  fixedVp?: Record<string, number>;
}

/** A unit destroyed this turn — what kill-based primary/secondary conditions score from. */
export interface KillRecord {
  /** Owner of the DESTROYED unit. */
  side: Side;
  /** The destroyed unit's instance id. */
  unitId?: string;
  /** Every datasheet in the destroyed unit (Bodyguard + merged Leaders). */
  datasheetIds: string[];
  /** Highest Wounds characteristic among those datasheets' profiles (Bring It Down). */
  maxWounds: number;
  /** Was any of its models within objective range when it was destroyed? */
  onObjective: boolean;
  /** The unit's starting strength (A Grievous Blow: 13+). */
  startingStrength?: number;
  /** CHARACTER models destroyed with the unit (Assassination). */
  charactersSlain?: number;
  /** Highest W among CHARACTER models slain (Assassination cumulative: W4+). */
  characterMaxW?: number;
  /** CHARACTER models slain with a Wounds characteristic of 4+ (Assassination FIXED rider). */
  charactersSlain4W?: number;
  /** Models slain whose datasheet W is 10+ (Bring It Down FIXED: per-model scoring). */
  bigModelsSlain?: number;
  /** Did the unit start the turn within range of an objective? (Overwhelming Force etc.) */
  startedTurnOnObjective?: boolean;
  /** Did it start the turn within range of a CENTRAL objective? (Secure Asset.) */
  startedTurnOnCentral?: boolean;
  /** Terrain area id the unit started the turn within, if any (Death Trap / Search and Scour). */
  startedTurnInArea?: string;
  /** Was the killer within range of an objective? (Purge and Secure.) */
  killerOnObjective?: boolean;
}

// ── 11th edition missions (Chapter Approved deck) ────────────────────────────
/** An operation marker placed by a mission rule or Objective Action. */
export interface OperationMarker {
  side: Side;
  pos: Vec2;
  /** Terrain area the marker sits in (Locate and Deny / Extract Relic). */
  areaId?: string;
  /** Objective index the marker is within range of (Vital Link / Triangulation / Gather Intel). */
  objectiveIdx?: number;
}

/** An Objective Action a unit has started this turn (16.01 + mission card reverses). */
export interface ActiveAction {
  side: Side;
  unitId: string;
  actionId: string;
  objectiveIdx?: number;
  areaId?: string;
  targetUnitId?: string;
}

/** Per-side 11e mission state. */
export interface MissionSideState {
  /** Force Disposition id (take_and_hold | purge_the_foe | disruption | reconnaissance | priority_assets). */
  disposition: string;
  /** Primary Mission id (from the disposition pairing matrix). */
  mission: string;
  /** Primary VP scored so far (cap 45). */
  primaryVp: number;
  /** Primary VP scored per battle round (cap 15/round). */
  roundVp: Record<number, number>;
  /** Playing Fixed secondaries: the two chosen card ids (Tactical otherwise). */
  fixedCards?: string[];
}

/** Whole-game 11e mission state (present when a match uses an Event Companion layout). */
export interface MissionState {
  perSide: Record<Side, MissionSideState>;
  /** Operation markers on the battlefield. */
  markers: OperationMarker[];
  /** Objective indices consecrated (Consecrate) / decoyed (Smoke and Mirrors) /
   *  triangulated (Triangulation). */
  consecrated?: { idx: number; side: Side }[];
  decoyed?: number[];
  triangulated?: number[];
  /** Terrain area ids trapped (Death Trap), plus the ones trapped this turn. */
  trapped?: string[];
  trappedThisTurn?: string[];
  /** Units condemned by Punishment until the start of that player's next turn. */
  condemned?: string[];
  /** Units that destroyed an enemy unit and haven't consecrated yet (Consecrate). */
  consecrationUnits?: string[];
  /** Enemy unit ids surveilled this turn (Surveil the Foe). */
  surveilledThisTurn?: string[];
  /** Per-side action completions this turn (actionId → count). */
  actionsDoneThisTurn?: Partial<Record<Side, Record<string, number>>>;
  /** Kill ledger from the PREVIOUS turn (Meatgrinder / Destroyer's Wrath comparisons). */
  prevTurnKills?: KillRecord[];
  /** Snapshot at the start of the current turn: unit id → objective/terrain flags. */
  unitStartTurnFlags?: Record<string, { onObjective: boolean; onCentral: boolean; areaId?: string }>;
  /** Objectives secured (14.03) by a side (index-aligned flags). */
  securedBy?: (Side | null)[];
}

/** One Combat Patrol mission scoring event (for the panel + logs). */
export interface CpMissionEvent {
  round: number;
  turn: Side;
  side: Side;
  label: string;
  vp: number;
}

/** Combat Patrol mission state: each side plays its own patrol's card (core/cpmissions.ts). */
export interface CpMissionState {
  /** Attacker side (setup is cleared at BeginBattle; home-objective ownership needs it). */
  attacker: Side;
  missionId: Record<Side, string>;
  /** Mission VP per side (also added into `score` — CP has no other VP source). */
  vp: Record<Side, number>;
  events: CpMissionEvent[];
  /** Kill ledger of the PREVIOUS player turn ("destroyed in this or the previous turn"). */
  prevTurnKills?: KillRecord[];
  /** Objectives sanctified (Purification): objective index + the side whose army sanctified it. */
  sanctified?: { idx: number; side: Side }[];
  /** Pending Sanctification actions — complete at that side's NEXT Command phase (or the end of
   *  the battle, whichever occurs first). */
  sanctifying?: { side: Side; unitId: string; objectiveIdx: number; startedTurnCounter: number }[];
}

// ── Pre-battle setup / deployment ────────────────────────────────────────────
export type Stage = 'setup' | 'battle' | 'done';

/** Steps of the pre-battle sequence (mission pack order). 'scouts' = the pre-battle Scout moves
 *  window (after the first-turn roll, before the battle begins). */
export type DeployStep = 'roll_roles' | 'deploy' | 'roll_first_turn' | 'scouts' | 'ready';

export interface RollOff {
  player: number;
  ai: number;
  winner: Side;
}

/** A Leader→Bodyguard pairing declared before deployment (Declare Battle Formations). The pair
 *  deploys as one merged unit; `infiltrate` marks a pair that may set up as Infiltrators (both
 *  have the ability, or a Backroom Deals leader grants it to the unit it leads). */
export interface DeclaredFormation {
  side: Side;
  leaderKey: string; // roster entry key of the Leader ("side:index")
  leaderDsId: string;
  bodyguardKey: string; // roster entry key of the Bodyguard unit
  bodyguardDsId: string;
  infiltrate?: boolean;
}

/** One half of a unit split at Declare Battle Formations (e.g. by a Sisters of Battle Immolator):
 *  its model count and the share of the parent entry's wargear items those models carry. */
export interface SplitGroup {
  count: number;
  wargear?: Record<string, number>;
}

/** A unit split declared at Declare Battle Formations by a transport's split rule. The roster
 *  entry `entryKey` becomes two half-units keyed `${entryKey}#a` (which must start the battle
 *  embarked within `transportUnitId`) and `${entryKey}#b` (deployed like any other unit). */
export interface DeclaredSplit {
  side: Side;
  entryKey: string; // roster entry key of the split unit ("side:index")
  dsId: string;
  transportUnitId: string; // the transport whose rule performed the split (carries group A)
  groups: [SplitGroup, SplitGroup]; // [riders, on-foot]
}

/** Warrant of Trade (Rogue Trader): after both armies have deployed, redeploy up to D3 IMPERIUM
 *  BATTLELINE units. `remaining` counts down as units are pulled back for redeployment. */
export interface WarrantState {
  side: Side;
  rolled: number; // the D3 result (0 when declined)
  remaining: number;
}

export interface SetupState {
  step: DeployStep;
  /** Each side's chosen Force Disposition (11e missions). */
  dispositions?: Record<Side, string>;
  /** Roll-off that set Attacker/Defender (for the dice display). */
  roleRoll?: RollOff;
  attacker?: Side;
  defender?: Side;
  /** Whose turn it is to place a unit during alternating deployment (Defender first). */
  toDeploy?: Side;
  /** Leader attachments declared before deployment (Declare Battle Formations). */
  formations?: DeclaredFormation[];
  /** Unit splits declared before deployment (a transport's split rule, e.g. the Immolator). */
  splits?: DeclaredSplit[];
  /** Warrant of Trade redeploy state per side, once that side has used (or declined) it. */
  warrant?: Partial<Record<Side, WarrantState>>;
  /** Army-wide Declare Battle Formations enhancement picks (Clandestine Operation's Infiltrators,
   *  Combat Landers' Deep Strike): which roster entries were granted the ability. A record with
   *  empty entryKeys marks the decision as resolved-without-picks. */
  grants?: { side: Side; enhancementId: string; label: string; grant: 'infiltrators' | 'deep_strike'; entryKeys: string[] }[];
  /** Post-deployment enhancement redeploys (Liber Heresius etc.), Warrant-of-Trade mould:
   *  present once used/declined; `remaining` counts down as units are pulled back. */
  redeploy?: Partial<Record<Side, { enhancementId: string; label: string; remaining: number }>>;
  /** Roll-off that set the first turn (for the dice display). */
  firstTurnRoll?: RollOff;
  firstTurn?: Side;
}

export interface GameState {
  layout: Layout;
  units: UnitInstance[];
  /** 'setup' = pre-battle deployment; 'battle' = the five-phase rounds; 'done' = finished. */
  stage: Stage;
  /** 'sandbox' = the free measuring board (no rules guards); 'match' = a real battle started via
   *  NewBattle — phase/once-per-turn guards apply and sandbox controls are hidden. */
  mode: 'sandbox' | 'match';
  /** 'combat_patrol' = a Combat Patrol battle (fixed patrol lists, 30"×44" maps, CP missions —
   *  the 11e Chapter Approved mission layer is skipped). Absent/'standard' = a normal battle. */
  battleType?: 'standard' | 'combat_patrol';
  /** The active player has already run their Command phase this turn (match-mode guard). */
  commandRun?: boolean;
  /** Core Stratagem "Command Re-roll" usage: side → phase key (`round:turn:phase`) it was last
   *  used in. Enforces once per phase per side (match-mode; currently bound to charge rolls). */
  rerollUsed?: Partial<Record<Side, string>>;
  /** Stratagem usage tracker: `${side}:${stratId}` → the phase key it was last used in.
   *  Enforces "each stratagem once per phase" (15.01) for the engine-bound stratagems. */
  stratUsed?: Record<string, string>;
  /** Counteroffensive (15.12): this unit must be the next selected to fight. Cleared when it
   *  fights or the phase ends. */
  fightNext?: string;
  /** Insane Bravery (15.04) is once per BATTLE per side. */
  insaneBraveryUsed?: Partial<Record<Side, boolean>>;
  /** Tactical (Secondary) Missions — per-side deck/hand/VP (match mode only). */
  secondaries?: Record<Side, SecondarySideState>;
  /** 11e Chapter Approved mission state (dispositions, primaries, markers, actions). */
  missions?: MissionState;
  /** Actions started this turn and not yet completed (16.01). */
  activeActions?: ActiveAction[];
  /** Units destroyed during the CURRENT turn (secondary scoring); reset at every turn end. */
  turnKills?: KillRecord[];
  /** Combat Patrol mission state (battleType 'combat_patrol' only; set at BeginBattle). */
  cpMissions?: CpMissionState;
  /** Objective control snapshot taken at the start of the active player's turn
   *  (Storm Hostile Objective). Index-aligned with `layout.objectives`. */
  controlAtTurnStart?: (Side | null)[];
  /** Pre-battle deployment sub-state (present while `stage === 'setup'`). */
  setup?: SetupState;
  round: number; // 1..5
  /** Absolute player-turn counter (increments at every turn change — Hidden's two-turn window). */
  turnCounter?: number;
  /** Which side took the first turn of the battle (the SAME side goes first every round in 11e). */
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
