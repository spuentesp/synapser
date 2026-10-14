// What a run reads from the library (plan 14 Q5.1). A run uses its snapshot (L3) and the operator's file, nothing else.
// The snapshot is checked under the operator's file as it stands now, so a document the file no longer accepts refuses
// the run whole, with every reason. Skills and templates are not read until Q5.4 consumes them.

import type { AgentProfile } from "../agents/profile.ts";
import type { ProviderConfig } from "../model/config.ts";
import type { FrozenLibrary, LibraryEntry, LibraryStore } from "./store.ts";
import { libraryPolicyOf, resolveAgent, validateLibraryDocument } from "./validate.ts";

/** What the operator's file contributes to every run. */
export interface OperatorFile {
  providers: Record<string, ProviderConfig>;
  profiles: AgentProfile[];
  providerKeyEnv?: readonly string[];
}

/** The providers and agents one view of the library yields, and the problems that keep documents out of it. */
export interface LibraryView {
  providers: Record<string, ProviderConfig>;
  profiles: AgentProfile[];
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
  if (!source) return { providers: file.providers, profiles: file.profiles, problems: [] };
  const base = libraryPolicyOf({ providers: file.providers, providerKeyEnv: file.providerKeyEnv ?? [], profiles: file.profiles });
  const problems: string[] = [];
  // providers first: an agent may name only a provider that is itself valid
  const libraryProviders: Record<string, ProviderConfig> = {};
  const agents: { id: string; document: Record<string, unknown> }[] = [];
  for (const entry of source.entries) {
    if (entry.kind !== "providers" && entry.kind !== "agents") continue;
    const document = source.get(entry.kind, entry.id);
    if (!document) {
      problems.push(`${entry.kind}/${entry.id}: not in this view of the library`);
      continue;
    }
    if (entry.kind === "providers") {
      const found = validateLibraryDocument("providers", entry.id, document, base);
      problems.push(...found);
      if (found.length === 0) libraryProviders[entry.id] = document as unknown as ProviderConfig;
    } else {
      agents.push({ id: entry.id, document: document as Record<string, unknown> });
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
  return { providers: { ...policy.providers }, profiles: [...file.profiles, ...profiles], problems };
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
