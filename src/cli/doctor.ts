// `synapser doctor`: what is installed, what is usable, what to enable (plan 13 §7). Read-only: it probes
// and suggests; nothing is enabled or written without the operator.

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import type { AgentProfile } from "../agents/profile.ts";
import { BUILTIN_PROFILES } from "../agents/profile.ts";
import type { SynapserConfig } from "../config/load.ts";

export interface Probe {
  /** Resolve a program on PATH; null when absent. */
  which(cmd: string): Promise<string | null>;
  version(cmd: string, args: string[]): Promise<string | null>;
  env(name: string): boolean;
  nodeVersion(): string;
  exists(path: string): boolean;
  writable(dir: string): boolean;
}

const run = (cmd: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000, encoding: "utf8" }, (err, stdout, stderr) => resolve(err ? null : (stdout || stderr).trim().split("\n")[0]?.slice(0, 120) ?? ""));
  });

export const realProbe: Probe = {
  which: async (cmd) => {
    const out = await new Promise<string | null>((resolve) => execFile("sh", ["-c", `command -v ${cmd.replace(/[^A-Za-z0-9._-]/g, "")}`], { encoding: "utf8" }, (e, o) => resolve(e ? null : o.trim() || null)));
    return out;
  },
  version: (cmd, args) => run(cmd, args),
  env: (n) => Boolean(process.env[n] && process.env[n]!.trim()),
  nodeVersion: () => process.versions.node,
  exists: (p) => existsSync(p),
  writable: (d) => {
    try {
      mkdirSync(d, { recursive: true });
      accessSync(d, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface DoctorReport {
  ok: boolean;
  checks: Check[];
  agents: { id: string; tier: string; role: string; adapter: string; available: boolean; enabledInConfig: boolean; detail: string }[];
  suggestions: string[];
}

export async function doctor(cfg: SynapserConfig, probe: Probe = realProbe): Promise<DoctorReport> {
  const checks: Check[] = [];
  const major = Number(probe.nodeVersion().split(".")[0]);
  checks.push({ name: "node", ok: major >= 24, detail: `v${probe.nodeVersion()} (needs >= 24)` });
  for (const [cmd, args] of [["git", ["--version"]], ["python3", ["--version"]]] as const) {
    const p = await probe.which(cmd);
    checks.push({ name: cmd, ok: p !== null, detail: p ? `${p} — ${(await probe.version(cmd, [...args])) ?? "?"}` : "not found on PATH" });
  }
  const zoo = process.env["ZOANTHROPE_BIN"] ?? (await probe.which("zoanthrope"));
  checks.push({ name: "zoanthrope", ok: Boolean(zoo), detail: zoo ? `${zoo} — ${(await probe.version(zoo, ["--version"])) ?? "?"}` : "set ZOANTHROPE_BIN to the pinned binary" });
  checks.push({ name: "workspace", ok: probe.exists(cfg.workspace), detail: cfg.workspace });
  checks.push({ name: "state dir", ok: probe.writable(cfg.stateDir), detail: cfg.stateDir });
  const hasModelKey = ["NEBIUS_API_KEY", "NEBIUS_TOKEN", "NEMOTRON_TOKEN"].some((n) => probe.env(n));
  checks.push({ name: "model key (Nebius Token Factory)", ok: hasModelKey, detail: hasModelKey ? "set" : "none of NEBIUS_API_KEY / NEBIUS_TOKEN / NEMOTRON_TOKEN is set — Nemotron cannot plan or advise" });
  const hasSearch = ["TAVILY_API_KEY", "TAVILY_TOKEN"].some((n) => probe.env(n));
  checks.push({ name: "search key (Tavily)", ok: hasSearch, detail: hasSearch ? "set" : "not set — research and pushback are off (never simulated)" });
  checks.push({ name: "commands", ok: cfg.commands.length > 0, detail: cfg.commands.length ? cfg.commands.map((c) => c.id).join(", ") : "no allowlisted commands: `command` conditions cannot be used" });

  const agents: DoctorReport["agents"] = [];
  const all = new Map<string, AgentProfile>([...BUILTIN_PROFILES, ...cfg.profiles].map((p) => [p.id, p]));
  for (const p of all.values()) {
    const enabledInConfig = cfg.profiles.some((q) => q.id === p.id);
    if (p.endpoint) {
      const key = p.endpoint.apiKeyEnv.some((n) => probe.env(n));
      agents.push({ id: p.id, tier: p.tier ?? "standard", role: p.role, adapter: "native (endpoint)", available: key, enabledInConfig, detail: key ? `${p.endpoint.model} @ ${p.endpoint.baseUrl}` : `no key in ${p.endpoint.apiKeyEnv.join(" / ")}` });
    } else if ((p.adapter ?? "cli-oneshot") === "native") {
      agents.push({ id: p.id, tier: p.tier ?? "standard", role: p.role, adapter: "native", available: hasModelKey, enabledInConfig, detail: hasModelKey ? "Nemotron on Token Factory" : "needs a Nebius key" });
    } else {
      const prog = p.argv[0] ?? "";
      const path = await probe.which(prog);
      const ver = path ? await probe.version(prog, ["--version"]) : null;
      const usable = path !== null && p.enabled;
      agents.push({ id: p.id, tier: p.tier ?? "standard", role: p.role, adapter: "cli-oneshot", available: usable, enabledInConfig, detail: !p.enabled ? `disabled: ${p.disabledReason ?? "no reason recorded"}` : path ? `${path}${ver ? ` — ${ver}` : ""}` : `${prog}: not installed` });
    }
  }
  const suggestions: string[] = [];
  const missing = agents.filter((a) => a.available && !a.enabledInConfig).map((a) => a.id);
  if (missing.length) suggestions.push(`available but not enabled in your config: ${missing.join(", ")} — add them to "profiles" if you want them used`);
  const dead = agents.filter((a) => a.enabledInConfig && !a.available).map((a) => a.id);
  if (dead.length) suggestions.push(`enabled in your config but NOT usable here: ${dead.join(", ")}`);
  for (const t of ["cheap", "standard", "advanced"] as const) {
    if (!agents.some((a) => a.enabledInConfig && a.available && a.tier === t && a.role === "writer") && t !== "advanced") suggestions.push(`no usable ${t}-tier writer is enabled: tasks marked ${t} will use a higher tier`);
  }
  if (!agents.some((a) => a.enabledInConfig && a.available && a.role === "advisor")) suggestions.push("no usable advisor-role agent is enabled: `review` conditions and advise steps cannot run");
  // limitations, not faults: no search key (research is off, never simulated) and no allowlisted commands
  const advisory = new Set(["search key (Tavily)", "commands"]);
  return { ok: checks.every((c) => c.ok || advisory.has(c.name)), checks, agents, suggestions };
}
