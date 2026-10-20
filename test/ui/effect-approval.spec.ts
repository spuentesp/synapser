import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.skip(process.env["UI_EFFECTS_FIXTURE"] !== "1", "Run with playwright.effects.config.ts to use the deterministic effects fixture");

const MARK = process.env["UI_EFFECTS_MARK"] ?? "";

test("a pending effect is approved from the Approvals view, and the approved call then runs", async ({ page }) => {
  await page.goto("/#approvals");
  const pending = page.locator('[data-testid="gate"][data-key^="effect:"]');
  await expect(pending).toHaveCount(1);
  await expect(pending).toContainText(/POST hooks\.example\.com\/deploy/);
  expect(existsSync(MARK), "nothing runs before a human decides").toBe(false);

  await pending.locator('[data-decide="APPROVED"]').click();

  await expect(page.locator('[data-testid="gate"][data-key^="effect:"]')).toHaveCount(0);
  await expect.poll(() => (existsSync(MARK) ? readFileSync(MARK, "utf8") : ""), { timeout: 10_000 }).toContain("hooks.example.com/deploy");
  await page.screenshot({ path: "evidence/effect-approval.png", fullPage: true });
});
