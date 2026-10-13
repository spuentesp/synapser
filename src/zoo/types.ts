// Types for the Zoanthrope adapter (design §13). Shapes were captured from the
// real 0.1.3 binary, not from the README: see test/zoo/g1-adapter.test.ts.

import type { WorkspacePath } from "../workspace/paths.ts";

export type Intent = "read" | "edit";

export interface CallerStamp {
  name: string;
  value: string;
}

export interface Grant {
  path: WorkspacePath;
  intent: Intent;
  claimedAt: number;
  purpose: string | null;
  callerStamps: CallerStamp[];
}

/** `isError=false, ok=false`: a business refusal, never a grant (S14). */
export interface Conflict {
  holder: string;
  path: string;
  holderStale: boolean;
  intent: Intent;
  purpose: string | null;
  claimedAt: number | null;
  /** Present for stale-claim style refusals, e.g. "stale-claim". */
  reason: string | null;
  callerStamps: CallerStamp[];
  /** The body exactly as received, so nothing the engine said is lost. */
  raw: unknown;
}

export type ClaimResult =
  | { kind: "granted"; agent: string; grants: Grant[] }
  | { kind: "conflict"; agent: string; conflict: Conflict };

export interface ClaimView {
  agent: string;
  path: string;
  intent: Intent;
  claimedAt: number;
  purpose: string | null;
  heldByStale: boolean;
  callerStamps: CallerStamp[];
}

export interface ReleaseResult {
  agent: string;
  requested: WorkspacePath[];
  released: string[];
  /** Claims the registry still lists for this agent among `requested` after release. */
  stillHeld: string[];
  /**
   * Zoanthrope ignores some errors from fs_lease::release, so `released` says nothing
   * about leases on disk. Never promoted to "cleared" by this adapter (design §15).
   */
  fsCleanup: "NOT_ATTESTED";
  /** CLEARED only when the registry lists zero claims for this agent (design §15). */
  registryCleanup: "CLEARED" | "UNVERIFIED";
  /** All claims this agent still holds, or null when the verification call itself failed. */
  remainingOwnClaims: string[] | null;
}

export interface RejoinResult {
  agent: string;
  claimsKept: string[];
  claimsAtRisk: string[];
  viewEpoch: number;
}

export interface WireRecord {
  t: number;
  dir: "out" | "in";
  line: string;
}

export type ZooErrorKind =
  | "SPAWN_FAILED"
  | "TRANSPORT_CLOSED"
  | "TIMEOUT"
  | "JSONRPC_ERROR"
  | "TOOL_ERROR" // isError=true
  | "MALFORMED"
  | "PROTOCOL_VIOLATION" // grant does not match request
  | "VERSION_MISMATCH"
  | "QUARANTINED" // mutating call refused until reconcile()
  | "HALTED"; // child exit could not be confirmed

/** Dependency failure. Callers must treat it as "no grant", never as advisory success (S09, S14). */
export class ZooError extends Error {
  readonly kind: ZooErrorKind;
  readonly detail?: unknown;
  constructor(kind: ZooErrorKind, message: string, detail?: unknown) {
    super(`zoanthrope ${kind}: ${message}`);
    this.name = "ZooError";
    this.kind = kind;
    this.detail = detail;
  }
}
