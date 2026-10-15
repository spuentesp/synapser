import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { runOracle } from "./oracle.ts";

// Plan 18 E8 (H8.2, H8.3, H8.4). The acceptance tests (oracles) must tell a real change from one that only looks right.
// Each oracle is a node test file that the host runs against a workspace, as in hidden-oracle.test.ts.
// The generated inputs use a fixed seed: a failure reproduces, and the agent never sees the inputs.

const dirs: string[] = [];
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const DISCOUNT = `export function discount(price, tier) {
  const rate = tier === "gold" ? 10 : tier === "silver" ? 5 : 0;
  return Math.floor((price * (100 - rate)) / 100);
}
`;
const TOTAL = `import { discount } from "./discount.mjs";
export function total(items) {
  return items.reduce((sum, it) => sum + discount(it.price, it.tier), 0);
}
`;
// Passes every capability on its own (tier "none" only) and fails the combination: it applies the first item's tier to the sum.
const TOTAL_BAD = `import { discount } from "./discount.mjs";
export function total(items) {
  const sum = items.reduce((s, it) => s + it.price, 0);
  return discount(sum, items[0]?.tier ?? "none");
}
`;
// A memorised answer: it matches the visible examples and nothing else.
const DISCOUNT_MEMORISED = `const TABLE = { "1000:gold": 900, "1000:silver": 950, "500:none": 500 };
export function discount(price, tier) {
  return TABLE[\`\${price}:\${tier}\`] ?? price;
}
`;

// The seeded generator the oracles share in text: deterministic, and independent of the agent's view.
const LCG = `let seed = 7;
const next = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const TIERS = ["gold", "silver", "none"];
const RATE = { gold: 10, silver: 5, none: 0 };
`;
// The examples the agent is given: the memorised answer was written to pass exactly these.
const VISIBLE_EXAMPLES = `import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { discount } = await import(pathToFileURL(join(process.env.ORACLE_WORKSPACE, "discount.mjs")).href);
test("visible examples", () => {
  assert.equal(discount(1000, "gold"), 900);
  assert.equal(discount(1000, "silver"), 950);
  assert.equal(discount(500, "none"), 500);
});
`;
const DISCOUNT_ORACLE = `import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { discount } = await import(pathToFileURL(join(process.env.ORACLE_WORKSPACE, "discount.mjs")).href);
${LCG}
test("discount matches the reference on generated inputs", () => {
  for (let i = 0; i < 300; i++) {
    const price = next(100000);
    const tier = TIERS[next(3)];
    assert.equal(discount(price, tier), Math.floor((price * (100 - RATE[tier])) / 100), \`price \${price} tier \${tier}\`);
  }
});
`;
const WEAK_DISCOUNT_ORACLE = `import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { discount } = await import(pathToFileURL(join(process.env.ORACLE_WORKSPACE, "discount.mjs")).href);
test("one example", () => {
  assert.equal(discount(1000, "gold"), 900);
});
`;
const COMPOSITE_ORACLE = `import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const ws = process.env.ORACLE_WORKSPACE;
const { total } = await import(pathToFileURL(join(ws, "total.mjs")).href);
${LCG}
test("the total applies each item's own tier", () => {
  for (let i = 0; i < 200; i++) {
    const items = Array.from({ length: 1 + next(4) }, () => ({ price: next(100000), tier: TIERS[next(3)] }));
    const want = items.reduce((s, it) => s + Math.floor((it.price * (100 - RATE[it.tier])) / 100), 0);
    assert.equal(total(items), want);
  }
});
`;

function run(oracle: string, files: Record<string, string>): boolean {
  const oracleDir = scratch("oracle-src-");
  const workspace = scratch("oracle-ws-");
  const attempts = scratch("oracle-att-");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(workspace, name), text);
  const oracleFile = join(oracleDir, "acceptance.test.mjs");
  writeFileSync(oracleFile, oracle);
  return runOracle({ oracleFile, workspace, attemptsDir: attempts, runId: "H8" }).passed;
}

describe("H8.3 an answer that only memorises the visible inputs fails the unseen ones", () => {
  test("the memorised answer passes the examples the agent can see", () => {
    assert.equal(run(VISIBLE_EXAMPLES, { "discount.mjs": DISCOUNT_MEMORISED }), true);
  });
  test("the same answer fails the oracle's generated inputs, and the correct change passes them", () => {
    assert.equal(run(DISCOUNT_ORACLE, { "discount.mjs": DISCOUNT_MEMORISED }), false);
    assert.equal(run(DISCOUNT_ORACLE, { "discount.mjs": DISCOUNT }), true);
  });
});

describe("H8.2 a change that passes each capability alone fails the combined acceptance", () => {
  test("the bad total passes the single-capability check (no tiers)", () => {
    const flat = [{ price: 300, tier: "none" }, { price: 200, tier: "none" }];
    assert.equal(run(`import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { pathToFileURL } from "node:url";\nimport { join } from "node:path";\nconst ws = process.env.ORACLE_WORKSPACE;\nconst { total } = await import(pathToFileURL(join(ws, "total.mjs")).href);\ntest("untiered total", () => assert.equal(total(${JSON.stringify(flat)}), 500));\n`, { "discount.mjs": DISCOUNT, "total.mjs": TOTAL_BAD }), true);
  });
  test("the combined oracle detects the bad total and accepts the correct one", () => {
    assert.equal(run(COMPOSITE_ORACLE, { "discount.mjs": DISCOUNT, "total.mjs": TOTAL_BAD }), false);
    assert.equal(run(COMPOSITE_ORACLE, { "discount.mjs": DISCOUNT, "total.mjs": TOTAL }), true);
  });
});

// Trivial mutants of the agent's change. Each replaces one token; a mutant that still passes the oracle survives.
const MUTANTS: [string, string][] = [
  ["100 - rate", "100 + rate"],
  ["/ 100", "/ 10"],
  ["Math.floor", "Math.round"],
  ['tier === "gold" ? 10', 'tier === "gold" ? 11'],
  ["? 5 :", "? 4 :"],
  [": 0;", ": 1;"],
];
function survivors(oracle: string): string[] {
  return MUTANTS.filter(([from, to]) => {
    if (!DISCOUNT.includes(from)) throw new Error(`mutant anchor missing: ${from}`);
    return run(oracle, { "discount.mjs": DISCOUNT.replace(from, to) });
  }).map(([from, to]) => `${from} -> ${to}`);
}

describe("H8.4 a change that survives trivial mutants is rejected", () => {
  test("the full oracle kills every trivial mutant of the change", () => {
    assert.deepEqual(survivors(DISCOUNT_ORACLE), []);
  });
  test("a weak oracle lets mutants through, so the gate rejects it", () => {
    assert.notDeepEqual(survivors(WEAK_DISCOUNT_ORACLE), []);
  });
});
