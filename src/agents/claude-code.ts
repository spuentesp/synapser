// Claude Code owns its headless invocation and result format here. Profiles contain policy choices;
// the isolated runner still owns HOME, credentials, process lifetime and change observation.

import { buildAgentEnv, type AgentAdapter, type AgentCapabilities, type AgentInvocation, type AdapterTask, type InjectedSkills } from "./adapter.ts";
import type { AgentProfile } from "./profile.ts";
import { skillFiles } from "./skills.ts";
import { parseClaude, type ParsedRun } from "./usage.ts";

const CAPABILITIES: AgentCapabilities = Object.freeze({
  headless: true,
  structuredOutput: true,
  skills: "native",
  skillMechanism: "native-dir",
  mcp: true,
  permissionModes: ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"],
  budgetFlag: true,
  resume: true,
  cliFlags: ["-p", "--output-format", "--model", "--allowedTools", "--disallowedTools", "--permission-mode", "--max-budget-usd"],
  profileDefinedFlags: false,
});

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code" as const;
  readonly displayName = "Claude Code";
  readonly capabilities = CAPABILITIES;

  build(profile: AgentProfile, task: AdapterTask, injected: InjectedSkills): AgentInvocation {
    const argv = ["claude", "-p", task.prompt, "--output-format", "json"];
    const template = ["claude", "-p", "{prompt}", "--output-format", "json"];
    const add = (...args: string[]) => {
      argv.push(...args);
      template.push(...args);
    };
    // An injected provider carries its own model flag; the profile's model is then not used.
    if (task.injection) add(...task.injection.argv);
    else if (profile.model) add("--model", profile.model);
    if (profile.permissions?.allowedTools?.length) add("--allowedTools", profile.permissions.allowedTools.join(","));
    if (profile.permissions?.disallowedTools?.length) add("--disallowedTools", profile.permissions.disallowedTools.join(","));
    if (profile.permissions?.mode) add("--permission-mode", profile.permissions.mode);
    if (profile.maxBudgetUsd !== undefined) add("--max-budget-usd", String(profile.maxBudgetUsd));
    return {
      argv, argvTemplate: template, env: { ...buildAgentEnv(profile, task.envSource, task.home), ...(task.injection?.env ?? {}) },
      resetDirs: [{ root: "worktree", path: ".claude/skills" }, { root: "home", path: ".claude/skills" }],
      files: skillFiles(injected.skills, "worktree", ".claude/skills"),
    };
  }

  parse(stdout: string, _profile: AgentProfile): ParsedRun {
    return parseClaude(stdout);
  }
}

export const CLAUDE_CODE_ADAPTER = new ClaudeCodeAdapter();
