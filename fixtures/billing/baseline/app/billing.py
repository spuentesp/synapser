"""Billing core: money is always integer cents."""

from app.schema import Invoice, Receipt


def compute_receipt(invoice: Invoice) -> Receipt:
    return Receipt(
        customer_id=invoice.customer_id,
        subtotal_cents=invoice.subtotal_cents,
        total_cents=invoice.subtotal_cents,
    )
