import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env["UI_PORT"] ?? 4222);
// A fresh marker per run: the runner and the server both read it, and a stale file would fake an early effect.
process.env["UI_EFFECTS_MARK"] ??= join(tmpdir(), `synapser-ui-effects-${process.pid}-${Date.now()}`);
const MARK = process.env["UI_EFFECTS_MARK"];

export default defineConfig({
  testDir: "test/ui",
  testMatch: /effect-approval\.spec\.ts/,
  outputDir: "evidence/ui/effects-results",
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: "npm --prefix web run -s build && node test/ui/serve-effects-fixture.ts",
    url: `http://127.0.0.1:${PORT}/api/session`,
    env: { UI_PORT: String(PORT), UI_EFFECTS_FIXTURE: "1", UI_EFFECTS_MARK: MARK },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
