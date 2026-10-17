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
  const setup = await page.evaluate(async () => {
    const skill = await fetch("/api/library/skills/fixture-skill", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Fixture skill", description: "UI publication fixture", content: "Report evidence." }),
    });
    const access = await fetch("/api/mcp/ui-review-tools/native-read-only", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profiles: { "nemotron-worker": ["inspect"] } }),
    });
    return { skill: skill.status, access: access.status, errors: [await skill.text(), await access.text()] };
  });
  expect(setup.skill, setup.errors[0]).toBe(200);
  expect(setup.access, setup.errors[1]).toBe(200);
  await page.getByRole("tab", { name: "Recipes" }).click();
  await page.getByLabel("New id").fill("ui-review-recipe");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Scoped review");
  await page.getByLabel("Purpose").fill("Review a user-provided diff and report evidence.");
  await page.getByLabel("Goals (one per line)", { exact: true }).fill("Inspect changed files\nReport concrete evidence");
  await page.getByLabel("Maximum budget in USD (optional)").fill("2.5");
  await page.getByLabel("Required capabilities (one per line)").fill("workspace.read\nmcp.call");
  await page.getByRole("button", { name: "Add skill" }).click();
  await page.getByLabel("Skill ID").fill("fixture-skill");
  await page.getByRole("button", { name: "Add tool" }).click();
  await page.getByLabel("Server ID").fill("ui-review-tools");
  await page.getByLabel("Tool name").fill("inspect");
  await page.getByRole("button", { name: "Add parameter" }).click();
  await page.locator("#recipe-param-name-0").fill("scope");
  await page.locator("#recipe-param-type-0").selectOption("string_list");
  await page.locator("#recipe-param-description-0").fill("Paths included in the review.");
  await page.getByLabel("Maximum items").fill("20");
  await page.getByLabel("Verifiable criterion").first().fill("The report includes evidence from changed files.");
  await page.getByRole("button", { name: "Add condition" }).click();
  await page.getByLabel("Verifiable criterion").nth(1).fill("The operator confirms the result.");
  await page.getByLabel("Checker").nth(1).selectOption("file");
  await page.getByLabel("File path").fill("review.md");
  await page.getByLabel("Assertion").selectOption("contains");
  await page.getByLabel("Required text").fill("Evidence:");
  await expect(page.getByText("Inspect changed files · Report concrete evidence")).toBeVisible();
  await expect(page.getByText("acceptance-2: The operator confirms the result.")).toBeVisible();
  const designedRecipe = JSON.parse(await page.locator("#library-doc").inputValue()) as Record<string, any>;
  expect(designedRecipe.requiredCapabilities).toEqual(["workspace.read", "mcp.call"]);
  expect(designedRecipe.requiredSkills).toEqual([{ id: "fixture-skill", required: true }]);
  expect(designedRecipe.requiredMcpServers).toEqual(["ui-review-tools"]);
  expect(designedRecipe.requiredMcpTools).toEqual([{ serverId: "ui-review-tools", toolName: "inspect" }]);
  expect(designedRecipe.parameters[0]).toMatchObject({ name: "scope", type: "string_list", maxItems: 20 });
  expect(designedRecipe.workflow.budget.usd).toBe(2.5);
  await page.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("server validator found no problems");
  await expect(page.getByRole("button", { name: "Publish saved digest" })).toHaveCount(0);
  await page.getByRole("button", { name: "Save / publish manually" }).click();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Publish saved digest" }).click();
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Withdraw from catalog" }).click();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  await page.getByLabel("Purpose").fill("A changed recipe must be saved before publication.");
  await expect(page.getByRole("button", { name: "Publish saved digest" })).toBeDisabled();
});
