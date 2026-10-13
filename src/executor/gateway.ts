// The surface the agent loop uses to touch the workspace. The Executor is the production
// implementation; src/bench/naive-gateway.ts is the A/B CONTROL (same loop, same tools, same
// prompts — only this port differs). Keeping the control behind the port means the Executor never
// grows a "skip the checks" switch.
import type { Executor } from "./executor.ts";

export type WriteGateway = Pick<Executor, "beginSession" | "readFiles" | "proposePatch" | "applyAction">;
