// Single source of truth for legal action transitions (plan 01). The same table is loaded into
// SQLite and enforced by a trigger, so a bug in the executor cannot skip a state.

export const ACTION_STATES = [
  "PREPARED",
  "CLAIMING",
  "WAITING_RESOURCE",
  "CLAIMED",
  "STALE_VIEW",
  "EXECUTING",
  "APPLIED",
  "RELEASE_PENDING",
  "SETTLED",
  "RECOVERY_REQUIRED",
  "REJECTED",
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export const ACTION_TRANSITIONS: readonly (readonly [ActionState, ActionState])[] = [
  ["PREPARED", "CLAIMING"],
  ["PREPARED", "REJECTED"],
  ["CLAIMING", "CLAIMED"],
  ["CLAIMING", "WAITING_RESOURCE"],
  ["CLAIMING", "RECOVERY_REQUIRED"],
  ["WAITING_RESOURCE", "CLAIMING"],
  ["WAITING_RESOURCE", "REJECTED"],
  ["CLAIMED", "EXECUTING"],
  ["CLAIMED", "STALE_VIEW"],
  ["CLAIMED", "WAITING_RESOURCE"], // claim lost across a restart: retry the acquisition
  ["CLAIMED", "RECOVERY_REQUIRED"],
  ["STALE_VIEW", "RELEASE_PENDING"],
  ["EXECUTING", "APPLIED"],
  ["EXECUTING", "RECOVERY_REQUIRED"],
  ["APPLIED", "RELEASE_PENDING"],
  ["APPLIED", "RECOVERY_REQUIRED"], // disk no longer matches what we applied
  ["RELEASE_PENDING", "SETTLED"],
  ["RELEASE_PENDING", "RECOVERY_REQUIRED"],
  ["RECOVERY_REQUIRED", "APPLIED"],
  ["RECOVERY_REQUIRED", "EXECUTING"],
  ["RECOVERY_REQUIRED", "REJECTED"],
];

const legal = new Set(ACTION_TRANSITIONS.map(([a, b]) => `${a}>${b}`));
export const isLegalTransition = (from: ActionState, to: ActionState): boolean => legal.has(`${from}>${to}`);

/** Terminal for scheduling purposes: nothing more will happen to this action. */
export const TERMINAL_STATES: readonly ActionState[] = ["SETTLED", "REJECTED"];
export const isTerminal = (s: ActionState): boolean => TERMINAL_STATES.includes(s);
