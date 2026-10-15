import { expect, test } from "@playwright/test";

// Plan 18 E9 (H9.3): a workflow created in the server shows in the workflows view, and its detail opens. The document is
// posted from the page itself with the session cookie, so the test uses the same path the interface uses.
const TITLE = "Ship the discount in the schema";
const doc = {
  title: TITLE,
  description: "Mark the schema file as changed; nothing else",
  goals: ["the schema file is changed"],
  nonGoals: [{ statement: "do not touch the README", guard: { kind: "diff", forbid: ["README.md"] } }],
  conditions: [{ id: "schema", statement: "app/schema.js was changed", checker: { kind: "diff", require: ["app/schema.js"] } }],
};

test("a workflow created on the server is listed and its detail opens", async ({ page }) => {
  await page.goto("/");
  const created = await page.evaluate(async (body) => {
    const r = await fetch("/api/workflows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  }, doc);
  expect(created.status, created.text).toBe(200);
  const id = JSON.parse(created.text).id as string;
  const second = await page.evaluate(async (body) => {
    const r = await fetch("/api/workflows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, text: await r.text() };
  }, { ...doc, title: "Second workflow context" });
  expect(second.status, second.text).toBe(200);
  await page.goto("/#workflows");
  await expect(page.getByText(TITLE).first()).toBeVisible();
  await expect(page.getByText("Second workflow context").first()).toBeVisible();
  await page.getByText(TITLE).first().click();
  await expect(page.getByText("app/schema.js was changed").first()).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Run" })).toContainText(id);

  await page.getByRole("button", { name: "Edit draft" }).click();
  await page.getByLabel("Non-goal statement").fill("do not modify the README either");
  const guard = page.getByLabel("Non-goal guard (optional JSON)");
  const validGuard = '{\n  "kind": "diff",\n  "forbid": [\n    "README.md"\n  ]\n}';
  await guard.fill("{");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await guard.fill(validGuard);
  await expect(page.getByLabel("JSON preview")).toContainText('"forbid": [\n        "README.md"');
  await page.getByRole("button", { name: "Save" }).click();
  let updatedNonGoals: unknown;
  await expect.poll(async () => {
    const updated = await page.evaluate(async (workflowId) => {
      const r = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`);
      return r.json() as Promise<{ workflow: { nonGoals: unknown[] } }>;
    }, id);
    updatedNonGoals = updated.workflow.nonGoals;
    return updatedNonGoals;
  }).toEqual([{ statement: "do not modify the README either", guard: { kind: "diff", forbid: ["README.md"] } }]);
  expect(updatedNonGoals).toEqual([{ statement: "do not modify the README either", guard: { kind: "diff", forbid: ["README.md"] } }]);
});
