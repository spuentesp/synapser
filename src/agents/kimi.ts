// Kimi Code adapter. Its session log carries usage that stdout omits, so parsing is rooted in the
// same disposable HOME used for the invocation rather than the operator's real home directory.

import { join } from "node:path";
import { buildAgentEnv, type AgentAdapter, type AgentCapabilities, type AgentInvocation, type AgentParseOptions, type AdapterTask, type InjectedSkills } from "./adapter.ts";
import type { AgentProfile } from "./profile.ts";
import { skillFiles } from "./skills.ts";
import { parseKimi, type ParsedRun } from "./usage.ts";

const CAPABILITIES: AgentCapabilities = Object.freeze({
  headless: true,
  structuredOutput: true,
  skills: "native",
  skillMechanism: "skills-dir-flag",
  mcp: false,
  permissionModes: ["default", "yolo", "plan"],
  budgetFlag: false,
  resume: true,
  cliFlags: ["-p", "--output-format", "--yolo", "--plan", "--skills-dir"],
  profileDefinedFlags: false,
});

export class KimiAdapter implements AgentAdapter {
  readonly id = "kimi" as const;
  readonly displayName = "Kimi Code";
  readonly capabilities = CAPABILITIES;

  build(profile: AgentProfile, task: AdapterTask, injected: InjectedSkills): AgentInvocation {
    const argv = ["kimi", "-p", task.prompt, "--output-format", "stream-json"];
    const template = ["kimi", "-p", "{prompt}", "--output-format", "stream-json"];
    const mode = profile.permissions?.mode;
    if (mode && mode !== "default") {
      argv.push(`--${mode}`);
      template.push(`--${mode}`);
    }
    if (injected.skills.length > 0) {
      const skillsDir = join(task.home, ".local/share/synapser/skills");
      argv.push("--skills-dir", skillsDir);
      template.push("--skills-dir", "{skillsDir}");
    }
    return {
      argv,
      argvTemplate: template,
      env: buildAgentEnv(profile, task.envSource, task.home),
      resetDirs: [{ root: "home", path: ".local/share/synapser/skills" }],
      files: skillFiles(injected.skills, "home", ".local/share/synapser/skills"),
    };
  }

  parse(stdout: string, _profile: AgentProfile, options: AgentParseOptions = {}): ParsedRun {
    const kimi = options.kimi ?? (options.home ? { sessionsRoot: join(options.home, ".kimi-code", "sessions") } : {});
    return parseKimi(stdout, kimi);
  }
}

export const KIMI_ADAPTER = new KimiAdapter();
