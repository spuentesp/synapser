import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const ROOT = resolve(import.meta.dirname, "../..");
const ZOO = process.env["ZOANTHROPE_BIN"];

test("offline integrated demo: browser approval, mission, and tamper-evident export", { skip: !ZOO, timeout: 90_000 }, async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "synapser-c3-"));
  const child = spawn(process.execPath, ["scripts/demo.ts", "--port", "0"], {
    cwd: ROOT,
    env: {
      PATH: process.env["PATH"] ?? "",
      ...(process.env["HOME"] ? { HOME: process.env["HOME"] } : {}),
      ZOANTHROPE_BIN: ZOO,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const serverUrl = await new Promise<string>((resolveUrl, reject) => {
      const deadline = setTimeout(() => reject(new Error(`demo did not start: ${stdout}\n${stderr}`)), 15_000);
      const read = () => {
        const match = /Synapser UI\s+→\s+(http:\/\/127\.0\.0\.1:\d+\/#swarm)/.exec(stdout);
        if (match?.[1]) {
          clearTimeout(deadline);
          resolveUrl(match[1]);
        }
      };
      child.stdout.on("data", read);
      child.once("exit", (code) => {
        clearTimeout(deadline);
        reject(new Error(`demo exited before it printed its URL (exit ${code}): ${stdout}\n${stderr}`));
      });
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    const url = new URL(serverUrl);
    url.searchParams.set("lang", "en");
    await page.goto(url.toString(), { waitUntil: "networkidle" });
    await page.getByText("scripted-worker", { exact: false }).first().waitFor({ timeout: 15_000 });
    assert.match(await page.locator("body").innerText(), /RUNNING|DONE/);

    await page.getByRole("button", { name: /Approvals/ }).click();
    const gate = page.getByTestId("gate").filter({ hasText: "Document the discount parameter in the README" });
    await gate.waitFor({ timeout: 55_000 });
    await page.getByLabel("Your name").fill("c3-test-operator");
    await gate.getByRole("button", { name: "Approve" }).click();
    await page.getByText("No pending gates.").waitFor({ timeout: 10_000 });

    const apiBase = new URL(serverUrl).origin;
    let state: { mission: { state: string }; pendingApprovals: string[]; atSeq: number; agents: { profile: string | null }[] } | undefined;
    const missionDeadline = Date.now() + 25_000;
    while (Date.now() < missionDeadline) {
      const response = await page.request.get(`${apiBase}/api/runs/demo-billing/state`);
      state = await response.json();
      if (state?.mission.state === "DONE") break;
      await page.waitForTimeout(200);
    }
    assert.equal(state?.mission.state, "DONE");
    assert.deepEqual(state?.pendingApprovals, []);
    const profiles = state?.agents.map((agent) => agent.profile).filter((profile): profile is string => profile !== null) ?? [];
    assert.ok(profiles.includes("scripted-advisor"));
    assert.ok(profiles.includes("scripted-worker"));
    assert.ok(profiles.every((profile) => !/nemotron|claude/i.test(profile)));
    const verified = await (await page.request.get(`${apiBase}/api/runs/demo-billing/verify`)).json() as { ok: boolean };
    assert.equal(verified.ok, true);

    const exported = await (await page.request.get(`${apiBase}/api/runs/demo-billing/export`)).json() as { events: { entity: string; entityId: string; toState: string | null; dataJson: string }[] };
    const approval = exported.events.find((event) => event.entity === "approval" && event.entityId === "docs" && event.toState === "APPROVED");
    assert.ok(approval);
    const approvalData = JSON.parse(approval.dataJson) as { actor: string; channel: string; plan_digest: string };
    assert.equal(approvalData.actor, "c3-test-operator");
    assert.equal(approvalData.channel, "ui");
    assert.match(approvalData.plan_digest, /^sha256:/);
    const validPath = join(outputDir, "demo.ledger.json");
    const alteredPath = join(outputDir, "demo-altered.ledger.json");
    writeFileSync(validPath, JSON.stringify(exported));
    const valid = spawnSync(process.execPath, ["scripts/verify-export.ts", validPath], { cwd: ROOT, encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    const altered = structuredClone(exported);
    const changed = altered.events[Math.floor(altered.events.length / 2)];
    assert.ok(changed);
    changed.dataJson += " ";
    writeFileSync(alteredPath, JSON.stringify(altered));
    const rejected = spawnSync(process.execPath, ["scripts/verify-export.ts", alteredPath], { cwd: ROOT, encoding: "utf8" });
    assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
    assert.match(rejected.stdout, /hash does not match/);

    const integrityUrl = new URL(apiBase);
    integrityUrl.searchParams.set("lang", "en");
    integrityUrl.hash = "integrity";
    await page.goto(integrityUrl.toString(), { waitUntil: "networkidle" });
    await page.getByRole("alert").getByText("Chain verified").waitFor();
    assert.deepEqual(consoleErrors, []);
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGINT");
      await new Promise<void>((done) => child.once("exit", () => done()));
    }
    rmSync(outputDir, { recursive: true, force: true });
  }
});
