/**
 * Extract the GW Chapter Approved 2025-26 terrain layouts and deployments from labrador.dev
 * and emit them as `Layout` JSON under `data/layouts/`.
 *
 * ─ Provenance ────────────────────────────────────────────────────────────────
 * Source: https://labrador.dev/40k_layouts?mapPack=gw-chapter-approved-2025-2026 (SvelteKit app).
 * The layout data is bundled in the client JS, not an API. The values embedded below were read
 * verbatim from the production bundles (June 2026 build):
 *   • Deployments (zones + objectives)  → _app/immutable/chunks/CW8xRr0c.js
 *   • Terrain feature shapes/footprints → _app/immutable/chunks/cqzbK7sO.js
 *   • The 8 terrain layouts (half-board)→ _app/immutable/nodes/3.AeyLoVTb.js  (vars tn,nn,rn,an,on,sn,fn,pn)
 *
 * ─ How labrador models a board ───────────────────────────────────────────────
 * Board is 60"×44". A layout stores only HALF the terrain; the renderer mirrors each piece by
 * 180° about the board centre (30,22) — `Ft()`/`Pt()` in cqzbK7sO.js. Each placed piece is
 *   { feature, point:{x,y}, rotation°, flip }
 * and the render transform (Sb5RK290.js) is, in labrador's y-DOWN screen space:
 *   final = point + flipX( rotate(rotation, localFootprintCorner) )
 * Splits are encoded as two adjacent features: a 12×6 "grey+blue" piece = an 8×6 grey (z) butted
 * against a 4×6 blue (y); a 10×5 = a 6.5×5 grey (T) + a 3.5×5 blue (R). (Verified: those pairs
 * share an exact edge once transformed.) Grey = tall, LoS-blocking ruin (footprintColor #5C6061);
 * blue = terrain ≤2" high / area cover (path colour #065475).
 *
 * ─ Our conventions ───────────────────────────────────────────────────────────
 * Our board coords are inches, origin BOTTOM-LEFT (y up). labrador is top-left (y down), so every
 * extracted point is converted once at the end: (x, y) → (x, 44 − y). This makes our maps render
 * identically to labrador's. Deployment zones map attacker→player, defender→opponent.
 *
 * Run with:  pnpm extract:layouts   (alias for `tsx tools/layouts/extract-gw-ca-2025.ts`)
 * Output is committed; this script needs no network access.
 */

import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'data', 'layouts');

const BOARD_W = 60;
const BOARD_H = 44;
const CENTER = { x: BOARD_W / 2, y: BOARD_H / 2 }; // (30, 22)

// Objective spec (uniform across all GW maps): 40mm marker, 3" horizontal control range.
const OBJ_MARKER_DIAMETER_IN = 40 / 25.4; // ≈ 1.5748"
const OBJ_CONTROL_RADIUS_IN = 3;

// ── Types (mirror of src/core/types.ts; output is validated against it at build/typecheck) ──
interface Vec2 {
  x: number;
  y: number;
}
type TerrainType = 'ruin_blocking' | 'area_cover' | 'obstacle';
interface TerrainPiece {
  id: string;
  type: TerrainType;
  polygon: Vec2[];
  height?: 'tall' | 'low';
  source?: string;
}
interface Layout {
  id: string;
  name: string;
  boardWidth: number;
  boardHeight: number;
  deployment: string;
  deploymentId: string;
  source: string;
  objectiveMarkerDiameterIn: number;
  objectiveControlRadiusIn: number;
  terrain: TerrainPiece[];
  objectives: Vec2[];
  deploymentZones: { player: Vec2[]; opponent: Vec2[] };
}

// ── 1. Terrain feature footprints (from cqzbK7sO.js) ──────────────────────────
// Each feature's footprint is an axis-aligned rectangle with its local origin at [0,0].
// kind: grey = tall ruin (ruin_blocking); blue = ≤2" area terrain (area_cover).
const FEATURES: Record<string, { w: number; h: number; kind: 'grey' | 'blue' }> = {
  L: { w: 12, h: 6, kind: 'grey' }, //  Xe — solid 12×6 ruin
  O: { w: 12, h: 6, kind: 'grey' }, //  Ze — solid 12×6 ruin
  z: { w: 8, h: 6, kind: 'grey' }, //   Qe — 8×6 grey portion of a split 12×6
  y: { w: 4, h: 6, kind: 'blue' }, //   et — 4×6 blue (split portion, or a standalone 6×4 area piece)
  T: { w: 6.5, h: 5, kind: 'grey' }, // tt — 6.5×5 grey portion of a split 10×5
  R: { w: 3.5, h: 5, kind: 'blue' }, // nt — 3.5×5 blue portion of a split 10×5
  Fe: { w: 6, h: 4, kind: 'grey' }, //  rt — 6×4 grey (layout 7 only)
  E: { w: 8, h: 6, kind: 'grey' }, //   $e — 8×6 grey (layout 7 only)
  D: { w: 6, h: 2, kind: 'blue' }, //   it — 6×2 blue (layout 7 only)
};

// ── 2. The 8 terrain layouts (verbatim half-board data from nodes/3.AeyLoVTb.js) ──
const RAW_HALF_LAYOUTS: string[] = [
  // 1 (tn)
  `[{feature:L,flip:!1,point:{x:12,y:5},rotation:90},{feature:O,flip:!1,point:{x:22,y:28},rotation:90},{feature:z,flip:!0,point:{x:16,y:22},rotation:0},{feature:y,flip:!1,point:{x:4,y:22},rotation:0},{feature:y,flip:!1,point:{x:28,y:0},rotation:0},{feature:T,flip:!0,point:{x:30,y:17},rotation:-45},{feature:R,flip:!0,point:{x:25.4,y:12.4},rotation:-45},{feature:y,flip:!0,point:{x:26.48,y:20.6},rotation:-45}]`,
  // 2 (nn)
  `[{feature:z,flip:!1,point:{x:11,y:4},rotation:90},{feature:y,flip:!1,point:{x:11,y:12},rotation:90},{feature:O,flip:!1,point:{x:17,y:15.55},rotation:42},{feature:y,flip:!1,point:{x:2,y:28},rotation:-90},{feature:L,flip:!1,point:{x:14,y:28},rotation:90},{feature:y,flip:!1,point:{x:24,y:35},rotation:-90},{feature:R,flip:!1,point:{x:20,y:4},rotation:0},{feature:T,flip:!0,point:{x:23.5,y:9},rotation:180}]`,
  // 3 (rn)
  `[{feature:z,flip:!1,point:{x:14.5,y:14},rotation:132},{feature:y,flip:!0,point:{x:4.7,y:15.9},rotation:48},{feature:y,flip:!0,point:{x:10,y:4},rotation:90},{feature:O,flip:!0,point:{x:22,y:10},rotation:180},{feature:L,flip:!0,point:{x:17.2,y:32.9},rotation:-30},{feature:R,flip:!1,point:{x:21,y:14},rotation:53},{feature:T,flip:!0,point:{x:27,y:22},rotation:307},{feature:y,flip:!0,point:{x:22.2,y:24},rotation:40}]`,
  // 4 (an)
  `[{feature:O,flip:!1,point:{x:8,y:27.5},rotation:41.5},{feature:L,flip:!1,point:{x:24,y:10},rotation:180},{feature:y,flip:!0,point:{x:12,y:10},rotation:0},{feature:y,flip:!0,point:{x:8,y:19},rotation:0},{feature:T,flip:!1,point:{x:18,y:16.2},rotation:48},{feature:R,flip:!1,point:{x:21,y:27},rotation:-132},{feature:z,flip:!1,point:{x:22.9,y:28.5},rotation:53},{feature:y,flip:!1,point:{x:27.7,y:34.9},rotation:53}]`,
  // 5 (on)
  `[{feature:O,flip:!0,point:{x:24,y:10},rotation:180},{feature:y,flip:!0,point:{x:12,y:4},rotation:90},{feature:L,flip:!1,point:{x:18.4,y:16.5},rotation:155.5},{feature:y,flip:!0,point:{x:0,y:24},rotation:90},{feature:T,flip:!0,point:{x:26,y:24},rotation:0},{feature:R,flip:!0,point:{x:16,y:29},rotation:180},{feature:z,flip:!1,point:{x:7,y:30.8},rotation:30},{feature:y,flip:!1,point:{x:14.4,y:42},rotation:210}]`,
  // 6 (sn)
  `[{feature:O,flip:!1,point:{x:8.5,y:27},rotation:48},{feature:y,flip:!0,point:{x:10,y:10},rotation:0},{feature:z,flip:!1,point:{x:22,y:10},rotation:180},{feature:y,flip:!0,point:{x:10,y:10},rotation:180},{feature:L,flip:!1,point:{x:26,y:28},rotation:90},{feature:y,flip:!0,point:{x:30,y:28},rotation:90},{feature:T,flip:!1,point:{x:16.8,y:14.600000000000001},rotation:50},{feature:R,flip:!0,point:{x:23.2,y:22.2},rotation:-50}]`,
  // 7 (fn)
  `[{feature:O,flip:!1,point:{x:29,y:3},rotation:90},{feature:z,flip:!0,point:{x:12,y:40},rotation:-90},{feature:y,flip:!0,point:{x:12,y:32},rotation:-90},{feature:y,flip:!0,point:{x:12,y:44},rotation:-90},{feature:T,flip:!0,point:{x:23,y:36},rotation:-90},{feature:R,flip:!0,point:{x:18,y:26},rotation:90},{feature:Fe,flip:!1,point:{x:23,y:20},rotation:90},{feature:E,flip:!1,point:{x:14,y:10},rotation:90},{feature:D,flip:!1,point:{x:8,y:8},rotation:0},{feature:D,flip:!1,point:{x:8,y:18},rotation:0}]`,
  // 8 (pn)
  `[{feature:O,flip:!1,point:{x:28,y:0},rotation:90},{feature:y,flip:!1,point:{x:23,y:28},rotation:0},{feature:y,flip:!0,point:{x:27,y:22},rotation:0},{feature:L,flip:!0,point:{x:19,y:35.5},rotation:-42},{feature:z,flip:!0,point:{x:19,y:25},rotation:-90},{feature:y,flip:!1,point:{x:13,y:17},rotation:-90},{feature:T,flip:!1,point:{x:15,y:8},rotation:143},{feature:R,flip:!1,point:{x:4,y:10},rotation:-37}]`,
];

// ── 3. The 6 Strike Force deployments (from CW8xRr0c.js; o=30, s=22) ───────────
interface DeploymentDef {
  slug: string;
  label: string;
  id: string;
  attacker: string; // SVG path, labrador coords
  defender: string;
  objectives: [number, number][]; // labrador coords
}
const o = CENTER.x;
const s = CENTER.y;
const DEPLOYMENTS: DeploymentDef[] = [
  {
    slug: 'crucible-of-battle',
    label: 'Crucible of Battle',
    id: 'crucible-of-battle-sf-2025',
    attacker: 'M 0,0 L 30,44 L 0,44 L 0,0',
    defender: 'M 30,0 L 60,0 L 60,44 L 30,0',
    objectives: [[o, s], [o - 10, s - 14], [o - 16, s + 12], [o + 10, s + 14], [o + 16, s - 12]],
  },
  {
    slug: 'search-and-destroy',
    label: 'Search and Destroy',
    id: 'search-and-destroy-sf-2025',
    attacker: 'M 30 31 L 30 44 L 0 44 L 0 22 L 21 22 A 9 9 0 0 0 30 31',
    defender: 'M 30 13 L 30 0 L 60 0 L 60 22 L 39 22 A 9 9 0 0 0 30 13',
    objectives: [[o, s], [o - 16, s - 12], [o - 16, s + 12], [o + 16, s + 12], [o + 16, s - 12]],
  },
  {
    slug: 'dawn-of-war',
    label: 'Dawn of War',
    id: 'dawn-of-war-sf-2025',
    attacker: 'M 0,32 L 60,32 L 60,44 L 0,44',
    defender: 'M 0,0 L 0,12 L 60,12 L 60,0',
    objectives: [[o, s], [o, s + 16], [o, s - 16], [o + 20, s], [o - 20, s]],
  },
  {
    slug: 'hammer-and-anvil',
    label: 'Hammer and Anvil',
    id: 'hammer-and-anvil-sf-2025',
    attacker: 'M 42,0 L 60,0 L 60,44 L 42,44',
    defender: 'M 0,0 L 18,0 L 18,44 L 0,44',
    objectives: [[o, s], [o, s + 16], [o, s - 16], [o + 20, s], [o - 20, s]],
  },
  {
    slug: 'sweeping-engagement',
    label: 'Sweeping Engagement',
    id: 'sweeping-engagement-sf-2025',
    attacker: 'M 0,0 L 60,0 L 60,14 L 30,14 L 30,8 L 0,8',
    defender: 'M 0,44 L 60,44 L 60,36 L 30,36 L 30,30 L 0,30',
    objectives: [[o, s], [o - 12, s + 16], [10, 18], [o + 12, s - 16], [50, 26]],
  },
  {
    slug: 'tipping-point',
    label: 'Tipping Point',
    id: 'tipping-point-sf-2025',
    attacker: 'M 60,0 L 60,44 L 48,44 L 48,22 L 40,22 L 40,0',
    defender: 'M 0,0 L 12,0 L 12,22 L 20,22 L 20,44 L 0,44',
    objectives: [[22, 8], [46, 10], [o, s], [14, 34], [38, 36]],
  },
];

// ── Geometry helpers (all in labrador's y-DOWN space until the final flip) ─────
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const ours = (p: Vec2): Vec2 => ({ x: r3(p.x), y: r3(BOARD_H - p.y) }); // y-flip to our bottom-left origin
// 180° rotation about board centre, IN OUR COORDS. Applied to already-rounded points so the two
// halves are provably symmetric (no sub-0.001" rounding drift between a piece and its partner).
const rot180 = (p: Vec2): Vec2 => ({ x: r3(BOARD_W - p.x), y: r3(BOARD_H - p.y) });

/** Rotate a vector by `deg` in y-down screen space (matches SVG `rotate`). */
function rotate(p: Vec2, deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const sn = Math.sin(r);
  return { x: p.x * c - p.y * sn, y: p.x * sn + p.y * c };
}

interface Placed {
  feature: string;
  flip: boolean;
  point: Vec2;
  rotation: number;
}

function parseHalfLayout(raw: string): Placed[] {
  const re = /\{feature:([A-Za-z]+),flip:!([01]),point:\{x:(-?[\d.]+),y:(-?[\d.]+)\},rotation:(-?[\d.]+)\}/g;
  const out: Placed[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push({
      feature: m[1],
      flip: m[2] === '0', // !0 === true (flipped), !1 === false
      point: { x: Number(m[3]), y: Number(m[4]) },
      rotation: Number(m[5]),
    });
  }
  return out;
}

/** Footprint corners of a placed piece, in labrador coords: point + flipX(rotate(local)). */
function footprint(p: Placed): Vec2[] {
  const f = FEATURES[p.feature];
  if (!f) throw new Error(`Unknown feature ${p.feature}`);
  const local: Vec2[] = [
    { x: 0, y: 0 },
    { x: f.w, y: 0 },
    { x: f.w, y: f.h },
    { x: 0, y: f.h },
  ];
  return local.map((lc) => {
    let v = rotate(lc, p.rotation);
    if (p.flip) v = { x: -v.x, y: v.y }; // scale(-1,1) applied after rotate
    return { x: p.point.x + v.x, y: p.point.y + v.y };
  });
}

// ── SVG path → polygon (handles M, L absolute, and A arcs; comma/space separators) ──
function tokenize(d: string): string[] {
  return d.replace(/,/g, ' ').trim().split(/\s+/);
}

/** Endpoint-parameterised SVG arc → sampled points (excluding the start point). */
function arcPoints(p0: Vec2, rx: number, ry: number, phiDeg: number, fA: number, fS: number, p1: Vec2, n = 24): Vec2[] {
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;
  const num = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2;
  const den = rx2 * y1p2 + ry2 * x1p2;
  let co = Math.sqrt(Math.max(0, num / den));
  if (fA === fS) co = -co;
  const cxp = (co * (rx * y1p)) / ry;
  const cyp = (co * (-ry * x1p)) / rx;
  const cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2;
  const cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = angle(1, 0, ux, uy);
  let dtheta = angle(ux, uy, vx, vy);
  if (!fS && dtheta > 0) dtheta -= 2 * Math.PI;
  if (fS && dtheta < 0) dtheta += 2 * Math.PI;
  const pts: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = theta1 + (dtheta * i) / n;
    pts.push({
      x: cosP * rx * Math.cos(t) - sinP * ry * Math.sin(t) + cx,
      y: sinP * rx * Math.cos(t) + cosP * ry * Math.sin(t) + cy,
    });
  }
  return pts;
}

function pathToPolygon(d: string): Vec2[] {
  const t = tokenize(d);
  const poly: Vec2[] = [];
  let i = 0;
  let cur: Vec2 = { x: 0, y: 0 };
  while (i < t.length) {
    const cmd = t[i++];
    if (cmd === 'M' || cmd === 'L') {
      cur = { x: Number(t[i++]), y: Number(t[i++]) };
      poly.push(cur);
    } else if (cmd === 'A') {
      const rx = Number(t[i++]);
      const ry = Number(t[i++]);
      const rot = Number(t[i++]);
      const fA = Number(t[i++]);
      const fS = Number(t[i++]);
      const end = { x: Number(t[i++]), y: Number(t[i++]) };
      poly.push(...arcPoints(cur, rx, ry, rot, fA, fS, end));
      cur = end;
    } else if (cmd === 'Z' || cmd === 'z') {
      // close — implicit for polygons
    } else {
      throw new Error(`Unsupported path command "${cmd}" in: ${d}`);
    }
  }
  // Drop a trailing point that duplicates the first (paths often close back to start).
  if (poly.length > 1) {
    const a = poly[0];
    const b = poly[poly.length - 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) poly.pop();
  }
  return poly;
}

// ── Build one Layout ──────────────────────────────────────────────────────────
function buildLayout(dep: DeploymentDef, layoutIndex: number): Layout {
  const half = parseHalfLayout(RAW_HALF_LAYOUTS[layoutIndex]);
  const n = layoutIndex + 1;

  const terrain: TerrainPiece[] = [];
  half.forEach((piece, pi) => {
    const f = FEATURES[piece.feature];
    const type: TerrainType = f.kind === 'grey' ? 'ruin_blocking' : 'area_cover';
    const height = f.kind === 'grey' ? 'tall' : 'low';
    // Original (this half) in our coords; its 180° partner is the exact rotation of the rounded
    // original (labrador builds the other half by mirroring each piece 180° about the centre).
    const poly = footprint(piece).map(ours);
    terrain.push({
      id: `t${pi}`,
      type,
      height,
      source: `${piece.feature} ${f.w}x${f.h}`,
      polygon: poly,
    });
    terrain.push({
      id: `t${pi}m`,
      type,
      height,
      source: `${piece.feature} ${f.w}x${f.h} (180° partner)`,
      polygon: poly.map(rot180),
    });
  });

  const objectives: Vec2[] = dep.objectives.map(([x, y]) => ours({ x, y }));
  const player = pathToPolygon(dep.attacker).map(ours);
  const opponent = pathToPolygon(dep.defender).map(ours);

  return {
    id: `ca2025-${dep.slug}-${n}`,
    name: `GW Chapter Approved 2025–2026 · ${dep.label} · Terrain Layout ${n}`,
    boardWidth: BOARD_W,
    boardHeight: BOARD_H,
    deployment: dep.label,
    deploymentId: dep.id,
    source: 'labrador.dev (gw-chapter-approved-2025-2026), Strike Force; extracted by tools/layouts/extract-gw-ca-2025.ts',
    objectiveMarkerDiameterIn: r3(OBJ_MARKER_DIAMETER_IN),
    objectiveControlRadiusIn: OBJ_CONTROL_RADIUS_IN,
    terrain,
    objectives,
    deploymentZones: { player, opponent },
  };
}

// ── Sanity checks (cheap; catch transform regressions) ────────────────────────
function check(layout: Layout) {
  const within = (p: Vec2) => p.x >= -0.75 && p.x <= BOARD_W + 0.75 && p.y >= -0.75 && p.y <= BOARD_H + 0.75;
  for (const t of layout.terrain) {
    if (t.polygon.length !== 4) throw new Error(`${layout.id} ${t.id}: expected 4 corners`);
    for (const p of t.polygon) {
      if (!within(p)) console.warn(`  ⚠ ${layout.id} ${t.id} corner off-board: (${p.x}, ${p.y})`);
    }
    // Edge lengths must equal the feature footprint (rotation/flip are isometries).
    const [a, b, , d] = t.polygon;
    const e1 = Math.hypot(b.x - a.x, b.y - a.y);
    const e2 = Math.hypot(d.x - a.x, d.y - a.y);
    const dims = [e1, e2].map((x) => Math.round(x * 10) / 10).sort((p, q) => p - q);
    const [fw, fh] = t.source!.split(' ')[1].split('x').map(Number).sort((p, q) => p - q);
    if (Math.abs(dims[0] - fw) > 0.05 || Math.abs(dims[1] - fh) > 0.05) {
      throw new Error(`${layout.id} ${t.id}: footprint ${dims} != ${[fw, fh]}`);
    }
  }
  if (layout.objectives.length !== 5) throw new Error(`${layout.id}: expected 5 objectives`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  // Idempotent: clear previously generated ca2025-*.json before writing the fresh set.
  for (const f of readdirSync(OUT_DIR)) {
    if (/^ca2025-.*\.json$/.test(f)) unlinkSync(join(OUT_DIR, f));
  }

  let count = 0;
  let grey = 0;
  let blue = 0;
  for (const dep of DEPLOYMENTS) {
    for (let i = 0; i < RAW_HALF_LAYOUTS.length; i++) {
      const layout = buildLayout(dep, i);
      check(layout);
      grey += layout.terrain.filter((t) => t.type === 'ruin_blocking').length;
      blue += layout.terrain.filter((t) => t.type === 'area_cover').length;
      writeFileSync(join(OUT_DIR, `${layout.id}.json`), JSON.stringify(layout, null, 2) + '\n');
      count++;
    }
  }
  console.log(`Wrote ${count} layouts to data/layouts/ (${DEPLOYMENTS.length} deployments × ${RAW_HALF_LAYOUTS.length} terrain layouts).`);
  console.log(`Terrain pieces: ${grey} grey (ruin_blocking) + ${blue} blue (area_cover) across all maps.`);
}

main();
