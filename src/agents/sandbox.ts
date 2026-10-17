import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const BWRAP = "/usr/bin/bwrap";
const SANDBOX_ROOT = "/opt/synapser";

function inside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolveExecutable(program: string, pathValue: string | undefined): string {
  const candidates = isAbsolute(program)
    ? [program]
    : (pathValue ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter(Boolean).map((directory) => join(directory, program));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("agent executable was not found in the operator PATH");
  try {
    return realpathSync(found);
  } catch {
    throw new Error("agent executable path could not be canonicalized");
  }
}

/**
 * Wrap an already-built CLI invocation in the filesystem boundary used by runAgent. The host root is
 * read-only; operator HOME, runtime sockets, temporary files and the original checkout are masked.
 * Only the run's work copy and scratch HOME are writable. Network isolation is deliberately omitted:
 * plan 17 K7 records the operator's decision to keep CLI egress open.
 */
export function sandboxAgentArgv(
  argv: readonly string[],
  options: { workspaceRoot: string; work: string; home: string; scratch: string; env: Readonly<Record<string, string>> },
): string[] {
  if (process.platform !== "linux") throw new Error("agent filesystem sandbox requires Linux bubblewrap");
  if (argv.length === 0 || typeof argv[0] !== "string" || !argv[0]) throw new Error("agent command is empty");
  if (!existsSync(BWRAP)) throw new Error("agent filesystem sandbox requires /usr/bin/bwrap");

  const workspaceRoot = realpathSync(options.workspaceRoot);
  const work = realpathSync(options.work);
  const home = realpathSync(options.home);
  const scratch = realpathSync(options.scratch);
  if ([workspaceRoot, work, home, scratch].some((path) => path === "/")) throw new Error("agent sandbox paths must not be filesystem roots");
  if (!inside(scratch, work) || !inside(scratch, home) || work === home) throw new Error("agent work and HOME must be separate paths inside its scratch directory");
  if (inside(workspaceRoot, scratch) || inside(scratch, workspaceRoot)) throw new Error("agent scratch and source workspace must not overlap");

  const hostProgram = resolveExecutable(argv[0], options.env["PATH"]);
  const isNodeProgram = basename(hostProgram) === "node" || basename(hostProgram).startsWith("node-");
  const mappedBin = join(SANDBOX_ROOT, "bin");
  let mappedProgram = join(mappedBin, basename(hostProgram));
  const node = realpathSync(process.execPath);
  const mappedNode = join(SANDBOX_ROOT, "runtime", "node");
  const toolMounts: string[] = ["--dir", SANDBOX_ROOT, "--dir", mappedBin, "--dir", join(SANDBOX_ROOT, "runtime")];
  const isJsProgram = hostProgram.endsWith(".js") || hostProgram.endsWith(".mjs") || hostProgram.endsWith(".cjs");
  if (isJsProgram) {
    // A JS CLI needs its containing package files as well as its entry point. Expose that package read-only.
    let packageRoot = dirname(hostProgram);
    while (packageRoot !== dirname(packageRoot) && !existsSync(join(packageRoot, "package.json"))) packageRoot = dirname(packageRoot);
    if (!existsSync(join(packageRoot, "package.json"))) throw new Error("JavaScript agent executable has no containing package manifest");
    const mappedPackage = join(SANDBOX_ROOT, "packages", basename(packageRoot));
    toolMounts.push("--dir", join(SANDBOX_ROOT, "packages"), "--ro-bind", packageRoot, mappedPackage);
    mappedProgram = join(mappedPackage, relative(packageRoot, hostProgram));
  } else {
    toolMounts.push("--ro-bind", hostProgram, mappedProgram);
  }
  toolMounts.push("--ro-bind", node, mappedNode);

  const scratchName = basename(scratch);
  const sandboxScratch = join(SANDBOX_ROOT, "session", scratchName);
  const sandboxWork = join(sandboxScratch, "work");
  const sandboxHome = join(sandboxScratch, "home");
  const sandboxArgv = [...argv];
  sandboxArgv[0] = mappedProgram;
  const extraMounts: string[] = [];
  let extraFileIndex = 0;
  const mapPath = (arg: string, index: number): string => {
    if (!isAbsolute(arg)) return arg;
    if (inside(work, arg)) return join(sandboxWork, relative(work, arg));
    if (inside(home, arg)) return join(sandboxHome, relative(home, arg));
    if (inside(workspaceRoot, arg)) return join(sandboxWork, relative(workspaceRoot, arg));
    // Absolute script arguments (for example `node /tmp/fixture.mjs`) need an explicit,
    // read-only mount because the host's /tmp is masked. Never expose arbitrary directories.
    if (isNodeProgram && index === 0 && existsSync(arg)) {
      try {
        const canonical = realpathSync(arg);
        if (canonical !== "/" && !inside(scratch, canonical) && !inside(workspaceRoot, canonical)) {
          const mapped = join(SANDBOX_ROOT, "args", String(extraFileIndex++));
          extraMounts.push("--ro-bind", canonical, mapped);
          return mapped;
        }
      } catch {
        /* leave unresolved arguments unchanged; the CLI will report its own error */
      }
    }
    return arg;
  };
  const mappedArgs = sandboxArgv.slice(1).map((arg, index) => mapPath(arg, index));

  const childEnv = { ...options.env };
  childEnv["HOME"] = sandboxHome;
  childEnv["TMPDIR"] = "/tmp";
  childEnv["PATH"] = `${mappedBin}:${join(SANDBOX_ROOT, "runtime")}:${childEnv["PATH"] ?? ""}:/usr/local/bin:/usr/bin:/bin`;
  childEnv["XDG_CONFIG_HOME"] = join(sandboxHome, ".config");
  childEnv["XDG_DATA_HOME"] = join(sandboxHome, ".local/share");
  childEnv["XDG_CACHE_HOME"] = join(sandboxHome, ".cache");
  childEnv["XDG_STATE_HOME"] = join(sandboxHome, ".local/state");
  if (childEnv["CODEX_HOME"]) childEnv["CODEX_HOME"] = join(sandboxHome, ".codex");

  const args = [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/", "/",
    "--tmpfs", "/opt",
    ...toolMounts,
    "--dir", join(SANDBOX_ROOT, "session"), "--dir", sandboxScratch,
    "--bind", work, sandboxWork, "--bind", home, sandboxHome,
    ...(extraMounts.length ? ["--dir", join(SANDBOX_ROOT, "args"), ...extraMounts] : []),
    "--dev", "/dev", "--proc", "/proc",
    "--tmpfs", "/home", "--tmpfs", "/root", "--tmpfs", "/run", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp",
  ];
  if (!["/home", "/root", "/run", "/tmp", "/var/tmp", "/opt"].some((root) => inside(root, workspaceRoot))) args.push("--tmpfs", workspaceRoot);
  args.push("--chdir", sandboxWork, "--clearenv");
  for (const [key, value] of Object.entries(childEnv)) args.push("--setenv", key, value);
  args.push("--", mappedProgram, ...mappedArgs);
  return [BWRAP, ...args];
}
