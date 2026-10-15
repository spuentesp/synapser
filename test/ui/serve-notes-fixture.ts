import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../../src/api/server.ts";
import type { Advisor } from "../../src/advisor/advisor.ts";
import { DEFAULT_POLICY } from "../../src/effects/policy.ts";
import { WorkflowManager } from "../../src/workflow/manager.ts";

const root = mkdtempSync(join(tmpdir(), "ui-notes-fixture-"));
const port = Number(process.env["UI_PORT"] ?? 4221);
const proposal = { id: "iv-fixture", type: "hold", task: "schema", state: "PROPOSED", trigger: "fixture review", reason: "human review requested" };
const manager = new WorkflowManager({
  stateDir: join(root, "state"),
  workspaceRoot: root,
  commandIds: new Set(),
  profileIds: new Set(),
  pollMs: 20,
  effectTickMs: 0,
  engine: { run: async () => ({ status: "DONE", reason: null }) },
  policy: () => ({ ...DEFAULT_POLICY, rules: [...DEFAULT_POLICY.rules, { id: "fixture-http-review", kind: "http.request", decision: "ask" }] }),
  advisor: () => ({ list: () => [proposal] }) as unknown as Advisor,
});
const created = manager.create({
  title: "Workflow notes fixture",
  description: "Show advisor and effect notes without starting a workflow.",
  conditions: [{ id: "schema", statement: "schema file changed", required: true, checker: { kind: "diff", require: ["schema.ts"] } }],
}, { id: "fixture", role: "operator" });
if (!created.ok) throw new Error(JSON.stringify(created));
const seededEffect = await manager.effects(created.id)!.request({
  kind: "http.request",
  params: { method: "POST", url: "https://hooks.example.com/deploy", body: "fixture-only" },
  requestedBy: "fixture",
});
if (!seededEffect.ok || seededEffect.state !== "PENDING") throw new Error(`expected a pending effect, got ${JSON.stringify(seededEffect)}`);

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
