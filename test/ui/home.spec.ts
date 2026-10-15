import { expect, test } from "@playwright/test";

// Plan 18 E9 (H9.2): the home page opens in a real browser, shows the application, and logs no console error.
test("the home page opens with no console error", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page).toHaveTitle("Synapser");
  await expect(page.locator("body")).not.toBeEmpty();
  expect(errors).toEqual([]);
});
