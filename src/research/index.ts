import { NullResearch, TavilyResearch } from "./adapters.ts";
import type { ResearchPort } from "./types.ts";

export { NullResearch, queryKey, ReplayResearch, TavilyResearch } from "./adapters.ts";
export { extractUrls, retrievedUrls, verifyCitations } from "./citations.ts";
export { QueryGuard } from "./guard.ts";
export { ResearchSession } from "./session.ts";
export * from "./types.ts";

export const TAVILY_KEY_ENV = ["TAVILY_API_KEY", "TAVILY_TOKEN"] as const;

/** Tavily when a key is configured; otherwise research is explicitly OFF (never a silent fake). */
export function researchFromEnv(env: NodeJS.ProcessEnv = process.env): ResearchPort {
  for (const name of TAVILY_KEY_ENV) {
    const v = env[name];
    if (v && v.trim()) return new TavilyResearch({ apiKey: v.trim() });
  }
  return new NullResearch();
}
