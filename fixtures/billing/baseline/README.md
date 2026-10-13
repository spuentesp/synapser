# billing

Tiny invoicing library. Money is integer cents; never floats.

```python
from app.client import checkout, render_receipt
print(render_receipt(checkout("c-1", 10_000)))
```
