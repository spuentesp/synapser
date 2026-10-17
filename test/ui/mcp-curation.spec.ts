import { expect, test } from "@playwright/test";

test("MCP curation discovers only the profile allowlist without exposing process configuration", async ({ page }) => {
  await page.goto("/#config");
  await expect(page.getByTestId("mcp-curation")).toBeVisible();
  const listing = await page.evaluate(async () => {
    const response = await fetch("/api/mcp");
    return { status: response.status, text: await response.text() };
  });
  expect(listing.status).toBe(200);
  expect(listing.text).toContain("ui-review-tools");
  expect(listing.text).not.toContain("node:");
  expect(listing.text).not.toContain("-e");

  const server = page.getByTestId("mcp-server-ui-review-tools");
  await expect(server).toContainText("ui-review-tools");
  await page.getByRole("button", { name: "Discover tools" }).click();
  const discovery = page.getByTestId("mcp-discovery-ui-review-tools");
  await expect(discovery).toContainText("ui-review-tools-fixture 1");
  await expect(discovery).toContainText("inspect");
  await expect(discovery).toContainText("Read-only review helper");
  await expect(discovery).not.toContainText("write");
  await expect(page.getByTestId("mcp-curation")).toContainText("Does not install, call tools, or enable agents.");
});
