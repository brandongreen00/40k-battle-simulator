#!/usr/bin/env python3
"""Build the three Combat Patrol layouts (30"x44") from the verified spec.

Source: three Warhammer-app map screenshots (owner-supplied, 2026-08).
`spec.json` holds hand-verified geometry (zones, mat rectangles, icons,
dividers) cross-checked against the screenshots by scripted colour
segmentation, dark-outline tracing, dotted-line RANSAC fits and printed
corner-offset measurements (offsets reference the NEAREST board edges).
`raw_98xx.json` holds the traced feature polygons (green=dense, gold=light).

Mats are emitted as clean rectangles (the printed torn edges are decorative);
every map uses the same 10-mat set: 2x 11.5"x7.5", 4x 6"x4", 4x 6"x2",
mirrored 180 degrees about the board centre.

Run:  python3 tools/layouts_cp/build.py     (writes data/layouts_cp/*.json)
"""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'data', 'layouts_cp'))

spec = json.load(open(os.path.join(HERE, 'spec.json')))

META = {
  '9886': dict(num=1, img='IMG_9886', attackerEdge='bottom'),
  '9887': dict(num=2, img='IMG_9887', attackerEdge='bottom'),
  '9888': dict(num=3, img='IMG_9888', attackerEdge='left'),
}
LETTERS = {'EF_big': 'EF', 'CD_big': 'CD', 'GH_med': 'GH', 'AB_med': 'AB'}

def rect_poly(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

def sh_area(poly):
    s = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]; x1, y1 = poly[(i + 1) % len(poly)]
        s += x0 * y1 - x1 * y0
    return abs(s) / 2

def centroid(poly):
    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
    return sum(xs) / len(xs), sum(ys) / len(ys)

for key, s in spec.items():
    meta = META[key]
    raw = json.load(open(os.path.join(HERE, f'raw_{key}.json')))
    mats = s['mats']
    areas = []
    order = list(mats.items())
    for i, (name, (x0, y0, x1, y1)) in enumerate(order):
        area = {'id': f'area-{i}', 'name': name, 'polygon': rect_poly(x0, y0, x1, y1), 'features': []}
        if name in LETTERS:
            area['letter'] = LETTERS[name]
        areas.append(area)

    skulls = [v for k, v in s['icons'].items() if k.startswith('skull')]
    def containing_area(cx, cy):
        best, bestd = None, 1e9
        for a, (name, (x0, y0, x1, y1)) in zip(areas, order):
            dx = max(x0 - cx, 0, cx - x1); dy = max(y0 - cy, 0, cy - y1)
            d = (dx * dx + dy * dy) ** 0.5
            if d < bestd: bestd, best = d, a
        return best if bestd <= 0.8 else None

    for kind, lst in (('dense', raw['green']), ('light', raw['gold'])):
        for f in lst:
            poly = [[round(x, 2), round(y, 2)] for x, y in f['poly']]
            if sh_area(poly) < 0.15: continue
            cx, cy = centroid(poly)
            if any((cx - sx) ** 2 + (cy - sy) ** 2 < 1.3 ** 2 for sx, sy in skulls):
                continue  # the teal skull-diamond icon, not terrain
            a = containing_area(cx, cy)
            if a is None: continue
            a['features'].append({'kind': kind, 'polygon': poly})

    icons = s['icons']
    objectives = [
      {'kind': 'home', 'owner': 'defender', 'pos': icons['castle_blue'],
       'areaId': containing_area(*icons['castle_blue'])['id']},
      {'kind': 'home', 'owner': 'attacker', 'pos': icons['castle_red'],
       'areaId': containing_area(*icons['castle_red'])['id']},
    ]
    for k, v in icons.items():
        if k.startswith('skull'):
            a = containing_area(*v)
            objectives.append({'kind': 'expansion', 'pos': v, 'areaId': a['id'] if a else None})

    area_markers = [{'kind': 'separate', 'pos': v} for k, v in icons.items() if k.startswith('sep')]
    divider_markers = [{'pos': v} for k, v in icons.items() if k.startswith('mark_')]

    out = {
      'id': f'cp2026-layout-{meta["num"]}',
      'name': f'Combat Patrol Layout {meta["num"]}',
      'boardWidth': 30.0, 'boardHeight': 44.0,
      'attackerEdge': meta['attackerEdge'],
      'players': [],
      'deploymentZones': {
        'attacker': [s['zones']['red']],
        'defender': [s['zones']['blue']],
      },
      'territoryDivider': s['divider'],
      'terrainAreas': areas,
      'objectives': objectives,
      'areaMarkers': area_markers,
      'dividerMarkers': divider_markers,
      'quarterGuides': True,
      'source': f'Warhammer app Combat Patrol map screenshot {meta["img"]} (2026-08), hand-verified',
    }
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f'{out["id"]}.json')
    json.dump(out, open(path, 'w'), indent=1)
    print(path, '| areas', len(areas), '| features', sum(len(a['features']) for a in areas),
          '| objectives', len(objectives), '| markers', len(area_markers), len(divider_markers))
