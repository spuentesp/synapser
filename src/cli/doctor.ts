// `synapser doctor`: what is installed, what is usable, what to enable (plan 13 §7). Read-only: it probes
// and suggests; nothing is enabled or written without the operator.

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import type { AgentProfile } from "../agents/profile.ts";
import { adapterOf, BUILTIN_PROFILES } from "../agents/profile.ts";
import type { SynapserConfig } from "../config/load.ts";
import { readLibrary } from "../library/store.ts";
import { libraryPolicyOf, validateLibraryDocument } from "../library/validate.ts";
import type { ProviderConfig } from "../model/config.ts";

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

const adapterProgram = (profile: AgentProfile): string => {
  const fixed: Partial<Record<ReturnType<typeof adapterOf>, string>> = {
    "claude-code": "claude",
    codex: "codex",
    kimi: "kimi",
    mimo: "mimo",
  };
  return fixed[adapterOf(profile)] ?? profile.argv[0] ?? "";
};

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
  // one key check per provider that a system role runs on; each names the roles it serves (plan 14 Q2.3)
  const servedBy = new Map<string, string[]>();
  for (const [role, assignment] of Object.entries(cfg.roles)) servedBy.set(assignment.provider, [...(servedBy.get(assignment.provider) ?? []), role]);
  for (const [providerId, served] of servedBy) {
    const provider = cfg.providers[providerId]!;
    const hasKey = provider.apiKeyEnv.some((n) => probe.env(n));
    checks.push({ name: `model key (${providerId})`, ok: hasKey, detail: hasKey ? "set" : `none of ${provider.apiKeyEnv.join(" / ")} is set — system roles ${served.join(", ")} cannot run` });
  }
  const hasModelKey = cfg.providers["tokenfactory"]!.apiKeyEnv.some((n) => probe.env(n));
  const hasSearch = ["TAVILY_API_KEY", "TAVILY_TOKEN"].some((n) => probe.env(n));
  checks.push({ name: "search key (Tavily)", ok: hasSearch, detail: hasSearch ? "set" : "not set — research and pushback are off (never simulated)" });
  checks.push({ name: "commands", ok: cfg.commands.length > 0, detail: cfg.commands.length ? cfg.commands.map((c) => c.id).join(", ") : "no allowlisted commands: `command` conditions cannot be used" });

  // the operator library (plan 14 Q2.7): read from the ledger, never materialised; its documents must still pass
  // their rules, and the keys of its providers are reported as information (no run uses a library provider yet)
  let library: ReturnType<typeof readLibrary> = [];
  try {
    library = readLibrary(cfg.stateDir);
    const count = (kind: string) => library.filter((e) => e.kind === kind).length;
    checks.push({ name: "library", ok: true, detail: library.length ? `providers ${count("providers")} · agents ${count("agents")} · skills ${count("skills")} · templates ${count("templates")} · recipes ${count("recipes")}` : "empty" });
  } catch (e) {
    checks.push({ name: "library", ok: false, detail: `cannot be read: ${String((e as Error).message ?? e).slice(0, 200)}` });
  }
  // an agent may name a library provider: its document is in the policy, so the agent is checked against it
  const libraryProviders = Object.fromEntries(library.filter((e) => e.kind === "providers").map((e) => [e.id, e.document as unknown as ProviderConfig]));
  for (const entry of library) {
    const problems = validateLibraryDocument(entry.kind, entry.id, entry.document, libraryPolicyOf(cfg, libraryProviders));
    if (problems.length) checks.push({ name: `library ${entry.kind}/${entry.id}`, ok: false, detail: problems.join("; ") });
    const names = entry.document["apiKeyEnv"];
    if (entry.kind === "providers" && Array.isArray(names)) {
      const hasKey = names.some((n) => probe.env(String(n)));
      checks.push({ name: `library provider key (${entry.id})`, ok: hasKey, detail: hasKey ? "set" : `none of ${names.join(" / ")} is set` });
    }
  }

  const agents: DoctorReport["agents"] = [];
  const all = new Map<string, AgentProfile>([...BUILTIN_PROFILES, ...cfg.profiles].map((p) => [p.id, p]));
  for (const p of all.values()) {
    const enabledInConfig = cfg.profiles.some((q) => q.id === p.id);
    if ((p.adapter ?? "cli-oneshot") === "native" && p.provider) {
      const provider = cfg.providers[p.provider];
      const declared = provider?.models.some((model) => model.id === p.model) ?? false;
      const key = provider?.apiKeyEnv.some((n) => probe.env(n)) ?? false;
      const detail = !provider
        ? `unknown provider ${p.provider}`
        : !declared
          ? `model ${p.model ?? "(missing)"} is not declared by ${p.provider}`
          : key
            ? `${p.model} @ ${provider.baseUrl}`
            : `no key in ${provider.apiKeyEnv.join(" / ")}`;
      agents.push({ id: p.id, tier: p.tier ?? "standard", role: p.role, adapter: `native (${p.provider})`, available: key && declared, enabledInConfig, detail });
    } else if ((p.adapter ?? "cli-oneshot") === "native") {
      agents.push({ id: p.id, tier: p.tier ?? "standard", role: p.role, adapter: "native", available: hasModelKey, enabledInConfig, detail: hasModelKey ? "Nemotron on Token Factory" : "needs a Nebius key" });
    } else {
      const prog = adapterProgram(p);
      const path = await probe.which(prog);
      const ver = path ? await probe.version(prog, ["--version"]) : null;
      const usable = path !== null && p.enabled;
      agents.push({ id: p.id, tier: p.tier ?? "standard", role: p.role, adapter: adapterOf(p), available: usable, enabledInConfig, detail: !p.enabled ? `disabled: ${p.disabledReason ?? "no reason recorded"}` : path ? `${path}${ver ? ` — ${ver}` : ""}` : `${prog}: not installed` });
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
  const informational = (name: string): boolean => advisory.has(name) || name.startsWith("library provider key");
  return { ok: checks.every((c) => c.ok || informational(c.name)), checks, agents, suggestions };
}
