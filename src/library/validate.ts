// Whole-document validation for library entries (plan 14 Q2.6). It reports EVERY problem, so an invalid edit is
// refused entirely with the full list. Providers and agents reuse the rules that already gate the configuration
// file. The templates schema is not defined until Q3.2, so templates only have to be JSON objects.

import { type AgentProfile, validateProfile } from "../agents/profile.ts";
import { PARSERS } from "../agents/usage.ts";
import { validateProviderConfig } from "../model/config.ts";
import type { LibraryKind } from "./store.ts";

const MAX_SKILL_BYTES = 64 * 1024;

export function validateLibraryDocument(kind: LibraryKind, id: string, document: unknown): string[] {
  const at = `${kind}/${id}`;
  if (!document || typeof document !== "object" || Array.isArray(document)) return [`${at}: the document must be a JSON object`];
  const d = document as Record<string, unknown>;
  const idProblems = d["id"] !== undefined && d["id"] !== id ? [`${at}: document id ${JSON.stringify(d["id"])} does not match ${id}`] : [];
  switch (kind) {
    case "providers":
      return [...idProblems, ...validateProviderConfig(id, d)];
    case "agents":
      return [...idProblems, ...agentProblems(at, id, d)];
    case "skills":
      return [...idProblems, ...skillProblems(at, d)];
    case "templates":
      return idProblems;
  }
}

function agentProblems(at: string, id: string, d: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const { description, role, argv, parser, timeoutMs, tags, enabled } = d;
  if (typeof description !== "string") problems.push(`${at}: description must be a string`);
  if (role !== "writer" && role !== "advisor") problems.push(`${at}: role must be "writer" or "advisor"`);
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) problems.push(`${at}: argv must be an array of strings`);
  if (typeof parser !== "string" || !Object.hasOwn(PARSERS, parser)) problems.push(`${at}: parser must be one of ${Object.keys(PARSERS).join(", ")}`);
  if (typeof timeoutMs !== "number" || !(timeoutMs > 0)) problems.push(`${at}: timeoutMs must be a positive number`);
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) problems.push(`${at}: tags must be an array of strings`);
  if (enabled !== undefined && typeof enabled !== "boolean") problems.push(`${at}: enabled must be a boolean`);
  // the field shapes above must hold before the profile rules run, because those rules read the fields directly
  if (problems.length) return problems;
  return validateProfile({ ...d, id } as unknown as AgentProfile).map((problem) => `${at}: ${problem}`);
}

function skillProblems(at: string, d: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const { name, description, content, tags } = d;
  if (typeof name !== "string" || !name.trim()) problems.push(`${at}: name is required`);
  if (typeof description !== "string") problems.push(`${at}: description must be a string`);
  if (typeof content !== "string" || !content.trim()) problems.push(`${at}: content must be a non-empty string`);
  else if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) problems.push(`${at}: content is larger than ${MAX_SKILL_BYTES} bytes`);
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))) problems.push(`${at}: tags must be an array of strings`);
  return problems;
}
