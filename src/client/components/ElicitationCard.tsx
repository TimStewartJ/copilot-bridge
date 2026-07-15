import { ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import type {
  ElicitationFieldValue,
  ElicitationResponseEndpointPayload,
  ElicitationSchemaField,
  ElicitationTextField,
  PendingElicitationRequestView,
} from "../api";

const CHAT_RAIL_CLASS = "mx-auto w-full max-w-4xl px-3 sm:px-4 md:px-6 lg:px-8";

type FieldDraft = string | boolean | string[] | undefined;

interface ElicitationCardProps {
  request: PendingElicitationRequestView;
  onSubmit: (
    requestId: string,
    payload: ElicitationResponseEndpointPayload,
  ) => Promise<void>;
}

function getSubmitError(error: unknown): string {
  if (
    error
    && typeof error === "object"
    && "status" in error
    && error.status === 404
  ) {
    return "This question is no longer active. The run may have ended before your response was accepted.";
  }
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Failed to submit response.";
}

function getFieldOptions(
  field: ElicitationSchemaField,
): Array<{ value: string; label: string }> {
  if (field.type === "string" && "enum" in field) {
    return field.enum.map((value, index) => ({
      value,
      label: field.enumNames?.[index] ?? value,
    }));
  }
  if (field.type === "string" && "oneOf" in field) {
    return field.oneOf.map((option) => ({
      value: option.const,
      label: option.title,
    }));
  }
  if (field.type === "array" && "enum" in field.items) {
    return field.items.enum.map((value) => ({ value, label: value }));
  }
  if (field.type === "array" && "anyOf" in field.items) {
    return field.items.anyOf.map((option) => ({
      value: option.const,
      label: option.title,
    }));
  }
  return [];
}

function getInitialDraft(field: ElicitationSchemaField): FieldDraft {
  if (field.default === undefined) {
    return field.type === "array" ? [] : undefined;
  }
  if (field.type === "number" || field.type === "integer") {
    return String(field.default);
  }
  if (field.type === "array") return [...field.default];
  if (field.type === "boolean") return field.default;
  return String(field.default);
}

function isTextField(field: ElicitationSchemaField): field is ElicitationTextField {
  return field.type === "string" && !("enum" in field) && !("oneOf" in field);
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function parseFieldValue(
  name: string,
  field: ElicitationSchemaField,
  draft: FieldDraft,
  required: boolean,
): ElicitationFieldValue | undefined {
  const label = field.title || name;
  if (field.type === "array") {
    const values = Array.isArray(draft) ? draft : [];
    if (!required && values.length === 0) return undefined;
    if (field.minItems !== undefined && values.length < field.minItems) {
      throw new Error(`${label} requires at least ${field.minItems} selections.`);
    }
    if (field.maxItems !== undefined && values.length > field.maxItems) {
      throw new Error(`${label} allows at most ${field.maxItems} selections.`);
    }
    return values;
  }

  if (field.type === "boolean") {
    if (draft === undefined) {
      if (required) throw new Error(`${label} is required.`);
      return undefined;
    }
    return Boolean(draft);
  }

  const rawText = typeof draft === "string" ? draft : "";
  const trimmedText = rawText.trim();
  if (!trimmedText) {
    if (required) throw new Error(`${label} is required.`);
    return undefined;
  }

  if (field.type === "number" || field.type === "integer") {
    const number = Number(trimmedText);
    if (!Number.isFinite(number)) throw new Error(`${label} must be a number.`);
    if (field.type === "integer" && !Number.isInteger(number)) {
      throw new Error(`${label} must be an integer.`);
    }
    if (field.minimum !== undefined && number < field.minimum) {
      throw new Error(`${label} must be at least ${field.minimum}.`);
    }
    if (field.maximum !== undefined && number > field.maximum) {
      throw new Error(`${label} must be at most ${field.maximum}.`);
    }
    return number;
  }

  if (field.type !== "string") {
    throw new Error(`${label} has an unsupported field type.`);
  }
  if (isTextField(field)) {
    if (field.minLength !== undefined && rawText.length < field.minLength) {
      throw new Error(`${label} must be at least ${field.minLength} characters.`);
    }
    if (field.maxLength !== undefined && rawText.length > field.maxLength) {
      throw new Error(`${label} must be at most ${field.maxLength} characters.`);
    }
    if (field.format === "email" && !isEmail(rawText)) {
      throw new Error(`${label} must be a valid email address.`);
    }
    if (field.format === "uri") {
      try {
        new URL(rawText);
      } catch {
        throw new Error(`${label} must be a valid URL.`);
      }
    }
    if (field.format === "date" && !isDate(rawText)) {
      throw new Error(`${label} must be a valid date.`);
    }
    if (field.format === "date-time" && !isDateTime(rawText)) {
      throw new Error(`${label} must be a valid date and time.`);
    }
  }
  return rawText;
}

function SourceLabel({ source }: { source?: string }) {
  return (
    <div className="text-xs text-text-muted">
      Requested by {source ? <span className="font-medium text-text-secondary">{source}</span> : "Copilot"}
    </div>
  );
}

function getUrlHost(url: string | undefined): string {
  if (!url) return "unknown host";
  try {
    return new URL(url).host;
  } catch {
    return "unknown host";
  }
}

export default function ElicitationCard({ request, onSubmit }: ElicitationCardProps) {
  const schemaEntries = useMemo(
    () => Object.entries(request.requestedSchema?.properties ?? {}),
    [request.requestedSchema],
  );
  const requiredFields = useMemo(
    () => new Set(request.requestedSchema?.required ?? []),
    [request.requestedSchema],
  );
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>(() => (
    Object.fromEntries(schemaEntries.map(([name, field]) => [name, getInitialDraft(field)]))
  ));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const submittingRef = useRef(false);
  const controlsDisabled = submitting || submitted;

  const updateDraft = useCallback((name: string, value: FieldDraft) => {
    setDrafts((current) => ({ ...current, [name]: value }));
    setError(null);
  }, []);

  const submit = useCallback(async (payload: ElicitationResponseEndpointPayload) => {
    if (submittingRef.current || submitted) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(request.requestId, payload);
      setSubmitted(true);
    } catch (submitError) {
      submittingRef.current = false;
      setError(getSubmitError(submitError));
    } finally {
      setSubmitting(false);
    }
  }, [onSubmit, request.requestId, submitted]);

  const handleFormSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const content: Record<string, ElicitationFieldValue> = {};
      for (const [name, field] of schemaEntries) {
        const value = parseFieldValue(name, field, drafts[name], requiredFields.has(name));
        if (value !== undefined) content[name] = value;
      }
      void submit({ action: "accept", content });
    } catch (validationError) {
      setError(getSubmitError(validationError));
    }
  }, [drafts, requiredFields, schemaEntries, submit]);

  const status = !error && (submitting || submitted) ? (
    <div className="mt-3 flex items-center gap-2 text-xs text-text-muted" role="status" aria-live="polite">
      {submitting && <Loader2 size={12} className="animate-spin" />}
      {submitting ? "Submitting response..." : "Response submitted. Waiting for the run to continue..."}
    </div>
  ) : null;

  if (request.mode === "url") {
    const host = getUrlHost(request.url);
    return (
      <div className={CHAT_RAIL_CLASS}>
        <div className="max-w-xl rounded-2xl border border-accent/30 bg-bg-secondary px-4 py-3 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
            Secure interaction
          </div>
          <div className="mt-1 whitespace-pre-wrap text-sm font-medium leading-6 text-text-primary">
            {request.message}
          </div>
          <div className="mt-2"><SourceLabel source={request.elicitationSource} /></div>
          <div className="mt-3 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-text-secondary">
            This opens <span className="font-medium">{host}</span>. Review the destination before continuing.
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={request.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={controlsDisabled}
              onClick={(event) => {
                if (controlsDisabled) {
                  event.preventDefault();
                  return;
                }
                void submit({ action: "accept" });
              }}
              className={`inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover ${
                controlsDisabled ? "pointer-events-none cursor-not-allowed opacity-60" : ""
              }`}
            >
              <ExternalLink size={14} />
              Open secure page
            </a>
            <button
              type="button"
              onClick={() => void submit({ action: "decline" })}
              disabled={controlsDisabled}
              className="rounded-md border border-border bg-bg-primary px-4 py-2 text-sm text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={() => void submit({ action: "cancel" })}
              disabled={controlsDisabled}
              className="rounded-md px-3 py-2 text-sm text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
          {error && <div className="mt-3 text-xs text-error" role="alert">{error}</div>}
          {status}
        </div>
      </div>
    );
  }

  return (
    <div className={CHAT_RAIL_CLASS}>
      <form
        className="max-w-xl rounded-2xl border border-accent/30 bg-bg-secondary px-4 py-3 shadow-sm"
        onSubmit={handleFormSubmit}
      >
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
          Questions
        </div>
        <div className="mt-1 whitespace-pre-wrap text-sm font-medium leading-6 text-text-primary">
          {request.message}
        </div>
        <div className="mt-1"><SourceLabel source={request.elicitationSource} /></div>
        {request.elicitationSource && (
          <div className="mt-3 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-text-secondary">
            Do not enter passwords, API keys, access tokens, or payment details into this form.
          </div>
        )}

        <div className="mt-4 space-y-4">
          {schemaEntries.map(([name, field]) => {
            const label = field.title || name;
            const required = requiredFields.has(name);
            const options = getFieldOptions(field);
            const draft = drafts[name];
            return (
              <fieldset
                key={name}
                className="rounded-xl border border-border/70 bg-bg-primary/40 px-3 py-3"
                disabled={controlsDisabled}
              >
                <legend className="px-1 text-sm font-medium text-text-primary">
                  {label}{required ? " *" : ""}
                </legend>
                {field.description && (
                  <div className="mb-2 text-xs text-text-muted">{field.description}</div>
                )}

                {options.length > 0 && field.type === "string" && (
                  <div className="flex flex-wrap gap-2">
                    {options.map((option) => {
                      const selected = draft === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => updateDraft(name, option.value)}
                          className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                            selected
                              ? "border-accent bg-accent/10 text-text-primary"
                              : "border-border bg-bg-primary text-text-secondary hover:border-accent/60 hover:text-text-primary"
                          }`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                )}

                {options.length > 0 && field.type === "array" && (
                  <div className="flex flex-wrap gap-2">
                    {options.map((option) => {
                      const selected = Array.isArray(draft) && draft.includes(option.value);
                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => {
                            const values = Array.isArray(draft) ? draft : [];
                            updateDraft(
                              name,
                              selected
                                ? values.filter((value) => value !== option.value)
                                : [...values, option.value],
                            );
                          }}
                          className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                            selected
                              ? "border-accent bg-accent/10 text-text-primary"
                              : "border-border bg-bg-primary text-text-secondary hover:border-accent/60 hover:text-text-primary"
                          }`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                )}

                {field.type === "boolean" && (
                  <div className="flex gap-2">
                    {[true, false].map((value) => (
                      <button
                        key={String(value)}
                        type="button"
                        aria-pressed={draft === value}
                        onClick={() => updateDraft(name, value)}
                        className={`rounded-full border px-3 py-1.5 text-sm ${
                          draft === value
                            ? "border-accent bg-accent/10 text-text-primary"
                            : "border-border bg-bg-primary text-text-secondary"
                        }`}
                      >
                        {value ? "Yes" : "No"}
                      </button>
                    ))}
                  </div>
                )}

                {(field.type === "number" || field.type === "integer") && (
                  <input
                    type="number"
                    step={field.type === "integer" ? "1" : "any"}
                    min={field.minimum}
                    max={field.maximum}
                    value={typeof draft === "string" ? draft : ""}
                    onChange={(event) => updateDraft(name, event.target.value)}
                    aria-label={label}
                    className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                  />
                )}

                {isTextField(field) && (
                  field.format ? (
                    <input
                      type={field.format === "email"
                        ? "email"
                        : field.format === "uri"
                          ? "url"
                          : field.format === "date"
                            ? "date"
                            : "text"}
                      placeholder={field.format === "date-time" ? "2026-07-13T14:30:00Z" : undefined}
                      value={typeof draft === "string" ? draft : ""}
                      onChange={(event) => updateDraft(name, event.target.value)}
                      aria-label={label}
                      className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                    />
                  ) : (
                    <textarea
                      rows={3}
                      value={typeof draft === "string" ? draft : ""}
                      onChange={(event) => updateDraft(name, event.target.value)}
                      aria-label={label}
                      className="w-full resize-y rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                    />
                  )
                )}
              </fieldset>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={controlsDisabled}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {submitting ? "Submitting..." : submitted ? "Submitted" : "Submit answers"}
          </button>
          <button
            type="button"
            onClick={() => void submit({ action: "decline" })}
            disabled={controlsDisabled}
            className="rounded-md border border-border bg-bg-primary px-4 py-2 text-sm text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => void submit({ action: "cancel" })}
            disabled={controlsDisabled}
            className="rounded-md px-3 py-2 text-sm text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
        {error && <div className="mt-3 text-xs text-error" role="alert">{error}</div>}
        {status}
      </form>
    </div>
  );
}
