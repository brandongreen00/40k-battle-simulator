/**
 * Render a contact sheet (SVG) of the generated GW Chapter Approved 2025-26 layouts so they can be
 * eyeballed against labrador.dev. Reads data/layouts/ca2025-*.json; writes tools/layouts/preview.svg.
 *
 * Run with:  pnpm preview:layouts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'data', 'layouts');

interface Vec2 {
  x: number;
  y: number;
}
interface Layout {
  id: string;
  name?: string;
  deployment: string;
  boardWidth: number;
  boardHeight: number;
  terrain: { type: string; polygon: Vec2[] }[];
  objectives: Vec2[];
  objectiveControlRadiusIn?: number;
  objectiveMarkerDiameterIn?: number;
  deploymentZones: { player: Vec2[]; opponent: Vec2[] };
}

const SCALE = 4; // px per inch
const PAD = 16; // px gap between cells
const LABEL_H = 16;
const DEPLOY_ORDER = [
  'Crucible of Battle',
  'Search and Destroy',
  'Dawn of War',
  'Hammer and Anvil',
  'Sweeping Engagement',
  'Tipping Point',
];

const files = readdirSync(DIR).filter((f) => /^ca2025-.*\.json$/.test(f));
const layouts: Layout[] = files.map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')));
const byId = new Map(layouts.map((l) => [l.id, l] as const));
const slug = (d: string) => d.toLowerCase().replace(/ /g, '-').replace('-and-', '-and-');

const cellW = 60 * SCALE;
const cellH = 44 * SCALE + LABEL_H;
const cols = 8;
const rows = DEPLOY_ORDER.length;
const sheetW = PAD + cols * (cellW + PAD);
const sheetH = PAD + rows * (cellH + PAD) + 30;

// y-flip (our bottom-left origin → SVG top-left), within a cell.
const sx = (x: number) => x * SCALE;
const sy = (y: number) => (44 - y) * SCALE;
const pts = (poly: Vec2[]) => poly.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');

const FILL: Record<string, string> = {
  ruin_blocking: 'rgba(120,124,128,0.75)',
  area_cover: 'rgba(96,170,210,0.55)',
};
const STROKE: Record<string, string> = { ruin_blocking: '#5c6061', area_cover: '#2f7da5' };

function cell(l: Layout): string {
  const parts: string[] = [];
  parts.push(`<rect width="${60 * SCALE}" height="${44 * SCALE}" fill="#11161c" stroke="#2a3441"/>`);
  // zones
  parts.push(`<polygon points="${pts(l.deploymentZones.player)}" fill="#3b82f622" stroke="#3b82f688" stroke-dasharray="4 3"/>`);
  parts.push(`<polygon points="${pts(l.deploymentZones.opponent)}" fill="#ef444422" stroke="#ef444488" stroke-dasharray="4 3"/>`);
  // terrain
  for (const t of l.terrain) {
    parts.push(`<polygon points="${pts(t.polygon)}" fill="${FILL[t.type] ?? '#888'}" stroke="${STROKE[t.type] ?? '#aaa'}" stroke-width="0.7"/>`);
  }
  // objectives: 3" control ring + 40mm marker
  const ctrl = (l.objectiveControlRadiusIn ?? 3) * SCALE;
  const mk = ((l.objectiveMarkerDiameterIn ?? 40 / 25.4) / 2) * SCALE;
  for (const o of l.objectives) {
    parts.push(`<circle cx="${sx(o.x).toFixed(1)}" cy="${sy(o.y).toFixed(1)}" r="${ctrl.toFixed(1)}" fill="#eab30810" stroke="#eab30877" stroke-dasharray="3 3"/>`);
    parts.push(`<circle cx="${sx(o.x).toFixed(1)}" cy="${sy(o.y).toFixed(1)}" r="${mk.toFixed(1)}" fill="#eab30855" stroke="#eab308"/>`);
  }
  const n = l.id.match(/-(\d)$/)?.[1] ?? '?';
  return `<g><text x="2" y="${44 * SCALE + 12}" fill="#cbd5e1" font-family="sans-serif" font-size="11">Terrain Layout ${n}</text>${parts.join('')}</g>`;
}

let body = `<rect width="${sheetW}" height="${sheetH}" fill="#0b0e13"/>`;
body += `<text x="${PAD}" y="20" fill="#e2e8f0" font-family="sans-serif" font-size="16" font-weight="bold">GW Chapter Approved 2025-26 — 48 layouts (rows: deployment · columns: terrain layout 1-8)</text>`;

DEPLOY_ORDER.forEach((dep, r) => {
  const y0 = 30 + PAD + r * (cellH + PAD);
  body += `<text x="${PAD}" y="${y0 - 4}" fill="#94a3b8" font-family="sans-serif" font-size="12">${dep}</text>`;
  for (let c = 0; c < cols; c++) {
    const id = `ca2025-${slug(dep)}-${c + 1}`;
    const l = byId.get(id);
    if (!l) continue;
    const x0 = PAD + c * (cellW + PAD);
    body += `<g transform="translate(${x0},${y0})">${cell(l)}</g>`;
  }
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}" viewBox="0 0 ${sheetW} ${sheetH}">${body}</svg>\n`;
const out = join(dirname(fileURLToPath(import.meta.url)), 'preview.svg');
writeFileSync(out, svg);
console.log(`Wrote ${out} (${layouts.length} layouts, ${(svg.length / 1024).toFixed(0)} KB).`);
