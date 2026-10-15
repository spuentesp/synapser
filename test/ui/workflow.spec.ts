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
  await page.goto("/#workflows");
  await expect(page.getByText(TITLE).first()).toBeVisible();
  await page.getByText(TITLE).first().click();
  await expect(page.getByText("app/schema.js was changed").first()).toBeVisible();
});
