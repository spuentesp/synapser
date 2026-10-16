import { expect, test } from "@playwright/test";
import { viewNames } from "./support.ts";

// Plan 18 E9 (H9.3 in part, H9.6 in part). Each main view opens directly, becomes the current page, and logs no error.
test("every view opens directly, becomes the current page, and logs no error", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const views = await viewNames(page);
  expect(views.length).toBeGreaterThan(3);
  for (const view of views) {
    // A fresh document for each view, so each one is checked from a cold start.
    await page.goto("about:blank");
    await page.goto(`/#${view}`);
    await expect(page.locator(`nav[aria-label="views"] button[data-view="${view}"]`)).toHaveAttribute("aria-current", "page");
  }
  expect(errors).toEqual([]);
});

// Regression for a defect this suite found: the chat view's scroll effect returned a value React could not clean up,
// so leaving the chat for another view unmounted the whole application. The effect now returns nothing.
test("chat then workflows: the application keeps its navigation", async ({ page }) => {
  await page.goto("/");
  await page.locator('nav[aria-label="views"] button[data-view="chat"]').click();
  await page.locator('nav[aria-label="views"] button[data-view="workflows"]').click();
  await expect(page.locator('nav[aria-label="views"] button[data-view]')).toHaveCount(13);
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
