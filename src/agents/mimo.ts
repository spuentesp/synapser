// MiMo Code adapter. The installed CLI schema exposes native skills through `skills.paths` in its
// XDG configuration; Q1.7 materialises that isolated config. No prompt fallback is needed.

import { join } from "node:path";
import { buildAgentEnv, type AdapterFile, type AgentAdapter, type AgentCapabilities, type AgentInvocation, type AdapterTask, type InjectedSkills } from "./adapter.ts";
import type { AgentProfile } from "./profile.ts";
import { skillFiles } from "./skills.ts";
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
  cliFlags: ["--format", "--pure", "--dir", "--model", "--dangerously-skip-permissions"],
  profileDefinedFlags: false,
});

export class MimoAdapter implements AgentAdapter {
  readonly id = "mimo" as const;
  readonly displayName = "MiMo Code";
  readonly capabilities = CAPABILITIES;

  build(profile: AgentProfile, task: AdapterTask, injected: InjectedSkills): AgentInvocation {
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
    const files: AdapterFile[] = skillFiles(injected.skills, "home", ".local/share/synapser/skills");
    if (injected.skills.length > 0) {
      files.push({
        root: "home",
        path: ".config/mimocode/mimocode.jsonc",
        content: `${JSON.stringify({ skills: { paths: [join(task.home, ".local/share/synapser/skills")] } }, null, 2)}\n`,
      });
    }
    return {
      argv, argvTemplate: template, env: buildAgentEnv(profile, task.envSource, task.home),
      resetDirs: [{ root: "home", path: ".local/share/synapser/skills" }], files,
    };
  }

  parse(stdout: string, _profile: AgentProfile): ParsedRun {
    return parseMimo(stdout);
  }
}

export const MIMO_ADAPTER = new MimoAdapter();
