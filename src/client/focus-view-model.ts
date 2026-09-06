import type { FocusCoverageRead, FocusDomain, FocusLifecycle, FocusObjectDetails, FocusSnapshot } from "./api";

export const FOCUS_FRESHNESS_MS = 45_000;
export function isFocusReadFresh(observedAt: number, now: number): boolean {
  return Number.isFinite(observedAt) && observedAt > 0 && Math.abs(now - observedAt) <= FOCUS_FRESHNESS_MS;
}
export const FOCUS_LIFECYCLE_LABELS: Record<FocusLifecycle, string> = {
  active: "Active",
  acknowledged: "Acknowledged",
  handed_off: "Handed off",
  resolved: "Resolved",
  accepted_risk: "Risk accepted",
  dismissed: "Dismissed",
};

export function isFocusOpen(lifecycle: FocusLifecycle): boolean {
  return lifecycle === "active" || lifecycle === "acknowledged" || lifecycle === "handed_off";
}

export function focusTime(value: string | null): string {
  if (!value) return "Not specified";
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : "Unknown time";
}

export function focusEvidenceValidity(details: Pick<FocusObjectDetails, "observedAt" | "validUntil">, now: number): "valid" | "expired" | "unknown" {
  const observedAt = details.observedAt ? Date.parse(details.observedAt) : NaN;
  const validUntil = details.validUntil ? Date.parse(details.validUntil) : NaN;
  if (Number.isFinite(validUntil) && validUntil <= now) return "expired";
  if (!Number.isFinite(observedAt) || !Number.isFinite(validUntil) || observedAt > now || validUntil <= observedAt) return "unknown";
  return "valid";
}

export function focusHasDueHandoff(snapshot: FocusSnapshot, now: number): boolean {
  return (snapshot.overdueHandoffTotal ?? 0) > 0 || (snapshot.overdueHandoffs ?? []).length > 0
    || snapshot.upcomingInterventions.some((item) => item.objectType !== "event" && item.lifecycle === "handed_off" && Date.parse(item.interventionBy) <= now)
    || (snapshot.quietConcerns ?? []).some((item) => item.lifecycle === "handed_off" && item.interventionBy !== null && Date.parse(item.interventionBy) <= now);
}

export function focusDueHandoffCount(snapshot: FocusSnapshot | undefined, now: number): number | null {
  if (snapshot?.overdueHandoffTotal == null) return null;
  const knownIds = new Set([
    ...snapshot.overdueHandoffs.map((item) => item.objectId),
    ...snapshot.upcomingInterventions.filter((item) => item.objectType !== "event" && item.lifecycle === "handed_off" && Date.parse(item.interventionBy) <= now).map((item) => item.objectId),
    ...snapshot.quietConcerns.filter((item) => item.lifecycle === "handed_off" && item.interventionBy && Date.parse(item.interventionBy) <= now).map((item) => item.objectId),
  ]);
  return Math.max(snapshot.overdueHandoffTotal, knownIds.size);
}

export function coverageNeedsRefresh(assertion: FocusCoverageRead, now: number): boolean {
  if (assertion.state !== "valid") return false;
  return !assertion.lastCheckedAt || !assertion.validUntil
    || Date.parse(assertion.lastCheckedAt) + assertion.expectedIntervalMinutes * 60_000 < now
    || Date.parse(assertion.validUntil) <= now + assertion.atRiskMinutes * 60_000
    || Boolean(assertion.interventionBy && Date.parse(assertion.interventionBy) <= now + assertion.atRiskMinutes * 60_000);
}

export interface FocusQueryHealth {
  loading: boolean;
  error?: unknown;
  updatedAt: number;
}

export function focusQueryProblem(name: string, health: FocusQueryHealth, now: number): string | null {
  if (health.error) return `${name} unavailable; any displayed records are from the last successful read`;
  if (health.loading || !health.updatedAt) return `${name} not yet checked`;
  if (!isFocusReadFresh(health.updatedAt, now)) return `${name} needs a fresh read`;
  return null;
}

export function assessFocusOverview(
  snapshot: FocusSnapshot | undefined,
  now: number,
  queries: Record<"Actions" | "Alerts" | "Decisions", FocusQueryHealth>,
  snapshotError?: unknown,
): { state: "partial" | "complete" | "clear"; problems: string[] } {
  const problems = Object.entries(queries).flatMap(([name, health]) => {
    const problem = focusQueryProblem(name, health, now);
    return problem ? [problem] : [];
  });
  if (!snapshot) return { state: "partial", problems: [...problems, "Focus coverage and digests not yet checked"] };
  const observed = Date.parse(snapshot.generatedAt);
  if (snapshotError) problems.push("Focus snapshot unavailable; showing the last successful read");
  if (!isFocusReadFresh(observed, now)) {
    problems.push("Focus snapshot freshness is unknown or stale");
  }
  const domains: FocusDomain[] = ["actions", "alerts", "decisions", "overdueHandoffs", "quietConcerns", "digests", "coverage", "authority", "audits", "compatibility", "telemetry"];
  for (const domain of domains) {
    const health = snapshot.domainHealth[domain];
    if (health?.status !== "ok") problems.push(`${domain}: ${health?.error ?? "state unknown"}`);
  }
  if ([snapshot.actionTotal, snapshot.alertTotal, snapshot.decisionTotal, snapshot.attentionTotal, snapshot.handedOffTotal, snapshot.overdueHandoffTotal, snapshot.quietConcernTotal].some((total) => total == null)) {
    problems.push("One or more attention totals are unknown");
  }
  if (snapshot.quietConcernTotal != null && snapshot.quietConcernTotal > snapshot.quietConcerns.length) {
    problems.push("Quiet concern summaries are capped; future intervention timing is incomplete until rechecked");
  }
  const coverage = snapshot.coverage;
  if (!coverage.summary || coverage.summary.total === 0) problems.push("No coverage assertions; silence is not assurance");
  else if (coverage.assertions.length !== coverage.summary.total) problems.push("Coverage assertions are incomplete");
  if (coverage.assertions.some((assertion) => coverageNeedsRefresh(assertion, now))) {
    problems.push("A coverage observation or intervention horizon needs refresh");
  }
  if (snapshot.authorityConstraints.some((grant) => grant.currentlyActive
    && (Date.parse(grant.validUntil) <= now || Date.parse(grant.validFrom) > now))) {
    problems.push("Authority validity changed since the last check");
  }
  if (problems.length) return { state: "partial", problems };
  const clear = snapshot.allClear && snapshot.attentionTotal === 0
    && snapshot.handedOffTotal === 0
    && snapshot.overdueHandoffTotal === 0 && !focusHasDueHandoff(snapshot, now)
    && snapshot.coverage.summary!.counts.valid === snapshot.coverage.summary!.total
    && snapshot.auditExceptions.length === 0;
  return { state: clear ? "clear" : "complete", problems };
}
