# Building a Warhammer 40,000 Battle Simulator — Feasibility & Build Plan

*Scoped for: a personal tool that plays **your** saved lists (Imperialis Fleet Agents, Grizzled Company AM, and the "Bane" Krieg list) on labrador.dev terrain layouts, with an AI controlling the opposing army. June 2026, 10th edition / Pariah Nexus.*

---

## 1. The honest answer up front

There are two very different projects hiding inside this request, and conflating them is what makes people quit halfway.

**Project A — "a faithful, general 40k simulator."** Every faction, every datasheet, every stratagem, true 3D line of sight, a tournament-legal rules engine. This is a *studio-scale, multi-year* effort. Nobody has shipped a free, full-fidelity digital 40k for a reason: the rules surface is enormous, the ability interactions are effectively infinite, and Games Workshop's IP means you could never distribute it anyway. **Do not attempt this.**

**Project B — "a tool that plays *my three lists* against each other on *one* map, with an AI good enough to be a useful sparring partner."** This is a genuinely achievable hobby project. Your fixed lists are the cheat code: instead of implementing all of 40k, you implement roughly **40 datasheets, 3 detachment rules, ~25 stratagems, and ~15 Orders/abilities**. That is a finite, enumerable list of work.

This plan is entirely about Project B.

**Realistic effort, solo developer who can code:**

| Milestone | What you can do | Rough effort |
|---|---|---|
| Data + board + deployment, no combat | Move models, measure ranges, see the map | 1–2 weeks |
| Deterministic combat MVP (shoot/charge/fight, hit→wound→save→damage) with the universal keywords | Resolve a real firefight by the book | 2–4 weeks |
| 2D line-of-sight + objectives + primary scoring | A game that can actually be won or lost | +2 weeks |
| The three detachments + their stratagems + Orders + per-unit abilities | Your *actual* lists play correctly | 3–6 weeks (the long tail) |
| A "good enough" AI opponent | Sparring partner, not a champion | 2–6 weeks depending on ambition |

So: a rough but playable MVP in **3–5 weekends**; a version that genuinely captures your three lists and gives a decent game in the **3–4 month** range of part-time work. The AI is the part with the widest uncertainty band.

---

## 2. What the research settled

**Unit data is the easy part — it's already solved.** Wahapedia publishes official data exports as pipe-delimited (`|`) UTF-8 CSV files, linked by ID across tables (datasheets, model stats, weapon profiles with keywords, abilities, stratagems, enhancements, detachment rules). There is a maintained open-source pipeline, **`fjlaubscher/depot`**, that fetches those CSVs and converts them into typed JSON ready for an app. You should reuse or fork its converter rather than scrape Wahapedia HTML.

> ⚠️ **Licensing reality.** Wahapedia's data is offered for personal, non-commercial use, and all 40k rules/IP belong to Games Workshop. A private tool for your own games is fine. Publishing it, charging for it, or hosting the rules text publicly is not. Keep this personal.

**The rules engine has prior art.** `rzem-ai/rzem-ai-tabletop-simulator` is a 10th-edition engine (full phase system, attack resolution, morale, 21 factions) built on **boardgame.io**. It proves the core game loop is tractable and is worth reading — but note it runs *inside* Tabletop Simulator and leans on TTS physics for terrain/LoS, which is exactly the part you'll need to do differently.

**The maps are 2D footprints, and that's a gift.** The labrador.dev layout tool is client-rendered SVG. Each terrain piece is a rectangle/polygon footprint positioned by corner-offset measurements (the "12 ←, 5 ↑" annotations are recoverable coordinates). Critically, it exposes **no model height and no terrain type**. That sounds like a limitation but it's actually what makes the hardest problem in digital 40k — true 3D line of sight — avoidable. See §5.

---

## 3. Architecture overview

A clean separation keeps this sane. Recommended stack: **TypeScript everywhere**, React + Canvas/SVG for the board, a pure-function rules core, and (optionally) the Anthropic API for the AI brain — which is convenient since the app can be a Claude Artifact that calls Claude.

```
┌─────────────────────────────────────────────────────────┐
│  UI LAYER (React + Canvas)                                │
│  · Board render (terrain, models, ranges, objectives)     │
│  · Drag-to-move with live distance + LoS preview          │
│  · Phase/turn controls, dice log, CP/score tracker        │
└───────────────┬───────────────────────────────────────────┘
                │ dispatches intents (Move, Shoot, Charge…)
┌───────────────▼───────────────────────────────────────────┐
│  GAME STATE MACHINE  (the referee — pure, deterministic)   │
│  · Turn/phase/step sequencer (Pariah Nexus)                │
│  · Validates legality, applies dice results to state       │
│  · Emits events that the Ability System hooks into         │
└───────┬───────────────────────────┬───────────────────────┘
        │                           │
┌───────▼─────────┐       ┌─────────▼──────────────┐
│ RULES CORE       │       │ ABILITY / EFFECT SYSTEM │
│ · combat math    │       │ · keyword library       │
│ · LoS (2D)       │       │ · per-unit hooks         │
│ · movement/range │       │ · stratagems, Orders     │
│ · objective/score│       │ · detachment rules       │
└──────────────────┘       └──────────────────────────┘
        │                           │
┌───────▼───────────────────────────▼───────────────────────┐
│  STATIC DATA  (built once, offline)                         │
│  · Wahapedia → JSON (depot converter)                       │
│  · Terrain layouts (transcribed from labrador) as polygons  │
│  · Your three army lists as structured rosters              │
└─────────────────────────────────────────────────────────────┘
        │
┌───────▼─────────┐
│  AI OPPONENT     │  reads state → returns intents
│  (heuristic /    │
│   LLM / hybrid)  │
└──────────────────┘
```

The single most important design rule: **the state machine is the only thing allowed to change game state, and it does so only in response to validated intents plus dice results.** Both you and the AI submit the *same* kind of intents. This means the AI is not "cheating in" — it plays through the exact same interface you do, which also makes the engine independently testable.

---

## 4. The rules engine — what to build, in order

10th edition's structure is your friend here: it's a rigid sequence of phases, and the *math* of combat is deterministic and fully documented. Build it as an explicit state machine.

**Turn structure (Pariah Nexus):** Command → Movement → Shooting → Charge → Fight, then end-of-turn scoring; alternate player turns within 5 battle rounds. Command phase handles Battle-shock and CP gain; scoring is capped (Primary 50, Secondary 40) with Tactical secondaries drawn two-per-turn.

**Combat resolution pipeline** (the heart of it) — model this as a pipeline of steps, each of which the ability system can modify:

1. Select attacker weapon + eligible target (range + LoS + engagement legality)
2. **Number of attacks** (handle `Blast`, variable `D6` attacks)
3. **Hit roll** vs WS/BS, apply modifiers (capped at ±1), check criticals → trigger `Sustained Hits`, `Lethal Hits`
4. **Wound roll** (S vs T table), apply `Anti-X`, `Lance`, re-rolls, criticals → `Devastating Wounds`
5. **Allocate** to target models; **saving throw** (best of armour vs AP, or invuln), `Cover`
6. **Damage**, `Feel No Pain`, `-1 Damage` reducers, spillover, model removal
7. Trigger on-death and end-of-step hooks (e.g. Death Korps regen, Yarrick's second life)

If you get this pipeline right with a clean modifier/hook system, **most of the game is data after that.** The universal keywords are a finite set you implement once: Rapid Fire, Heavy, Assault, Pistol, Torrent, Blast, Melta, Lance, Sustained Hits N, Lethal Hits, Devastating Wounds, Anti-X N+, Precision, Indirect Fire, Ignores Cover, Hazardous, Twin-linked, Extra Attacks, Conversion. Your three lists exercise almost all of these (the Stormlord's Torrent flamers, Kasrkin melta, the mortar's Indirect Fire + Blast, etc.).

**Movement:** straightforward 2D — Move/Advance/Fall Back/Remain Stationary, Deep Strike placement (9" rule), Infiltrators/Scout pre-game moves, embark/disembark for the Stormlord/Immolator/Chimera. Charge = 2D6 with a path that must end in base-to-base/engagement range and clear intervening models.

**Battle-shock & objectives:** Battle-shock is a Leadership test below half-strength; it matters mechanically for you because **Grizzled Company's whole engine collapses under battle-shock** (Orders switch off), so the AI playing a battle-shock-stacking opponent is a real tactical axis. Objective control = sum of OC in range, with the detachment/stratagem modifiers layered on.

---

## 5. Line of sight — the make-or-break decision

This is where ambitious projects die. The honest options:

- **True 3D LoS (what the tabletop technically uses):** requires 3D model geometry, model heights, and ray-casting from any point of one model to any point of another. Enormous content and compute cost. **Reject this.**
- **Competitive 2D-footprint abstraction (recommended):** Treat each terrain piece as a 2D polygon that blocks LoS *through* it. A model can see a target if the straight segment between their base centres (or base edges) does not cross an LoS-blocking polygon — with the standard Ruins carve-outs (a unit can see/shoot if it or the target is *within* the footprint and on the ground floor; models on top/within can see out). This reduces the entire problem to **segment–polygon intersection**, which is ~50 lines of geometry code and runs instantly.

The labrador maps give you exactly the footprint polygons this approach needs. The one thing they *don't* give you is **terrain type** (which footprints are LoS-blocking Ruins vs. low Area Terrain that only grants cover). You'll add that yourself as a one-time per-layout annotation: when you transcribe a layout, tag each piece as `ruin_blocking`, `area_cover`, or `obstacle`. For a handful of layouts that's an hour of work, not a pipeline.

This abstraction is also *how a lot of competitive play actually adjudicates ruins anyway*, so it's faithful enough to give meaningful games. Document it as an explicit, known simplification.

**Cover** falls out of the same data: a target gets the cover benefit if the LoS segment clips an intervening terrain piece or the target sits within area terrain.

---

## 6. The ability system — where 90% of the real work lives

This is the part that makes 40k 40k, and the part no shortcut survives. The strategy is **a generic effect engine + bespoke hooks, implemented only for the units in your three lists.**

**Design it as an event/hook system.** The state machine emits events (`onHitRoll`, `onWoundRoll`, `onSave`, `onModelDestroyed`, `onCommandPhase`, `onMoveDeclared`, `onObjectiveScored`, …). Abilities are functions that subscribe to events and return modifiers or new effects. Example shapes you'll need:

- **Static modifiers:** Grim Demeanour (+1 to Hit below Starting Strength, +1 to Wound below half), Bullgryn Wall of Muscle (−1 Damage), the Immolator/Sisters melta profiles.
- **Command-phase choices:** the detachment rules — Imperialis Fleet's *Eliminate at All Costs* / *Acquire at All Costs*; Grizzled Company's *Ruthless Discipline* (extra Order + re-roll 1s to hit).
- **Orders (AM):** Take Aim!, First Rank Fire!, Duty and Honour!, Target Weak Spot, Move to the Shadows — each is a temporary modifier applied to a unit and consumed at end of turn. Officer Order-count and the "two Orders on one unit" cases (Kasrkin Warrior Elite, Yarrick's 3 Orders) are just counters.
- **Stratagems:** model each as `{cost, timing/phase, target filter, effect}`. Your sets are ~10–12 per detachment (Displacer Field, Violent Acquisition, Mordian Minute, No Retreat, Veteran Sharpshooters, etc.). Displacer Field is the spicy one — a *reactive* stratagem with a post-shooting 6" move — so your engine needs reactive-window timing, not just active-turn timing. Build that early; lots of things depend on it.
- **Persistent unit specials:** Death Korps Medi-pack (return D3 models in Command phase), Yarrick's Will of Iron (come back on 2+), Stormlord's Mount Up!/Firing Deck 24, Death Riders' Screening Line reactive move, Krieg Engineers' free Grenade stratagem.

**Scope discipline:** make a spreadsheet of every datasheet, weapon, ability, stratagem, enhancement, and Order across your three lists. That finite checklist *is* your backlog. When it's all green, your lists play correctly — and you have ignored 95% of the game you'll never use. (Your own list files already enumerate most of this — they're effectively a half-written spec.)

---

## 7. The AI opponent — options, honestly ranked

This is the hardest and least certain piece. 40k is near-perfect-information (only reserves/secondaries are hidden) but has an astronomical branching factor: continuous 2D positioning × per-model target selection × stratagem timing. Brute-force search (minimax/MCTS) is impractical at full fidelity. Three viable approaches:

**A. Heuristic / utility AI (recommended starting point).** Per phase, generate candidate actions and score them with hand-written utility functions: *expected damage per point*, *objective control delta*, *survivability after enemy turn*, *threat range overlap*. Greedy or beam-search over the top candidates. This is how most shipped tactics-game AIs work. It will play a *competent, predictable* game — castle the Stormlord, push Bullgryn onto objectives, melta the biggest threat — which is exactly a useful sparring partner. Effort: 2–4 weeks for a decent one; it improves indefinitely as you add heuristics.

**B. LLM-driven brain (fits your context — the app can call Claude).** Serialise the board state into structured text, hand it to an LLM, and ask for a plan ("move unit X to (a,b), shoot Y, spend CP on Z"). Strengths: genuinely good at *high-level strategy*, stratagem choice, and target priority; understands the rules narratively. Weakness: **bad at precise 2D geometry** — it will propose illegal moves and mis-measure ranges. Never let it move models in raw coordinates.

**C. Hybrid (best end state).** LLM picks *intent and priorities* ("this turn, contest centre objective, kill the Immolator, protect Yarrick"); the heuristic layer + engine translate that into legal, measured actions and reject illegal ones. You get strategic flavour without geometric nonsense. This is the sweet spot but requires both A and B built first.

**Hard constraint for all three:** the AI must submit the *same validated intents* you do and only see the information a player would (no peeking at your reserves/secret missions). The engine validates everything; the AI cannot produce an illegal state even if it tries.

A pragmatic path: ship **A** to get a playable opponent, then bolt on **B→C** once the engine is stable.

---

## 8. Suggested phased roadmap

**Phase 0 — Data & scaffolding (1–2 wk).** Fork `depot`'s converter; pull Wahapedia CSVs → JSON. Hand-transcribe one labrador layout (your Hammer-and-Anvil example) into footprint polygons + terrain-type tags. Encode your three rosters as structured data. Render the board, terrain, and models with drag-to-move and a live distance read-out. *No combat yet — just a measuring board.*

**Phase 1 — Deterministic combat core (2–4 wk).** Phase/turn state machine. The full hit→wound→save→damage pipeline. The universal keyword library. A visible dice log. Test against known math (e.g. "10 Kasrkin rapid-firing into Guardsmen" should match a dice calculator). *Win condition: two units can fight by the book.*

**Phase 2 — A real game (≈2 wk).** 2D LoS + cover. Objectives, OC, Primary scoring, CP. Movement edge cases: Deep Strike, Infiltrators/Scout, embark/disembark, Fall Back, charge pathing. Battle-shock. *Win condition: a full 5-round game ends with a score, human-vs-human (you play both sides).*

**Phase 3 — Your lists, faithfully (3–6 wk).** The ability-system backlog from §6: 3 detachment rules, ~25 stratagems (incl. reactive timing for Displacer Field), AM Orders, and every per-unit special in your three lists. *Win condition: your "Bane" list plays exactly as your reference doc describes.*

**Phase 4 — AI opponent (2–6 wk).** Heuristic AI first (Approach A). Then optional LLM/hybrid brain (B→C). *Win condition: you can pick a side, hit "AI takes its turn," and get a game worth playing.*

**Phase 5 — Polish (ongoing).** Secondary missions, more layouts, save/replay, a "why did that happen" rules-trace panel (invaluable for debugging *and* for trusting the sim).

---

## 9. Biggest risks & how to defuse them

- **Scope creep into Project A.** The whole plan only works if you *never* implement a unit you don't own. Guard this ruthlessly; the backlog spreadsheet is the fence.
- **The ability long tail.** It's death by a thousand special rules. Defuse by building the generic hook system *before* writing any specific ability, so each new ability is ~20 lines, not a refactor.
- **Reactive timing.** Displacer Field, Death Riders' Screening Line, Yarrick's Counterstrategist, overwatch — these fire *during the opponent's turn*. If you build the engine as "active player does everything," you'll have to rip it apart. Bake reactive windows in from Phase 1.
- **AI illegal moves.** Solved structurally: AI submits intents, engine validates, illegal intents bounce. Never let any actor mutate state directly.
- **Rules drift / edition change.** 11th edition was revealed at AdeptiCon (March 2026) with an "Armageddon" launch box in June 2026. **A 10th-edition engine is being built at the very end of 10th.** Your three lists and their points are explicitly 10th/Pariah Nexus. Accept that this sim has a shelf life, or architect the rules core to be data-driven enough to re-point for 11th later (don't hard-code the turn structure into the UI).
- **LoS faithfulness disputes.** The 2D abstraction will occasionally disagree with how you'd adjudicate a real ruin. Document it as a known, deliberate simplification rather than a bug.

---

## 10. Bottom line

Difficulty: **hard but bounded, and the boundaries are the thing that saves you.** A general 40k simulator is effectively impossible for one person; *your* simulator is a well-defined engineering project because your three lists turn an infinite rules surface into a finite checklist. The data is a solved problem, the maps hand you a way to dodge the worst geometry, and a heuristic AI gets you a real sparring partner without research-grade machine learning.

If you want, next steps I can take from here: (1) draft the JSON schema for a roster + datasheet + weapon + ability so you've got a concrete data contract to build against; (2) write the LoS segment-vs-polygon function; or (3) turn the §6 ability list into the actual backlog spreadsheet by going through your three list files unit by unit. Say which and I'll build it.
