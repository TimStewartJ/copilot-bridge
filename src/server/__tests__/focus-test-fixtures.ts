import type { FocusMutationInput } from "../focus-details-store.js";

export const decisionDetails = { alternatives: ["Proceed", "Defer"], recommendation: "Proceed" };

export function alertDetails(): FocusMutationInput {
  return {
    evidence: ["Service health check failed"], impact: "Requests cannot complete",
    sourceFamily: "health", producer: "health-check",
    observedAt: new Date().toISOString(), interventionBy: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

export function eventDetails(): FocusMutationInput {
  return { sourceFamily: "release", producer: "release-watch", observedAt: new Date().toISOString() };
}
