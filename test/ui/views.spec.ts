import { expect, test } from "@playwright/test";

// Plan 18 E9 (H9.3 in part, H9.6 in part). Each main view opens directly, becomes the current page, and logs no error.
test("every view opens directly, becomes the current page, and logs no error", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const views = await page.locator('nav[aria-label="views"] button[data-view]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset["view"] ?? ""));
  expect(views.length).toBeGreaterThan(3);
  for (const view of views) {
    // A fresh document for each view: a hash change inside one document would also trigger the known defect below.
    await page.goto("about:blank");
    await page.goto(`/#${view}`);
    await expect(page.locator(`nav[aria-label="views"] button[data-view="${view}"]`)).toHaveAttribute("aria-current", "page");
  }
  expect(errors).toEqual([]);
});

// Known defect found by this suite: leaving the chat view for the workflows view unmounts the whole application
// ("destroy_ is not a function" in development, "l is not a function" in the production build). Reproduced on
// 15 oct 2026; the cause is still open. Remove test.fail when it is fixed.
test("chat then workflows: the application keeps its navigation", async ({ page }) => {
  test.fail(true, "known defect: leaving chat for workflows unmounts the application (see test/ui/views.spec.ts)");
  await page.goto("/");
  await page.locator('nav[aria-label="views"] button[data-view="chat"]').click();
  await page.locator('nav[aria-label="views"] button[data-view="workflows"]').click();
  await expect(page.locator('nav[aria-label="views"] button[data-view]')).toHaveCount(12);
});

test("every navigation button has an accessible name", async ({ page }) => {
  await page.goto("/");
  const buttons = page.locator('nav[aria-label="views"] button[data-view]');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const name = (await buttons.nth(i).innerText()).trim();
    expect(name.length, `button ${i} has no name`).toBeGreaterThan(0);
  }
});
