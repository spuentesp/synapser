import { expect, test } from "@playwright/test";

// Plan 14 Q3.2: applying each built-in template must transfer its parameters into the exact workflow document preview.
const templates = [
  {
    name: "Bounded change with tests",
    params: { Title: "Bounded change", "Scope (paths, one per line)": "src/one.ts\nsrc/two.ts", "Allowlisted command": "test:unit" },
    expected: {
      title: "Bounded change",
      description: "Change only the files in scope and prove the change with the allowlisted check test:unit.",
      goals: ["The change is made inside the declared scope and its check passes"],
      nonGoals: [{ statement: "Touch files outside the declared scope" }],
      conditions: [
        { id: "in-scope", statement: "The declared files changed", required: true, checker: { kind: "diff", require: ["src/one.ts", "src/two.ts"] } },
        { id: "checks-pass", statement: "The allowlisted check passes", required: true, checker: { kind: "command", commandId: "test:unit" } },
      ],
    },
  },
  {
    name: "Research with citations",
    params: { Title: "Cited research", "Question or topic": "How does caching work?", "Output file": "docs/cache.md", "Minimum citations": "3" },
    expected: {
      title: "Cited research",
      description: "Research How does caching work? and write the findings to docs/cache.md, citing only sources retrieved in this run.",
      goals: ["How does caching work?"],
      nonGoals: [{ statement: "Cite a source that was not retrieved in this run" }],
      conditions: [{ id: "cited", statement: "The document cites enough retrieved sources", required: true, checker: { kind: "citations", file: "docs/cache.md", min: 3 } }],
    },
  },
  {
    name: "Review",
    params: { Title: "Review API", "Files to review (paths, one per line)": "src/api.ts\nsrc/types.ts", "Reviewer profile": "reviewer", Rubric: "Check compatibility and error handling." },
    expected: {
      title: "Review API",
      description: "A reviewer judges the files against the rubric. The reviewed files must not change in this run.",
      goals: ["A reviewer has judged the files against the rubric"],
      nonGoals: [{ statement: "Change the reviewed files", guard: { kind: "diff", forbid: ["src/api.ts", "src/types.ts"] } }],
      conditions: [
        { id: "judged", statement: "A reviewer judged the files", required: false, checker: { kind: "review", profile: "reviewer", rubric: "Check compatibility and error handling." } },
        { id: "unchanged", statement: "The reviewed files are unchanged", required: true, checker: { kind: "diff", forbid: ["src/api.ts", "src/types.ts"] } },
      ],
    },
  },
  {
    name: "Migration with non-goals",
    params: { Title: "Move cache module", "Current path": "src/cache.ts", "New path": "src/cache/index.ts", "Public API (paths that must not change)": "src/public.ts\nsrc/types.ts" },
    expected: {
      title: "Move cache module",
      description: "Move src/cache.ts to src/cache/index.ts without changing the public surface listed in the non-goals.",
      goals: ["src/cache.ts now lives at src/cache/index.ts"],
      nonGoals: [{ statement: "Change the public API", guard: { kind: "diff", forbid: ["src/public.ts", "src/types.ts"] } }],
      conditions: [
        { id: "new-place", statement: "The new location exists", required: true, checker: { kind: "file", path: "src/cache/index.ts", assert: "exists" } },
        { id: "old-gone", statement: "The old location is gone", required: true, checker: { kind: "file", path: "src/cache.ts", assert: "absent" } },
      ],
    },
  },
] as const;

for (const template of templates) {
  test(`applying the ${template.name.toLowerCase()} workflow template fills its parameters`, async ({ page }) => {
    await page.goto("/#workflows");
    await page.getByRole("button", { name: "New workflow" }).click();

    const templatePanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Template" }) });
    await templatePanel.getByRole("combobox").click();
    await page.getByRole("option", { name: template.name, exact: true }).click();
    for (const [label, value] of Object.entries(template.params)) {
      await templatePanel.getByLabel(label, { exact: true }).fill(value);
    }
    await templatePanel.getByRole("button", { name: "Use template" }).click();

    const preview = await page.locator("#wf-preview").inputValue();
    expect(JSON.parse(preview)).toEqual(template.expected);
  });
}
