import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_MEMORY_MAX_BYTES } from "./limits.ts";

const BUSCTL = "/usr/bin/busctl";
const SYSTEMCTL = "/usr/bin/systemctl";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const UNIT_NAME = /^synapser-run-[0-9a-f]{32}\.slice$/;

function invoke(binary: string, args: string[], timeout = 5_000): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
  for (const key of ["HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG"] as const) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return spawnSync(binary, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"], env });
}

function properties(unit: string): Record<string, string> | null {
  const result = invoke(SYSTEMCTL, ["--user", "show", unit, "--property=LoadState", "--property=ActiveState", "--property=ControlGroup", "--property=MemoryMax", "--property=MemoryAccounting"]);
  if (result.error || result.status !== 0) return null;
  return Object.fromEntries(String(result.stdout).trim().split("\n").map((line) => {
    const index = line.indexOf("=");
    return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
  }));
}

function cgroupMemoryMax(controlGroup: string): string | null {
  if (!controlGroup.startsWith("/") || controlGroup.split("/").some((part) => part === "..")) return null;
  try { return readFileSync(join("/sys/fs/cgroup", controlGroup.slice(1), "memory.max"), "utf8").trim(); } catch { return null; }
}

/** One lazily-created parent cgroup shared by every CLI and MCP child in a workflow run. */
export class RunMemoryScope {
  // Hyphens have hierarchy semantics in systemd slice names. Keep the random id as one component so
  // every workflow creates only one transient leaf, instead of leaving a chain of random ancestors.
  readonly unit = `synapser-run-${randomUUID().replaceAll("-", "")}.slice`;
  readonly #memoryMaxBytes: number;
  #started = false;
  #closed = false;
  #starting: Promise<string> | null = null;
  #closing: Promise<void> | null = null;

  constructor(memoryMaxBytes = AGENT_MEMORY_MAX_BYTES) {
    if (!Number.isSafeInteger(memoryMaxBytes) || memoryMaxBytes < 16 * 1024 * 1024 || memoryMaxBytes > AGENT_MEMORY_MAX_BYTES) {
      throw new Error("workflow memory limit must be between 16 MiB and the configured agent maximum");
    }
    this.#memoryMaxBytes = memoryMaxBytes;
  }

  ensure(): Promise<string> {
    if (this.#closed) throw new Error("workflow memory scope is closed");
    if (this.#started) return Promise.resolve(this.unit);
    if (this.#starting) return this.#starting;
    this.#starting = this.#startOnce();
    return this.#starting;
  }

  async #startOnce(): Promise<string> {
    if (process.platform !== "linux" || !UNIT_NAME.test(this.unit) || ![BUSCTL, SYSTEMCTL, SYSTEMD_RUN].every((path) => {
      try { return spawnSync("/usr/bin/test", ["-x", path], { stdio: "ignore" }).status === 0; } catch { return false; }
    })) throw new Error("workflow process memory scope requires Linux systemd user manager and busctl");

    const result = invoke(BUSCTL, [
      "--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
      "StartTransientUnit", "ssa(sv)a(sa(sv))", this.unit, "replace", "2",
      "MemoryMax", "t", String(this.#memoryMaxBytes), "MemoryAccounting", "b", "true", "0",
    ]);
    if (result.error || result.status !== 0) throw new Error("workflow process memory scope could not be created");
    this.#started = true;
    const deadline = Date.now() + 2_000;
    let verified = false;
    do {
      const props = properties(this.unit);
      const controlGroup = props?.["ControlGroup"];
      verified = props?.["LoadState"] === "loaded" && props["ActiveState"] === "active" && Boolean(controlGroup) &&
        Number(props["MemoryMax"]) === this.#memoryMaxBytes && props["MemoryAccounting"] === "yes" &&
        cgroupMemoryMax(controlGroup!) === String(this.#memoryMaxBytes);
      if (verified || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (true);
    if (!verified) {
      this.#closed = true;
      invoke(SYSTEMCTL, ["--user", "stop", this.unit]);
      this.#started = false;
      throw new Error("workflow process memory scope limits could not be verified");
    }
    return this.unit;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.#closed && !this.#started) return Promise.resolve();
    this.#closed = true;
    this.#closing = this.#closeStarted();
    return this.#closing;
  }

  async #closeStarted(): Promise<void> {
    if (this.#starting) await this.#starting.catch(() => undefined);
    if (!this.#started) return;
    // The unit name is generated here, never accepted from a request. Killing the private parent cgroup also
    // catches a child scope whose runner returned before systemd finished reaping its descendants.
    invoke(SYSTEMCTL, ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", this.unit]);
    const stopped = invoke(SYSTEMCTL, ["--user", "stop", this.unit]);
    if (stopped.error || stopped.status !== 0) throw new Error("workflow process memory scope could not be stopped");
    const final = properties(this.unit);
    if (!(final?.["LoadState"] === "not-found" || (final?.["ActiveState"] === "inactive" && final["ControlGroup"] === ""))) {
      throw new Error("workflow process memory scope cleanup could not be confirmed");
    }
  }
}
