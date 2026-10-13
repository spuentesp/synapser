"""Independent acceptance oracle for the discount mission (design §16).

Defined BEFORE any run and never shown to the agents. Run it against a candidate
tree:  PYTHONPATH=<candidate> python -m unittest discover -s fixtures/billing/oracle
"""

import unittest

from app.billing import compute_receipt
from app.client import checkout, render_receipt
from app.schema import Invoice


class DiscountOracle(unittest.TestCase):
    def test_ten_percent(self):
        r = checkout("c-1", 10_000, discount_bps=1_000)
        self.assertEqual((r.subtotal_cents, r.discount_cents, r.total_cents), (10_000, 1_000, 9_000))

    def test_zero_bps_keeps_total(self):
        r = checkout("c-1", 10_000, discount_bps=0)
        self.assertEqual((r.discount_cents, r.total_cents), (0, 10_000))

    def test_default_is_no_discount(self):
        r = checkout("c-1", 777)
        self.assertEqual((r.discount_cents, r.total_cents), (0, 777))

    def test_full_discount(self):
        r = checkout("c-1", 10_000, discount_bps=10_000)
        self.assertEqual((r.discount_cents, r.total_cents), (10_000, 0))

    def test_floor_rounding(self):
        # 999 * 3333 / 10000 = 332.9667 -> 332
        r = compute_receipt(Invoice("c-1", 999, 3_333))
        self.assertEqual((r.discount_cents, r.total_cents), (332, 667))

    def test_original_total_preserved(self):
        r = checkout("c-1", 12_345, discount_bps=2_500)
        self.assertEqual(r.subtotal_cents, 12_345)
        self.assertEqual(r.discount_cents + r.total_cents, r.subtotal_cents)

    def test_invalid_bps_rejected(self):
        for bad in (-1, 10_001, 1.5, True, "100", None):
            with self.subTest(bad=bad):
                with self.assertRaises((ValueError, TypeError)):
                    compute_receipt(Invoice("c-1", 1_000, bad))

    def test_invalid_subtotal_rejected(self):
        for bad in (-1, 1.0, True, "10"):
            with self.subTest(bad=bad):
                with self.assertRaises((ValueError, TypeError)):
                    compute_receipt(Invoice("c-1", bad, 0))

    def test_receipt_keeps_customer_id(self):
        self.assertEqual(checkout("cust-42", 100, discount_bps=100).customer_id, "cust-42")

    def test_render_shows_subtotal_discount_total(self):
        text = render_receipt(checkout("c-9", 10_000, discount_bps=1_000))
        for needle in ("c-9", "subtotal=10000", "discount=1000", "total=9000"):
            self.assertIn(needle, text)


if __name__ == "__main__":
    unittest.main()
