import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { discloseConditionDetail, HIDDEN_REVIEW_DETAIL } from "../../src/workflow/disclosure.ts";

describe("adversarial review disclosure defaults", () => {
  test("only the operator receives reviewer-authored condition detail", () => {
    const privateFinding = "PRIVATE_REVIEW_FINDING";
    assert.equal(discloseConditionDetail("review", privateFinding, "operator"), privateFinding);
    assert.equal(discloseConditionDetail("review", privateFinding, "initiator"), HIDDEN_REVIEW_DETAIL);
    assert.equal(discloseConditionDetail("review", privateFinding, "executor"), HIDDEN_REVIEW_DETAIL);
  });

  test("non-review condition evidence keeps its existing audience behavior", () => {
    const detail = "test command failed with exit code 1";
    assert.equal(discloseConditionDetail("command", detail, "initiator"), detail);
  });
});
