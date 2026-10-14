// Plan 17 P17.5: per-run injection of one operator-declared provider into a CLI.
// K1: the key never enters argv, a file, the ledger or an error. It travels only in the child's environment,
// under the variable name the operator declared. K6: a variable Synapser reserves cannot hold a provider key.
// K7: cloud metadata addresses are refused. Only providers the current schema can serve are accepted: the
// provider schema speaks openai-compatible, so claude-code and kimi (Anthropic protocol) are refused for now.

export interface InjectedProvider {
  /** Provider id from the operator's file: a lowercase slug. */
  id: string;
  /** Endpoint as the operator declared it. */
  baseUrl: string;
  /** Name of the environment variable that holds the key. The configuration stores only this name. */
  apiKeyEnv: string;
  /** Upstream model id the provider declares. */
  model: string;
}

export interface InjectionPlan {
  /** Added to the child's environment. The key value appears here and nowhere else. */
  env: Record<string, string>;
  /** Flags the injection adds. They carry ids and variable names, never key values. */
  argv: string[];
  /** A JSON object the adapter merges into its own home configuration file (path relative to HOME). */
  homeJson?: { path: string; value: Record<string, unknown> };
}

/** K6: variables Synapser reserves for itself (the operator token and its own credentials). */
export const RESERVED_ENV = /^SYNAPSER_/;

/** K7 (proposal): cloud metadata addresses, refused whoever declares them. */
const METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata", "fd00:ec2::254"]);

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MODEL = /^[A-Za-z0-9._:/-]{1,200}$/;

/** Refuses a provider that must not reach a CLI. Messages never include a key value. */
export function checkInjectedProvider(p: InjectedProvider): void {
  if (!SLUG.test(p.id)) throw new Error("provider id must be a lowercase slug");
  if (!ENV_NAME.test(p.apiKeyEnv)) throw new Error("apiKeyEnv must be an environment variable name");
  if (RESERVED_ENV.test(p.apiKeyEnv)) throw new Error(`${p.apiKeyEnv} is reserved by Synapser and cannot hold a provider key (plan 17 K6)`);
  if (!MODEL.test(p.model)) throw new Error("model id contains characters a CLI flag cannot carry");
  let url: URL;
  try {
    url = new URL(p.baseUrl);
  } catch {
    throw new Error("baseUrl is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("baseUrl must be http or https");
  if (METADATA_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("baseUrl points at a cloud metadata address (plan 17 K7)");
}

/** Builds what one run needs to talk to the provider through the named CLI. */
export function planInjection(adapterId: string, p: InjectedProvider, source: NodeJS.ProcessEnv): InjectionPlan {
  checkInjectedProvider(p);
  const value = source[p.apiKeyEnv];
  if (!value) throw new Error(`${p.apiKeyEnv} is not set in the operator's environment`);
  const env: Record<string, string> = { [p.apiKeyEnv]: value };
  switch (adapterId) {
    case "codex":
      // codex runs with --ignore-user-config, so the provider travels as -c overrides, not as a file.
      return {
        env,
        argv: [
          "-c", `model_provider=${JSON.stringify(p.id)}`,
          "-c", `model_providers.${p.id}={name=${JSON.stringify(p.id)},base_url=${JSON.stringify(p.baseUrl)},env_key=${JSON.stringify(p.apiKeyEnv)},wire_api="responses"}`,
          "-m", p.model,
        ],
      };
    case "mimo":
      return {
        env,
        argv: ["--model", `${p.id}/${p.model}`],
        homeJson: {
          path: ".config/mimocode/mimocode.jsonc",
          value: {
            provider: {
              [p.id]: {
                npm: "@ai-sdk/openai-compatible",
                name: p.id,
                options: { baseURL: p.baseUrl, apiKey: `{env:${p.apiKeyEnv}}` },
                models: { [p.model]: { name: p.model } },
              },
            },
          },
        },
      };
    case "claude-code":
    case "kimi":
      throw new Error(`${adapterId} speaks the Anthropic protocol, and the provider schema has only openai-compatible (plan 17, decision pending)`);
    default:
      throw new Error(`no provider injection for adapter ${adapterId}`);
  }
}
