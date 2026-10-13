"""Local consumer of the billing API."""

from app.billing import compute_receipt
from app.schema import Invoice, Receipt


def checkout(customer_id: str, subtotal_cents: int, discount_bps: int = 0) -> Receipt:
    return compute_receipt(Invoice(customer_id, subtotal_cents, discount_bps))


def render_receipt(receipt: Receipt) -> str:
    return (
        f"customer={receipt.customer_id} subtotal={receipt.subtotal_cents} "
        f"discount={receipt.discount_cents} total={receipt.total_cents}"
    )
