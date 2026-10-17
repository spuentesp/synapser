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
  await expect(server).toContainText("artifact pinned");
  const editor = page.getByTestId("mcp-registration-editor");
  await expect(editor).toBeVisible();
  const editable = await page.evaluate(async () => {
    const response = await fetch("/api/config/mcpServers");
    return { status: response.status, text: await response.text() };
  });
  expect(editable.status).toBe(200);
  expect(editable.text).toContain("server.cjs");
  await editor.getByLabel("MCP registration").selectOption("ui-review-tools");
  await expect(editor.getByLabel("Host runtime (absolute path)")).toHaveValue(process.execPath);
  await editor.locator('input[type="checkbox"]').uncheck();
  await editor.getByRole("button", { name: "Save registration" }).click();
  await expect(editor.getByRole("status")).toContainText("Registration saved.");
  await expect(server.getByRole("button", { name: "Discover tools" })).toBeDisabled();
  const savedRegistration = await page.evaluate(async () => {
    const response = await fetch("/api/config/mcpServers");
    const body = await response.json() as { servers: { enabled: boolean }[] };
    return body.servers[0];
  });
  expect(savedRegistration?.enabled).toBe(false);
  await editor.locator('input[type="checkbox"]').check();
  await editor.getByRole("button", { name: "Save registration" }).click();
  await expect(server.getByRole("button", { name: "Discover tools" })).toBeEnabled();
  await page.getByRole("button", { name: "Discover tools" }).click();
  const discovery = page.getByTestId("mcp-discovery-ui-review-tools");
  await expect(discovery).toContainText("ui-review-tools-fixture 1");
  await expect(discovery).toContainText("inspect");
  await expect(discovery).toContainText("Read-only review helper");
  await expect(discovery).not.toContainText("write");
  await expect(page.getByTestId("mcp-curation")).toContainText("Does not install, call tools, or enable agents.");
});
