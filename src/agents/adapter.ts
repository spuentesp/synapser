// Per-agent CLI contract. The runner owns isolation and observation; an adapter owns the
// invocation surface and the interpretation of the CLI's own output.

import { join } from "node:path";
import type { AdapterId, AgentProfile } from "./profile.ts";
import { PARSERS, type KimiOptions, type ParsedRun } from "./usage.ts";

export type SkillSupport = "native" | "prompt-prepend" | "none";
export type SkillMechanism = "native-dir" | "skills-dir-flag" | "prompt-prepend" | "none";

export interface AgentCapabilities {
  headless: boolean;
  structuredOutput: boolean;
  skills: SkillSupport;
  skillMechanism: SkillMechanism;
  mcp: boolean;
  permissionModes: readonly string[];
  budgetFlag: boolean;
  resume: boolean;
}

export interface InjectedSkill {
  id: string;
  digest: string;
  content: string;
}

export interface InjectedSkills {
  skills: readonly InjectedSkill[];
}

export const NO_INJECTED_SKILLS: InjectedSkills = Object.freeze({ skills: [] });

export interface AdapterTask {
  prompt: string;
  cwd: string;
  home: string;
  envSource: NodeJS.ProcessEnv;
}

/** A future skill adapter may place files in either isolated root; paths are always relative. */
export interface AdapterFile {
  root: "worktree" | "home";
  path: string;
  content: string;
}

export interface AgentInvocation {
  argv: readonly string[];
  /** Prompt-free form stored in the ledger. */
  argvTemplate: readonly string[];
  env: Readonly<Record<string, string>>;
  files: readonly AdapterFile[];
}

export interface AgentParseOptions {
  kimi?: KimiOptions;
  /** The disposable HOME used by this invocation. */
  home?: string;
}

export interface AgentAdapter {
  readonly id: AdapterId;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  build(profile: AgentProfile, task: AdapterTask, injected: InjectedSkills): AgentInvocation;
  parse(stdout: string, profile: AgentProfile, options?: AgentParseOptions): ParsedRun;
}

const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "CODEX_HOME", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
/** Variables that would let a git/ssh/gh call inside the agent authenticate or even prompt. */
export const CREDENTIAL_ENV_DENY = /^(SSH_|GPG_|GH_|GITHUB_|GITLAB_|GIT_ASKPASS|GIT_SSH|NPM_|NODE_AUTH|AWS_|AZURE_|GOOGLE_APPLICATION|DOCKER_|KUBE)/i;
/** Plan 13 §5.2: a CLI gets neither Git configuration nor an authentication path. */
export const GIT_HARDENING: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "/bin/false",
  GCM_INTERACTIVE: "never",
};
const SECRET_NAME = /(NEBIUS|NEMOTRON|TAVILY|API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** Environment for a third-party CLI: an allowlist plus the profile's explicitly safe entries. */
export function buildAgentEnv(profile: AgentProfile, source: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW) {
    if (source[key] !== undefined && !SECRET_NAME.test(key) && !CREDENTIAL_ENV_DENY.test(key)) env[key] = source[key] as string;
  }
  env["HOME"] = home;
  env["XDG_CONFIG_HOME"] = join(home, ".config");
  env["XDG_DATA_HOME"] = join(home, ".local/share");
  env["XDG_CACHE_HOME"] = join(home, ".cache");
  env["XDG_STATE_HOME"] = join(home, ".local/state");
  Object.assign(env, GIT_HARDENING);
  for (const [key, value] of Object.entries(profile.env ?? {})) {
    if (!CREDENTIAL_ENV_DENY.test(key) && !SECRET_NAME.test(key)) env[key] = value;
  }
  return env;
}

/** Compatibility adapter for the existing declarative cli-oneshot profiles. */
export class ProfileCliAdapter implements AgentAdapter {
  readonly id = "cli-oneshot";
  readonly displayName = "Configured CLI";
  readonly capabilities: AgentCapabilities = Object.freeze({
    headless: true,
    structuredOutput: false,
    skills: "none",
    skillMechanism: "none",
    mcp: false,
    permissionModes: [],
    budgetFlag: false,
    resume: false,
  });

  build(profile: AgentProfile, task: AdapterTask, _injected: InjectedSkills): AgentInvocation {
    return {
      argv: profile.argv.map((arg) => arg.replaceAll("{prompt}", task.prompt).replaceAll("{cwd}", task.cwd).replaceAll("{model}", profile.model ?? "")),
      argvTemplate: [...profile.argv],
      env: buildAgentEnv(profile, task.envSource, task.home),
      files: [],
    };
  }

  parse(stdout: string, profile: AgentProfile, options: AgentParseOptions = {}): ParsedRun {
    const parser = PARSERS[profile.parser] as (out: string, kimi?: KimiOptions) => ParsedRun;
    return parser(stdout, options.kimi);
  }
}

export const PROFILE_CLI_ADAPTER = new ProfileCliAdapter();
