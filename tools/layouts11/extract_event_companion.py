#!/usr/bin/env python3
"""Extract the 45 Warhammer Event Companion (11th edition, June 2026) terrain layouts.

Source PDF (not committed - GW IP, personal use):
  https://assets.warhammer-community.com/eng_12-06_warhammer40000_event_companion-s3bfb5f9s1-ivswuij3fo.pdf

The companion's layout pages (9-53) are vector diagrams. This script reads the
vector objects directly (pdfplumber) so every polygon is exact, calibrated via the
44"x60" battlefield image on each page (scale ~7.7445 pt/inch).

Colour code (CMYK fills, from the p.8 "Layouts Key"):
  (0,1,1,.4)   red    = Attacker deployment zone (+ attacker home objective ring)
  (1,.4,0,.6)  blue   = Defender deployment zone (+ defender home objective ring)
  (0,0,0,.2)   grey   = terrain area polygons (the 5 canonical footprints)
  (1,0,.6,.4)  teal   = central objective circle (25pt) / feature letter badges (16pt)
  (.7,0,.42,.28) teal-dark = expansion objective diamonds (5-pt path)
  (0,0,0,.6)   grey   = single/separate terrain-area markers (15.9pt circles;
                        'separate' has an extra 3-pt slash stroke)
Terrain features are tinted photos (images): green tint = dense, gold tint = light,
neutral rust = the terrain-area base mats (skipped; grey polygons are the areas).
Dashed black line = attacker/defender territory divider.

Output: data/layouts11/<id>.json + data/layouts11/index.json
Coordinates: inches, origin bottom-left of the battlefield, y up (sim convention).
Vertical maps are 44 wide x 60 tall with the Attacker's edge at TOP (y=60).

Usage: python3 tools/layouts11/extract_event_companion.py <event_companion.pdf>
Deps:  pip install pdfplumber pypdfium2 pillow
"""
import json
import math
import os
import re
import sys
from collections import defaultdict

import pdfplumber
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image

PAGES = range(9, 54)  # 1-indexed layout pages
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data", "layouts11")

RED = (0.0, 1.0, 1.0, 0.4)
BLUE = (1.0, 0.4, 0.0, 0.6)
GREY_AREA = (0.0, 0.0, 0.0, 0.2)
TEAL = (1.0, 0.0, 0.6, 0.4)
TEAL_DARK = (0.7, 0.0, 0.42, 0.28)
GREY_ICON = (0.0, 0.0, 0.0, 0.6)


def col_eq(c, ref, tol=0.01):
    if c is None or c == 0 or isinstance(c, (int, float)):
        return False
    if len(c) != len(ref):
        return False
    return all(abs(a - b) <= tol for a, b in zip(c, ref))


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


class Calib:
    """page pt -> board inches (origin bottom-left, y up)."""

    def __init__(self, bbox):
        self.x0, self.top, self.x1, self.bottom = bbox
        w_pt = self.x1 - self.x0
        h_pt = self.bottom - self.top
        ratio = w_pt / h_pt
        if abs(ratio - 44 / 60) < 0.02:
            self.w_in, self.h_in = 44.0, 60.0
        elif abs(ratio - 60 / 44) < 0.04:
            self.w_in, self.h_in = 60.0, 44.0
        else:
            raise ValueError(f"battlefield ratio {ratio:.3f} not 44x60 or 60x44")
        self.sx = self.w_in / w_pt
        self.sy = self.h_in / h_pt

    def pt(self, x, y_top):
        """(x, top-based y) page pt -> board inches."""
        return (
            round((x - self.x0) * self.sx, 3),
            round((self.bottom - y_top) * self.sy, 3),
        )

    def contains(self, x, y_top, pad=6):
        return (
            self.x0 - pad <= x <= self.x1 + pad
            and self.top - pad <= y_top <= self.bottom + pad
        )


def flatten_path(curve):
    """Flatten a pdfplumber path (m/l/c/h segments, top-based page pts) to points."""
    path = curve.get("path")
    if not path:
        return [tuple(p) for p in curve["pts"]]
    pts = []
    start = None
    cur = None
    for seg in path:
        op = seg[0]
        if op == "m":
            cur = seg[1]
            start = cur
            pts.append(cur)
        elif op == "l":
            cur = seg[1]
            pts.append(cur)
        elif op == "c":
            p1, p2, p3 = seg[1], seg[2], seg[3]
            p0 = cur
            for i in range(1, 9):
                t = i / 8
                mt = 1 - t
                x = (mt**3) * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0]
                y = (mt**3) * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1]
                pts.append((x, y))
            cur = p3
        elif op == "h":
            if start is not None:
                cur = start
    return pts


def poly_pts(curve, cal):
    pts = [cal.pt(x, y) for (x, y) in flatten_path(curve)]
    # drop consecutive duplicates and a closing point equal to the first
    out = []
    for p in pts:
        if not out or (abs(p[0] - out[-1][0]) > 1e-6 or abs(p[1] - out[-1][1]) > 1e-6):
            out.append(p)
    if len(out) > 1 and abs(out[0][0] - out[-1][0]) < 1e-6 and abs(out[0][1] - out[-1][1]) < 1e-6:
        out = out[:-1]
    return out


def poly_area(pts):
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def centroid(bbox):
    x0, t, x1, b = bbox
    return (x0 + x1) / 2, (t + b) / 2


def point_in_poly(p, poly):
    x, y = p
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < xin:
                inside = not inside
    return inside


def clamp_poly(pts, w, h):
    return [(min(max(x, 0.0), w), min(max(y, 0.0), h)) for (x, y) in pts]


def simplify(pts, tol=0.06):
    """Douglas-Peucker on a closed polygon (inches)."""
    if len(pts) <= 8:
        return pts

    def dp(seg):
        if len(seg) <= 2:
            return seg
        (x1, y1), (x2, y2) = seg[0], seg[-1]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy) or 1e-9
        best_i, best_d = 0, -1.0
        for i in range(1, len(seg) - 1):
            px, py = seg[i]
            d = abs(dx * (y1 - py) - dy * (x1 - px)) / norm
            if d > best_d:
                best_i, best_d = i, d
        if best_d <= tol:
            return [seg[0], seg[-1]]
        left = dp(seg[: best_i + 1])
        right = dp(seg[best_i:])
        return left[:-1] + right

    closed = pts + [pts[0]]
    out = dp(closed)[:-1]
    return out if len(out) >= 3 else pts


def image_quads(doc, page_no, page_height):
    """Image placements as page-space quads (top-based y), via pdfium matrices."""
    page = doc[page_no - 1]
    quads = []
    for obj in page.get_objects(max_depth=4):
        if obj.type != pdfium_c.FPDF_PAGEOBJ_IMAGE:
            continue
        try:
            m = obj.get_matrix()
        except Exception:
            continue
        corners = []
        for u, v in ((0, 0), (1, 0), (1, 1), (0, 1)):
            x = m.a * u + m.c * v + m.e
            y = m.b * u + m.d * v + m.f
            corners.append((x, page_height - y))
        quads.append(corners)
    return quads


def parse_header(page):
    """Two stroked header boxes: FORCE DISPOSITION <name> / MISSION <name>."""
    boxes = [r for r in page.rects if r["stroke"] and (r["x1"] - r["x0"]) > 150]
    boxes.sort(key=lambda r: r["x0"])
    out = []
    words = page.extract_words()
    for r in boxes[:2]:
        inside = [
            w
            for w in words
            if r["x0"] - 2 <= w["x0"] and w["x1"] <= r["x1"] + 2
            and r["top"] - 2 <= w["top"] and w["bottom"] <= r["bottom"] + 2
        ]
        # group into lines by top
        lines = defaultdict(list)
        for w in inside:
            lines[round(w["top"] / 4)].append(w)
        ordered = [
            " ".join(w["text"] for w in sorted(ws, key=lambda w: w["x0"]))
            for _, ws in sorted(lines.items())
        ]
        fd, mission, mode = [], [], None
        for ln in ordered:
            up = ln.upper().strip()
            if up == "FORCE DISPOSITION":
                mode = "fd"
                continue
            if up == "MISSION":
                mode = "mission"
                continue
            if up in ("VS", ""):
                continue
            if mode == "fd":
                fd.append(up)
            elif mode == "mission":
                mission.append(up)
        out.append({"disposition": " ".join(fd), "mission": " ".join(mission)})
    if len(out) != 2 or not all(o["disposition"] and o["mission"] for o in out):
        raise ValueError(f"header parse failed: {out}")
    return out


def find_board_bbox(page):
    best = None
    for im in page.images:
        w = im["x1"] - im["x0"]
        h = im["bottom"] - im["top"]
        if w < 250 or h < 250:
            continue
        # must sit within the page (the full-page background image bleeds past it)
        if (im["x0"] < -1 or im["top"] < -1
                or im["x1"] > page.width + 1 or im["bottom"] > page.height + 1):
            continue
        if w > page.width * 0.85 and h > page.height * 0.85:
            continue
        ratio = w / h
        if abs(ratio - 44 / 60) < 0.02 or abs(ratio - 60 / 44) < 0.04:
            area = w * h
            if best is None or area > best[0]:
                best = (area, (im["x0"], im["top"], im["x1"], im["bottom"]))
    if not best:
        raise ValueError("no battlefield image found")
    return best[1]


def snap_to_edges(pts, w, h, tol=0.35):
    out = []
    for x, y in pts:
        if x < tol:
            x = 0.0
        elif x > w - tol:
            x = w
        if y < tol:
            y = 0.0
        elif y > h - tol:
            y = h
        out.append((x, y))
    return out


def rect_overlap(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ox = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    oy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    return ox * oy


def dedupe(polys, tol=0.35):
    out = []
    for p in polys:
        bb = (
            min(x for x, _ in p),
            min(y for _, y in p),
            max(x for x, _ in p),
            max(y for _, y in p),
        )
        dup = False
        for q, qb in out:
            if all(abs(a - b) < tol for a, b in zip(bb, qb)):
                # keep the higher-vertex-count version of the same shape
                if len(p) > len(q):
                    out[out.index((q, qb))] = (p, qb)
                dup = True
                break
        if not dup:
            out.append((p, bb))
    return [p for p, _ in out]


def classify_image_tint(render, rscale, cal, bbox):
    """Average hue of the page render inside a shrunk bbox -> dense/light/mat."""
    x0, t, x1, b = bbox
    # shrink 25% to avoid background bleed
    dx = (x1 - x0) * 0.25
    dy = (b - t) * 0.25
    crop = render.crop(
        (int((x0 + dx) * rscale), int((t + dy) * rscale),
         max(int((x1 - dx) * rscale), int((x0 + dx) * rscale) + 2),
         max(int((b - dy) * rscale), int((t + dy) * rscale) + 2))
    ).convert("RGB")
    px = list(crop.resize((24, 24)).getdata())
    greens = golds = 0
    for r, g, bl in px:
        mx, mn = max(r, g, bl), min(r, g, bl)
        if mx - mn < 18:
            continue
        if g > r * 1.12 and g > bl * 1.05:
            greens += 1
        elif r > bl * 1.25 and g > bl * 1.15 and r >= g * 0.92:
            golds += 1
    total = len(px)
    if greens > total * 0.22 and greens > golds * 1.3:
        return "dense"
    if golds > total * 0.3 and golds > greens * 1.3:
        return "light"
    return "mat"


def extract_page(pdf, doc, page_no):
    page = pdf.pages[page_no - 1]
    header = parse_header(page)
    cal = Calib(find_board_bbox(page))
    render = doc[page_no - 1].render(scale=2.0).to_pil()
    rscale = 2.0

    zones = {"attacker": [], "defender": []}
    areas = []
    objectives = []
    markers = []
    letter_badges = []  # (pos_in, ())
    divider = None

    # deployment zones drawn as plain rectangles (straight bands)
    for r in page.rects:
        if not r.get("fill"):
            continue
        ns = r.get("non_stroking_color")
        side = "attacker" if col_eq(ns, RED) else "defender" if col_eq(ns, BLUE) else None
        if side is None:
            continue
        if not cal.contains(*centroid((r["x0"], r["top"], r["x1"], r["bottom"]))):
            continue
        x0, y1 = cal.pt(r["x0"], r["top"])
        x1, y0 = cal.pt(r["x1"], r["bottom"])
        if (x1 - x0) * (y1 - y0) > 40:
            zones[side].append(
                clamp_poly([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], cal.w_in, cal.h_in)
            )

    for c in page.curves:
        if not cal.contains(*centroid((c["x0"], c["top"], c["x1"], c["bottom"]))):
            continue
        ns = c.get("non_stroking_color")
        w = c["x1"] - c["x0"]
        h = c["bottom"] - c["top"]
        big = w > 6 and h > 6
        if c["fill"]:
            if col_eq(ns, GREY_AREA):
                p = poly_pts(c, cal)
                if poly_area(p) > 2:
                    areas.append(p)
            elif col_eq(ns, RED):
                p = poly_pts(c, cal)
                a = poly_area(p)
                if a > 40:
                    zones["attacker"].append(clamp_poly(p, cal.w_in, cal.h_in))
                elif 2.5 < w * cal.sx < 4.5 and abs(w - h) < 2 and len(c["pts"]) <= 6:
                    objectives.append(
                        {"kind": "home", "owner": "attacker",
                         "pos": cal.pt(*centroid((c["x0"], c["top"], c["x1"], c["bottom"])))}
                    )
            elif col_eq(ns, BLUE):
                p = poly_pts(c, cal)
                a = poly_area(p)
                if a > 40:
                    zones["defender"].append(clamp_poly(p, cal.w_in, cal.h_in))
                elif 2.5 < w * cal.sx < 4.5 and abs(w - h) < 2 and len(c["pts"]) <= 6:
                    objectives.append(
                        {"kind": "home", "owner": "defender",
                         "pos": cal.pt(*centroid((c["x0"], c["top"], c["x1"], c["bottom"])))}
                    )
            elif col_eq(ns, TEAL):
                d_in = w * cal.sx
                pos = cal.pt(*centroid((c["x0"], c["top"], c["x1"], c["bottom"])))
                if 2.6 < d_in < 4.2 and len(c["pts"]) <= 6:
                    objectives.append({"kind": "central", "pos": pos})
                elif 1.6 <= d_in <= 2.6 and len(c["pts"]) <= 6:
                    letter_badges.append(pos)
            elif col_eq(ns, TEAL_DARK) and big and len(c["pts"]) <= 6:
                pos = cal.pt(*centroid((c["x0"], c["top"], c["x1"], c["bottom"])))
                objectives.append({"kind": "expansion", "pos": pos})
            elif col_eq(ns, GREY_ICON) and big and 1.4 < w * cal.sx < 2.6 and len(c["pts"]) <= 6:
                pos = cal.pt(*centroid((c["x0"], c["top"], c["x1"], c["bottom"])))
                markers.append({"kind": "single", "pos": pos,
                                "_pt": centroid((c["x0"], c["top"], c["x1"], c["bottom"]))})
        else:  # stroked
            ss = c.get("stroking_color")
            if col_eq(ss, GREY_ICON) and len(c["pts"]) <= 4:
                # slash over a nearby grey circle -> separate marker
                pos_pt = centroid((c["x0"], c["top"], c["x1"], c["bottom"]))
                for m in markers:
                    mx, my = m["_pt"]
                    if abs(mx - pos_pt[0]) < 8 and abs(my - pos_pt[1]) < 8:
                        m["kind"] = "separate"

    # slashes can be parsed before their circle - second pass over stroked curves
    for c in page.curves:
        ss = c.get("stroking_color")
        if c["stroke"] and col_eq(ss, GREY_ICON) and len(c["pts"]) <= 4:
            pos_pt = centroid((c["x0"], c["top"], c["x1"], c["bottom"]))
            for m in markers:
                mx, my = m["_pt"]
                if abs(mx - pos_pt[0]) < 8 and abs(my - pos_pt[1]) < 8:
                    m["kind"] = "separate"
    for m in markers:
        m.pop("_pt", None)

    # territory divider: dashed black line/curve spanning the board
    cands = []
    for l in page.lines + page.curves:
        dash = l.get("dash")
        if not dash or not dash[0]:
            continue
        ss = l.get("stroking_color")
        if not (col_eq(ss, (0, 0, 0, 1)) or ss in ((0, 0, 0, 1),)):
            continue
        if not cal.contains(*centroid((l["x0"], l["top"], l["x1"], l["bottom"]))):
            continue
        length = math.hypot(l["x1"] - l["x0"], l["bottom"] - l["top"])
        if length > 100:
            pts = l.get("pts") or [(l["x0"], l["y0"]), (l["x1"], l["y1"])]
            cands.append((length, pts))
    if cands:
        cands.sort(key=lambda t: -t[0])
        raw = cands[0][1]
        # lines store pts as (x, y) with y in top-based coords for curves;
        # plain lines use y0/y1 distance coords - convert via top/bottom fields
        ln = max(page.lines + page.curves, key=lambda l: (
            math.hypot(l["x1"] - l["x0"], l["bottom"] - l["top"])
            if l.get("dash") and l.get("dash")[0] else -1))
        p1 = cal.pt(ln["x0"], ln["top"])
        p2 = cal.pt(ln["x1"], ln["bottom"])
        # dashed diagonal runs top-left -> bottom-right in page space; recover
        # true endpoint pairing from the curve pts when available
        if ln in page.curves and ln.get("pts"):
            p1 = cal.pt(*ln["pts"][0])
            p2 = cal.pt(*ln["pts"][-1])
        divider = [list(p1), list(p2)]

    # letter badges -> nearest word letters (AB/CD/EF/GH)
    words = page.extract_words()
    badge_letters = []
    for bx, by in letter_badges:
        best = None
        for w in words:
            if not re.fullmatch(r"[A-H]{2}", w["text"]):
                continue
            wx, wy = cal.pt((w["x0"] + w["x1"]) / 2, (w["top"] + w["bottom"]) / 2)
            d = math.hypot(wx - bx, wy - by)
            if best is None or d < best[0]:
                best = (d, w["text"])
        badge_letters.append((bx, by, best[1] if best and best[0] < 2.5 else None))

    # terrain features: tinted photo images inside the board (quads, may be rotated)
    features = []
    for quad in image_quads(doc, page_no, page.height):
        xs = [p[0] for p in quad]
        ys = [p[1] for p in quad]
        bb = (min(xs), min(ys), max(xs), max(ys))
        w_side = math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]) * cal.sx
        h_side = math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]) * cal.sx
        if w_side > cal.w_in * 0.9 or h_side > cal.h_in * 0.9:
            continue  # the battlefield photo itself
        if not cal.contains(*centroid(bb), pad=2):
            continue
        if w_side < 1.2 or h_side < 1.2:
            continue  # letter badge textures / tiny decals
        kind = classify_image_tint(render, rscale, cal, bb)
        if kind == "mat":
            continue
        poly = [cal.pt(x, y) for (x, y) in quad]
        # ensure counter-clockwise in board coords
        if sum(
            (poly[(i + 1) % 4][0] - poly[i][0]) * (poly[(i + 1) % 4][1] + poly[i][1])
            for i in range(4)
        ) > 0:
            poly = poly[::-1]
        feat = {
            "kind": kind,
            "polygon": [[round(x, 3), round(y, 3)] for x, y in poly],
        }
        for bx, by, letter in badge_letters:
            if letter and point_in_poly((bx, by), poly):
                feat["letter"] = letter
                break
        features.append(feat)

    # dedupe features: overlapping same-kind quads collapse (keep the larger)
    def fbbox(f):
        xs = [p[0] for p in f["polygon"]]
        ys = [p[1] for p in f["polygon"]]
        return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]

    features.sort(key=lambda f: -(fbbox(f)[2] * fbbox(f)[3]))
    merged = []
    for f in features:
        fb = fbbox(f)
        hit = None
        for g in merged:
            if g["kind"] != f["kind"]:
                continue
            if rect_overlap(fb, fbbox(g)) > 0.55 * fb[2] * fb[3]:
                hit = g
                break
        if hit:
            if not hit.get("letter") and f.get("letter"):
                hit["letter"] = f["letter"]
        else:
            merged.append(dict(f))
    features = merged

    areas = dedupe(areas)
    areas = [
        simplify(snap_to_edges(clamp_poly(p, cal.w_in, cal.h_in), cal.w_in, cal.h_in))
        for p in areas
    ]

    # attach features + objectives to areas
    area_objs = []
    for i, p in enumerate(areas):
        area_objs.append({"id": f"area-{i}", "polygon": [[round(x, 3), round(y, 3)] for x, y in p], "features": []})
    for f in features:
        cx = sum(p[0] for p in f["polygon"]) / len(f["polygon"])
        cy = sum(p[1] for p in f["polygon"]) / len(f["polygon"])
        best, bestd = None, 1e9
        for a in area_objs:
            poly = [(x, y) for x, y in a["polygon"]]
            if point_in_poly((cx, cy), poly):
                best, bestd = a, 0
                break
            d = min(math.hypot(cx - x, cy - y) for x, y in poly)
            if d < bestd:
                best, bestd = a, d
        if best is not None and bestd < 3.5:
            best["features"].append(f)
        # features that match no area (shouldn't happen) are dropped with a note
    # areas whose features are baked into the mat photo: recover from render pixels
    for a in area_objs:
        if a["features"]:
            continue
        poly = [(x, y) for x, y in a["polygon"]]
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        px0 = (cal.x0 + min(xs) / cal.sx) * rscale
        px1 = (cal.x0 + max(xs) / cal.sx) * rscale
        py0 = (cal.bottom - max(ys) / cal.sy) * rscale
        py1 = (cal.bottom - min(ys) / cal.sy) * rscale
        crop = render.crop((int(px0), int(py0), int(px1), int(py1))).convert("RGB")
        w_px, h_px = crop.size
        if w_px < 4 or h_px < 4:
            continue
        data = list(crop.getdata())
        for kind, test in (
            ("light", lambda r, g, b: r > b * 1.3 and g > b * 1.2 and r >= g * 0.92 and max(r, g, b) - b > 30),
            ("dense", lambda r, g, b: g > r * 1.15 and g > b * 1.08 and g - min(r, b) > 20),
        ):
            hits = [
                (i % w_px, i // w_px)
                for i, (r, g, b) in enumerate(data)
                if test(r, g, b)
            ]
            if len(hits) < w_px * h_px * 0.015:
                continue
            hx0 = min(h[0] for h in hits)
            hx1 = max(h[0] for h in hits)
            hy0 = min(h[1] for h in hits)
            hy1 = max(h[1] for h in hits)
            fx0 = min(xs) + hx0 / w_px * (max(xs) - min(xs))
            fx1 = min(xs) + (hx1 + 1) / w_px * (max(xs) - min(xs))
            fy1 = max(ys) - hy0 / h_px * (max(ys) - min(ys))
            fy0 = max(ys) - (hy1 + 1) / h_px * (max(ys) - min(ys))
            a["features"].append(
                {
                    "kind": kind,
                    "polygon": [
                        [round(fx0, 2), round(fy0, 2)],
                        [round(fx1, 2), round(fy0, 2)],
                        [round(fx1, 2), round(fy1, 2)],
                        [round(fx0, 2), round(fy1, 2)],
                    ],
                    "recovered": True,
                }
            )

    for o in objectives:
        for a in area_objs:
            poly = [(x, y) for x, y in a["polygon"]]
            if point_in_poly(tuple(o["pos"]), poly):
                o["areaId"] = a["id"]
                break
        o["pos"] = [round(o["pos"][0], 3), round(o["pos"][1], 3)]

    zones = {
        k: [
            [[round(x, 3), round(y, 3)] for x, y in snap_to_edges(p, cal.w_in, cal.h_in)]
            for p in v
        ]
        for k, v in zones.items()
    }

    # which board edge does the attacker's zone hug?
    attacker_edge = None
    if zones["attacker"]:
        pts = [p for poly in zones["attacker"] for p in poly]
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        dists = {
            "left": cx,
            "right": cal.w_in - cx,
            "bottom": cy,
            "top": cal.h_in - cy,
        }
        attacker_edge = min(dists, key=dists.get)

    # no explicit dashed divider -> straight midline between the halves
    if divider is None and attacker_edge:
        if attacker_edge in ("left", "right"):
            divider = [[cal.w_in / 2, 0.0], [cal.w_in / 2, cal.h_in]]
        else:
            divider = [[0.0, cal.h_in / 2], [cal.w_in, cal.h_in / 2]]

    return {
        "page": page_no,
        "boardWidth": cal.w_in,
        "boardHeight": cal.h_in,
        "attackerEdge": attacker_edge,
        "players": header,
        "deploymentZones": zones,
        "territoryDivider": divider,
        "terrainAreas": area_objs,
        "objectives": objectives,
        "areaMarkers": markers,
    }


def main():
    pdf_path = sys.argv[1]
    pdf = pdfplumber.open(pdf_path)
    doc = pdfium.PdfDocument(pdf_path)
    os.makedirs(OUT_DIR, exist_ok=True)
    index = []
    combo_counter = defaultdict(int)
    for page_no in PAGES:
        data = extract_page(pdf, doc, page_no)
        a, b = data["players"]
        combo = f"{slug(a['disposition'])}_vs_{slug(b['disposition'])}"
        combo_counter[combo] += 1
        letter = "ABC"[(combo_counter[combo] - 1) % 3]
        lid = f"ec2026-{combo}-{letter.lower()}"
        data["id"] = lid
        data["layoutLetter"] = letter
        data["source"] = f"GW Warhammer Event Companion v1.0 (2026-06), page {page_no}"
        with open(os.path.join(OUT_DIR, f"{lid}.json"), "w") as f:
            json.dump(data, f, indent=1)
        index.append(
            {
                "id": lid,
                "page": page_no,
                "layout": letter,
                "orientation": "vertical" if data["boardWidth"] == 44 else "horizontal",
                "dispositions": [a["disposition"], b["disposition"]],
                "missions": [a["mission"], b["mission"]],
                "areas": len(data["terrainAreas"]),
                "features": sum(len(t["features"]) for t in data["terrainAreas"]),
                "objectives": len(data["objectives"]),
            }
        )
        print(
            f"p{page_no}: {lid} {data['boardWidth']}x{data['boardHeight']} "
            f"areas={index[-1]['areas']} feats={index[-1]['features']} "
            f"objs={index[-1]['objectives']} zones={len(data['deploymentZones']['attacker'])}/"
            f"{len(data['deploymentZones']['defender'])} div={'y' if data['territoryDivider'] else 'n'}"
        )
    with open(os.path.join(OUT_DIR, "index.json"), "w") as f:
        json.dump(index, f, indent=1)
    print(f"wrote {len(index)} layouts")


if __name__ == "__main__":
    main()
