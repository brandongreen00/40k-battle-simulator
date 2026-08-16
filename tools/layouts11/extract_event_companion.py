#!/usr/bin/env python3
"""Extract the 45 Warhammer Event Companion (11th edition) terrain layouts.

Source PDF (not committed - GW IP, personal use) - v1.1, July 2026:
  https://assets.warhammer-community.com/eng_22-07_warhammer_40,000_event_companion-alyapl19us-b2drgwkji4.pdf
(previously v1.0, June 2026:
  https://assets.warhammer-community.com/eng_12-06_warhammer40000_event_companion-s3bfb5f9s1-ivswuij3fo.pdf)

The companion's layout pages (9-53) are vector diagrams. This script reads the
vector objects directly (pdfplumber) so every polygon is exact, calibrated via the
44"x60" battlefield image on each page (scale ~7.7445 pt/inch).

Colour code (CMYK fills, from the p.8 "Layouts Key"):
  (0,1,1,.4)   red    = Attacker deployment zone (+ attacker home objective ring)
  (1,.4,0,.6)  blue   = Defender deployment zone (+ defender home objective ring)
  (0,0,0,.2)   grey   = terrain area polygons (the 5 canonical footprints)
  (1,0,.6,.4)  teal   = central objective circle (25pt) / feature letter badges (16pt)
  (.7,0,.42,.28) teal-dark = expansion objective diamonds (5-pt path)
  (0,0,0,.6)   grey   = single/separate terrain-area markers (15.9pt circles).
                        The PLAIN eye badge (= "single terrain area") draws its eye as a
                        STROKED grey outline; the SLASHED badge (= "separate terrain
                        areas") draws its eye as TWO grey-FILLED halves (npts > 6) split
                        by the white slash bar - those halves are the 'separate' signal.
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

import numpy as np
import pdfplumber
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image
from scipy import ndimage
from skimage import measure

PAGES = range(9, 54)  # 1-indexed layout pages

# terrain-feature tracing (see trace_features)
FEATURE_RENDER_SCALE = 6.0  # page render scale -> ~46 px per board inch
FEATURE_MIN_AREA_IN2 = 0.35  # smaller tinted blobs are print noise, not terrain
FEATURE_CLOSE_IN = 0.07  # morphological closing radius (bridges printed hairlines)
FEATURE_SIMPLIFY_TOL = 0.09  # Douglas-Peucker tolerance on the traced outline
BADGE_PAD_IN = 0.18  # icon-disk margin (their white outline ring also hides terrain)
BADGE_INPAINT_OPEN_IN = 0.15  # opening radius applied to what is inpainted under a badge
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


def dist_to_poly(p, poly):
    """Shortest distance from a point to a polygon's boundary (inches)."""
    x, y = p
    best = 1e9
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
        best = min(best, math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)))
    return best


def area_for_point(pt, area_objs, max_gap=0.0):
    """Which terrain area owns this point?

    The five footprint mats are printed overlapping, so a point near a shared edge
    can fall inside two of them: take the one it sits DEEPEST inside, rather than
    whichever the parse happened to reach first (a first-match rule flips as soon
    as an outline moves by a hundredth of an inch). With `max_gap`, a point inside
    none of them binds to the nearest area within that distance.
    """
    inside, nearest = [], (None, 1e9)
    for a in area_objs:
        poly = [(x, y) for x, y in a["polygon"]]
        d = dist_to_poly(pt, poly)
        if point_in_poly(pt, poly):
            inside.append((d, a))
        elif d < nearest[1]:
            nearest = (a, d)
    if inside:
        return max(inside, key=lambda t: t[0])[1]
    if max_gap and nearest[0] is not None and nearest[1] <= max_gap:
        return nearest[0]
    return None


def clamp_poly(pts, w, h):
    return [(min(max(x, 0.0), w), min(max(y, 0.0), h)) for (x, y) in pts]


def simplify(pts, tol=0.06):
    """Douglas-Peucker on a closed polygon (inches).

    The ring is cut at two opposite vertices and each chain simplified on its
    own. Running DP straight down a ring whose first and last point coincide
    degenerates - the baseline has zero length, so every vertex measures zero
    deviation from it, the whole ring collapses to a single point and the
    guard below hands back the INPUT untouched (which is why the shipped area
    polygons carry 200-300 raw vertices each).
    """
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

    far = max(
        range(len(pts)),
        key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2,
    )
    head = dp(pts[: far + 1])
    tail = dp(pts[far:] + [pts[0]])
    out = head[:-1] + tail[:-1]
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


def _disk_close(mask, r_px):
    """Binary closing by a disk of radius r_px, via distance transforms (O(N))."""
    if r_px < 1:
        return mask
    dilated = ndimage.distance_transform_edt(~mask) <= r_px
    return ndimage.distance_transform_edt(dilated) > r_px


def _disk_open(mask, r_px):
    """Binary opening by a disk of radius r_px, via distance transforms (O(N))."""
    if r_px < 1:
        return mask
    eroded = ndimage.distance_transform_edt(mask) > r_px
    return ndimage.distance_transform_edt(~eroded) <= r_px


def trace_features(doc, page_no, cal, badges):
    """Trace the printed terrain-feature silhouettes off a high-resolution render.

    Every feature is printed as a tinted photo of the real kit - an L-shaped
    ruin, a bridge span, a barricade run - dropped onto a mat. The photo's
    PLACEMENT is a rectangle, so reading the placement quad (what the earlier
    extraction did) squares off every organic footprint. Instead the page is
    rendered at ~46 px/inch and the green (dense) / gold (light) pixels are
    traced into polygons, the same ground truth the Combat Patrol maps use.

    `badges` are the printed icons (objectives, letter roundels, area markers)
    as (x_in, y_in, radius_in): they are punched out of the mask first (the
    teal ones read as "dense"), then whatever the silhouette implies underneath
    them is closed back in, so a badge printed on a ruin doesn't bite a hole in
    it. Returns [{kind, polygon}] in board inches, CCW.
    """
    render = doc[page_no - 1].render(scale=FEATURE_RENDER_SCALE).to_pil().convert("RGB")
    arr = np.asarray(render).astype(np.int16)
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    # same colour tests the audited quad classifier / pixel recovery used
    tints = {
        "dense": (g > r * 1.15) & (g > b * 1.08) & ((g - np.minimum(r, b)) > 20),
        "light": (r > b * 1.3)
        & (g > b * 1.2)
        & (r >= g * 0.92)
        & ((np.maximum(np.maximum(r, g), b) - b) > 30),
    }
    ppi = (cal.x1 - cal.x0) * FEATURE_RENDER_SCALE / cal.w_in
    h_px, w_px = r.shape
    board = np.zeros(r.shape, bool)
    board[
        max(int(cal.top * FEATURE_RENDER_SCALE), 0) : int(cal.bottom * FEATURE_RENDER_SCALE),
        max(int(cal.x0 * FEATURE_RENDER_SCALE), 0) : int(cal.x1 * FEATURE_RENDER_SCALE),
    ] = True

    def to_in(px, py):
        return (
            (px / FEATURE_RENDER_SCALE - cal.x0) * cal.sx,
            (cal.bottom - py / FEATURE_RENDER_SCALE) * cal.sy,
        )

    out = []
    for kind, tint in tints.items():
        mask = tint & board
        for bx, by, br in badges:
            r_px = br * ppi
            cx = (cal.x0 + bx / cal.sx) * FEATURE_RENDER_SCALE
            cy = (cal.bottom - by / cal.sy) * FEATURE_RENDER_SCALE
            pad = int(r_px * 2.4)
            x0, x1 = max(int(cx) - pad, 0), min(int(cx) + pad, w_px)
            y0, y1 = max(int(cy) - pad, 0), min(int(cy) + pad, h_px)
            if x1 - x0 < 3 or y1 - y0 < 3:
                continue
            yy, xx = np.ogrid[y0:y1, x0:x1]
            disk = (xx - cx) ** 2 + (yy - cy) ** 2 <= (r_px + 1) ** 2
            win = mask[y0:y1, x0:x1] & ~disk
            # inpaint the disk from its rim: each hidden pixel takes the value of the
            # nearest visible one, so a silhouette running behind a badge carries
            # straight through it while a badge on bare mat stays bare
            _, (iy, ix) = ndimage.distance_transform_edt(
                disk, return_distances=True, return_indices=True
            )
            visible = win.copy()
            win[disk] = win[iy[disk], ix[disk]]
            # a silhouette merely GRAZING the badge would otherwise fan a thin wedge
            # across it: keep only what survives an opening inside the disk
            win = visible | (_disk_open(win, BADGE_INPAINT_OPEN_IN * ppi) & disk)
            mask[y0:y1, x0:x1] = win
        # bridge the hairline dimension lines printed across a silhouette, then drop
        # single-pixel photo noise and close interior holes (windows, texture)
        mask = _disk_close(mask, max(FEATURE_CLOSE_IN * ppi, 1.0))
        mask = ndimage.binary_opening(mask, np.ones((3, 3), bool))
        mask = ndimage.binary_fill_holes(mask)
        labels, n = ndimage.label(mask, structure=np.ones((3, 3), bool))
        for i, sl in enumerate(ndimage.find_objects(labels), start=1):
            if sl is None:
                continue
            comp = labels[sl] == i
            if comp.sum() / (ppi * ppi) < FEATURE_MIN_AREA_IN2:
                continue  # noise speck / stray tinted decal
            contours = measure.find_contours(np.pad(comp, 1).astype(float), 0.5)
            if not contours:
                continue
            ring = max(contours, key=len)
            pts = [
                to_in(sl[1].start - 1 + cx, sl[0].start - 1 + cy) for cy, cx in ring
            ]
            pts = simplify(clamp_poly(pts, cal.w_in, cal.h_in), tol=FEATURE_SIMPLIFY_TOL)
            if len(pts) < 3 or abs(poly_area(pts)) < FEATURE_MIN_AREA_IN2:
                continue
            if sum(
                (pts[(k + 1) % len(pts)][0] - pts[k][0])
                * (pts[(k + 1) % len(pts)][1] + pts[k][1])
                for k in range(len(pts))
            ) > 0:
                pts = pts[::-1]  # counter-clockwise in board coords
            out.append({"kind": kind, "polygon": [[round(x, 2), round(y, 2)] for x, y in pts]})
    return out


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
    eye_halves = []  # grey-filled halves of the slashed "separate" badge (page pts)
    letter_badges = []  # (pos_in, ())
    # every printed icon disk as (x_in, y_in, radius_in) - punched out of the feature
    # tint masks before tracing (the teal ones read as "dense"), then closed back in
    badge_disks = []
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
                    pos = cal.pt(*centroid((c["x0"], c["top"], c["x1"], c["bottom"])))
                    objectives.append({"kind": "home", "owner": "attacker", "pos": pos})
                    badge_disks.append((pos[0], pos[1], w * cal.sx / 2 + BADGE_PAD_IN))
                elif 0.6 < w * cal.sx < 2.0 and abs(w - h) < 2 and len(c["pts"]) <= 6:
                    # the attacker's territory-divider roundel (two printed sizes): not an
                    # objective, but its warm rim traces as a "light" feature unless masked
                    badge_disks.append((*cal.pt(*centroid((c["x0"], c["top"], c["x1"], c["bottom"]))),
                                        w * cal.sx / 2 + BADGE_PAD_IN))
            elif col_eq(ns, BLUE):
                p = poly_pts(c, cal)
                a = poly_area(p)
                if a > 40:
                    zones["defender"].append(clamp_poly(p, cal.w_in, cal.h_in))
                elif 2.5 < w * cal.sx < 4.5 and abs(w - h) < 2 and len(c["pts"]) <= 6:
                    pos = cal.pt(*centroid((c["x0"], c["top"], c["x1"], c["bottom"])))
                    objectives.append({"kind": "home", "owner": "defender", "pos": pos})
                    badge_disks.append((pos[0], pos[1], w * cal.sx / 2 + BADGE_PAD_IN))
                elif 0.6 < w * cal.sx < 2.0 and abs(w - h) < 2 and len(c["pts"]) <= 6:
                    # the defender's territory-divider roundel (two printed sizes): not an
                    # objective, but its warm rim traces as a "light" feature unless masked
                    badge_disks.append((*cal.pt(*centroid((c["x0"], c["top"], c["x1"], c["bottom"]))),
                                        w * cal.sx / 2 + BADGE_PAD_IN))
            elif col_eq(ns, TEAL):
                d_in = w * cal.sx
                pos = cal.pt(*centroid((c["x0"], c["top"], c["x1"], c["bottom"])))
                if 2.6 < d_in < 4.2 and len(c["pts"]) <= 6:
                    objectives.append({"kind": "central", "pos": pos})
                    badge_disks.append((pos[0], pos[1], d_in / 2 + BADGE_PAD_IN))
                elif 1.6 <= d_in <= 2.6 and len(c["pts"]) <= 6:
                    letter_badges.append(pos)
                    badge_disks.append((pos[0], pos[1], d_in / 2 + BADGE_PAD_IN))
            elif col_eq(ns, TEAL_DARK) and big and len(c["pts"]) <= 6:
                pos = cal.pt(*centroid((c["x0"], c["top"], c["x1"], c["bottom"])))
                objectives.append({"kind": "expansion", "pos": pos})
                badge_disks.append((pos[0], pos[1], w * cal.sx / 2 + BADGE_PAD_IN))
            elif col_eq(ns, GREY_ICON) and big and 1.4 < w * cal.sx < 2.6:
                pos_pt = centroid((c["x0"], c["top"], c["x1"], c["bottom"]))
                if len(c["pts"]) <= 6:
                    # the 15.9pt badge circle itself
                    pos = cal.pt(*pos_pt)
                    markers.append({"kind": "single", "pos": pos, "_pt": pos_pt})
                    badge_disks.append((pos[0], pos[1], w * cal.sx / 2 + BADGE_PAD_IN))
                else:
                    # a grey-filled eye HALF (npts > 6): only the slashed "separate
                    # terrain areas" badge draws these (its eye is split by the white
                    # slash bar). The plain "single" badge's eye is a grey STROKED
                    # outline instead - the old stroked-arc test matched THAT, which
                    # inverted every marker on every page.
                    eye_halves.append(pos_pt)

    # eye halves may be parsed before or after their badge circle - match after the loop
    for hx, hy in eye_halves:
        for m in markers:
            mx, my = m["_pt"]
            if abs(mx - hx) < 8 and abs(my - hy) < 8:
                m["kind"] = "separate"
    for m in markers:
        m.pop("_pt", None)
    # A badge painted over by a later deployment-zone fill is invisible on the printed page
    # (p35 buries one under the red zone; players only ever see four badges there). Keep a
    # marker only if the render actually shows its grey badge disk: visible badges score
    # grey-fraction 0.53-0.62 in a 28x28px centre crop, the buried one 0.09.
    def badge_visible(m):
        px = (cal.x0 + m["pos"][0] / cal.sx) * rscale
        py = (cal.bottom - m["pos"][1] / cal.sy) * rscale
        crop = render.crop((int(px - 14), int(py - 14), int(px + 14), int(py + 14))).convert("RGB")
        pxls = list(crop.getdata())
        grey = sum(1 for r, g, b in pxls if max(r, g, b) - min(r, g, b) < 30 and 70 < (r + g + b) // 3 < 190)
        return grey >= len(pxls) * 0.3
    markers = [m for m in markers if badge_visible(m)]

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
        if length > 100 and l.get("pts"):
            cands.append((length, l["pts"]))
    if cands:
        # pdfplumber stores the true endpoints in `pts` ((x, top-based y) - for plain lines
        # and curves alike). Pairing the bbox corners (x0,top)/(x1,bottom) instead mirrors
        # every bottom-left -> top-right diagonal - and ALL of the companion's diagonal
        # dividers run that way (the v1.0 extraction shipped 34 mirrored dividers this way).
        cands.sort(key=lambda t: -t[0])
        raw = cands[0][1]
        divider = [list(cal.pt(*raw[0])), list(cal.pt(*raw[-1]))]

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

    areas = dedupe(areas)
    areas = [
        simplify(snap_to_edges(clamp_poly(p, cal.w_in, cal.h_in), cal.w_in, cal.h_in))
        for p in areas
    ]
    area_objs = [
        {
            "id": f"area-{i}",
            "polygon": [[round(x, 3), round(y, 3)] for x, y in p],
            "features": [],
        }
        for i, p in enumerate(areas)
    ]

    # Terrain features: the printed silhouettes, traced off a high-resolution render
    # (see trace_features). The tinted photos are also PLACED as image quads, which is
    # what earlier extractions recorded - but a placement quad is the photo's bounding
    # rectangle, so every L-shaped ruin, bridge span and barricade run came out square.
    # The placements are still read here, purely to cross-check that tracing found a
    # silhouette wherever the page places a tinted photo.
    placements = []
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
        placements.append({"kind": kind, "polygon": [list(cal.pt(x, y)) for (x, y) in quad]})

    features = trace_features(doc, page_no, cal, badge_disks)

    # attach features + objectives to areas
    for f in features:
        cx = sum(p[0] for p in f["polygon"]) / len(f["polygon"])
        cy = sum(p[1] for p in f["polygon"]) / len(f["polygon"])
        owner = area_for_point((cx, cy), area_objs, max_gap=3.5)
        if owner is not None:
            owner["features"].append(f)
        # a silhouette matching no mat (shouldn't happen) is dropped

    # the printed AB/CD/EF/GH roundel labels the ruin it sits on
    for bx, by, letter in badge_letters:
        if not letter:
            continue
        best, bestd = None, 1e9
        for a in area_objs:
            for f in a["features"]:
                poly = [(x, y) for x, y in f["polygon"]]
                d = 0.0 if point_in_poly((bx, by), poly) else min(
                    math.hypot(bx - x, by - y) for x, y in poly
                )
                if d < bestd and not f.get("letter"):
                    best, bestd = f, d
        if best is not None and bestd < 2.0:
            best["letter"] = letter

    # cross-check: every tinted photo placement should have a traced silhouette on it
    traced = [f for a in area_objs for f in a["features"]]
    missed = 0
    for pl in placements:
        pxs = [p[0] for p in pl["polygon"]]
        pys = [p[1] for p in pl["polygon"]]
        box = (min(pxs) - 0.3, min(pys) - 0.3, max(pxs) + 0.3, max(pys) + 0.3)
        if not any(
            box[0] <= sum(q[0] for q in f["polygon"]) / len(f["polygon"]) <= box[2]
            and box[1] <= sum(q[1] for q in f["polygon"]) / len(f["polygon"]) <= box[3]
            for f in traced
        ):
            missed += 1
    if missed:
        print(f"  ! p{page_no}: {missed}/{len(placements)} tinted placements with no traced silhouette")

    for o in objectives:
        owner = area_for_point(tuple(o["pos"]), area_objs)
        if owner is not None:
            o["areaId"] = owner["id"]
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
        data["source"] = f"GW Warhammer Event Companion v1.1 (2026-07), page {page_no}"
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
