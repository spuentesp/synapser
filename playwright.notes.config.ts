import { defineConfig } from "@playwright/test";

const PORT = Number(process.env["UI_PORT"] ?? 4221);

export default defineConfig({
  testDir: "test/ui",
  testMatch: /workflow-notes-data\.spec\.ts/,
  outputDir: "evidence/ui/notes-results",
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: "npm --prefix web run -s build && node test/ui/serve-notes-fixture.ts",
    url: `http://127.0.0.1:${PORT}/api/session`,
    env: { UI_PORT: String(PORT), UI_NOTES_FIXTURE: "1" },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
