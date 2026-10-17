import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export const AGENT_ADDRESS_SPACE_KIB = 2 * 1024 * 1024;
export const AGENT_TASKS_MAX = 64;
export const AGENT_MEMORY_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** Wrap a CLI in a per-run systemd scope; never fall back to an unbounded invocation. */
export function boundedAgentArgv(argv: readonly string[], unit = `synapser-agent-${randomUUID()}.scope`): string[] {
  if (argv.length === 0 || !argv[0]) throw new Error("agent command is empty");
  if (!/^synapser-agent-[0-9a-f-]+\.scope$/.test(unit)) throw new Error("invalid agent systemd scope name");
  return [
    "systemd-run", "--user", "--scope", "--quiet", `--unit=${unit}`,
    `--property=TasksMax=${AGENT_TASKS_MAX}`,
    "--property=MemoryAccounting=yes",
    `--property=MemoryMax=${AGENT_MEMORY_MAX_BYTES}`,
    "--property=KillMode=control-group",
    "--",
    "/bin/bash", "-c", `unset DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR; ulimit -v ${AGENT_ADDRESS_SPACE_KIB} || exit 125; exec "$@"`,
    "synapser-agent", ...argv,
  ];
}

function systemctl(args: string[], env: Readonly<Record<string, string>>): ReturnType<typeof spawnSync> {
  return spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], env: { ...env },
  });
}

function scopeState(unit: string, env: Readonly<Record<string, string>>): Record<string, string> | null {
  const result = systemctl(["show", unit, "--property=LoadState", "--property=ActiveState", "--property=ControlGroup"], env);
  if (result.error || result.status !== 0) return null;
  return Object.fromEntries(String(result.stdout).trim().split("\n").map((line) => {
    const index = line.indexOf("=");
    return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
  }));
}

/** Kill every process in the transient scope and prove systemd released its cgroup. */
export async function stopAgentScope(unit: string, env: Readonly<Record<string, string>>): Promise<boolean> {
  if (!/^synapser-agent-[0-9a-f-]+\.scope$/.test(unit)) return false;
  systemctl(["kill", "--kill-whom=all", "--signal=SIGKILL", unit], env);
  systemctl(["stop", unit], env);
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = scopeState(unit, env);
    if (state?.["LoadState"] === "not-found" || (state?.["ActiveState"] === "inactive" && state["ControlGroup"] === "")) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const state = scopeState(unit, env);
  return state?.["LoadState"] === "not-found" || (state?.["ActiveState"] === "inactive" && state["ControlGroup"] === "");
}
