// Input corpus for the P16.6 workflow validator golden; generated against the pre-zod validator.
export interface WorkflowValidationCase { name: string; value: unknown }

const valid = {
  id: "wf-golden", title: "A useful workflow", description: "A long enough workflow description for validation.",
  goals: ["deliver the change"], nonGoals: ["leave unrelated files alone"],
  conditions: [{ id: "tests", statement: "The tests pass", checker: { kind: "command", commandId: "unit" } }],
};
const cases: WorkflowValidationCase[] = [{ name: "valid defaults and string non-goal", value: valid }];
const add = (name: string, patch: Record<string, unknown>) => cases.push({ name, value: { ...valid, ...patch } });
for (const [field, values] of Object.entries({
  id: ["", "bad id", "a".repeat(82), null], title: ["x", "x".repeat(161), null],
  description: ["short", "d".repeat(4001), null], goals: [null, "goal", ["", 1]], nonGoals: [null, Array(41).fill("x"), ["", 2]],
  conditions: [null, [], Array(31).fill(valid.conditions[0]), "condition"], budget: [null, {}, { usd: 0 }, { minutes: -1 }, { usd: "1" }],
})) for (const value of values) add(`${field}: ${JSON.stringify(value).slice(0, 50)}`, { [field]: value });
add("missing id", { id: undefined });
add("missing title", { title: undefined });
add("missing description", { description: undefined });
add("unknown workflow key ignored", { extra: { nested: true } });
add("workflow unknown key with invalid field", { extra: true, title: "x" });
add("checker command unknown id", { conditions: [{ id: "tests", statement: "The tests pass", checker: { kind: "command", commandId: "missing" } }] });
add("checker command missing id", { conditions: [{ id: "tests", statement: "The tests pass", checker: { kind: "command" } }] });
add("checker citations defaults min", { conditions: [{ id: "cites", statement: "Citations exist", checker: { kind: "citations", file: "README.md" } }] });
add("checker citations rejects traversal", { conditions: [{ id: "cites", statement: "Citations exist", checker: { kind: "citations", file: "../../outside", min: 1 } }] });
add("checker diff requires paths", { conditions: [{ id: "diff", statement: "Change exists", checker: { kind: "diff" } }] });
add("checker file bad assertion", { conditions: [{ id: "file", statement: "File exists", checker: { kind: "file", path: "README.md", assert: "contains" } }] });
add("checker approval short prompt", { conditions: [{ id: "approval", statement: "Approval exists", checker: { kind: "approval", prompt: "ok" } }] });
add("checker review unknown profile", { conditions: [{ id: "review", statement: "Review", required: false, checker: { kind: "review", profile: "ghost", rubric: "review it" } }] });
add("required review needs secondary evidence", { conditions: [{ id: "review", statement: "Review", checker: { kind: "review", profile: "adv", rubric: "review it" } }] });
add("required review secondary evidence accepted", { conditions: [{ id: "review", statement: "Review", checker: { kind: "review", profile: "adv", rubric: "review it" }, secondaryAccepted: { actor: "operator", reason: "independent evidence exists" } }] });
add("duplicate condition ids", { conditions: [valid.conditions[0], { id: "tests", statement: "Also pass", checker: { kind: "command", commandId: "unit" } }] });
add("only optional condition", { conditions: [{ id: "info", statement: "Informational", required: false, checker: { kind: "file", path: "README.md", assert: "exists" } }] });
add("waived required condition", { conditions: [{ id: "tests", statement: "The tests pass", checker: { kind: "command", commandId: "unit" }, waivedBy: { actor: "operator", reason: "not applicable" } }] });
add("bad non-goal guard kind", { nonGoals: [{ statement: "No docs", guard: { kind: "approval", prompt: "keep docs" } }] });
add("non-goal guard invalid path", { nonGoals: [{ statement: "No traversal", guard: { kind: "file", path: "../outside", assert: "absent" } }] });
add("effect checker valid params", { conditions: [{ id: "effect", statement: "Effect done", checker: { kind: "effect", effectKind: "git.push", params: { remote: "origin" } } }] });
add("effect checker invalid kind", { conditions: [{ id: "effect", statement: "Effect done", checker: { kind: "effect", effectKind: "Git Push", params: {} } }] });
add("multiple shape and semantic failures preserve order", { title: "x", goals: "bad", conditions: [{ id: "bad id", statement: "x", checker: { kind: "command", commandId: "missing" } }] });

export const workflowValidationCases = cases;
