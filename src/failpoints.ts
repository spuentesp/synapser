// Crash/fault injection points (plan 04 §7). In production they are inert. When
// SYNAPSER_ENABLE_FAILPOINTS=1 and SYNAPSER_FAILPOINT=<name>[:<n>] the process SIGKILLs itself
// at the n-th hit of <name>: no finally blocks, no flush — the same exit a real crash has.

export type FailpointName =
  | "after-prepare-commit"
  | "after-claim-intent"
  | "after-zoo-grant"
  | "after-claimed-commit"
  | "after-stale-view"
  | "after-executing-commit"
  | "after-temp-written"
  | "after-first-rename"
  | "between-renames"
  | "after-last-rename"
  | "after-applied-before-reply"
  | "after-release-pending"
  | "after-zoo-release";

/** May be async so in-process tests can hold an action at a precise point. */
export type FailpointHook = (name: FailpointName, ctx: { actionId: string }) => void | Promise<void>;

export function envFailpoint(env: NodeJS.ProcessEnv = process.env): FailpointHook {
  if (env["SYNAPSER_ENABLE_FAILPOINTS"] !== "1" || !env["SYNAPSER_FAILPOINT"]) return () => undefined;
  const [target, nth] = (env["SYNAPSER_FAILPOINT"] as string).split(":");
  const want = Number(nth ?? "1");
  let hits = 0;
  return (name) => {
    if (name !== target) return;
    if (++hits === want) process.kill(process.pid, "SIGKILL");
  };
}
