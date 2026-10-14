// Codex CLI adapter. CODEX_HOME is pinned inside the runner's disposable HOME so neither user
// configuration nor future injected skills can escape into the operator's real home directory.

import { join } from "node:path";
import { buildAgentEnv, type AgentAdapter, type AgentCapabilities, type AgentInvocation, type AdapterTask, type InjectedSkills } from "./adapter.ts";
import type { AgentProfile } from "./profile.ts";
import { skillFiles } from "./skills.ts";
import { parseCodex, type ParsedRun } from "./usage.ts";

const CAPABILITIES: AgentCapabilities = Object.freeze({
  headless: true,
  structuredOutput: true,
  skills: "native",
  skillMechanism: "native-dir",
  mcp: false,
  permissionModes: ["read-only", "workspace-write"],
  budgetFlag: false,
  resume: true,
  cliFlags: ["--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-s", "-C", "-m"],
  profileDefinedFlags: false,
});

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Codex CLI";
  readonly capabilities = CAPABILITIES;

  build(profile: AgentProfile, task: AdapterTask, injected: InjectedSkills): AgentInvocation {
    const sandbox = profile.permissions?.mode ?? (profile.role === "advisor" ? "read-only" : "workspace-write");
    const argv = ["codex", "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "-s", sandbox, "-C", task.cwd];
    const template = [...argv];
    // An injected provider carries its own model flag; the profile's model is then not used.
    if (task.injection) {
      argv.push(...task.injection.argv);
      template.push(...task.injection.argv);
    } else if (profile.model) {
      argv.push("-m", profile.model);
      template.push("-m", profile.model);
    }
    argv.push(task.prompt);
    template.push("{prompt}");
    const env = buildAgentEnv(profile, task.envSource, task.home);
    env["CODEX_HOME"] = join(task.home, ".codex");
    if (task.injection) Object.assign(env, task.injection.env);
    return {
      argv, argvTemplate: template, env,
      resetDirs: [{ root: "home", path: ".codex/skills" }],
      files: skillFiles(injected.skills, "home", ".codex/skills"),
    };
  }

  parse(stdout: string, _profile: AgentProfile): ParsedRun {
    return parseCodex(stdout);
  }
}

export const CODEX_ADAPTER = new CodexAdapter();
