"""Continuous 2D + height geometry (§3.8).

All distances are inches. Board coordinates: origin bottom-left, x across the
44" edge, y along the 60" edge (the 11th edition battlefield is 44" x 60").

No grid, no zone abstraction: model positions are floats and every distance is
measured between the closest points of the models' bases, per core rules 01.05.
Height is carried as a separate ``z`` (the model's footing level) plus a model
height band, which the 5" vertical terms of engagement range and coherency and
the Solid terrain rule need.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, List, Optional, Sequence, Tuple

Point = Tuple[float, float]

EPS = 1e-9


# --------------------------------------------------------------------------
# Bases
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class BaseShape:
    """A model's footprint.

    ``circle``  round base, ``radius`` inches.
    ``oval``    oval base, ``rx``/``ry`` semi-axes (rotation is not tracked; see
                ``inscribed_radius`` for the conservative reading used by
                overlap tests).
    ``hull``    a vehicle measured by its hull (Base Size Guide "Hull" entries):
                axis-aligned half-extents rx/ry.
    """

    kind: str = "circle"
    radius: float = 0.5
    rx: float = 0.0
    ry: float = 0.0

    @property
    def avg_radius(self) -> float:
        if self.kind == "circle":
            return self.radius
        return (self.rx + self.ry) / 2.0

    @property
    def inscribed_radius(self) -> float:
        if self.kind == "circle":
            return self.radius
        return min(self.rx, self.ry)

    @property
    def circumscribed_radius(self) -> float:
        if self.kind == "circle":
            return self.radius
        return max(self.rx, self.ry)

    @staticmethod
    def circle_mm(mm: float) -> "BaseShape":
        return BaseShape("circle", radius=mm / 25.4 / 2.0)

    @staticmethod
    def oval_mm(a: float, b: float) -> "BaseShape":
        return BaseShape("oval", rx=a / 25.4 / 2.0, ry=b / 25.4 / 2.0)

    def to_json(self) -> dict:
        if self.kind == "circle":
            return {"kind": "circle", "radius": round(self.radius, 4)}
        return {"kind": self.kind, "rx": round(self.rx, 4), "ry": round(self.ry, 4)}

    @staticmethod
    def from_json(d: dict) -> "BaseShape":
        kind = d.get("kind", "circle")
        if kind == "circle":
            return BaseShape("circle", radius=float(d.get("radius", 0.5)))
        return BaseShape(kind, rx=float(d.get("rx", 0.5)), ry=float(d.get("ry", 0.5)))


# --------------------------------------------------------------------------
# Vector helpers
# --------------------------------------------------------------------------
def dist(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def sub(a: Point, b: Point) -> Point:
    return (a[0] - b[0], a[1] - b[1])


def add(a: Point, b: Point) -> Point:
    return (a[0] + b[0], a[1] + b[1])


def scale(a: Point, k: float) -> Point:
    return (a[0] * k, a[1] * k)


def norm(a: Point) -> Point:
    d = math.hypot(a[0], a[1])
    if d < EPS:
        return (0.0, 0.0)
    return (a[0] / d, a[1] / d)


def lerp(a: Point, b: Point, t: float) -> Point:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def gap(a: Point, ra: float, b: Point, rb: float) -> float:
    """Base-to-base horizontal distance (never negative)."""
    return max(0.0, dist(a, b) - ra - rb)


def bases_overlap(a: Point, sa: BaseShape, b: Point, sb: BaseShape) -> bool:
    """Conservative overlap test — bases may touch but never stack."""
    return dist(a, b) + EPS < sa.inscribed_radius + sb.inscribed_radius


# --------------------------------------------------------------------------
# Polygons
# --------------------------------------------------------------------------
def point_in_polygon(p: Point, poly: Sequence[Point]) -> bool:
    """Ray casting.

    A point exactly on an edge lands on whichever side the crossing rule puts
    it. That ambiguity is immaterial here: every rules query that cares about
    the boundary (a base within an area, a base wholly within it) measures the
    base radius against the edge distance instead of asking about a bare point.
    Testing each edge for containment made this the hottest function in the
    engine for no rules benefit.
    """
    if len(poly) < 3:
        return False
    x, y = p
    inside = False
    n = len(poly)
    x1, y1 = poly[-1]
    for i in range(n):
        x2, y2 = poly[i]
        if (y1 > y) != (y2 > y):
            if x1 + (y - y1) * (x2 - x1) / (y2 - y1) > x:
                inside = not inside
        x1, y1 = x2, y2
    return inside


def point_on_polygon_boundary(p: Point, poly: Sequence[Point], tol: float = 1e-9) -> bool:
    n = len(poly)
    return any(point_on_segment(p, poly[i], poly[(i + 1) % n], tol) for i in range(n))


def point_on_segment(p: Point, a: Point, b: Point, tol: float = 1e-9) -> bool:
    return distance_point_to_segment(p, a, b) <= tol


def distance_point_to_segment(p: Point, a: Point, b: Point) -> float:
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    if denom < EPS:
        return dist(p, a)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denom))
    return dist(p, (ax + t * dx, ay + t * dy))


def distance_point_to_polygon(p: Point, poly: Sequence[Point]) -> float:
    """0 when inside, else the distance to the nearest edge."""
    if point_in_polygon(p, poly):
        return 0.0
    n = len(poly)
    return min(distance_point_to_segment(p, poly[i], poly[(i + 1) % n]) for i in range(n))


def segments_intersect(p1: Point, p2: Point, p3: Point, p4: Point) -> bool:
    def orient(a: Point, b: Point, c: Point) -> float:
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    d1, d2 = orient(p3, p4, p1), orient(p3, p4, p2)
    d3, d4 = orient(p1, p2, p3), orient(p1, p2, p4)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)):
        return True
    for a, b, c in ((p3, p4, p1), (p3, p4, p2), (p1, p2, p3), (p1, p2, p4)):
        if abs(orient(a, b, c)) < EPS and point_on_segment(c, a, b, 1e-9):
            return True
    return False


_BBOX_CACHE: dict = {}


def _bbox(poly: Sequence[Point]):
    key = id(poly)
    hit = _BBOX_CACHE.get(key)
    if hit is None:
        hit = polygon_bounds(poly)
        _BBOX_CACHE[key] = hit
    return hit


def segment_crosses_polygon(a: Point, b: Point, poly: Sequence[Point]) -> bool:
    """True when the segment enters the polygon's interior at all."""
    x0, y0, x1, y1 = _bbox(poly)
    if (max(a[0], b[0]) < x0 or min(a[0], b[0]) > x1
            or max(a[1], b[1]) < y0 or min(a[1], b[1]) > y1):
        return False          # the segment cannot reach this polygon at all
    n = len(poly)
    for i in range(n):
        if segments_intersect(a, b, poly[i], poly[(i + 1) % n]):
            return True
    # fully contained
    return point_in_polygon(a, poly) and point_in_polygon(b, poly)


def polygon_centroid(poly: Sequence[Point]) -> Point:
    if not poly:
        return (0.0, 0.0)
    area = 0.0
    cx = cy = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        cross = x1 * y2 - x2 * y1
        area += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    if abs(area) < EPS:
        xs = [p[0] for p in poly]
        ys = [p[1] for p in poly]
        return (sum(xs) / len(xs), sum(ys) / len(ys))
    area *= 0.5
    return (cx / (6 * area), cy / (6 * area))


def polygon_bounds(poly: Sequence[Point]) -> Tuple[float, float, float, float]:
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    return (min(xs), min(ys), max(xs), max(ys))


# --------------------------------------------------------------------------
# Circle-vs-polygon: "within" and "wholly within" are DISTINCT predicates
# --------------------------------------------------------------------------
def base_within_polygon(centre: Point, radius: float, poly: Sequence[Point]) -> bool:
    """Any part of the base inside (or touching) the area."""
    return distance_point_to_polygon(centre, poly) <= radius + EPS


def base_wholly_within_polygon(centre: Point, radius: float, poly: Sequence[Point]) -> bool:
    """The whole base inside — needs clearance from every edge."""
    if not point_in_polygon(centre, poly):
        return False
    n = len(poly)
    clearance = min(
        distance_point_to_segment(centre, poly[i], poly[(i + 1) % n]) for i in range(n)
    )
    return clearance >= radius - EPS


# --------------------------------------------------------------------------
# Model silhouettes — line of sight sampling (§3.8, approximation documented)
# --------------------------------------------------------------------------
#: Number of silhouette sample points per model used for the "1mm line to any
#: visible part" test (core rules 06.01). The exact rule is a continuous
#: visibility cone against a 3D silhouette; we sample the base perimeter plus
#: its centre. ``tests_py/test_geometry.py::test_los_sampling_error_bound``
#: bounds the induced error against exact circle-vs-polygon tangency.
LOS_SAMPLES = 12


def silhouette_points(centre: Point, shape: BaseShape, samples: int = LOS_SAMPLES) -> List[Point]:
    """Sample points on a model's footprint used as LoS endpoints."""
    pts: List[Point] = [centre]
    rx = shape.radius if shape.kind == "circle" else shape.rx
    ry = shape.radius if shape.kind == "circle" else shape.ry
    for i in range(samples):
        ang = 2 * math.pi * i / samples
        pts.append((centre[0] + rx * math.cos(ang), centre[1] + ry * math.sin(ang)))
    return pts


# --------------------------------------------------------------------------
# Movement helpers
# --------------------------------------------------------------------------
def clamp_to_board(p: Point, width: float, height: float, radius: float) -> Point:
    return (
        min(max(p[0], radius), width - radius),
        min(max(p[1], radius), height - radius),
    )


def step_towards(a: Point, b: Point, max_dist: float) -> Point:
    d = dist(a, b)
    if d <= max_dist or d < EPS:
        return b
    return lerp(a, b, max_dist / d)


def path_length_3d(a: Point, az: float, b: Point, bz: float) -> float:
    """Movement counts vertical distance up AND down (core rules 09.02)."""
    return dist(a, b) + abs(bz - az)


@dataclass
class Ring:
    """Candidate positions on a ring — used by placement searches."""

    centre: Point
    radius: float
    count: int = 16

    def points(self) -> List[Point]:
        out = []
        for i in range(self.count):
            ang = 2 * math.pi * i / self.count
            out.append(
                (
                    self.centre[0] + self.radius * math.cos(ang),
                    self.centre[1] + self.radius * math.sin(ang),
                )
            )
        return out
