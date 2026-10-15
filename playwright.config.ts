// Plan 18 E9: browser tests run against a real `synapser serve` with throwaway state. Not part of npm run verify (time).
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env["UI_PORT"] ?? 4199);

export default defineConfig({
  testDir: "test/ui",
  testMatch: /.*\.spec\.ts/,
  outputDir: "evidence/ui/results",
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    // The interface is built first, so the tests never run against a stale web/dist.
    command: "npm --prefix web run -s build && node test/ui/serve-fixture.ts",
    url: `http://127.0.0.1:${PORT}/api/session`,
    env: { UI_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
