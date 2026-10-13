"""Billing core: money is always integer cents."""

from app.schema import Invoice, Receipt

MAX_BPS = 10_000


def _check_int(name: str, value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an int, got {type(value).__name__}")
    return value


def compute_receipt(invoice: Invoice) -> Receipt:
    subtotal = _check_int("subtotal_cents", invoice.subtotal_cents)
    bps = _check_int("discount_bps", invoice.discount_bps)
    if subtotal < 0:
        raise ValueError("subtotal_cents must be >= 0")
    if not 0 <= bps <= MAX_BPS:
        raise ValueError(f"discount_bps must be in 0..{MAX_BPS}")
    discount = subtotal * bps // MAX_BPS
    return Receipt(
        customer_id=invoice.customer_id,
        subtotal_cents=subtotal,
        discount_cents=discount,
        total_cents=subtotal - discount,
    )
