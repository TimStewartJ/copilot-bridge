import { EVIDENCE_KINDS, isEvidenceKind, type EvidenceKind } from "./workflow-vocabulary.js";

/**
 * What `verify_complete` records: the agent's evidence that a piece of work is done. The server
 * validates and stores it; the chat reads the same arguments back from the tool call to draw the
 * verified card, so both sides use the reader below.
 */

export const COMPLETION_TOOL_NAME = "verify_complete";

export const EVIDENCE_RESULTS = ["pass", "fail", "not_run"] as const;
export type EvidenceResult = typeof EVIDENCE_RESULTS[number];

export const COMPLETION_STATUSES = ["verified", "partial", "failed"] as const;
export type CompletionStatus = typeof COMPLETION_STATUSES[number];

export const COMPLETION_LIMITS = {
  summary: 2000,
  evidenceItems: 30,
  claim: 500,
  ref: 1000,
  unverifiedItems: 20,
  unverifiedItem: 300,
  notesItems: 10,
  noteItem: 300,
} as const;

export interface CompletionEvidence {
  kind: EvidenceKind;
  claim: string;
  ref?: string;
  result: EvidenceResult;
}

export interface CompletionInput {
  summary: string;
  playbook?: string;
  evidence: CompletionEvidence[];
  /** In-scope checks the work needed that could not be run; each one makes the report partial. */
  unverified: string[];
  /** Caveats outside what was asked, shown with the report without changing its status. */
  notes: string[];
}

export interface CompletionReport extends CompletionInput {
  id: string;
  sessionId: string;
  taskId?: string;
  playbookLabel?: string;
  status: CompletionStatus;
  createdAt: string;
}

export function isEvidenceResult(value: unknown): value is EvidenceResult {
  return typeof value === "string" && (EVIDENCE_RESULTS as readonly string[]).includes(value);
}

export function isCompletionStatus(value: unknown): value is CompletionStatus {
  return typeof value === "string" && (COMPLETION_STATUSES as readonly string[]).includes(value);
}

/** Any failed check fails the report; an in-scope check left unrun makes it partial. Notes never change it. */
export function deriveCompletionStatus(evidence: readonly Pick<CompletionEvidence, "result">[], unverified: readonly string[]): CompletionStatus {
  if (evidence.some((item) => item.result === "fail")) return "failed";
  if (unverified.length > 0 || evidence.some((item) => item.result === "not_run")) return "partial";
  return "verified";
}

function boundedText(value: unknown, name: string, max: number, required: boolean): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return required ? { ok: false, error: `${name} is required` } : { ok: true };
  }
  if (typeof value !== "string") return { ok: false, error: `${name} must be a string` };
  const text = value.trim();
  if (!text) return required ? { ok: false, error: `${name} must not be empty` } : { ok: true };
  if (text.length > max) return { ok: false, error: `${name} must be at most ${max} characters` };
  return { ok: true, value: text };
}

function readTextList(value: unknown, name: string, maxItems: number, maxLength: number): { ok: true; value: string[] } | { ok: false; error: string } {
  const items: string[] = [];
  if (value === undefined || value === null) return { ok: true, value: items };
  if (!Array.isArray(value)) return { ok: false, error: `${name} must be a list of strings` };
  if (value.length > maxItems) return { ok: false, error: `${name} must have at most ${maxItems} items` };
  for (const [index, item] of value.entries()) {
    const text = boundedText(item, `${name}[${index}]`, maxLength, false);
    if (!text.ok) return text;
    if (text.value) items.push(text.value);
  }
  return { ok: true, value: items };
}

export type CompletionInputResult = { ok: true; value: CompletionInput } | { ok: false; error: string };

/** Validates and trims `verify_complete` arguments. */
export function readCompletionInput(args: unknown): CompletionInputResult {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "arguments must be an object" };
  const record = args as Record<string, unknown>;

  const summary = boundedText(record.summary, "summary", COMPLETION_LIMITS.summary, true);
  if (!summary.ok) return summary;
  const playbook = boundedText(record.playbook, "playbook", 80, false);
  if (!playbook.ok) return playbook;

  if (!Array.isArray(record.evidence) || record.evidence.length === 0) {
    return { ok: false, error: "evidence must list at least one check" };
  }
  if (record.evidence.length > COMPLETION_LIMITS.evidenceItems) {
    return { ok: false, error: `evidence must have at most ${COMPLETION_LIMITS.evidenceItems} items` };
  }
  const evidence: CompletionEvidence[] = [];
  for (const [index, item] of record.evidence.entries()) {
    const at = `evidence[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, error: `${at} must be an object` };
    const entry = item as Record<string, unknown>;
    if (!isEvidenceKind(entry.kind)) {
      return { ok: false, error: `${at}.kind must be one of: ${EVIDENCE_KINDS.join(", ")}` };
    }
    if (!isEvidenceResult(entry.result)) {
      return { ok: false, error: `${at}.result must be one of: ${EVIDENCE_RESULTS.join(", ")}` };
    }
    const claim = boundedText(entry.claim, `${at}.claim`, COMPLETION_LIMITS.claim, true);
    if (!claim.ok) return claim;
    const ref = boundedText(entry.ref, `${at}.ref`, COMPLETION_LIMITS.ref, false);
    if (!ref.ok) return ref;
    evidence.push({ kind: entry.kind, claim: claim.value!, ...(ref.value ? { ref: ref.value } : {}), result: entry.result });
  }

  const unverified = readTextList(record.unverified, "unverified", COMPLETION_LIMITS.unverifiedItems, COMPLETION_LIMITS.unverifiedItem);
  if (!unverified.ok) return unverified;
  const notes = readTextList(record.notes, "notes", COMPLETION_LIMITS.notesItems, COMPLETION_LIMITS.noteItem);
  if (!notes.ok) return notes;

  return {
    ok: true,
    value: {
      summary: summary.value!,
      ...(playbook.value ? { playbook: playbook.value } : {}),
      evidence,
      unverified: unverified.value,
      notes: notes.value,
    },
  };
}
