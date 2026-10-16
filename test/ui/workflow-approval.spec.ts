import { expect, test } from "@playwright/test";

// Plan 18 H9.3: create a workflow through the designer, observe it in the UI, approve its human
// acceptance gate through the UI, then observe the terminal result. The real Synapser server is
// backed only by the local deterministic model and CLI fixtures (no paid provider is involved).
test("a workflow can be created, approved by a human, and observed complete", async ({ page }) => {
  await page.goto("/#workflows");
  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByLabel("Title").fill("Human review workflow");
  await page.getByLabel("Description").fill("Change the README after a human review.");
  await page.getByLabel("Goals (one per line)").fill("The README changes after approval");
  await page.getByLabel("Statement").fill("The README changes");
  await page.getByLabel("Must change (paths, one per line)").fill("README.md");
  await expect(page.getByText("Ready to save: the server validator found no problems.")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByRole("button", { name: /Human review workflow/ })).toBeVisible();
  await expect(page.getByText("Human review workflow").first()).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();
  await page.getByRole("button", { name: /Approvals/ }).click();
  await expect(page.getByText("fixture-check")).toBeVisible();
  await expect(page.getByText("Run the deterministic fixture agent before human review.")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Recorded on the ledger")).toBeVisible();

  await page.getByRole("button", { name: "Workflows" }).click();
  await expect(page.getByText("DONE", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("The README changes").last()).toBeVisible();
  await expect(page.getByText("SATISFIED", { exact: true })).toBeVisible();
});
