"""Minor-unit exponents of currencies (ISO 4217)."""

from __future__ import annotations

_EXPONENTS = {"USD": 2, "CLP": 0, "JPY": 0, "KWD": 3}


def minor_unit_exponent(code: str) -> int:
    """Return the number of decimal digits of the minor unit of the currency `code`.

    Supported: USD, CLP, JPY, KWD. Raise ValueError for any other code.
    """
    try:
        return _EXPONENTS[code]
    except KeyError:
        raise ValueError(code) from None
