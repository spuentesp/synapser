// MiMo Code adapter. The installed CLI schema exposes native skills through `skills.paths` in its
// XDG configuration; Q1.7 materialises that isolated config. No prompt fallback is needed.

import { buildAgentEnv, type AgentAdapter, type AgentCapabilities, type AgentInvocation, type AdapterTask, type InjectedSkills } from "./adapter.ts";
import type { AgentProfile } from "./profile.ts";
import { parseMimo, type ParsedRun } from "./usage.ts";

const CAPABILITIES: AgentCapabilities = Object.freeze({
  headless: true,
  structuredOutput: true,
  skills: "native",
  skillMechanism: "native-dir",
  mcp: true,
  permissionModes: ["default", "yolo"],
  budgetFlag: false,
  resume: true,
});

export class MimoAdapter implements AgentAdapter {
  readonly id = "mimo" as const;
  readonly displayName = "MiMo Code";
  readonly capabilities = CAPABILITIES;

  build(profile: AgentProfile, task: AdapterTask, _injected: InjectedSkills): AgentInvocation {
    const argv = ["mimo", "run", task.prompt, "--format", "json", "--pure", "--dir", task.cwd];
    const template = ["mimo", "run", "{prompt}", "--format", "json", "--pure", "--dir", "{cwd}"];
    if (profile.model) {
      argv.push("--model", profile.model);
      template.push("--model", profile.model);
    }
    if (profile.permissions?.mode === "yolo") {
      argv.push("--dangerously-skip-permissions");
      template.push("--dangerously-skip-permissions");
    }
    return { argv, argvTemplate: template, env: buildAgentEnv(profile, task.envSource, task.home), files: [] };
  }

  parse(stdout: string, _profile: AgentProfile): ParsedRun {
    return parseMimo(stdout);
  }
}

export const MIMO_ADAPTER = new MimoAdapter();
