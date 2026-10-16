import { defineConfig } from "@playwright/test";

const PORT = Number(process.env["UI_PORT"] ?? 4231);

export default defineConfig({
  testDir: "test/ui",
  testMatch: /workflow-approval\.spec\.ts/,
  outputDir: "evidence/ui/workflow-results",
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: "npm --prefix web run -s build && node test/ui/serve-workflow-fixture.ts",
    url: `http://127.0.0.1:${PORT}/api/session`,
    env: { UI_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
