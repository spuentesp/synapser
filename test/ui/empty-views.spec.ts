import { expect, test } from "@playwright/test";

const EMPTY_VIEWS = ["swarm", "timeline", "why", "cost", "coordination", "approvals", "integrity"] as const;

test("each run view explains the empty state and opens the workflow designer from its CTA", async ({ page }) => {
  await page.route("**/api/runs", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [] }) });
  });

  for (const view of EMPTY_VIEWS) {
    await page.goto(`/#${view}`);
    await expect(page.getByText("No runs yet. Create a workflow and start it: its run will appear here.")).toBeVisible();
    await page.getByRole("button", { name: "Create a workflow" }).click();
    await expect(page.getByLabel("Title")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.goto("/#home");
    await page.getByRole("button", { name: "Workflows" }).click();
    await expect(page.getByRole("button", { name: "New workflow" })).toBeVisible();
    await expect(page.getByLabel("Title")).toHaveCount(0);
  }
});
