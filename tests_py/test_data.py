"""The ingested snapshot: the §1 verified facts and the §6 parsing traps."""

import json
import os

import pytest

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data2")

#: §1, verified from both faction pages on 11 Aug 2026. If a re-snapshot moves
#: any of these, the test fails and the change gets read rather than absorbed.
EXPECTED_DETACHMENTS = {
    "Ordo Malleus Daemon Hunters": ("Priority Assets", 2),
    "Ordo Xenos Alien Hunters": ("Purge the Foe", 2),
    "Imperialis Fleet": ("Reconnaissance", 2),
    "Ordo Hereticus Purgation Force": ("Take and Hold", 2),
    "Veiled Blade Elimination Force": ("Disruption", 1),
    "Grizzled Company": ("Priority Assets", 3),
    "Recon Element": ("Reconnaissance", 3),
    "Siege Regiment": ("Disruption", 2),
    "Hammer of the Emperor": ("Purge the Foe", 2),
    "Steel Hammer": ("Purge the Foe", 2),
    "Mechanised Assault": ("Reconnaissance", 2),
    "Armoured Infantry": ("Take and Hold", 2),
    "Combined Arms": ("Take and Hold", 2),
    "Bridgehead Strike": ("Priority Assets", 1),
    "Designation Force": ("Reconnaissance", 1),
    "Abhuman Auxiliaries": ("Take and Hold", 1),
}


def test_every_detachment_matches_the_verified_strip(data):
    got = {d.name: (d.disposition, d.dp) for d in data.detachments.values()}
    assert got == EXPECTED_DETACHMENTS


def test_imperialis_fleet_is_reconnaissance(data):
    """The owner-confirmed ruling of §1: Reconnaissance, not Disruption."""
    fleet = [d for d in data.detachments.values() if d.name == "Imperialis Fleet"][0]
    assert fleet.disposition == "Reconnaissance"


def test_datasheet_counts(data):
    ia = data.datasheets_of("IA", include_legends=True)
    am = data.datasheets_of("AM", include_legends=True)
    assert len(ia) >= 44
    assert len(am) >= 130
    assert any(d.legends for d in ia) and any(d.legends for d in am)


def test_legends_are_flagged_not_dropped(data):
    legends = [d for d in data.datasheets.values() if d.legends]
    assert legends
    assert all(d.name for d in legends)
    # a known Legends sheet from the §6 hint list
    assert any(d.name == "Daemonhost" for d in legends)


def test_dual_points_column_trap(data):
    """§6.5: Agents datasheets price differently as an Assigned Agent."""
    eversor = data.by_name("Eversor Assassin")
    assert eversor is not None
    army = eversor.cost(1, column="army_faction")
    ally = eversor.cost(1, column="assigned_agent")
    assert army and ally and ally > army


def test_escalating_squadron_costs_trap(data):
    """§6.6 / §7 fixture 12: the third Hellhound costs more than the first."""
    hellhound = data.by_name("Hellhound")
    assert hellhound is not None
    assert hellhound.cost(1, copy_index=1) == 125
    assert hellhound.cost(1, copy_index=3) == 135


def test_no_boarding_actions_contamination(data):
    """§6.7: Boarding Actions detachments carry no Force Disposition and must
    never enter the matched-play data."""
    names = {d.name for d in data.detachments.values()}
    for banned in ("Voidship's Company", "Interdiction Team", "Embarked Regiment",
                   "Tempestus Boarding Regiment"):
        assert banned not in names
    for rec in data.effects.values():
        assert "boarding" not in rec.detachment.lower()


def test_weapon_keywords_are_parsed_whole(data):
    """§6.4: keywords are printed one span per word; they must rejoin."""
    cadians = data.by_name("Cadian Shock Troops")
    lasgun = [w for w in cadians.weapons if w.name.lower().startswith("lasgun")][0]
    assert lasgun.abilities == ["RAPID FIRE 1"]
    assert lasgun.range_in == 24 and lasgun.strength == 3
    flamer = [w for w in cadians.weapons if w.name.lower().startswith("flamer")][0]
    assert "TORRENT" in flamer.abilities and "IGNORES COVER" in flamer.abilities


def test_weapon_names_are_clean(data):
    """A weapon's keywords must not bleed into its name.

    "Bolt pistol" is a real weapon name, so a bare suffix check would be wrong.
    The actual failure mode of the per-word keyword spans is duplication
    ("Bolt pistol pistol", "Lasgun 1") and multi-word keyword text landing in
    the name ("Flamer cover torrent").
    """
    for ds in list(data.datasheets.values())[:80]:
        for w in ds.weapons:
            low = w.name.lower()
            words = low.replace("-", " ").split()
            for a, b in zip(words, words[1:]):
                assert a != b, (ds.name, w.name)
            assert not words[-1].isdigit(), (ds.name, w.name)
            for phrase in ("rapid fire", "ignores cover", "sustained hits",
                           "lethal hits", "devastating wounds"):
                assert phrase not in low, (ds.name, w.name)


def test_every_datasheet_has_points_and_provenance(data):
    for ds in data.datasheets.values():
        if ds.id.startswith("test."):
            continue          # synthetic sheets injected by the battle fixtures
        assert ds.provenance.source and ds.provenance.pack_version, ds.id
        assert ds.points, ds.id
        assert ds.models, ds.id


def test_mission_matrix_is_asymmetric(data):
    """§5.1: each player reads the OPPONENT's symbol, so rows differ."""
    assert data.matrix
    a = data.primary_for("Reconnaissance", "Priority Assets")
    b = data.primary_for("Priority Assets", "Reconnaissance")
    assert a and b and a != b


def test_matrix_covers_every_disposition_pair(data):
    dispositions = {d.disposition for d in data.detachments.values()}
    for own in dispositions:
        for opp in dispositions:
            assert data.primary_for(own, opp), f"{own} vs {opp}"


def test_layouts_are_three_per_pairing(data):
    assert len(data.layouts) >= 45
    options = data.layouts_for("Reconnaissance", "Priority Assets")
    assert len(options) == 3
    assert {l.letter.lower() for l in options} == {"a", "b", "c"}
    for layout in options:
        assert layout.width == 44.0 and layout.height == 60.0
        assert layout.objectives and layout.terrain
        assert layout.provenance.source.startswith("Warhammer Event Companion")


def test_gaps_are_recorded_not_hidden():
    gaps = json.load(open(os.path.join(DATA, "gaps.json"), encoding="utf-8"))
    assert gaps, "an empty gap list would mean gaps are being hidden, not absent"
    for g in gaps[:20]:
        assert g["what"] and g["why"] and g["attempted"]


def test_unbound_effects_are_visible(data):
    """A rule we cannot yet express must be present-and-flagged, never absent."""
    unbound = [r for r in data.effects.values() if not r.bound]
    assert unbound
    assert all(r.text for r in unbound), "an unbound record must still carry its printed text"
