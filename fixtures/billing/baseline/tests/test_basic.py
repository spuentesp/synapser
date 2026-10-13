import unittest

from app.client import checkout, render_receipt


class BasicTest(unittest.TestCase):
    def test_total_equals_subtotal(self):
        receipt = checkout("c-1", 10_000)
        self.assertEqual(receipt.total_cents, 10_000)

    def test_render_mentions_customer(self):
        self.assertIn("c-1", render_receipt(checkout("c-1", 500)))


if __name__ == "__main__":
    unittest.main()
