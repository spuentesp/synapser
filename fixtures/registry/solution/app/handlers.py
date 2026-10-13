"""Small, independent text and number helpers.

Each function below is specified by its docstring and is currently a stub. Implement ONE function
at a time and leave every other function exactly as it is.
"""

from __future__ import annotations

def slugify(text: str) -> str:
    """
    Lowercase the text, replace every run of characters that are not ASCII letters or
    digits with a single '-', and strip leading and trailing '-'. slugify('  Hello,
    World!! ') == 'hello-world'; slugify('---') == ''.
    """
    out = []
    pending = False
    for ch in text.lower():
        if ch.isascii() and ch.isalnum():
            if pending and out:
                out.append('-')
            pending = False
            out.append(ch)
        else:
            pending = True
    return ''.join(out)


# ----------------------------------------------------------------------------

def parse_duration(text: str) -> int:
    """
    Parse a duration made of one or more '<int><unit>' parts with units h, m, s (in that
    order, each at most once) into total seconds. parse_duration('1h30m15s') == 5415;
    parse_duration('90s') == 90. Raise ValueError for an empty string, an unknown unit,
    a missing number, repeated or out-of-order units.
    """
    import re
    m = re.fullmatch(r'(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?', text)
    if not text or m is None:
        raise ValueError(text)
    h, mi, s = (int(g) if g else 0 for g in m.groups())
    return h * 3600 + mi * 60 + s


# ----------------------------------------------------------------------------

def clamp(value: float, low: float, high: float) -> float:
    """
    Return value limited to the closed interval [low, high]. Raise ValueError when low >
    high. clamp(5, 0, 3) == 3; clamp(-1, 0, 3) == 0; clamp(2, 0, 3) == 2.
    """
    if low > high:
        raise ValueError('low > high')
    return max(low, min(high, value))


# ----------------------------------------------------------------------------

def chunk(items: list, size: int) -> list:
    """
    Split items into consecutive lists of at most size elements, preserving order; the
    last list may be shorter. Raise ValueError when size <= 0. chunk([1,2,3,4,5], 2) ==
    [[1,2],[3,4],[5]]; chunk([], 3) == [].
    """
    if size <= 0:
        raise ValueError('size must be positive')
    return [items[i:i + size] for i in range(0, len(items), size)]


# ----------------------------------------------------------------------------

def to_roman(number: int) -> str:
    """
    Convert an integer 1..3999 to an upper-case Roman numeral using subtractive
    notation. to_roman(4) == 'IV'; to_roman(1994) == 'MCMXCIV'. Raise ValueError outside
    1..3999 and TypeError for non-int (bool is not accepted).
    """
    if isinstance(number, bool) or not isinstance(number, int):
        raise TypeError('int required')
    if not 1 <= number <= 3999:
        raise ValueError(number)
    table = [(1000,'M'),(900,'CM'),(500,'D'),(400,'CD'),(100,'C'),(90,'XC'),(50,'L'),(40,'XL'),(10,'X'),(9,'IX'),(5,'V'),(4,'IV'),(1,'I')]
    out = []
    for v, s in table:
        while number >= v:
            out.append(s)
            number -= v
    return ''.join(out)


# ----------------------------------------------------------------------------

def is_balanced(text: str) -> bool:
    """
    Return True when every bracket among ()[]{} in text is closed by the matching
    bracket in the right order; characters other than brackets are ignored.
    is_balanced('a(b[c]{d})') is True; is_balanced('(]') is False; is_balanced('') is
    True.
    """
    pairs = {')': '(', ']': '[', '}': '{'}
    stack = []
    for ch in text:
        if ch in '([{':
            stack.append(ch)
        elif ch in pairs:
            if not stack or stack.pop() != pairs[ch]:
                return False
    return not stack


# ----------------------------------------------------------------------------

def camel_to_snake(name: str) -> str:
    """
    Convert a CamelCase or lowerCamelCase identifier to snake_case: insert '_' before an
    upper-case letter that follows a lower-case letter or digit, or that is followed by
    a lower-case letter when preceded by an upper-case letter, then lower-case
    everything. camel_to_snake('HTTPServerError') == 'http_server_error';
    camel_to_snake('parseJSON') == 'parse_json'.
    """
    import re
    s = re.sub(r'(?<=[a-z0-9])(?=[A-Z])', '_', name)
    s = re.sub(r'(?<=[A-Z])(?=[A-Z][a-z])', '_', s)
    return s.lower()


# ----------------------------------------------------------------------------

def dedupe(items: list) -> list:
    """
    Return the items with duplicates removed, keeping the FIRST occurrence of each and
    the original order. Elements may be unhashable (lists); equality is ==.
    dedupe([3,1,3,2,1]) == [3,1,2]; dedupe([[1],[1],[2]]) == [[1],[2]].
    """
    out = []
    for x in items:
        if x not in out:
            out.append(x)
    return out
