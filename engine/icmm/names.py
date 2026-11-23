"""What's wrong with a name a dataset, a protocol or a config won't take (#561 D9).

What's wrong comes first, then the rule: each character it can't have, once, in the order typed,
by name for spaces, dots and slashes, else in quotes; or, with none of those, its length.
"""

from dataclasses import dataclass

EMPTY = "Write a name."

_CALLED = {" ": "spaces", ".": "dots", "/": "slashes"}


@dataclass(frozen=True)
class NameRule:
    """The names a kind of thing takes: `allowed` characters, up to `longest` of them."""

    kind: str
    """"Dataset", "Protocol" or "Config"."""
    longest: int
    allowed: frozenset[str]
    """The characters a name takes, said as `rule`."""
    rule: str
    """The characters, as the sentence after the problem says them."""

    def problem(self, name: str) -> str | None:
        """What's wrong with `name`, in a sentence or two; `None` for a name this rule takes."""
        if name == "":
            return EMPTY
        bad = list(dict.fromkeys(c for c in name if c not in self.allowed))
        if bad:
            words = [_CALLED.get(c, f"“{c}”") for c in bad]
            listed = words[0] if len(words) == 1 else f"{', '.join(words[:-1])} or {words[-1]}"
            return f"{self.kind} names can’t have {listed}. Use {self.rule}."
        if len(name) > self.longest:
            return (
                f"{self.kind} names take up to {self.longest} characters, "
                f"and this one has {len(name)}."
            )
        return None


_PLAIN = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

DATASET = NameRule("Dataset", 64, _PLAIN | {"."}, "letters, digits, ., - and _")
PROTOCOL = NameRule("Protocol", 32, _PLAIN, "letters, digits, - and _")
CONFIG = NameRule("Config", 64, _PLAIN | {"."}, "letters, digits, ., - and _")
