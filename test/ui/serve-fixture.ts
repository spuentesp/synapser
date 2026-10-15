// Plan 18 E9 (H9.1): starts `synapser serve` on a port chosen by the test run, with a throwaway workspace and state.
// Playwright starts it as its web server and stops it when the run ends; the child is stopped with the parent.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ui-fixture-"));
writeFileSync(join(dir, "synapser.config.json"), JSON.stringify({ workspace: dir, stateDir: join(dir, "state") }));
const port = process.env["UI_PORT"] ?? "4199";
const cli = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const child = spawn(process.execPath, [cli, "serve", "--port", port], { cwd: dir, stdio: "inherit" });
const stop = () => child.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => process.exit(code ?? 0));
