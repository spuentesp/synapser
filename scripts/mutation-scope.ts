/** Stable mapping from changed runtime files to the Stryker module gates already in the repository. */
export const MUTATION_MODULES = ["security", "journal", "executor", "library"] as const;
export type MutationModule = (typeof MUTATION_MODULES)[number];

const MUTATED_FILES: Readonly<Record<string, MutationModule>> = {
  "src/agents/inject.ts": "security",
  "src/config/write.ts": "security",
  "src/journal/journal.ts": "journal",
  "src/executor/executor.ts": "executor",
  "src/library/validate.ts": "library",
};

export interface MutationScope {
  modules: MutationModule[];
  uncoveredRuntimeFiles: string[];
}

/**
 * Select module gates for a git-diff path list.
 *
 * Non-source changes are intentionally ignored. A changed source path without a configured module is
 * returned separately so callers fail closed instead of mistaking an incomplete mapping for no work.
 */
export function mutationScope(changedPaths: readonly string[]): MutationScope {
  const selected = new Set<MutationModule>();
  const uncovered = new Set<string>();

  for (const rawPath of changedPaths) {
    const path = rawPath.replaceAll("\\", "/");
    if (!path.startsWith("src/")) continue;
    const module = MUTATED_FILES[path];
    if (module) selected.add(module);
    else uncovered.add(path);
  }

  return {
    modules: MUTATION_MODULES.filter((module) => selected.has(module)),
    uncoveredRuntimeFiles: [...uncovered].sort(),
  };
}
