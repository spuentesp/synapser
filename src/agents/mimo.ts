// MiMo Code adapter. The installed CLI schema exposes native skills through `skills.paths` in its
// XDG configuration; Q1.7 materialises that isolated config. No prompt fallback is needed.

import { join } from "node:path";
import { buildAgentEnv, type AdapterFile, type AgentAdapter, type AgentInvocation, type AdapterTask, type InjectedSkills } from "./adapter.ts";
import { capabilitiesForAdapter } from "./capabilities.ts";
import type { AgentProfile } from "./profile.ts";
import { skillFiles } from "./skills.ts";
import { parseMimo, type ParsedRun } from "./usage.ts";

export class MimoAdapter implements AgentAdapter {
  readonly id = "mimo" as const;
  readonly displayName = "MiMo Code";
  readonly capabilities = capabilitiesForAdapter("mimo");

  build(profile: AgentProfile, task: AdapterTask, injected: InjectedSkills): AgentInvocation {
    const argv = ["mimo", "run", task.prompt, "--format", "json", "--pure", "--dir", task.cwd];
    const template = ["mimo", "run", "{prompt}", "--format", "json", "--pure", "--dir", "{cwd}"];
    // An injected provider carries its own model flag; the profile's model is then not used.
    if (task.injection) {
      argv.push(...task.injection.argv);
      template.push(...task.injection.argv);
    } else if (profile.model) {
      argv.push("--model", profile.model);
      template.push("--model", profile.model);
    }
    if (profile.permissions?.mode === "yolo") {
      argv.push("--dangerously-skip-permissions");
      template.push("--dangerously-skip-permissions");
    }
    const files: AdapterFile[] = skillFiles(injected.skills, "home", ".local/share/synapser/skills");
    // One configuration file carries both the skills and the injected provider.
    const homeConfig: Record<string, unknown> = {};
    if (injected.skills.length > 0) homeConfig["skills"] = { paths: [join(task.home, ".local/share/synapser/skills")] };
    if (task.injection?.homeJson) Object.assign(homeConfig, task.injection.homeJson.value);
    if (Object.keys(homeConfig).length > 0) {
      files.push({ root: "home", path: ".config/mimocode/mimocode.jsonc", content: `${JSON.stringify(homeConfig, null, 2)}\n` });
    }
    const env = buildAgentEnv(profile, task.envSource, task.home);
    if (task.injection) Object.assign(env, task.injection.env);
    return {
      argv, argvTemplate: template, env,
      resetDirs: [{ root: "home", path: ".local/share/synapser/skills" }], files,
    };
  }

  parse(stdout: string, _profile: AgentProfile): ParsedRun {
    return parseMimo(stdout);
  }
}

export const MIMO_ADAPTER = new MimoAdapter();
