import type { Deadline } from "../deadline.js";
import { PROCESS_TREE_TERMINATION_BUDGET_MS, type ProcessTreeTerminationObservation } from "../platform.js";

export const RUNTIME_FENCE_STARTUP_WAIT_MS = 10_000;
export const RUNTIME_FENCE_CHILD_EXIT_WAIT_MS = 5_000;
// A stdio owner may need separate native-subtree and loader termination phases.
export const RUNTIME_FENCE_BUDGET_MS = 2 * PROCESS_TREE_TERMINATION_BUDGET_MS
  + RUNTIME_FENCE_STARTUP_WAIT_MS + RUNTIME_FENCE_CHILD_EXIT_WAIT_MS;

export interface RuntimeFenceObservation extends Omit<ProcessTreeTerminationObservation, "phase"> {
  phase: ProcessTreeTerminationObservation["phase"] | "startup" | "survivors" | "child-exit";
}

export interface RuntimeFenceOptions {
  /** The first fence caller owns this absolute deadline; joiners cannot reset it. */
  deadline?: Deadline;
  onPhase?: (observation: RuntimeFenceObservation) => void;
}
