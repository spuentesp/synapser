// Contention workload for the coordination A/B (docs/plans/09): N tasks, ONE shared file, each task
// implements a different function. Every edit is partial and every write races on the same bytes,
// so a lost update cannot be masked by an agent re-emitting the whole file from a shared contract.

import { join, resolve } from "node:path";
import type { AllowedCommand } from "../validation/runner.ts";
import type { Plan } from "./plan.ts";

export const REGISTRY_FUNCTIONS = ["slugify", "parse_duration", "clamp", "chunk", "to_roman", "is_balanced", "camel_to_snake", "dedupe"] as const;

export const REGISTRY_OBJECTIVE = "Implement the eight helper functions of app/handlers.py; each is specified by its docstring.";

export function registryPlan(): Plan {
  return {
    tasks: REGISTRY_FUNCTIONS.map((fn) => ({
      id: `impl_${fn}`,
      objective: `In app/handlers.py implement ONLY the function \`${fn}\` as specified by its docstring. Leave every other function exactly as it is (other agents are implementing them in the same file at the same time).`,
      scope: ["app/handlers.py"],
      criteria: [`\`${fn}\` behaves exactly as its docstring specifies, and no other function in the file is changed.`],
      context: [],
      deps: [],
      priority: 10,
    })),
  };
}

export function registryAcceptance(fixturesDir = resolve("fixtures/registry")): AllowedCommand[] {
  return [{ id: "oracle", argv: ["python3", "-m", "unittest", "discover", "-s", join(fixturesDir, "oracle")], timeoutMs: 60_000 }];
}
