// Provider validator cases captured before the P16.6 zod migration. Keep inputs JSON-shaped: these cross the
// operator-file and library trust boundaries. Regenerate the golden only when an intentional contract change lands.
import type { ProviderConfig } from "../../src/model/config.ts";

const valid: ProviderConfig = {
  protocol: "openai-compatible", baseUrl: "https://models.example/v1/", apiKeyEnv: ["MODEL_KEY"],
  models: [{ id: "task", usdPer1MIn: 1.25, usdPer1MOut: 2.5 }, { id: "free" }],
};

export interface ProviderValidationCase { name: string; id: string; value: unknown }

const cases: ProviderValidationCase[] = [{ name: "valid with prices and no prices", id: "good-provider", value: valid }];
const add = (name: string, value: unknown, id = "good-provider") => cases.push({ name, id, value });
const variants: [string, unknown][] = [
  ["not object null", null], ["not object array", []], ["not object string", "provider"],
  ["missing protocol", { ...valid, protocol: undefined }], ["unsupported protocol", { ...valid, protocol: "grpc" }],
  ["base url wrong type", { ...valid, baseUrl: 4 }], ["base url http public", { ...valid, baseUrl: "http://models.example/v1" }],
  ["base url malformed", { ...valid, baseUrl: "not a url" }], ["base url loopback ipv4", { ...valid, baseUrl: "http://127.0.0.1:9/v1/" }],
  ["base url loopback hostname", { ...valid, baseUrl: "http://localhost:9/v1/" }], ["base url cloud metadata", { ...valid, baseUrl: "http://169.254.169.254/latest/" }],
  ["key env not array", { ...valid, apiKeyEnv: "MODEL_KEY" }], ["key env empty", { ...valid, apiKeyEnv: [] }],
  ["key env lowercase", { ...valid, apiKeyEnv: ["model_key"] }], ["key env mixed", { ...valid, apiKeyEnv: ["MODEL_KEY", 2] }],
  ["key env reserved token", { ...valid, apiKeyEnv: ["SYNAPSER_OPERATOR_TOKEN"] }], ["key env reserved home", { ...valid, apiKeyEnv: ["HOME"] }],
  ["models not array", { ...valid, models: {} }], ["models empty", { ...valid, models: [] }], ["model not object", { ...valid, models: [null] }],
  ["model id missing", { ...valid, models: [{}] }], ["model id blank", { ...valid, models: [{ id: "  " }] }],
  ["duplicate model ids", { ...valid, models: [{ id: "same" }, { id: "same" }] }],
  ["price negative", { ...valid, models: [{ id: "m", usdPer1MIn: -1, usdPer1MOut: 0 }] }],
  ["price wrong type", { ...valid, models: [{ id: "m", usdPer1MIn: "NaN", usdPer1MOut: 0 }] }],
  ["one-sided price", { ...valid, models: [{ id: "m", usdPer1MIn: 0 }] }],
  ["unknown keys ignored", { ...valid, futureField: { enabled: true }, models: [{ id: "m", extra: "ignored" }] }],
];
for (const [name, value] of variants) add(name, value);
add("invalid id slug", valid, "Bad Provider");
add("id boundary 64", valid, `a${"b".repeat(63)}`);
add("id too long", valid, `a${"b".repeat(64)}`);

export const providerValidationCases = cases;
