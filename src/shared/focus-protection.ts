export type FocusProtectionStatus = "scheduled" | "active" | "completed" | "cancelled";

export interface FocusProtectionRequest {
  startsAt?: string;
  endsAt: string;
  timezone: string;
  reason: string;
  allowNeedsInput: boolean;
  allowAuthorizedDeadlineOverride: boolean;
}

export interface FocusProtectionWindow extends Required<FocusProtectionRequest> {
  id: string;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  status: FocusProtectionStatus;
}

export type FocusProtectionWorkKind = "schedule" | "defer" | "defer-loop" | "notification" | "needs-input";
export interface FocusProtectionWork {
  kind: FocusProtectionWorkKind;
  workId: string;
  scheduledFor: string;
  title?: string;
  sessionId?: string;
}
export type FocusProtectionDisposition = "started" | "delivered" | "expired" | "cancelled" | "superseded" | "no-longer-needed" | "failed";
export interface FocusProtectionHold extends FocusProtectionWork {
  id: string;
  windowId: string;
  endsAt: string;
  createdAt: string;
}
export interface FocusProtectionImpact extends FocusProtectionHold {
  disposition: FocusProtectionDisposition | null;
  settledAt: string | null;
}
export interface FocusProtectionImpactSummary {
  postponed: number;
  pending: number;
  dispositions: Partial<Record<FocusProtectionDisposition, number>>;
  recent: FocusProtectionImpact[];
}

export interface FocusProtectionSession {
  sessionId: string;
  title: string;
  taskId: string | null;
  muted: boolean;
  busy: boolean;
  pendingUserInputCount: number;
}
export interface FocusProtectionScheduleImpact {
  id: string;
  name: string;
  taskId: string;
  type: "cron" | "once";
  slotsDue: number;
  /** False means slotsDue is only a lower bound, including an unknown zero. */
  slotCountComplete?: boolean;
  firstScheduledFor: string | null;
  lastScheduledFor: string | null;
  expiresAt: string | null;
}
export interface FocusProtectionDeferImpact {
  id: string;
  deferId: string;
  kind: "defer" | "defer-loop";
  sessionId: string;
  name: string;
  scheduledFor: string;
  expiresAt: string | null;
  expiresDuringProtection: boolean;
}
export interface FocusProtectionIntervention {
  objectId: string;
  activationId: string;
  objectType: "alert" | "decision";
  title: string;
  interventionBy: string;
  taskId: string | null;
  taskState: string;
  notificationMode: "focus" | "summary" | "immediate";
  consequenceOfDelay: string | null;
}
export interface FocusProtectionInFlight {
  kind: "session" | "schedule" | "defer" | "defer-loop" | "session-creation";
  id: string;
  name: string;
  sessionId?: string;
}
export interface FocusProtectionPreview {
  generatedAt: string;
  request: FocusProtectionRequest;
  startsAt: string;
  endsAt: string;
  schedules: FocusProtectionScheduleImpact[];
  defers: FocusProtectionDeferImpact[];
  needsInput: FocusProtectionSession[];
  interventions: FocusProtectionIntervention[];
  inFlight: FocusProtectionInFlight[];
  continuingRecoveryPrompts: number;
  confirmationToken: string;
}
export interface FocusProtectionCreateRequest extends FocusProtectionRequest {
  confirmationToken: string;
  confirmInterventionConflicts: boolean;
}
export interface FocusProtectionSnapshot {
  generatedAt: string;
  current: FocusProtectionWindow | null;
  upcoming: FocusProtectionWindow | null;
  latest: FocusProtectionWindow | null;
  impacts: FocusProtectionImpactSummary;
}
export interface FocusProtectionPage {
  generatedAt: string;
  windows: FocusProtectionWindow[];
  nextOffset: number | null;
}

export const MAX_FOCUS_PROTECTION_DURATION_MS = 7 * 24 * 60 * 60_000;
