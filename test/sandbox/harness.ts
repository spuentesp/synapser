// Plan 18 E6: the sandbox used by the tests of agent work. The root is read-only; the workspace is the only writable
// place; the network is disconnected; the process has a time limit. A directory listed in `hide` is covered by an empty
// tmpfs, so a secret placed there is invisible inside. Requires bubblewrap (bwrap), which is installed on this host.
import { spawnSync } from "node:child_process";

export interface SandboxOptions {
  workspace: string;
  hide?: string[];
  timeoutMs?: number;
}

export function sandboxArgv(opts: SandboxOptions, command: string[]): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", opts.workspace, opts.workspace, "--chdir", opts.workspace, "--unshare-net", "--die-with-parent"];
  for (const dir of opts.hide ?? []) args.push("--tmpfs", dir);
  return ["bwrap", ...args, "--", ...command];
}

export function runSandboxed(opts: SandboxOptions, command: string[]): { status: number | null; stdout: string; stderr: string; timedOut: boolean } {
  const [file, ...rest] = sandboxArgv(opts, command);
  const r = spawnSync("timeout", [`${Math.ceil((opts.timeoutMs ?? 20_000) / 1000)}s`, file!, ...rest], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.status === 124 };
}

export function bwrapAvailable(): boolean {
  return spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status === 0;
}
