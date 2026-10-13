# fixtures/billing

Mission fixture (design §16): add per-customer discounts (basis points) to a tiny
Python billing library.

- `baseline/` — the repo each run starts from (commit-pinned by the harness). Its own tests pass.
- `oracle/` — acceptance oracle, independent of any model; never shown to agents.
- `solution/` — reference overlay used ONLY to prove the oracle is satisfiable. Copy over `baseline/`.

Approved contract (both T1 and T2 start from it, both need `app/schema.py`):

| | |
|---|---|
| `Invoice(customer_id, subtotal_cents, discount_bps=0)` | T1 adds `discount_bps` |
| `Receipt(customer_id, subtotal_cents, discount_cents, total_cents)` | T2 adds `discount_cents` |
| `compute_receipt(invoice)` | floor(subtotal*bps/10000); bps int 0..10000, no bool, no float |
| `checkout(customer_id, subtotal_cents, discount_bps=0)` | T2 |
| `render_receipt(r)` | contains `subtotal=… discount=… total=…` |
