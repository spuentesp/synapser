import { expect, test } from "@playwright/test";

test("library UI evaluates pasted holdout outputs and restores a prior skill digest", async ({ page }) => {
  await page.goto("/#library");
  await page.getByRole("tab", { name: "Skills" }).click();
  await page.getByLabel("New id").fill("ui-curated-skill");
  await page.getByRole("button", { name: "New", exact: true }).click();
  const original = { id: "ui-curated-skill", name: "UI curated", description: "original", content: "# Review\nName a concrete risk." };
  await page.locator("#library-doc").fill(JSON.stringify(original, null, 2));
  await page.getByRole("button", { name: "Save / publish manually" }).click();

  const cases = [{ id: "holdout-risk", split: "holdout", task: "Review the change", k: 2, expectedIncludes: "Risk:" }];
  const outputs = [{ caseId: "holdout-risk", repetition: 1, output: "Risk: missing bounds" }, { caseId: "holdout-risk", repetition: 2, output: "Risk: stale cache" }];
  await page.locator("#skill-cases").fill(JSON.stringify(cases));
  await page.locator("#skill-outputs").fill(JSON.stringify(outputs));
  await page.getByRole("button", { name: "Evaluate holdout" }).click();
  await expect(page.getByRole("status")).toContainText("All repetitions pass");

  await page.locator("#library-doc").fill(JSON.stringify({ ...original, description: "new candidate" }, null, 2));
  await page.getByRole("button", { name: "Save / publish manually" }).click();
  await page.getByLabel("Rollback reason").fill("restore reviewed digest");
  await page.getByRole("button", { name: "Restore digest" }).first().click();
  await expect(page.locator("#library-doc")).toContainText('"description": "original"');
  await expect(page.locator("#library-doc")).not.toContainText("new candidate");
});

test("recipe designer previews a bounded request and asks the server to validate it", async ({ page }) => {
  await page.goto("/#library");
  await page.getByRole("tab", { name: "Recipes" }).click();
  await page.getByLabel("New id").fill("ui-review-recipe");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Scoped review");
  await page.getByLabel("Purpose").fill("Review a user-provided diff and report evidence.");
  await page.getByLabel("Goals (one per line)").fill("Inspect changed files\nReport concrete evidence");
  await expect(page.getByText("Inspect changed files · Report concrete evidence")).toBeVisible();
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("server validator found no problems");
});
