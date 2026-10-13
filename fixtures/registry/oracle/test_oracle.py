import unittest
from app import handlers as h


class Oracle(unittest.TestCase):
    def test_slugify(self):
        self.assertEqual(h.slugify("  Hello, World!! "), "hello-world")
        self.assertEqual(h.slugify("---"), "")
        self.assertEqual(h.slugify("a--b__c"), "a-b-c")
        self.assertEqual(h.slugify("Ünï 9"), "n-9")

    def test_parse_duration(self):
        self.assertEqual(h.parse_duration("1h30m15s"), 5415)
        self.assertEqual(h.parse_duration("90s"), 90)
        self.assertEqual(h.parse_duration("2h"), 7200)
        for bad in ("", "1x", "h", "15s1m", "1m1m", "1 h"):
            with self.assertRaises(ValueError, msg=bad):
                h.parse_duration(bad)

    def test_clamp(self):
        self.assertEqual(h.clamp(5, 0, 3), 3)
        self.assertEqual(h.clamp(-1, 0, 3), 0)
        self.assertEqual(h.clamp(2, 0, 3), 2)
        self.assertEqual(h.clamp(1, 1, 1), 1)
        with self.assertRaises(ValueError):
            h.clamp(1, 3, 0)

    def test_chunk(self):
        self.assertEqual(h.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
        self.assertEqual(h.chunk([], 3), [])
        self.assertEqual(h.chunk([1, 2], 5), [[1, 2]])
        for bad in (0, -1):
            with self.assertRaises(ValueError):
                h.chunk([1], bad)

    def test_to_roman(self):
        self.assertEqual(h.to_roman(4), "IV")
        self.assertEqual(h.to_roman(1994), "MCMXCIV")
        self.assertEqual(h.to_roman(3999), "MMMCMXCIX")
        for bad in (0, 4000, -3):
            with self.assertRaises(ValueError):
                h.to_roman(bad)
        for bad in (True, 3.0, "4"):
            with self.assertRaises(TypeError):
                h.to_roman(bad)

    def test_is_balanced(self):
        self.assertTrue(h.is_balanced("a(b[c]{d})"))
        self.assertTrue(h.is_balanced(""))
        self.assertFalse(h.is_balanced("(]"))
        self.assertFalse(h.is_balanced("(("))
        self.assertFalse(h.is_balanced(")("))

    def test_camel_to_snake(self):
        self.assertEqual(h.camel_to_snake("HTTPServerError"), "http_server_error")
        self.assertEqual(h.camel_to_snake("parseJSON"), "parse_json")
        self.assertEqual(h.camel_to_snake("simple"), "simple")
        self.assertEqual(h.camel_to_snake("A1B"), "a1_b")

    def test_dedupe(self):
        self.assertEqual(h.dedupe([3, 1, 3, 2, 1]), [3, 1, 2])
        self.assertEqual(h.dedupe([[1], [1], [2]]), [[1], [2]])
        self.assertEqual(h.dedupe([]), [])
