// The demo mission (design §16): per-customer discounts for a small Python billing library.
// T1/T2 deliberately share app/schema.py; T3 works on disjoint files. The oracle is NOT part of
// any task: it is an acceptance command the agents never see.

import { join, resolve } from "node:path";
import type { AllowedCommand } from "../validation/runner.ts";
import type { Plan } from "./plan.ts";

export const BILLING_CONTRACT = [
  "app/schema.py: Invoice is a frozen dataclass Invoice(customer_id: str, subtotal_cents: int, discount_bps: int = 0). Receipt is a frozen dataclass Receipt(customer_id: str, subtotal_cents: int, discount_cents: int, total_cents: int).",
  "app/billing.py: compute_receipt(invoice) -> Receipt with discount_cents = floor(subtotal_cents * discount_bps / 10000) using INTEGER arithmetic only (no floats) and total_cents = subtotal_cents - discount_cents. The receipt keeps customer_id and the original subtotal_cents.",
  "Validation in compute_receipt: subtotal_cents must be an int >= 0 and discount_bps an int in 0..10000; bool is NOT accepted as a number; floats and strings are rejected. Raise ValueError for out-of-range ints and TypeError for wrong types.",
  "app/client.py: checkout(customer_id, subtotal_cents, discount_bps=0) -> Receipt (use compute_receipt); render_receipt(receipt) -> str containing 'customer=<id>', 'subtotal=<cents>', 'discount=<cents>' and 'total=<cents>' as space-separated key=value pairs.",
];

export function billingPlan(): Plan {
  return {
    tasks: [
      {
        id: "api",
        objective: "Add the discount fields to the shapes and implement compute_receipt with validation in the billing module.",
        scope: ["app/billing.py", "app/schema.py"],
        criteria: [
          "app/schema.py: Invoice has discount_bps (int, default 0) and Receipt has discount_cents, exactly as in the contract.",
          "app/billing.py: compute_receipt implements the integer floor formula and the validation rules of the contract.",
        ],
        context: BILLING_CONTRACT,
        deps: [],
        priority: 10,
      },
      {
        id: "consumer",
        objective: "Make the local consumer expose subtotal, discount and total in the receipt.",
        scope: ["app/client.py", "app/schema.py"],
        criteria: [
          "app/client.py: checkout(customer_id, subtotal_cents, discount_bps=0) and render_receipt as in the contract.",
          "app/schema.py: Receipt must have discount_cents (another agent is also editing this file for Invoice: re-read it before changing it and keep their changes).",
        ],
        context: BILLING_CONTRACT,
        deps: [],
        priority: 10,
      },
      {
        id: "tests",
        objective: "Add unittest acceptance cases for the discount contract and document usage.",
        scope: ["tests/test_discount.py", "README.md"],
        criteria: [
          "tests/test_discount.py uses unittest, imports from app.client and app.billing, and covers: 10000 cents at 1000 bps -> discount 1000 total 9000; 0 bps keeps the total; 10000 bps gives total 0; floor rounding; invalid bps raises.",
          "README.md documents the discount_bps parameter of checkout().",
        ],
        context: BILLING_CONTRACT,
        deps: [],
        priority: 5,
      },
    ],
  };
}

export const BILLING_OBJECTIVE = "Add per-customer discounts (basis points, integer cents) to a small Python billing library with a local consumer, unittest tests and documentation.";

export function billingAcceptance(fixturesDir = resolve("fixtures/billing")): AllowedCommand[] {
  return [
    { id: "unit", argv: ["python3", "-m", "unittest", "discover", "-s", "tests", "-t", "."], timeoutMs: 60_000 },
    { id: "oracle", argv: ["python3", "-m", "unittest", "discover", "-s", join(fixturesDir, "oracle")], timeoutMs: 60_000 },
  ];
}
