// What a run reads from the library (plan 14 Q5.1 and Q5.4). A run uses its snapshot (L3) and the operator's file, nothing
// else. The snapshot is checked under the operator's file as it stands now, so a document the file no longer accepts
// refuses the run whole, with every reason. A skill enters a run only where the operator's file assigns it to an agent
// (decision D6), as a library document, with the digest of its bytes (L1).

import type { InjectedSkill } from "../agents/adapter.ts";
import { effectiveProfileCapabilities } from "../agents/capabilities.ts";
import type { AgentProfile } from "../agents/profile.ts";
import { sha256Bytes } from "../digest/file.ts";
import type { ProviderConfig } from "../model/config.ts";
import type { FrozenLibrary, LibraryEntry, LibraryStore } from "./store.ts";
import { libraryPolicyOf, resolveAgent, validateLibraryDocument } from "./validate.ts";

/** At most this many library skills per agent (decision D6). */
const MAX_SKILLS_PER_AGENT = 5;

/** What the operator's file contributes to every run. */
export interface OperatorFile {
  providers: Record<string, ProviderConfig>;
  profiles: AgentProfile[];
  providerKeyEnv?: readonly string[];
  /** Operator-authorized skill IDs per profile; a task may choose a subset from this list. */
  agentSkills?: Record<string, readonly string[]>;
}

/** The providers, agents and skills one view of the library yields, and the problems that keep documents out of it. */
export interface LibraryView {
  providers: Record<string, ProviderConfig>;
  profiles: AgentProfile[];
  /** The skills each agent receives in this run, each with the digest of its bytes (plan 14 Q5.4). */
  skillsFor: Map<string, InjectedSkill[]>;
  problems: string[];
}

/** A run whose library does not hold under the operator's file. The run fails with every problem. */
export class LibraryRunError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`the library does not hold under the operator's file: ${problems.join("; ")}`);
    this.name = "LibraryRunError";
    this.problems = problems;
  }
}

/** Resolves a view of the library against the operator's file. A problem never stops it: the document is left out. */
export function resolveLibrary(file: OperatorFile, source: FrozenLibrary | undefined): LibraryView {
  const base = libraryPolicyOf({ providers: file.providers, providerKeyEnv: file.providerKeyEnv ?? [], profiles: file.profiles });
  const problems: string[] = [];
  // providers first: an agent may name only a provider that is itself valid
  const libraryProviders: Record<string, ProviderConfig> = {};
  const agents: { id: string; document: Record<string, unknown> }[] = [];
  const skillDocs = new Map<string, Record<string, unknown>>();
  for (const entry of source?.entries ?? []) {
    if (entry.kind !== "providers" && entry.kind !== "agents" && entry.kind !== "skills") continue;
    const document = source?.get(entry.kind, entry.id);
    if (!document) {
      problems.push(`${entry.kind}/${entry.id}: not in this view of the library`);
      continue;
    }
    if (entry.kind === "providers") {
      const found = validateLibraryDocument("providers", entry.id, document, base);
      problems.push(...found);
      if (found.length === 0) libraryProviders[entry.id] = document as unknown as ProviderConfig;
    } else if (entry.kind === "agents") {
      agents.push({ id: entry.id, document: document as Record<string, unknown> });
    } else {
      skillDocs.set(entry.id, document as Record<string, unknown>);
    }
  }
  const policy = libraryPolicyOf({ providers: file.providers, providerKeyEnv: file.providerKeyEnv ?? [], profiles: file.profiles }, libraryProviders);
  const profiles: AgentProfile[] = [];
  for (const agent of agents) {
    const found = validateLibraryDocument("agents", agent.id, agent.document, policy);
    problems.push(...found);
    if (found.length === 0) {
      const { profile } = resolveAgent(`agents/${agent.id}`, agent.id, agent.document, policy);
      if (profile) profiles.push(profile);
    }
  }
  const allProfiles = [...file.profiles, ...profiles];
  // agentSkills is the operator allowlist; a task may select a subset later. The run sees only this frozen view.
  const skillsFor = new Map<string, InjectedSkill[]>();
  for (const [agentId, skillIds] of Object.entries(file.agentSkills ?? {})) {
    if (!allProfiles.some((p) => p.id === agentId)) {
      problems.push(`agentSkills: ${agentId} is not a profile of the operator's file or of the library`);
      continue;
    }
    if (skillIds.length > MAX_SKILLS_PER_AGENT) {
      problems.push(`agentSkills.${agentId}: at most ${MAX_SKILLS_PER_AGENT} skills per agent (decision D6)`);
      continue;
    }
    const injected: InjectedSkill[] = [];
    const profile = allProfiles.find((p) => p.id === agentId)!;
    if (skillIds.length > 0 && effectiveProfileCapabilities(profile).skills === "none") {
      problems.push(`agentSkills.${agentId}: adapter ${profile.adapter ?? "cli-oneshot"} does not support skill injection`);
      continue;
    }
    for (const skillId of skillIds) {
      const document = skillDocs.get(skillId);
      if (!document) {
        problems.push(`agentSkills.${agentId}: skill ${skillId} is not in this run's library`);
        continue;
      }
      const found = validateLibraryDocument("skills", skillId, document);
      problems.push(...found);
      if (found.length === 0) {
        const content = document["content"] as string;
        injected.push({ id: skillId, digest: sha256Bytes(Buffer.from(content, "utf8")), content, selectionReason: "operator-default", source: "library" });
      }
    }
    skillsFor.set(agentId, injected);
  }
  return { providers: { ...policy.providers }, profiles: allProfiles, skillsFor, problems };
}

/** The view a run uses. A library that does not hold under the operator's file refuses the run whole. */
export function runLibrary(file: OperatorFile, snapshot: FrozenLibrary | undefined): LibraryView {
  const view = resolveLibrary(file, snapshot);
  if (view.problems.length) throw new LibraryRunError(view.problems);
  return view;
}

/** A library shaped like a snapshot, from entries read now. For the write path and for displays; a run never reads it. */
export function sourceOf(entries: readonly LibraryEntry[]): FrozenLibrary {
  return {
    entries: entries.map((e) => ({ kind: e.kind, id: e.id, digest: e.digest })),
    get: (kind, id) => entries.find((e) => e.kind === kind && e.id === id)?.document ?? null,
  };
}

/** The library as it stands now. */
export function liveSource(store: LibraryStore): FrozenLibrary {
  return sourceOf(store.list());
}
