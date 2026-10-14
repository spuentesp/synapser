// Explicit wrapper for an arbitrary one-shot CLI. It trusts no structured events: exit status and
// later acceptance are the evidence, while stdout is retained only as plain final text.

import { buildAgentEnv, type AgentAdapter, type AgentCapabilities, type AgentInvocation, type AdapterTask, type InjectedSkills } from "./adapter.ts";
import type { AgentProfile } from "./profile.ts";
import { prependSkills } from "./skills.ts";
import { parsePlain, type ParsedRun } from "./usage.ts";

const CAPABILITIES: AgentCapabilities = Object.freeze({
  headless: true,
  structuredOutput: false,
  skills: "prompt-prepend",
  skillMechanism: "prompt-prepend",
  mcp: false,
  permissionModes: [],
  budgetFlag: false,
  resume: false,
});

export class GenericCliAdapter implements AgentAdapter {
  readonly id = "generic-cli" as const;
  readonly displayName = "Generic CLI";
  readonly capabilities = CAPABILITIES;

  build(profile: AgentProfile, task: AdapterTask, injected: InjectedSkills): AgentInvocation {
    const prompt = prependSkills(task.prompt, injected.skills);
    return {
      argv: profile.argv.map((arg) => arg.replaceAll("{prompt}", prompt).replaceAll("{cwd}", task.cwd).replaceAll("{model}", profile.model ?? "")),
      argvTemplate: [...profile.argv],
      env: buildAgentEnv(profile, task.envSource, task.home),
      resetDirs: [],
      files: [],
    };
  }

  parse(stdout: string, _profile: AgentProfile): ParsedRun {
    return parsePlain(stdout);
  }
}

export const GENERIC_CLI_ADAPTER = new GenericCliAdapter();
