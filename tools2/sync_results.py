"""Publish run artifacts to the static site (§11, one artifact contract).

Copies ``results/`` into ``public/results/`` (which Vite ships verbatim) and
writes the ``index.json`` manifest the Auto Player reads: the available armies,
the snapshot's coverage counts, and every batch, optimizer and battle-log
artifact found.

Run: ``python3 tools2/sync_results.py``
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
from typing import Any, Dict, List

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sim2.loader import load

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "results")
DST = os.path.join(ROOT, "public", "results")
MAX_LOGS = 12


def main() -> int:
    os.makedirs(DST, exist_ok=True)
    copied = _copy_tree(SRC, DST)

    data = load()
    armies = [
        {
            "name": a.name,
            "faction": a.faction,
            "detachment": a.detachment,
            "disposition": data.disposition_for(a),
            "points": a.points,
            "units": len(a.units),
            "battle_size": a.battle_size,
        }
        for a in sorted(data.armies.values(), key=lambda x: x.name)
    ]

    index: Dict[str, Any] = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "data_version": data.meta.get("retrieved", ""),
        "armies": armies,
        "coverage": data.coverage(),
        "batches": _refs(DST, "batch.json"),
        "optimizer": _refs(DST, "optimizer.json"),
        "logs": _refs(DST, "", subdir="logs")[:MAX_LOGS],
    }
    with open(os.path.join(DST, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1)

    print(json.dumps({
        "copied_files": copied,
        "armies": len(armies),
        "batches": len(index["batches"]),
        "optimizer": len(index["optimizer"]),
        "logs": len(index["logs"]),
    }, indent=1))
    return 0


def _copy_tree(src: str, dst: str) -> int:
    if not os.path.isdir(src):
        return 0
    n = 0
    for root, _dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        target = os.path.join(dst, rel) if rel != "." else dst
        os.makedirs(target, exist_ok=True)
        for name in files:
            if not name.endswith(".json"):
                continue
            shutil.copy2(os.path.join(root, name), os.path.join(target, name))
            n += 1
    return n


def _refs(base: str, filename: str, subdir: str = "") -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for root, _dirs, files in os.walk(base):
        rel_root = os.path.relpath(root, base)
        if subdir and subdir not in rel_root.split(os.sep):
            continue
        if not subdir and rel_root != "." and "logs" in rel_root.split(os.sep):
            continue
        for name in sorted(files):
            if filename and name != filename:
                continue
            if not filename and not name.endswith(".json"):
                continue
            if name == "index.json":
                continue
            rel = os.path.normpath(os.path.join(rel_root, name)).replace(os.sep, "/")
            rel = rel[2:] if rel.startswith("./") else rel
            out.append({
                "path": rel,
                "label": _label(os.path.join(root, name), rel),
                "generated": time.strftime(
                    "%Y-%m-%d", time.gmtime(os.path.getmtime(os.path.join(root, name)))
                ),
            })
    return out


def _label(path: str, rel: str) -> str:
    try:
        blob = json.load(open(path, encoding="utf-8"))
    except Exception:
        return rel
    if blob.get("kind") == "batch":
        cfg = blob.get("config", {})
        return f"{cfg.get('armies', ['?', '?'])[0]} vs {cfg.get('armies', ['?', '?'])[1]} " \
               f"({cfg.get('games')} games, {cfg.get('battle_size')}pts)"
    if blob.get("kind") == "optimizer":
        cfg = blob.get("config", {})
        return f"optimizer {cfg.get('faction')} vs {cfg.get('opponent')}"
    meta = blob.get("meta", {})
    if meta:
        return f"{meta.get('armies', ['?', '?'])[0]} vs {meta.get('armies', ['?', '?'])[1]} " \
               f"— seed {blob.get('seed')}"
    return rel


if __name__ == "__main__":
    raise SystemExit(main())
