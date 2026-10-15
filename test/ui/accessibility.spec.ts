import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Plan 18 E9 (H9.6): every main view has no WCAG 2.x A/AA violation that axe can detect. Each view opens in a fresh
// document, as in views.spec.ts, and the scan runs once the view is current.
test("every view passes the automated WCAG 2.x A/AA scan", async ({ page }) => {
  await page.goto("/");
  const views = await page.locator('nav[aria-label="views"] button[data-view]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset["view"] ?? ""));
  const problems: string[] = [];
  for (const view of views) {
    await page.goto("about:blank");
    await page.goto(`/#${view}`);
    await expect(page.locator(`nav[aria-label="views"] button[data-view="${view}"]`)).toHaveAttribute("aria-current", "page");
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    for (const v of result.violations) problems.push(`${view}: ${v.id} (${v.impact}) x${v.nodes.length}: ${v.help} :: ${v.nodes.map((n) => n.html.slice(0, 160)).join(" ")}`);
  }
  expect(problems).toEqual([]);
});
