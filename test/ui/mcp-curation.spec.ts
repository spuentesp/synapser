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
  await expect(editor.getByRole("status")).toContainText("Configuration saved.");
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

  const nativeAccess = server.getByTestId("mcp-native-access-ui-review-tools");
  await expect(nativeAccess).toBeVisible();
  const nativeProfile = nativeAccess.getByLabel("Native writer profile ui-review-tools");
  await expect(nativeProfile.locator("option")).toHaveCount(1);
  await expect(nativeProfile.locator("option").first()).toHaveValue("nemotron-worker");
  await nativeAccess.getByRole("button", { name: "Discover native tools" }).click();
  await expect(nativeAccess.getByLabel("inspect")).toBeVisible();
  await nativeAccess.getByLabel("inspect").check();
  await nativeAccess.getByRole("button", { name: "Save selection" }).click();
  await expect(nativeAccess.getByRole("status")).toContainText("Configuration saved.");
  const nativeRegistration = await page.evaluate(async () => {
    const response = await fetch("/api/config/mcpServers");
    const body = await response.json() as { servers: { nativeReadOnlyProfiles?: Record<string, string[]> }[] };
    return body.servers[0];
  });
  expect(nativeRegistration?.nativeReadOnlyProfiles).toEqual({ "nemotron-worker": ["inspect"] });

  // The legacy full-entry editor must preserve an opt-in it was not loaded with.
  await editor.locator('input[type="checkbox"]').uncheck();
  await editor.getByRole("button", { name: "Save registration" }).click();
  await expect(editor.getByRole("status")).toContainText("Configuration saved.");
  await editor.locator('input[type="checkbox"]').check();
  await editor.getByRole("button", { name: "Save registration" }).click();
  await expect(server.getByRole("button", { name: "Discover tools" })).toBeEnabled();
  const preserved = await page.evaluate(async () => {
    const response = await fetch("/api/config/mcpServers");
    const body = await response.json() as { servers: { nativeReadOnlyProfiles?: Record<string, string[]> }[] };
    return body.servers[0];
  });
  expect(preserved?.nativeReadOnlyProfiles).toEqual({ "nemotron-worker": ["inspect"] });

  await page.getByRole("button", { name: "Discover tools" }).click();
  const discovery = page.getByTestId("mcp-discovery-ui-review-tools");
  await expect(discovery).toContainText("ui-review-tools-fixture 1");
  await expect(discovery).toContainText("inspect");
  await expect(discovery).toContainText("Read-only review helper");
  await expect(discovery).not.toContainText("write");
  await expect(page.getByTestId("mcp-curation")).toContainText("agent access is configured separately");
  await discovery.getByText("inspect", { exact: true }).click();
  const args = discovery.getByLabel("Test JSON arguments inspect");
  await args.fill('{"path":"src/example.ts"}');
  page.once("dialog", (dialog) => dialog.dismiss());
  await discovery.getByRole("button", { name: "Test call" }).click();
  await expect(discovery.getByRole("status")).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await discovery.getByRole("button", { name: "Test call" }).click();
  await expect(discovery.getByRole("status")).toContainText("inspected:src/example.ts");
  await expect(discovery).toContainText("does not itself enable agent access");
});
