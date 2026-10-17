// Adversarial-review output is operator-only by default (P19.7). Callers that are
// not the authenticated operator receive a fixed status, never reviewer-authored text.

export type ReviewAudience = "operator" | "initiator" | "executor";

export const HIDDEN_REVIEW_DETAIL = "A secondary review did not pass. Ask the operator for permitted guidance.";

export function discloseConditionDetail(checker: string, detail: string, audience: ReviewAudience): string {
  return checker === "review" && audience !== "operator" ? HIDDEN_REVIEW_DETAIL : detail;
}
