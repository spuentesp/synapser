// Effect policy (plan 13 §5.3). A policy is data: ordered rules matching an effect KIND and glob
// patterns over its string parameters. The strictest matching decision wins (deny > ask > allow) and the
// default is DENY, so a kind nobody thought about cannot happen. The policy's hash is cited by every
// decision (G6): an auditor can tell which rules were in force when an effect was allowed.

import { digestOfJson } from "../digest/canonical.ts";
import { matchesPattern } from "../workflow/model.ts";

export type Decision = "allow" | "ask" | "deny";
export type Channel = "ui" | "cli" | "mcp";

export interface PolicyRule {
  id: string;
  /** Effect kind, exact or with a trailing `*` (`git.*`). */
  kind: string;
  /** Param name → glob pattern over its string value (`*` within a segment, `**` across). */
  params?: Record<string, string>;
  decision: Decision;
  /** Which channels may approve an `ask` (default: all). */
  channels?: Channel[];
  /** Seconds an approval stays valid after it is given (default 900). */
  ttlSeconds?: number;
  reason?: string;
}

export interface Policy {
  version: 1;
  rules: PolicyRule[];
  /** Applied when no rule matches. Always `deny` unless explicitly relaxed. */
  default: Decision;
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  default: "deny",
  rules: [
    { id: "never-force-push", kind: "git.push", params: { force: "true" }, decision: "deny", reason: "force pushes are not allowed" },
    { id: "ask-commit", kind: "git.commit", decision: "ask" },
    { id: "ask-push", kind: "git.push", decision: "ask" },
  ],
};

export interface Evaluation {
  decision: Decision;
  ruleId: string | null;
  channels: Channel[];
  ttlSeconds: number;
  reason: string | null;
}

export const policyHash = (p: Policy): string => digestOfJson(JSON.parse(JSON.stringify(p)));

const kindMatches = (rule: string, kind: string): boolean => (rule.endsWith("*") ? kind.startsWith(rule.slice(0, -1)) : rule === kind);

export function evaluate(policy: Policy, kind: string, params: Record<string, unknown>): Evaluation {
  const matching = policy.rules.filter(
    (r) => kindMatches(r.kind, kind) && Object.entries(r.params ?? {}).every(([k, pat]) => typeof params[k] !== "object" && params[k] !== undefined && matchesPattern(String(params[k]), pat)),
  );
  const rank: Record<Decision, number> = { deny: 2, ask: 1, allow: 0 };
  const strictest = matching.sort((a, b) => rank[b.decision] - rank[a.decision] || a.id.localeCompare(b.id))[0];
  if (!strictest) return { decision: policy.default, ruleId: null, channels: ["ui", "cli", "mcp"], ttlSeconds: 900, reason: "no rule matched: default applies" };
  return {
    decision: strictest.decision,
    ruleId: strictest.id,
    channels: strictest.channels ?? ["ui", "cli", "mcp"],
    ttlSeconds: strictest.ttlSeconds ?? 900,
    reason: strictest.reason ?? null,
  };
}

export function validatePolicy(raw: unknown): { ok: true; policy: Policy } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const p = raw as Partial<Policy> | null;
  if (!p || typeof p !== "object") return { ok: false, errors: ["policy must be an object"] };
  if (p.version !== 1) errors.push("version must be 1");
  const def = p.default ?? "deny";
  if (!["allow", "ask", "deny"].includes(def)) errors.push("default must be allow|ask|deny");
  const rules: PolicyRule[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(p.rules)) errors.push("rules must be an array");
  else {
    p.rules.forEach((r, i) => {
      const x = r as Partial<PolicyRule>;
      if (typeof x?.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,60}$/.test(x.id)) return void errors.push(`rules[${i}].id must match [a-z0-9][a-z0-9_-]*`);
      if (seen.has(x.id)) return void errors.push(`rules[${i}].id "${x.id}" is duplicated`);
      seen.add(x.id);
      if (typeof x.kind !== "string" || !/^[a-z][a-z0-9_.]*\*?$/.test(x.kind)) return void errors.push(`rules[${i}].kind must be a kind or a prefix ending in *`);
      if (!["allow", "ask", "deny"].includes(String(x.decision))) return void errors.push(`rules[${i}].decision must be allow|ask|deny`);
      if (x.params !== undefined && (typeof x.params !== "object" || Object.values(x.params).some((v) => typeof v !== "string"))) return void errors.push(`rules[${i}].params must map names to glob strings`);
      if (x.channels !== undefined && (!Array.isArray(x.channels) || x.channels.some((c) => !["ui", "cli", "mcp"].includes(c)))) return void errors.push(`rules[${i}].channels must be ui|cli|mcp`);
      if (x.ttlSeconds !== undefined && (typeof x.ttlSeconds !== "number" || x.ttlSeconds <= 0 || x.ttlSeconds > 86_400)) return void errors.push(`rules[${i}].ttlSeconds must be 1..86400`);
      // an `allow` on a destructive kind with no param constraint is almost always a mistake: say so
      if (x.decision === "allow" && /^(git\.push|deploy|shell)/.test(x.kind) && !x.params) errors.push(`rules[${i}] "${x.id}": an unconditional allow on ${x.kind} defeats the gate; constrain it with params (e.g. branch)`);
      rules.push(x as PolicyRule);
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, policy: { version: 1, rules, default: def as Decision } };
}
