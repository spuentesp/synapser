import { randomUUID } from "node:crypto";

export const AGENT_ADDRESS_SPACE_KIB = 2 * 1024 * 1024;
export const AGENT_TASKS_MAX = 64;
export const AGENT_MEMORY_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** Wrap a CLI in a per-run systemd scope; never fall back to an unbounded invocation. */
export function boundedAgentArgv(argv: readonly string[]): string[] {
  if (argv.length === 0 || !argv[0]) throw new Error("agent command is empty");
  const unit = `synapser-agent-${randomUUID()}.scope`;
  return [
    "systemd-run", "--user", "--scope", "--quiet", `--unit=${unit}`,
    `--property=TasksMax=${AGENT_TASKS_MAX}`,
    "--property=MemoryAccounting=yes",
    `--property=MemoryMax=${AGENT_MEMORY_MAX_BYTES}`,
    "--",
    "/bin/bash", "-c", `unset DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR; ulimit -v ${AGENT_ADDRESS_SPACE_KIB} || exit 125; exec "$@"`,
    "synapser-agent", ...argv,
  ];
}
