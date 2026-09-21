import { ExternalLink, Loader2, ShieldAlert } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import type {
  ElicitationFieldValue,
  ElicitationResponseEndpointPayload,
  ElicitationSchemaField,
  ElicitationTextField,
  PendingElicitationRequestView,
} from "../api";
import PromptMarkdown from "./chat/PromptMarkdown";
import { DS, cx } from "../design/tokens";
import { Button, ChoiceButton, Panel, TextArea, TextInput } from "../design/primitives";

const CHAT_RAIL_CLASS = DS.layout.readingColumn;

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
        <Panel className="max-w-xl">
          <div className={DS.text.attention}>Secure interaction</div>
          <div className="mt-1 whitespace-pre-wrap text-sm font-medium leading-6 text-text-primary">
            {request.message}
          </div>
          <div className="mt-2"><SourceLabel source={request.elicitationSource} /></div>
          <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-text-secondary">
            <ShieldAlert size={13} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <span>This opens <span className="font-medium text-text-primary">{host}</span>. Review the destination before continuing.</span>
          </p>
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
              className={cx(
                DS.button.base,
                DS.button.size.md,
                DS.button.variant.secondary,
                controlsDisabled && "pointer-events-none cursor-not-allowed opacity-60",
              )}
            >
              <ExternalLink size={14} />
              Open secure page
            </a>
            <Button onClick={() => void submit({ action: "decline" })} disabled={controlsDisabled}>Decline</Button>
            <Button variant="ghost" onClick={() => void submit({ action: "cancel" })} disabled={controlsDisabled}>Cancel</Button>
          </div>
          {error && <div className="mt-3 text-xs text-error" role="alert">{error}</div>}
          {status}
        </Panel>
      </div>
    );
  }

  return (
    <div className={CHAT_RAIL_CLASS}>
      <Panel className="max-w-xl">
        <form onSubmit={handleFormSubmit}>
          <div className={DS.text.attention}>Questions</div>
          <PromptMarkdown content={request.message} trusted={!request.elicitationSource} />
          <div className="mt-1"><SourceLabel source={request.elicitationSource} /></div>
          {request.elicitationSource && (
            <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-text-secondary">
              <ShieldAlert size={13} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
              <span>Do not enter passwords, API keys, access tokens, or payment details into this form.</span>
            </p>
          )}

          <div className="mt-4 space-y-5">
            {schemaEntries.map(([name, field]) => {
              const label = field.title || name;
              const required = requiredFields.has(name);
              const options = getFieldOptions(field);
              const draft = drafts[name];
              return (
                <fieldset key={name} className="min-w-0" disabled={controlsDisabled}>
                  <legend className="mb-1.5 text-[13px] font-medium text-text-primary">
                    {label}{required ? " *" : ""}
                  </legend>
                  {field.description && (
                    <div className={cx(DS.field.help, "mb-2")}>{field.description}</div>
                  )}

                  {options.length > 0 && field.type === "string" && (
                    <div className={DS.choice.group}>
                      {options.map((option) => (
                        <ChoiceButton
                          key={option.value}
                          selected={draft === option.value}
                          onClick={() => updateDraft(name, option.value)}
                        >
                          {option.label}
                        </ChoiceButton>
                      ))}
                    </div>
                  )}

                  {options.length > 0 && field.type === "array" && (
                    <div className={DS.choice.group}>
                      {options.map((option) => {
                        const selected = Array.isArray(draft) && draft.includes(option.value);
                        return (
                          <ChoiceButton
                            key={option.value}
                            selected={selected}
                            onClick={() => {
                              const values = Array.isArray(draft) ? draft : [];
                              updateDraft(
                                name,
                                selected
                                  ? values.filter((value) => value !== option.value)
                                  : [...values, option.value],
                              );
                            }}
                          >
                            {option.label}
                          </ChoiceButton>
                        );
                      })}
                    </div>
                  )}

                  {field.type === "boolean" && (
                    <div className={DS.choice.group}>
                      {[true, false].map((value) => (
                        <ChoiceButton key={String(value)} selected={draft === value} onClick={() => updateDraft(name, value)}>
                          {value ? "Yes" : "No"}
                        </ChoiceButton>
                      ))}
                    </div>
                  )}

                  {(field.type === "number" || field.type === "integer") && (
                    <TextInput
                      type="number"
                      step={field.type === "integer" ? "1" : "any"}
                      min={field.minimum}
                      max={field.maximum}
                      value={typeof draft === "string" ? draft : ""}
                      onChange={(event) => updateDraft(name, event.target.value)}
                      aria-label={label}
                    />
                  )}

                  {isTextField(field) && (
                    field.format ? (
                      <TextInput
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
                      />
                    ) : (
                      <TextArea
                        rows={3}
                        value={typeof draft === "string" ? draft : ""}
                        onChange={(event) => updateDraft(name, event.target.value)}
                        aria-label={label}
                        className="resize-y"
                      />
                    )
                  )}
                </fieldset>
              );
            })}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={controlsDisabled}
              icon={submitting ? <Loader2 size={14} className="animate-spin" /> : undefined}
            >
              {submitting ? "Submitting..." : submitted ? "Submitted" : "Submit answers"}
            </Button>
            <Button onClick={() => void submit({ action: "decline" })} disabled={controlsDisabled}>Decline</Button>
            <Button variant="ghost" onClick={() => void submit({ action: "cancel" })} disabled={controlsDisabled}>Cancel</Button>
          </div>
          {error && <div className="mt-3 text-xs text-error" role="alert">{error}</div>}
          {status}
        </form>
      </Panel>
    </div>
  );
}
