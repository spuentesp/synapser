// Run intentionally before P16.6 changes a validator. The generated files are the pre-zod behaviour contract.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { metadataEndpointProblems, validateProviderConfig } from "../src/model/config.ts";
import { validateWorkflow } from "../src/workflow/model.ts";
import { providerValidationCases } from "./model/provider-validation-corpus.ts";
import { workflowValidationCases } from "./workflow/validation-corpus.ts";

const providerRows = providerValidationCases.map((c) => ({
  name: c.name, id: c.id, value: c.value,
  output: [...validateProviderConfig(c.id, c.value), ...metadataEndpointProblems(c.id, c.value)],
}));
const workflowRows = workflowValidationCases.map((c) => ({
  name: c.name, value: c.value,
  output: validateWorkflow(c.value, {
    workspaceRoot: resolve("fixtures/billing/baseline"), commandIds: new Set(["unit"]), profileIds: new Set(["adv"]),
  }),
}));
writeFileSync(new URL("./model/provider-validation-golden.json", import.meta.url), `${JSON.stringify(providerRows, null, 1)}\n`);
writeFileSync(new URL("./workflow/validation-golden.json", import.meta.url), `${JSON.stringify(workflowRows, null, 1)}\n`);
console.log(`provider cases: ${providerRows.length}; workflow cases: ${workflowRows.length}`);
