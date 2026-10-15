import { expect, test } from "@playwright/test";

// Plan 18 E9 (H9.4): a library document the server refuses shows the same reasons in the interface as the API returns for
// the same body. The API is asked first, from the page, with the session it already has; then the interface saves the same body.
const BODY = { protocol: "nonsense", models: [] };
const ID = "ui-refused-provider";

test("a refused library document shows the server's reasons, unchanged, in the interface", async ({ page }) => {
  await page.goto("/#library");
  const api = await page.evaluate(
    async ({ id, body }) => {
      const r = await fetch(`/api/library/providers/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, errors: ((await r.json()) as { errors?: string[] }).errors ?? [] };
    },
    { id: ID, body: BODY },
  );
  expect(api.status).toBe(400);
  expect(api.errors.length).toBeGreaterThan(0);

  await page.getByRole("tab", { name: "Providers" }).click();
  await page.getByLabel("New id").fill(ID);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.locator("#library-doc").fill(JSON.stringify(BODY));
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const shown = await page.locator("ul.list-disc > li").allTextContents();
  expect(shown).toEqual(api.errors);
});
