"""Data shapes shared by the billing API and its consumers."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Invoice:
    customer_id: str
    subtotal_cents: int


@dataclass(frozen=True)
class Receipt:
    customer_id: str
    subtotal_cents: int
    total_cents: int
