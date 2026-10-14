"""Minor-unit exponents of currencies (ISO 4217)."""

from __future__ import annotations


def minor_unit_exponent(code: str) -> int:
    """Return the number of decimal digits of the minor unit of the currency `code`.

    Supported: USD, CLP, JPY, KWD. Raise ValueError for any other code.
    """
    raise NotImplementedError("minor_unit_exponent")
