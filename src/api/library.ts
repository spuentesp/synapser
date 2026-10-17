// The operator library's HTTP routes (plan 14 Q2.6). Reads are open like the other GETs; writes come through the control.
import type { IncomingMessage, ServerResponse } from "node:http";
import { type ProviderConfig } from "../model/config.ts";
import { testProviderConnection } from "../model/connection.ts";
import { libraryFetch } from "../model/destinations.ts";
import { LIBRARY_KINDS, type LibraryDocument, type LibraryEntry, type LibraryKind, type LibraryStore } from "../library/store.ts";
import { EXTENDING_FIELDS, FILE_ONLY_FIELDS, type LibraryPolicy, NATIVE_FIELDS, NATIVE_REQUIRED, NO_LIBRARY_POLICY, providerOfAgent, resolveAgent, validateLibraryDocument } from "../library/validate.ts";
import { reviewProfilesOf } from "../workflow/model.ts";
import type { WorkflowManager } from "../workflow/manager.ts";
import { fail, json, OPERATOR, readBody } from "./http.ts";
import { evaluateSkillCases, type SkillCase, type SkillCandidate } from "../library/curation.ts";
import { isDigest } from "../digest/file.ts";
import type { McpServerRegistration } from "../mcp/registry.ts";

export const entryJson = (e: LibraryEntry) => ({ kind: e.kind, id: e.id, digest: e.digest, document: e.document, seq: e.seq, actor: e.actor });

/** A library write is checked against the providers the library holds now, as well as the operator's (plan 14 Q5.1). */
export function withLibraryProviders(policy: LibraryPolicy, lib: LibraryStore): LibraryPolicy {
  const providers = Object.fromEntries(lib.list("providers").map((e) => [e.id, e.document as unknown as ProviderConfig]));
  return { ...policy, providers: { ...policy.providers, ...providers } };
}

/** The workflows that can still start and name this agent as a reviewer: a delete must not break them (plan 14 Q5.2). */
export function reviewingWorkflows(m: Pick<WorkflowManager, "list">, agentId: string): string[] {
  return m
    .list()
    .filter((v) => (v.state === "DRAFT" || v.state === "AWAITING_START") && reviewProfilesOf(v.workflow).includes(agentId))
    .map((v) => `workflow ${v.id} reviews with ${agentId}`);
}

/** The library agents that run on this provider. */
function usersOfProvider(lib: LibraryStore, providerId: string, policy: LibraryPolicy): string[] {
  return lib.list("agents").filter((e) => providerOfAgent(e.document, policy) === providerId).map((e) => `agent ${e.id} runs on provider ${providerId}`);
}

/** The agents on this provider that an edit would leave unresolvable: such an edit is refused, with the agents it breaks. */
function agentsBrokenBy(lib: LibraryStore, providerId: string, edited: LibraryDocument, policy: LibraryPolicy): string[] {
  const candidate: LibraryPolicy = { ...policy, providers: { ...policy.providers, [providerId]: edited as unknown as ProviderConfig } };
  return lib.list("agents")
    .filter((e) => providerOfAgent(e.document, policy) === providerId)
    .flatMap((e) => {
      const problems = resolveAgent(`agents/${e.id}`, e.id, e.document, candidate).problems;
      return problems.length ? [`agent ${e.id} would not resolve with this edit: ${problems.join("; ")}`] : [];
    });
}

/** What the agent designer may offer: the profiles a library agent can extend, and the fields the operator's file keeps (plan 14 Q3.3). */
function libraryBases(policy: LibraryPolicy) {
  return {
    bases: policy.bases.map((b) => ({
      id: b.profile.id,
      adapter: b.profile.adapter ?? "cli-oneshot",
      role: b.profile.role,
      tier: b.profile.tier ?? "standard",
      permissions: b.profile.permissions ?? null,
      maxBudgetUsd: b.profile.maxBudgetUsd ?? null,
      pool: b.profile.pool ?? null,
      enabledByFile: b.enabledByFile,
      provider: b.profile.provider ?? null,
    })),
    fields: { extending: EXTENDING_FIELDS, native: NATIVE_FIELDS, nativeRequired: NATIVE_REQUIRED, fileOnly: FILE_ONLY_FIELDS },
  };
}

/**
 * The operator library (plan 14 Q2.6). Reads are open like the other GETs (no secrets live in a document:
 * provider keys are environment NAMES, which validateProviderConfig enforces). Writes come through control().
 */
export async function libraryRoute(lib: LibraryStore, req: IncomingMessage, res: ServerResponse, rest: string[], method: string, policy: LibraryPolicy, reviewers: (agentId: string) => string[], mcpServers: () => readonly McpServerRegistration[] = () => []): Promise<void> {
  const [kind, key, sub] = rest;
  if (rest.length > 3) return fail(res, 404, "NOT_FOUND");
  if (kind === "bases" && rest.length === 1) return method === "GET" ? json(res, 200, libraryBases(policy)) : fail(res, 405, "METHOD_NOT_ALLOWED");
  if (kind === undefined) return method === "GET" ? json(res, 200, { entries: lib.list().map(entryJson) }) : fail(res, 405, "METHOD_NOT_ALLOWED");
  if (!(LIBRARY_KINDS as readonly string[]).includes(kind)) return fail(res, 404, "UNKNOWN_KIND");
  const k = kind as LibraryKind;
  if (key !== undefined && sub === "check" && method === "POST") {
    const body = await readBody(req, res);
    if (body === undefined) return;
    const errors = validateLibraryDocument(k, key, body, policy);
    return errors.length ? json(res, 400, { error: "INVALID_LIBRARY_DOCUMENT", errors }) : json(res, 200, { ok: true });
  }
  if (key !== undefined && sub === "history" && method === "GET") {
    try {
      return json(res, 200, { history: lib.history(k, key) });
    } catch {
      return fail(res, 400, "BAD_ID");
    }
  }
  if (key !== undefined && sub === "publish" && k === "recipes" && method === "POST") {
    const body = await readBody(req, res) as { digest?: unknown } | undefined;
    if (body === undefined) return;
    if (typeof body.digest !== "string" || !isDigest(body.digest)) return fail(res, 400, "PUBLISH_DIGEST_REQUIRED");
    const current = lib.get("recipes", key);
    if (!current || current.digest !== body.digest) return fail(res, 409, "RECIPE_DIGEST_NOT_CURRENT");
    const errors = validateLibraryDocument("recipes", key, current.document, policy);
    const recipe = current.document as { requiredSkills?: { id: string }[]; requiredMcpServers?: string[]; requiredMcpTools?: { serverId: string; toolName: string }[] };
    for (const skill of recipe.requiredSkills ?? []) if (!lib.get("skills", skill.id)) errors.push(`recipes/${key}: required skill ${skill.id} is not in the operator library`);
    const registrations = mcpServers();
    for (const serverId of recipe.requiredMcpServers ?? []) {
      const server = registrations.find((candidate) => candidate.id === serverId);
      if (!server?.enabled || !server.artifact) errors.push(`recipes/${key}: required MCP server ${serverId} must be enabled and pinned`);
    }
    for (const tool of recipe.requiredMcpTools ?? []) {
      const server = registrations.find((candidate) => candidate.id === tool.serverId);
      const granted = !!server && Object.entries(server.nativeReadOnlyProfiles ?? {}).some(([profileId, names]) =>
        (server.profiles[profileId] ?? []).includes(tool.toolName) && names.includes(tool.toolName));
      if (!server?.enabled || !server.artifact || !granted) errors.push(`recipes/${key}: MCP tool ${tool.serverId}/${tool.toolName} must be pinned and granted to an eligible native worker`);
    }
    if (errors.length) return json(res, 409, { error: "RECIPE_NOT_PUBLISHABLE", errors });
    try {
      return json(res, 200, lib.publishRecipe(key, body.digest, OPERATOR.id));
    } catch {
      return fail(res, 409, "RECIPE_DIGEST_NOT_CURRENT");
    }
  }
  if (key !== undefined && sub === "unpublish" && k === "recipes" && method === "POST") {
    try { return json(res, 200, lib.unpublishRecipe(key, OPERATOR.id)); }
    catch { return fail(res, 404, "UNKNOWN_RECIPE"); }
  }
  if (key !== undefined && sub === "rollback" && k === "skills" && method === "POST") {
    const body = await readBody(req, res) as { digest?: unknown; reason?: unknown } | undefined;
    if (body === undefined) return;
    if (typeof body.digest !== "string" || !isDigest(body.digest) || typeof body.reason !== "string" || !body.reason.trim()) return fail(res, 400, "ROLLBACK_INPUT_REQUIRED");
    const target = lib.version("skills", key, body.digest);
    if (!target) return fail(res, 404, "UNKNOWN_VERSION");
    const errors = validateLibraryDocument("skills", key, target.document, policy);
    if (errors.length) return json(res, 409, { error: "HISTORICAL_VERSION_INVALID", errors });
    try {
      return json(res, 200, entryJson(lib.rollbackSkill(key, body.digest, OPERATOR.id, body.reason)));
    } catch (e) {
      return fail(res, 400, "ROLLBACK_REFUSED", String((e as Error).message ?? e).slice(0, 200));
    }
  }
  if (key !== undefined && sub === "evaluate" && k === "skills" && method === "POST") {
    const body = await readBody(req, res) as { split?: unknown; candidate?: SkillCandidate; cases?: SkillCase[]; outputs?: { caseId: string; repetition: number; output: string }[] } | undefined;
    if (body === undefined) return;
    if ((body.split !== "dev" && body.split !== "holdout") || !body.candidate || body.candidate.id !== key || !Array.isArray(body.cases) || !Array.isArray(body.outputs)) return fail(res, 400, "INVALID_EVALUATION_INPUT");
    try {
      const outputs = new Map<string, string>();
      const caseSplits = new Map(body.cases.map((item) => [item.id, item.split]));
      for (const output of body.outputs) {
        if (!output || typeof output.caseId !== "string" || !Number.isInteger(output.repetition) || output.repetition < 1 || typeof output.output !== "string") throw new Error("each output needs caseId, positive repetition, and string output");
        const outputSplit = caseSplits.get(output.caseId);
        if (outputSplit === undefined) throw new Error(`unexpected output case: ${output.caseId}`);
        if (outputSplit !== body.split) continue;
        const id = `${output.caseId}\u0000${output.repetition}`;
        if (outputs.has(id)) throw new Error(`duplicate output: ${output.caseId} repetition ${output.repetition}`);
        outputs.set(id, output.output);
      }
      const report = await evaluateSkillCases(body.cases, body.candidate, body.split, ({ caseId, repetition }) => {
        const id = `${caseId}\u0000${repetition}`;
        const output = outputs.get(id);
        if (output === undefined) throw new Error(`missing output: ${caseId} repetition ${repetition}`);
        outputs.delete(id);
        return output;
      });
      if (outputs.size) throw new Error(`unexpected output: ${outputs.keys().next().value?.replace("\u0000", " repetition ")}`);
      return json(res, 200, report);
    } catch (e) {
      return json(res, 400, { error: "EVALUATION_REFUSED", errors: [String((e as Error).message ?? e).slice(0, 300)] });
    }
  }
  if (key === undefined) return method === "GET" ? json(res, 200, { entries: lib.list(k).map(entryJson) }) : fail(res, 405, "METHOD_NOT_ALLOWED");
  if (sub !== undefined) {
    // POST /api/library/providers/:id/test tests the STORED endpoint and key, never ones sent in the body. A cross-site
    // page cannot make the server send the key to its own address. A local process that can read the session token
    // can, because a stored document may name any https endpoint and any environment variable: a declared limit
    // (design document, section 40).
    if (sub !== "test" || k !== "providers" || method !== "POST") return fail(res, 404, "NOT_FOUND");
    let stored: LibraryEntry | null;
    try {
      stored = lib.get(k, key);
    } catch {
      return fail(res, 400, "BAD_ID");
    }
    if (!stored) return fail(res, 404, "UNKNOWN_ENTRY");
    // the allowlist can change after the document was stored: the test honours the current one
    const refused = validateLibraryDocument(k, key, stored.document, policy).filter((p) => p.includes("providerKeyEnv"));
    if (refused.length) return json(res, 403, { error: "KEY_NOT_ALLOWED", errors: refused });
    return json(res, 200, { provider: key, ...(await testProviderConnection(stored.document as unknown as ProviderConfig, { fetch: libraryFetch() })) });
  }
  if (method === "GET") {
    let entry: LibraryEntry | null;
    try {
      entry = lib.get(k, key);
    } catch {
      return fail(res, 400, "BAD_ID");
    }
    return entry ? json(res, 200, entryJson(entry)) : fail(res, 404, "UNKNOWN_ENTRY");
  }
  if (method === "PUT") {
    const body = await readBody(req, res);
    if (body === undefined) return;
    // every problem at once: an invalid edit changes nothing
    const errors = validateLibraryDocument(k, key, body, policy);
    if (errors.length) return json(res, 400, { error: "INVALID_LIBRARY_DOCUMENT", errors });
    // a provider edit that would leave an agent unresolvable is refused, with the agents it breaks (plan 14 Q5.2)
    const broken = k === "providers" ? agentsBrokenBy(lib, key, body as LibraryDocument, policy) : [];
    if (broken.length) return json(res, 409, { error: "REFERENCED", errors: broken });
    try {
      const r = lib.put(k, key, body as LibraryDocument, OPERATOR.id);
      return json(res, 200, { ...entryJson(r.entry), changed: r.changed });
    } catch (e) {
      return fail(res, 400, "INVALID_LIBRARY_ENTRY", String((e as Error).message ?? e).slice(0, 200));
    }
  }
  if (method === "DELETE") {
    // a referenced entry stays, and the references say why (plan 14 Q5.2)
    const references = k === "providers" ? usersOfProvider(lib, key, policy) : k === "agents" ? reviewers(key) : [];
    if (references.length) return json(res, 409, { error: "REFERENCED", errors: references });
    try {
      return json(res, 200, { removed: lib.remove(k, key, OPERATOR.id) });
    } catch (e) {
      return fail(res, 400, "INVALID_LIBRARY_ENTRY", String((e as Error).message ?? e).slice(0, 200));
    }
  }
  return fail(res, 405, "METHOD_NOT_ALLOWED");
}
