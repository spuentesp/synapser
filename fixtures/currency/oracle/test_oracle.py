import os
import unittest

from app.currency import minor_unit_exponent


class Oracle(unittest.TestCase):
    def test_exponents(self):
        self.assertEqual(minor_unit_exponent("USD"), 2)
        self.assertEqual(minor_unit_exponent("CLP"), 0)
        self.assertEqual(minor_unit_exponent("JPY"), 0)
        self.assertEqual(minor_unit_exponent("KWD"), 3)

    def test_unknown_code(self):
        for bad in ("XXX", "usd", "", "EURO"):
            with self.assertRaises(ValueError):
                minor_unit_exponent(bad)

    def test_sources_document_names_every_currency(self):
        text = open(os.path.join("docs", "SOURCES.md"), encoding="utf8").read()
        for code in ("USD", "CLP", "JPY", "KWD"):
            self.assertIn(code, text)
