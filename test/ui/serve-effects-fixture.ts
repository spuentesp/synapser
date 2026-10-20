import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../../src/api/server.ts";
import { DEFAULT_POLICY } from "../../src/effects/policy.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

// Deterministic fixture for the Approvals view: one pending effect, and a fetch stub that records the call it receives.
// The browser test approves the effect in the UI and then checks the marker, which only the approved effect writes.
const root = mkdtempSync(join(tmpdir(), "ui-effects-fixture-"));
const port = Number(process.env["UI_PORT"] ?? 4222);
const mark = process.env["UI_EFFECTS_MARK"] ?? join(root, "fetched");
const manager = new WorkflowManager({
  stateDir: join(root, "state"),
  workspaceRoot: root,
  commandIds: new Set(),
  profileIds: new Set(),
  pollMs: 20,
  effectTickMs: 50,
  engine: { run: async () => ({ status: "DONE", reason: null }) },
  policy: () => ({ ...DEFAULT_POLICY, rules: [...DEFAULT_POLICY.rules, { id: "fixture-http-ask", kind: "http.request", decision: "ask" }] }),
  effectFetch: (async (url: string | URL | Request) => {
    writeFileSync(mark, String(url));
    return new Response("ok", { status: 200 });
  }) as typeof fetch,
});
const created = manager.create({
  title: "Effect approval fixture",
  description: "One pending effect, approved from the Approvals view.",
  conditions: [{ id: "schema", statement: "schema file changed", required: true, checker: { kind: "diff", require: ["schema.ts"] } }],
}, { id: "fixture", role: "operator" });
if (!created.ok) throw new Error(JSON.stringify(created));
const seeded = await manager.effects(created.id)!.request({
  kind: "http.request",
  params: { method: "POST", url: "https://hooks.example.com/deploy", body: "fixture-only" },
  requestedBy: "fixture",
});
if (!seeded.ok || seeded.state !== "PENDING") throw new Error(`expected a pending effect, got ${JSON.stringify(seeded)}`);

const api = createApi({ stateDir: join(root, "state"), ssePollMs: 20, control: { manager } });
await api.listen(port);

const stop = async () => {
  await api.close();
  await manager.close();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
