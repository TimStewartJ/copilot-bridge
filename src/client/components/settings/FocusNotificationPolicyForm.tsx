import { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  DEFAULT_FOCUS_NOTIFICATION_POLICY,
  MAX_FOCUS_COALESCE_MINUTES,
  MAX_FOCUS_REVIEW_TIMES,
  isFocusClockTime,
  type FocusNotificationPolicy,
} from "../../../shared/focus-notification-policy.js";
import { useSettingsMutation, useSettingsQuery } from "../../hooks/queries/useSettings";

interface PolicyDraft {
  timezone: string;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  reviewTimes: string;
  coalesceMinutes: string;
  enableAuthorizedImmediate: boolean;
  allowGrantQuietHoursOverride: boolean;
}

type PolicyErrors = Partial<Record<"timezone" | "quietHours" | "reviewTimes" | "coalesceMinutes", string>>;

interface EditorState {
  draft: PolicyDraft;
  saved: PolicyDraft;
  errors: PolicyErrors;
  feedback: { tone: "success" | "error"; message: string } | null;
}

function policyDraft(policy: FocusNotificationPolicy = DEFAULT_FOCUS_NOTIFICATION_POLICY): PolicyDraft {
  const quietHours = policy.quietHours ?? DEFAULT_FOCUS_NOTIFICATION_POLICY.quietHours;
  return {
    timezone: policy.timezone,
    quietHoursEnabled: policy.quietHours !== null,
    quietStart: quietHours?.start ?? "22:00",
    quietEnd: quietHours?.end ?? "08:00",
    reviewTimes: policy.reviewTimes.join(", "),
    coalesceMinutes: String(policy.coalesceMinutes),
    enableAuthorizedImmediate: policy.enableAuthorizedImmediate,
    allowGrantQuietHoursOverride: policy.allowGrantQuietHoursOverride,
  };
}

function sameDraft(a: PolicyDraft, b: PolicyDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function editorState(draft: PolicyDraft): EditorState {
  return { draft, saved: draft, errors: {}, feedback: null };
}

function validatePolicy(draft: PolicyDraft): { policy: FocusNotificationPolicy | null; errors: PolicyErrors } {
  const errors: PolicyErrors = {};
  const timezone = draft.timezone.trim();
  const timezoneError = "Enter a valid IANA timezone, such as America/Los_Angeles or UTC.";
  if (timezone.length > 100 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(timezone)) {
    errors.timezone = timezoneError;
  } else {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      errors.timezone = timezoneError;
    }
  }

  if (draft.quietHoursEnabled) {
    if (!isFocusClockTime(draft.quietStart) || !isFocusClockTime(draft.quietEnd)) {
      errors.quietHours = "Enter quiet-hours start and end as HH:mm clock times.";
    } else if (draft.quietStart === draft.quietEnd) {
      errors.quietHours = "Quiet-hours start and end must differ.";
    }
  }

  const reviewTimes = draft.reviewTimes.split(",").map((time) => time.trim());
  if (reviewTimes.length > MAX_FOCUS_REVIEW_TIMES || !reviewTimes.every(isFocusClockTime)) {
    errors.reviewTimes = `Enter 1–${MAX_FOCUS_REVIEW_TIMES} review times as HH:mm, separated by commas.`;
  } else if (new Set(reviewTimes).size !== reviewTimes.length) {
    errors.reviewTimes = "Review times must be unique.";
  }

  const coalesceMinutes = Number(draft.coalesceMinutes);
  if (!draft.coalesceMinutes.trim() || !Number.isInteger(coalesceMinutes)
    || coalesceMinutes < 0 || coalesceMinutes > MAX_FOCUS_COALESCE_MINUTES) {
    errors.coalesceMinutes = `Enter a whole number from 0 to ${MAX_FOCUS_COALESCE_MINUTES} minutes.`;
  }

  return {
    errors,
    policy: Object.keys(errors).length ? null : {
      timezone,
      quietHours: draft.quietHoursEnabled ? { start: draft.quietStart, end: draft.quietEnd } : null,
      reviewTimes,
      coalesceMinutes,
      enableAuthorizedImmediate: draft.enableAuthorizedImmediate,
      allowGrantQuietHoursOverride: draft.allowGrantQuietHoursOverride,
    },
  };
}

const inputClassName = "min-h-11 w-full min-w-0 rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50";
const buttonClassName = "min-h-11 rounded-md px-3 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50";

export function FocusNotificationPolicyForm() {
  const settingsQuery = useSettingsQuery();
  const settingsMutation = useSettingsMutation();
  const id = useId();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const dirty = editor !== null && !sameDraft(editor.draft, editor.saved);

  useEffect(() => {
    if (!settingsQuery.data || savingRef.current) return;
    const next = policyDraft(settingsQuery.data.focusNotifications ?? DEFAULT_FOCUS_NOTIFICATION_POLICY);
    setEditor((current) => {
      if (current && (!sameDraft(current.draft, current.saved) || sameDraft(current.saved, next))) {
        return current;
      }
      return editorState(next);
    });
  }, [settingsQuery.data]);

  const updateDraft = (changes: Partial<PolicyDraft>) => {
    if (savingRef.current) return;
    setEditor((current) => current ? {
      ...current,
      draft: { ...current.draft, ...changes },
      errors: {},
      feedback: null,
    } : current);
  };

  const discard = () => {
    if (!editor || savingRef.current) return;
    setEditor(editorState(settingsQuery.data
      ? policyDraft(settingsQuery.data.focusNotifications ?? DEFAULT_FOCUS_NOTIFICATION_POLICY)
      : editor.saved));
  };

  const save = async () => {
    if (!editor || !dirty || savingRef.current) return;
    const { policy, errors } = validatePolicy(editor.draft);
    setEditor((current) => current ? { ...current, errors, feedback: null } : current);
    if (!policy) return;

    savingRef.current = true;
    setSaving(true);
    try {
      // The server replaces this policy, including quietHours, rather than merging nested edits.
      const updated = await settingsMutation.mutateAsync({ focusNotifications: policy });
      setEditor({
        ...editorState(policyDraft(updated.focusNotifications ?? DEFAULT_FOCUS_NOTIFICATION_POLICY)),
        feedback: { tone: "success", message: "Focus delivery policy saved." },
      });
    } catch (error) {
      setEditor((current) => current ? {
        ...current,
        feedback: {
          tone: "error",
          message: `Could not save Focus delivery policy: ${error instanceof Error ? error.message : String(error)}`,
        },
      } : current);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const draft = editor?.draft;
  const errors = editor?.errors ?? {};

  return (
    <div className="mt-4 space-y-4 rounded-md border border-border bg-bg-elevated p-4">
      <div>
        <h3 id={`${id}-heading`} className="text-sm font-medium text-text-primary">Focus delivery policy</h3>
        <p className="mt-1 text-xs text-text-muted">
          Persistence is not permission to interrupt. Saving an item preserves its state; it does not authorize a notification.
          Routine completions remain quiet.
        </p>
      </div>

      {settingsQuery.error && (
        <div className="space-y-2 rounded-md border border-error/25 bg-error/10 p-3">
          <p role="alert" className="text-xs text-error">
            Could not load Focus delivery policy: {settingsQuery.error.message}
            {editor ? " Showing the last loaded policy; unsaved edits are preserved." : ""}
          </p>
          <button
            type="button"
            onClick={() => void settingsQuery.refetch()}
            disabled={settingsQuery.isFetching}
            className={`${buttonClassName} bg-bg-surface text-text-secondary hover:bg-bg-hover`}
          >
            {settingsQuery.isFetching ? "Retrying…" : "Retry policy loading"}
          </button>
        </div>
      )}

      {!editor && !settingsQuery.error && (
        <p role="status" className="text-xs text-text-muted">Loading Focus delivery policy…</p>
      )}

      {editor && draft && (
        <form
          aria-labelledby={`${id}-heading`}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="space-y-4"
        >
          <fieldset disabled={saving} className="space-y-4" aria-busy={saving}>
            <legend className="sr-only">Focus delivery policy settings</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor={`${id}-timezone`} className="block text-xs font-medium text-text-secondary">IANA timezone</label>
                <input
                  id={`${id}-timezone`}
                  name="timezone"
                  type="text"
                  value={draft.timezone}
                  onChange={(event) => updateDraft({ timezone: event.target.value })}
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={100}
                  placeholder="America/Los_Angeles"
                  aria-invalid={!!errors.timezone}
                  aria-describedby={`${id}-timezone-help${errors.timezone ? ` ${id}-timezone-error` : ""}`}
                  className={inputClassName}
                />
                <p id={`${id}-timezone-help`} className="text-xs text-text-muted">All times below use this timezone, not the browser timezone.</p>
                {errors.timezone && <p id={`${id}-timezone-error`} className="text-xs text-error">{errors.timezone}</p>}
              </div>
              <div className="space-y-1">
                <label htmlFor={`${id}-coalesce`} className="block text-xs font-medium text-text-secondary">Coalescing window (minutes)</label>
                <input
                  id={`${id}-coalesce`}
                  name="coalesceMinutes"
                  type="number"
                  min={0}
                  max={MAX_FOCUS_COALESCE_MINUTES}
                  step={1}
                  value={draft.coalesceMinutes}
                  onChange={(event) => updateDraft({ coalesceMinutes: event.target.value })}
                  aria-invalid={!!errors.coalesceMinutes}
                  aria-describedby={`${id}-coalesce-help${errors.coalesceMinutes ? ` ${id}-coalesce-error` : ""}`}
                  className={inputClassName}
                />
                <p id={`${id}-coalesce-help`} className="text-xs text-text-muted">
                  Hold eligible Focus alerts for up to {MAX_FOCUS_COALESCE_MINUTES} minutes to coalesce updates. Zero adds no delay; intervention deadlines can shorten the wait.
                </p>
                {errors.coalesceMinutes && <p id={`${id}-coalesce-error`} className="text-xs text-error">{errors.coalesceMinutes}</p>}
              </div>
            </div>

            <div className="space-y-2">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-medium text-text-secondary">
                <input
                  name="quietHoursEnabled"
                  type="checkbox"
                  checked={draft.quietHoursEnabled}
                  onChange={(event) => updateDraft({ quietHoursEnabled: event.target.checked })}
                  aria-describedby={`${id}-quiet-help`}
                  className="h-4 w-4 accent-accent"
                />
                Use quiet hours
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor={`${id}-quiet-start`} className="block text-xs font-medium text-text-secondary">Quiet hours start</label>
                  <input
                    id={`${id}-quiet-start`}
                    name="quietStart"
                    type="time"
                    value={draft.quietStart}
                    disabled={!draft.quietHoursEnabled}
                    onChange={(event) => updateDraft({ quietStart: event.target.value })}
                    aria-invalid={!!errors.quietHours}
                    aria-describedby={`${id}-quiet-help${errors.quietHours ? ` ${id}-quiet-error` : ""}`}
                    className={inputClassName}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor={`${id}-quiet-end`} className="block text-xs font-medium text-text-secondary">Quiet hours end</label>
                  <input
                    id={`${id}-quiet-end`}
                    name="quietEnd"
                    type="time"
                    value={draft.quietEnd}
                    disabled={!draft.quietHoursEnabled}
                    onChange={(event) => updateDraft({ quietEnd: event.target.value })}
                    aria-invalid={!!errors.quietHours}
                    aria-describedby={`${id}-quiet-help${errors.quietHours ? ` ${id}-quiet-error` : ""}`}
                    className={inputClassName}
                  />
                </div>
              </div>
              <p id={`${id}-quiet-help`} className="text-xs text-text-muted">
                Quiet hours can cross midnight. Turn off to disable them; other delivery and authority checks still apply.
              </p>
              {errors.quietHours && <p id={`${id}-quiet-error`} className="text-xs text-error">{errors.quietHours}</p>}
            </div>

            <div className="space-y-1">
              <label htmlFor={`${id}-reviews`} className="block text-xs font-medium text-text-secondary">Review times</label>
              <input
                id={`${id}-reviews`}
                name="reviewTimes"
                type="text"
                value={draft.reviewTimes}
                onChange={(event) => updateDraft({ reviewTimes: event.target.value })}
                placeholder="09:00, 17:00"
                aria-invalid={!!errors.reviewTimes}
                aria-describedby={`${id}-reviews-help${errors.reviewTimes ? ` ${id}-reviews-error` : ""}`}
                className={inputClassName}
              />
              <p id={`${id}-reviews-help`} className="text-xs text-text-muted">
                Enter 1–{MAX_FOCUS_REVIEW_TIMES} unique 24-hour HH:mm times, separated by commas. These are review windows, not a promise of a push at each time.
              </p>
              {errors.reviewTimes && <p id={`${id}-reviews-error`} className="text-xs text-error">{errors.reviewTimes}</p>}
            </div>

            <div className="space-y-3 border-t border-border pt-3">
              <label className="flex min-h-11 cursor-pointer items-start gap-2 py-2 text-xs text-text-secondary">
                <input
                  name="enableAuthorizedImmediate"
                  type="checkbox"
                  checked={draft.enableAuthorizedImmediate}
                  onChange={(event) => updateDraft({ enableAuthorizedImmediate: event.target.checked })}
                  aria-labelledby={`${id}-immediate-label`}
                  aria-describedby={`${id}-immediate-help`}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                />
                <span>
                  <span id={`${id}-immediate-label`} className="font-medium">Allow authorized immediate Focus alerts</span>
                  <span id={`${id}-immediate-help`} className="mt-1 block text-text-muted">
                    Requires a matching active authority grant that permits immediate delivery. This switch does not create or broaden a grant.
                  </span>
                </span>
              </label>
              <label className="flex min-h-11 cursor-pointer items-start gap-2 py-2 text-xs text-text-secondary">
                <input
                  name="allowGrantQuietHoursOverride"
                  type="checkbox"
                  checked={draft.allowGrantQuietHoursOverride}
                  onChange={(event) => updateDraft({ allowGrantQuietHoursOverride: event.target.checked })}
                  aria-labelledby={`${id}-override-label`}
                  aria-describedby={`${id}-override-help`}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                />
                <span>
                  <span id={`${id}-override-label`} className="font-medium">Allow grant-authorized quiet-hours override</span>
                  <span id={`${id}-override-help`} className="mt-1 block text-text-muted">
                    Quiet hours may be bypassed only when this policy and a matching active grant both permit it, with authorized immediate alerts enabled.
                    This is not an unconditional bypass and does not create authority grants.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          {Object.keys(errors).length > 0 && (
            <p role="alert" className="text-xs text-error">Check the highlighted policy fields before saving.</p>
          )}
          {editor.feedback && (
            <p
              role={editor.feedback.tone === "error" ? "alert" : "status"}
              className={`text-xs ${editor.feedback.tone === "error" ? "text-error" : "text-success"}`}
            >
              {editor.feedback.message}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={!dirty || saving}
              className={`${buttonClassName} inline-flex items-center gap-1.5 bg-accent text-white hover:bg-accent-hover`}
            >
              {saving && <Loader2 size={12} aria-hidden="true" className="animate-spin" />}
              {saving ? "Saving policy…" : "Save policy"}
            </button>
            <button
              type="button"
              onClick={discard}
              disabled={!dirty || saving}
              className={`${buttonClassName} bg-bg-surface text-text-secondary hover:bg-bg-hover`}
            >
              Discard changes
            </button>
            <button
              type="button"
              onClick={() => updateDraft(policyDraft())}
              disabled={saving}
              className={`${buttonClassName} text-text-muted hover:bg-bg-hover`}
            >
              Use defaults
            </button>
            {dirty && !saving && <span role="status" className="text-xs text-text-muted">Unsaved policy changes</span>}
          </div>
          <p className="text-xs text-text-muted">Changes, including defaults, apply only after Save policy. Browser push subscription is managed separately.</p>
        </form>
      )}
    </div>
  );
}
