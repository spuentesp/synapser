import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EMPTY_VIEWS = ["swarm", "timeline", "why", "cost", "coordination", "approvals", "integrity"] as const;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a local port");
  const { port } = address;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fresh Synapser server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/runs`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("fresh Synapser server did not become ready within 15 seconds");
}

test("each run view explains the real empty state and opens the workflow designer from its CTA", async ({ page }) => {
  const workspace = mkdtempSync(join(tmpdir(), "ui-empty-state-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  writeFileSync(join(workspace, "synapser.config.json"), JSON.stringify({
    workspace,
    stateDir: join(workspace, "state"),
    research: false,
  }));
  const cli = new URL("../../src/cli/main.ts", import.meta.url).pathname;
  const child = spawn(process.execPath, [cli, "serve", "--port", String(port)], {
    cwd: workspace,
    env: { ...process.env, UI_PORT: String(port) },
    stdio: "ignore",
  });
  const exited = once(child, "exit");

  try {
    await waitForServer(baseUrl, child);
    await page.goto(baseUrl);
    const response = await page.evaluate(async () => {
      const result = await fetch("/api/runs");
      return { status: result.status, body: await result.json() as { runs?: unknown[] } };
    });
    expect(response.status).toBe(200);
    expect(response.body.runs).toEqual([]);

    for (const view of EMPTY_VIEWS) {
      await page.goto(`${baseUrl}/#${view}`);
      await expect(page.getByText("No runs yet. Create a workflow and start it: its run will appear here.")).toBeVisible();
      await page.getByRole("button", { name: "Create a workflow" }).click();
      await expect(page.getByLabel("Title")).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.goto(`${baseUrl}/#home`);
      await page.getByRole("button", { name: "Workflows" }).click();
      await expect(page.getByRole("button", { name: "New workflow" })).toBeVisible();
      await expect(page.getByLabel("Title")).toHaveCount(0);
    }
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(workspace, { recursive: true, force: true });
  }
});
