"""Selector algebra (§3.3).

Selectors are keyword-set expressions with modifiers::

    unit(DEATHWATCH & INFANTRY & !selected_to_shoot_this_phase & from_my_army)
    enemy_unit(VEHICLE & !TITANIC & within(12", bearer) & visible(bearer))
    weapon_named("Hot-shot Lasgun" | "Hot-shot Volley Gun")

Grammar::

    selector := head '(' expr ')'
    expr     := term ('|' term)*
    term     := factor ('&' factor)*
    factor   := '!' factor | '(' expr ')' | atom
    atom     := KEYWORD | flag | call
    call     := name '(' arg (',' arg)* ')'

Atoms resolve through the predicate registry in :mod:`sim2.effects.predicates`.
An unknown atom raises at parse/eval time rather than silently matching nothing —
a rule that cannot be expressed must be logged, not quietly disabled (mandate 3).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence

TOKEN_RE = re.compile(
    r"""\s*(?:
        (?P<str>"[^"]*")
      | (?P<num>\d+(?:\.\d+)?\s*")
      | (?P<op>[&|!(),])
      | (?P<word>[A-Za-z_][A-Za-z0-9_\-']*(?:\s+[A-Za-z0-9_\-']+)*)
    )""",
    re.X,
)

HEADS = {
    "unit", "friendly_unit", "enemy_unit", "any_unit", "model", "models",
    "weapon", "weapons", "weapon_named", "attacks", "objective", "self",
    "bearer", "target_unit", "abilities_named", "models_named",
}


class SelectorError(ValueError):
    pass


# --------------------------------------------------------------------------
# AST
# --------------------------------------------------------------------------
class Node:
    def eval(self, obj: Any, ctx: "EvalContext") -> bool:  # pragma: no cover - iface
        raise NotImplementedError


@dataclass
class And(Node):
    parts: List[Node]

    def eval(self, obj, ctx) -> bool:
        return all(p.eval(obj, ctx) for p in self.parts)


@dataclass
class Or(Node):
    parts: List[Node]

    def eval(self, obj, ctx) -> bool:
        return any(p.eval(obj, ctx) for p in self.parts)


@dataclass
class Not(Node):
    part: Node

    def eval(self, obj, ctx) -> bool:
        return not self.part.eval(obj, ctx)


@dataclass
class Always(Node):
    def eval(self, obj, ctx) -> bool:
        return True


@dataclass
class Atom(Node):
    name: str
    args: List[Any]

    def eval(self, obj, ctx) -> bool:
        from .predicates import evaluate_atom

        return evaluate_atom(self.name, self.args, obj, ctx)


# --------------------------------------------------------------------------
# Parser
# --------------------------------------------------------------------------
def _tokenize(s: str) -> List[str]:
    out: List[str] = []
    i = 0
    while i < len(s):
        m = TOKEN_RE.match(s, i)
        if not m or m.end() == i:
            if s[i].isspace():
                i += 1
                continue
            raise SelectorError(f"cannot tokenise {s[i:]!r} in {s!r}")
        i = m.end()
        tok = next(g for g in m.groups() if g is not None)
        out.append(tok.strip())
    return out


class _Parser:
    def __init__(self, tokens: Sequence[str]):
        self.toks = list(tokens)
        self.i = 0

    def peek(self) -> Optional[str]:
        return self.toks[self.i] if self.i < len(self.toks) else None

    def take(self) -> str:
        t = self.peek()
        if t is None:
            raise SelectorError("unexpected end of selector")
        self.i += 1
        return t

    def expect(self, tok: str) -> None:
        t = self.take()
        if t != tok:
            raise SelectorError(f"expected {tok!r}, got {t!r}")

    def parse_expr(self) -> Node:
        parts = [self.parse_term()]
        while self.peek() == "|":
            self.take()
            parts.append(self.parse_term())
        return parts[0] if len(parts) == 1 else Or(parts)

    def parse_term(self) -> Node:
        parts = [self.parse_factor()]
        while self.peek() == "&":
            self.take()
            parts.append(self.parse_factor())
        return parts[0] if len(parts) == 1 else And(parts)

    def parse_factor(self) -> Node:
        t = self.peek()
        if t == "!":
            self.take()
            return Not(self.parse_factor())
        if t == "(":
            self.take()
            node = self.parse_expr()
            self.expect(")")
            return node
        return self.parse_atom()

    def parse_atom(self) -> Node:
        name = self.take()
        args: List[Any] = []
        if self.peek() == "(":
            self.take()
            while self.peek() not in (")", None):
                args.append(self.parse_arg())
                if self.peek() == ",":
                    self.take()
            self.expect(")")
        return Atom(name, args)

    def parse_arg(self) -> Any:
        t = self.take()
        if t.startswith('"') and t.endswith('"'):
            return t[1:-1]
        if t.endswith('"'):
            return float(t[:-1].strip())          # a distance literal: 12"
        try:
            return float(t) if "." in t else int(t)
        except ValueError:
            return t


@dataclass
class Selector:
    head: str
    expr: Node
    raw: str

    def matches(self, obj: Any, ctx: "EvalContext") -> bool:
        return self.expr.eval(obj, ctx)

    def select(self, ctx: "EvalContext") -> List[Any]:
        """Every candidate of this selector's head that satisfies the expression."""
        from .predicates import candidates_for_head

        return [o for o in candidates_for_head(self.head, ctx) if self.matches(o, ctx)]


_CACHE: Dict[str, Selector] = {}


def parse_selector(text: str) -> Selector:
    text = (text or "").strip()
    if text in _CACHE:
        return _CACHE[text]
    if not text:
        sel = Selector("unit", Always(), "")
        _CACHE[text] = sel
        return sel
    m = re.match(r"^([a-z_]+)\s*\((.*)\)\s*$", text, re.S)
    if not m:
        # bare head such as "bearer" or "self"
        if text in HEADS:
            sel = Selector(text, Always(), text)
            _CACHE[text] = sel
            return sel
        raise SelectorError(f"malformed selector: {text!r}")
    head, body = m.group(1), m.group(2).strip()
    if head not in HEADS:
        raise SelectorError(f"unknown selector head {head!r} in {text!r}")
    expr: Node = Always() if not body else _Parser(_tokenize(body)).parse_expr()
    sel = Selector(head, expr, text)
    _CACHE[text] = sel
    return sel


def parse_predicate(text: str) -> Node:
    """A bare boolean expression (trigger conditions, ``while(...)`` durations)."""
    text = (text or "").strip()
    if not text:
        return Always()
    return _Parser(_tokenize(text)).parse_expr()


# --------------------------------------------------------------------------
# Evaluation context
# --------------------------------------------------------------------------
@dataclass
class EvalContext:
    """Everything a predicate may look at.

    ``state`` is the live :class:`sim2.kernel.state.GameState`; the rest names
    the actors of the moment (bearer of an aura, the unit being targeted, the
    attack being resolved).
    """

    state: Any
    player: int = 0
    bearer: Any = None            # unit the effect hangs off
    target_unit: Any = None
    attacker_unit: Any = None
    weapon: Any = None
    attack: Any = None            # AttackContext during the attack sequence
    extra: Dict[str, Any] = None

    def __post_init__(self):
        if self.extra is None:
            self.extra = {}
