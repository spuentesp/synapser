import { expect, test } from "@playwright/test";

test.skip(process.env["UI_NOTES_FIXTURE"] !== "1", "Run with playwright.notes.config.ts to use the deterministic notes fixture");

test("workflow details show advisor intervention and pending effect data without a decision control", async ({ page }) => {
  await page.goto("/#workflows");
  await page.getByRole("button", { name: /Workflow notes fixture/ }).click();

  await expect(page.getByText("Interventions")).toBeVisible();
  await expect(page.getByText("fixture review")).toBeVisible();
  await expect(page.getByText("human review requested")).toBeVisible();
  await expect(page.getByText("PROPOSED")).toBeVisible();
  await expect(page.getByText("Effects")).toBeVisible();
  await expect(page.getByText("http.request")).toBeVisible();
  await expect(page.getByText("PENDING")).toBeVisible();
  await expect(page.getByText("fixture-http-review")).toBeVisible();
  await expect(page.getByText("POST hooks.example.com/deploy")).toBeVisible();
  await expect(page.getByText("Read only: decisions are taken in Approvals.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve|Deny|Reject/ })).toHaveCount(0);
  await page.screenshot({ path: "evidence/workflow-notes-data.png", fullPage: true });
});
