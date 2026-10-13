import unittest

from app.client import checkout


class DiscountTest(unittest.TestCase):
    def test_ten_percent(self):
        receipt = checkout("c-1", 10_000, discount_bps=1_000)
        self.assertEqual(receipt.total_cents, 9_000)


if __name__ == "__main__":
    unittest.main()
