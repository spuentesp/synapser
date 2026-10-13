"""Local consumer of the billing API."""

from app.billing import compute_receipt
from app.schema import Invoice, Receipt


def checkout(customer_id: str, subtotal_cents: int) -> Receipt:
    return compute_receipt(Invoice(customer_id, subtotal_cents))


def render_receipt(receipt: Receipt) -> str:
    return f"customer={receipt.customer_id} total={receipt.total_cents}"
