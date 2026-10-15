import { expect, test } from "@playwright/test";

// Plan 14 Q3.3: inherited execution controls and operator-assigned skills are visible, not editable library fields.
test("agent designer explains inherited controls and operator-assigned skills", async ({ page }) => {
  await page.goto("/#library");
  await page.getByRole("tab", { name: "Agents" }).click();
  await page.getByLabel("New id").fill("q33-inspect-agent");
  await page.getByRole("button", { name: "New", exact: true }).click();

  await expect(page.locator("[data-agent-skills]")).toContainText("fixture-skill");
  await expect(page.locator("[data-agent-skills]")).toContainText("Read-only");
  await expect(page.getByText("Native mode limits")).toBeVisible();

  await page.getByRole("tab", { name: "Extends a profile" }).click();
  await page.locator("[role=group]").filter({ hasText: "Base profile" }).getByRole("combobox").first().click();
  await page.getByRole("option", { name: /codex-writer/ }).click();
  const inherited = page.locator("[data-agent-inherited-controls]");
  await expect(inherited).toContainText("codex");
  await expect(inherited).toContainText("workspace-write");
  await expect(inherited).toContainText("standard");
  await expect(page.getByText("Adapter", { exact: true })).toBeVisible();
  await expect(page.getByText("Maximum budget", { exact: true })).toBeVisible();
  await expect(inherited).toContainText("Pool");
  await expect(page.getByText("CLI command", { exact: true })).toBeVisible();
  await page.screenshot({ path: "evidence/agent-designer.png", fullPage: true });
});
