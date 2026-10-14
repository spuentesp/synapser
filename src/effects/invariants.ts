// G1–G6 over the ledger (plan 13 §5.4). These judge the RECORD, so they hold for any channel and any
// future broker: an effect that ran without a matching human decision shows up here, whatever caused it.

import type { Violation } from "../audit/invariants.ts";
import type { Journal } from "../journal/journal.ts";
import { policyHash, type Policy } from "./policy.ts";

export function checkEffects(journal: Journal): Violation[] {
  const out: Violation[] = [];
  const events = journal.listEvents();
  const approvals = events.filter((e) => e.entity === "approval");
  const challenges = events.filter((e) => e.entity === "approval_challenge");
  const policies = new Set(events.filter((e) => e.entity === "policy").map((e) => e.entityId));
  const byEffect = new Map<string, typeof events>();
  for (const e of events) if (e.entity === "effect") (byEffect.get(e.entityId) ?? byEffect.set(e.entityId, []).get(e.entityId)!).push(e);

  for (const [id, evs] of byEffect) {
    const first = evs[0]!;
    const d = first.data as { decision?: string; digest?: string; policy_hash?: string; requested_by?: string };
    const executing = evs.find((e) => e.toState === "EXECUTING");
    const done = evs.some((e) => e.toState === "DONE");

    // G6: the decision cites a policy that is itself on the ledger
    if (!d.policy_hash || !policies.has(d.policy_hash)) out.push({ invariant: "G6", code: "POLICY_NOT_RECORDED", where: id, detail: { policy_hash: d.policy_hash ?? null } });

    // G5: a denied effect has no approval and never ran
    if (d.decision === "deny" && (executing || approvals.some((a) => a.entityId === `effect:${id}`))) out.push({ invariant: "G5", code: "DENIED_EFFECT_HAD_A_PATH", where: id, detail: {} });

    // G4: only the broker executes
    if (executing && (executing.data as { by?: string }).by !== "broker" && d.decision === "ask") out.push({ invariant: "G4", code: "EXECUTED_BY_NON_BROKER", where: id, detail: {} });
    if (done && !evs.find((e) => e.toState === "DONE")!.data) out.push({ invariant: "G4", code: "DONE_WITHOUT_EVIDENCE", where: id, detail: {} });

    if (d.decision === "ask" && executing) {
      // G1: an `ask` effect executed only after an APPROVED decision, earlier in the ledger
      const ok = approvals.find((a) => a.entityId === `effect:${id}` && a.toState === "APPROVED" && a.seq < executing.seq);
      if (!ok) {
        out.push({ invariant: "G1", code: "EXECUTED_WITHOUT_APPROVAL", where: id, detail: { executingSeq: executing.seq } });
        continue;
      }
      // G2: the approval is for THIS digest
      if ((ok.data as { plan_digest?: string }).plan_digest !== d.digest || (executing.data as { digest?: string }).digest !== d.digest) {
        out.push({ invariant: "G2", code: "APPROVAL_FOR_ANOTHER_EFFECT", where: id, detail: {} });
      }
      // G3: a decision relayed over MCP carries a minted challenge (a human was in the loop)
      const channel = (ok.data as { channel?: string }).channel ?? "ui";
      if (channel === "mcp" && !challenges.some((c) => c.entityId === `effect:${id}` && c.seq < ok.seq)) out.push({ invariant: "G3", code: "MCP_APPROVAL_WITHOUT_CHALLENGE", where: id, detail: {} });
      // an approval is spent once
      const runs = evs.filter((e) => e.toState === "EXECUTING").length;
      if (runs > 1) out.push({ invariant: "G1", code: "APPROVAL_SPENT_TWICE", where: id, detail: { runs } });
    }
  }
  return out;
}

/** The recorded policy documents resolve to what they claim to be (G6, integrity of the document). */
export function checkPolicyDocuments(journal: Journal): Violation[] {
  const out: Violation[] = [];
  for (const e of journal.listEvents().filter((x) => x.entity === "policy")) {
    const blob = (e.data as { blob?: string }).blob;
    try {
      const doc = JSON.parse(journal.artifacts.get(blob as string).toString("utf8")) as Policy;
      if (policyHash(doc) !== e.entityId) out.push({ invariant: "G6", code: "POLICY_DOCUMENT_MISMATCH", where: e.entityId, detail: {} });
    } catch {
      out.push({ invariant: "G6", code: "POLICY_DOCUMENT_MISSING", where: e.entityId, detail: {} });
    }
  }
  return out;
}
