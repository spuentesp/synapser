import { expect, test } from "@playwright/test";

test("agent trial sends the operator task and shows its run report", async ({ page }) => {
  let request: { task?: string; timeLimitSeconds?: number; maxBudgetUsd?: number } | null = null;
  await page.route("**/api/agents/*/trial", async (route) => {
    request = route.request().postDataJSON() as typeof request;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "SUCCEEDED",
        output: "The disposable workspace is ready.",
        costUsd: 0.000123,
        durationMs: 1250,
        skills: [{ id: "test-skill", digest: "sha256:1234567890abcdef", mechanism: "prompt-prepend" }],
        changedPaths: [],
        reason: null,
        networkIsolated: false,
      }),
    });
  });

  await page.goto("/#agents");
  const row = page.locator("tbody tr", { hasText: "nemotron-worker" });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Try agent" }).click();
  await expect(page.locator('[data-agent-trial="nemotron-worker"]')).toBeVisible();
  await expect(page.locator('[data-network-warning="native"]')).toBeVisible();
  await page.getByLabel("One-line task").fill("Return a short readiness status.");
  await page.getByRole("button", { name: "Run trial" }).click();

  await expect(page.locator("[data-trial-result]")).toBeVisible();
  await expect(page.locator("[data-trial-result]")).toContainText("The disposable workspace is ready.");
  await expect(page.locator("[data-trial-result]")).toContainText("test-skill");
  await expect(page.locator("[data-trial-result]")).toContainText("$0.000123 USD");
  expect(request).toEqual({ task: "Return a short readiness status.", timeLimitSeconds: 30 });
  await page.screenshot({ path: "evidence/agent-trial.png", fullPage: true });
});
