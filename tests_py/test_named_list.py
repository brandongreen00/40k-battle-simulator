"""Named-list payloads (a List Builder saved list) → v2 armies.

The Auto Player tab converts a saved list to unit NAMES + model counts in the
browser (src/ui/autoplayer/savedArmies.ts — localStorage only exists there);
these tests pin the Python half of the bridge: resolution in
tools2/import_army.import_named_list and sim2.cli's army-file arguments.
"""

import json

import pytest

from sim2.cli import _armies


def _payload(**over):
    base = {
        "kind": "sim2_named_list",
        "name": "Saved Test List",
        "faction": "AM",
        "detachment": "Grizzled Company",
        "battle_size": 1000,
        "units": [
            {"name": "Commissar Yarrick", "models": 1, "warlord": True},
            {"name": "Death Korps of Krieg", "models": 10},
            {"name": "Death Korps of Krieg", "models": 10},
        ],
    }
    base.update(over)
    return base


def test_named_list_resolves_by_name_with_snapshot_points(data):
    from tools2.import_army import import_named_list

    report = import_named_list(data, _payload())
    assert report.ok, report.unresolved
    army = report.army
    assert [u.datasheet_id for u in army.units] == [
        "am.commissar_yarrick", "am.death_korps_of_krieg", "am.death_korps_of_krieg",
    ]
    assert army.units[0].warlord and not army.units[1].warlord
    assert army.faction == "AM"
    assert army.detachments == ["am.grizzled_company"]
    assert army.battle_size == 1000
    # Points come from the snapshot (the payload states none), with copy
    # escalation applied in list order.
    expected = (
        data.datasheets["am.commissar_yarrick"].cost(1, copy_index=1)
        + data.datasheets["am.death_korps_of_krieg"].cost(10, copy_index=1)
        + data.datasheets["am.death_korps_of_krieg"].cost(10, copy_index=2)
    )
    assert army.points == expected


def test_named_list_never_invents_a_datasheet(data):
    """An unknown unit is reported, not matched to something similar (mandate 3)."""
    from tools2.import_army import import_named_list

    report = import_named_list(
        data, _payload(units=[{"name": "Unit That Does Not Exist", "models": 5}])
    )
    assert report.unresolved and "Unit That Does Not Exist" in report.unresolved[0]
    assert not report.ok


def test_named_list_prices_an_agents_ally_in_the_ally_column(data):
    """Trap §6.5: an Agents unit inside an AM army pays the Assigned Agent column
    (Eversor 100/110) — the named-list path must hit the same column logic as the
    text-export importer."""
    from tools2.import_army import import_named_list

    report = import_named_list(
        data, _payload(units=[{"name": "Eversor Assassin", "models": 1}])
    )
    assert report.ok
    ally = data.datasheets["ia.eversor_assassin"].cost(1, column="assigned_agent")
    own = data.datasheets["ia.eversor_assassin"].cost(1, column="army_faction")
    assert ally != own, "the dual-column trap needs differing prices to test anything"
    assert report.army.points == ally


def test_named_list_splits_a_combined_detachment_header(data):
    """A multi-detachment army prints one combined header; every part must
    resolve for the split to be kept."""
    from tools2.import_army import import_named_list

    report = import_named_list(data, _payload(
        faction="IA",
        detachment="Imperialis Fleet and Veiled Blade Elimination Force",
        units=[{"name": "Eversor Assassin", "models": 1}],
    ))
    assert report.army.detachments == [
        "ia.imperialis_fleet", "ia.veiled_blade_elimination_force",
    ]


# --------------------------------------------------------------------------
# sim2.cli takes army files
# --------------------------------------------------------------------------
def test_cli_accepts_a_named_list_payload_file(data, tmp_path):
    path = tmp_path / "list.sim2list.json"
    path.write_text(json.dumps(_payload()), encoding="utf-8")
    army, bane = _armies(data, [str(path), "Bane"])
    assert army.name == "Saved Test List" and len(army.units) == 3
    assert bane.name == "Bane"


def test_cli_refuses_a_partial_payload_file(data, tmp_path):
    """A payload with an unresolvable unit aborts the run — a partial army is
    never fielded silently."""
    path = tmp_path / "bad.sim2list.json"
    path.write_text(
        json.dumps(_payload(units=[{"name": "No Such Unit", "models": 3}])),
        encoding="utf-8",
    )
    with pytest.raises(SystemExit):
        _armies(data, [str(path)])


def test_cli_accepts_a_v2_army_file(data):
    (army,) = _armies(data, ["data2/armies/bane.json"])
    assert army.name == "Bane" and army.units
