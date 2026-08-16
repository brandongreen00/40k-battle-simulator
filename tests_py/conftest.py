"""Shared fixtures: a loaded snapshot and a minimal two-unit battlefield."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sim2.geometry import BaseShape
from sim2.kernel.engine import Engine
from sim2.kernel.state import GameState, ModelState, PlayerState, UnitState
from sim2.loader import load
from sim2.rng import Rng
from sim2.schema import Datasheet, Layout, ModelProfile, Objective, TerrainArea, WeaponProfile


@pytest.fixture(scope="session")
def data():
    return load()


@pytest.fixture
def rng():
    return Rng(12345)


def bare_layout(with_terrain: bool = False) -> Layout:
    layout = Layout(
        id="test-layout",
        width=44.0,
        height=60.0,
        dispositions=["Take and Hold", "Purge the Foe"],
        objectives=[Objective("obj-0", (22.0, 30.0), "central")],
        deployment_zones={
            "attacker": [[(0.0, 48.0), (44.0, 48.0), (44.0, 60.0), (0.0, 60.0)]],
            "defender": [[(0.0, 0.0), (44.0, 0.0), (44.0, 12.0), (0.0, 12.0)]],
        },
    )
    if with_terrain:
        layout.terrain.append(
            TerrainArea("area-0", [(18.0, 24.0), (26.0, 24.0), (26.0, 36.0), (18.0, 36.0)], "dense")
        )
    return layout


def test_datasheet(ds_id="test.trooper", **over) -> Datasheet:
    profile = ModelProfile(
        name=over.get("name", "Trooper"),
        m=over.get("m", 6), t=over.get("t", 4), sv=over.get("sv", 4),
        w=over.get("w", 1), ld=over.get("ld", 7), oc=over.get("oc", 1),
        invuln=over.get("invuln"), base=BaseShape.circle_mm(32),
    )
    return Datasheet(
        id=ds_id,
        name=over.get("name", "Trooper"),
        faction=over.get("faction", "AM"),
        models=[profile],
        weapons=[
            WeaponProfile("Test rifle", "ranged", "2", 3, 4, 0, "1", 24.0),
            WeaponProfile("Test blade", "melee", "2", 3, 4, 0, "1", 0.0),
        ],
        keywords=over.get("keywords", ["INFANTRY", "REGIMENT"]),
        unit_sizes=[5],
        points=[],
    )


@pytest.fixture
def simple_battle(data):
    """Two 5-model units 12" apart on a bare board, sharing the real snapshot."""
    from sim2.kernel.state import new_unit_from_datasheet

    ds = test_datasheet()
    data.datasheets[ds.id] = ds
    layout = bare_layout()
    state = GameState(
        layout=layout,
        players=[PlayerState(0, "A", "AM"), PlayerState(1, "B", "IA")],
    )
    state.data = data
    state.phase = "shooting"
    state.battle_round = 1

    attacker = new_unit_from_datasheet("p0:a", 0, ds, 5)
    target = new_unit_from_datasheet("p1:b", 1, ds, 5)
    for i, m in enumerate(attacker.models):
        m.pos = (10.0 + i * 1.4, 20.0)
    for i, m in enumerate(target.models):
        m.pos = (10.0 + i * 1.4, 32.0)
    state.units = {attacker.uid: attacker, target.uid: target}

    from sim2.kernel import measure

    measure.bump_epoch()
    engine = Engine(data, Rng(99))
    return engine, state, attacker, target
