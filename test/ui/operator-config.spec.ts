import { expect, test } from "@playwright/test";

const SECRET = "sentinel-ui-p17-secret-never-return";
const PROVIDER = "ui-p17-provider";

test("operator settings edit provider and role through the same-origin API without exposing key values", async ({ page }) => {
  await page.goto("/#config");
  await expect(page.getByRole("heading", { name: "Operator settings" })).toBeVisible();
  await expect(page.getByTestId("operator-config")).toBeVisible();

  const initial = await page.evaluate(async () => {
    const response = await fetch("/api/config");
    return { status: response.status, body: await response.text() };
  });
  expect(initial.status).toBe(200);
  expect(initial.body).not.toContain(SECRET);

  await page.getByRole("button", { name: "New provider" }).click();
  await page.getByLabel("Provider ID").fill(PROVIDER);
  await page.getByLabel("Base URL").fill("https://api.example.invalid/v1/");
  await page.getByLabel("Key variables (one per line)").fill("UI_P17_KEY");
  await page.getByLabel("Models (one per line)", { exact: true }).fill("fixture-model");
  await page.getByRole("button", { name: "Save changes" }).first().click();
  await expect(page.getByRole("status")).toHaveText("Configuration saved and applied.");

  const written = await page.evaluate(async () => {
    const response = await fetch("/api/config");
    const body = await response.text();
    return { status: response.status, body, config: JSON.parse(body) as { providers: Record<string, { apiKeyEnv: string[] }> } };
  });
  expect(written.status).toBe(200);
  expect(written.body).not.toContain(SECRET);
  expect(written.config.providers[PROVIDER]?.apiKeyEnv).toEqual(["UI_P17_KEY"]);

  await page.getByLabel("Role", { exact: true }).selectOption("worker");
  await page.getByLabel("Providers Role").selectOption(PROVIDER);
  await page.getByLabel("Model", { exact: true }).selectOption("fixture-model");
  await page.getByRole("button", { name: "Save changes" }).last().click();
  await expect(page.getByRole("status")).toHaveText("Configuration saved and applied.");

  const assigned = await page.evaluate(async () => await (await fetch("/api/config")).json() as { roles: Record<string, { provider: string; model: string }> });
  expect(assigned.roles.worker).toMatchObject({ provider: PROVIDER, model: "fixture-model" });

  await page.getByRole("button", { name: PROVIDER, exact: true }).click();
  await page.getByLabel("Base URL").fill("http://169.254.169.254/");
  await page.getByRole("button", { name: "Save changes" }).first().click();
  await expect(page.getByText(/cloud metadata address/)).toBeVisible();
  await expect(page.locator("body")).not.toContainText(SECRET);
});
