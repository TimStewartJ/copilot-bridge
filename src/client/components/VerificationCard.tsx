import { memo, useMemo, useState } from "react";
import { Check } from "lucide-react";
import type { ToolCall } from "../api";
import { Badge, StatusIcon } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { readVerificationRecord, type VerificationRecord } from "../lib/verification-record";
import { EVIDENCE_KIND_DESCRIPTIONS } from "../../shared/workflow-vocabulary.js";
import type { CompletionEvidence, CompletionStatus } from "../../shared/completion-report.js";

const STATUS_VIEW: Record<CompletionStatus, { label: string; tone: "success" | "warning" | "danger" }> = {
  verified: { label: "Verified", tone: "success" },
  partial: { label: "Partly verified", tone: "warning" },
  failed: { label: "Not verified", tone: "danger" },
};

function StatusMark({ status }: { status: CompletionStatus }) {
  if (status === "verified") return <Check size={12} aria-hidden="true" className="shrink-0" />;
  return <StatusIcon kind={status === "failed" ? "danger" : "warning"} decorative />;
}

function ResultMark({ result }: { result: CompletionEvidence["result"] }) {
  if (result === "pass") return <Check size={14} role="img" aria-label="Passed" className={cx("shrink-0", DS.tone.success)} />;
  if (result === "fail") return <StatusIcon kind="danger" label="Failed" size="md" />;
  return <StatusIcon kind="unknown" label="Not run" size="md" />;
}

function isWebUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** A reference opens as a link when it is one; anything else is literal text that unfolds on tap. */
function EvidenceRef({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  if (isWebUrl(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        title={value}
        className={cx(DS.focus, "block min-w-0 truncate rounded-sm text-xs text-accent hover:underline")}
      >
        {value}
      </a>
    );
  }
  return (
    <button
      type="button"
      title={value}
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
      className={cx(DS.focus, DS.text.literal, "block w-full min-w-0 rounded-sm text-left", open ? "whitespace-pre-wrap break-all" : "truncate")}
    >
      {value}
    </button>
  );
}

function kindLabel(kind: CompletionEvidence["kind"]): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function VerificationCardView({ record }: { record: VerificationRecord }) {
  const view = STATUS_VIEW[record.status];
  return (
    <section className={cx(DS.surface.group, "min-w-0 px-4 py-3")} data-verification-status={record.status}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={view.tone}>
          <StatusMark status={record.status} />
          {view.label}
        </Badge>
        {record.playbookLabel && <span className={cx(DS.text.sectionLabel, "min-w-0 truncate")}>{record.playbookLabel}</span>}
      </div>
      <p className={cx("mt-2 whitespace-pre-wrap break-words", DS.text.content)}>{record.summary}</p>
      <ul className={cx("mt-1.5", DS.surface.divided)}>
        {record.evidence.map((item, index) => (
          <li key={index} className="flex min-w-0 items-start gap-2 py-1.5" data-evidence-result={item.result}>
            <span className={cx(DS.row.iconSlot, "mt-0.5")}>
              <ResultMark result={item.result} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="break-words text-[13px] leading-5">
                <span className="font-medium text-text-secondary" title={EVIDENCE_KIND_DESCRIPTIONS[item.kind]}>
                  {kindLabel(item.kind)}
                </span>
                <span className="text-text-muted"> {item.claim}</span>
              </div>
              {item.ref && <EvidenceRef value={item.ref} />}
            </div>
          </li>
        ))}
      </ul>
      {record.unverified.length > 0 && (
        <div className="mt-1.5">
          <div className={DS.text.sectionLabel}>Not checked</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {record.unverified.map((item, index) => (
              <li key={index} className={cx(DS.text.rowDetail, "break-words")}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {record.notes.length > 0 && (
        <div className="mt-1.5">
          <div className={DS.text.sectionLabel}>Notes</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {record.notes.map((item, index) => (
              <li key={index} className={cx(DS.text.rowDetail, "break-words")}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The transcript's card for a recorded `verify_complete` call. */
export default memo(function VerificationCard({ toolCall }: { toolCall: ToolCall }) {
  const record = useMemo(
    () => readVerificationRecord(toolCall),
    [toolCall.args, toolCall.name, toolCall.result, toolCall.success],
  );
  if (!record) return null;
  return <VerificationCardView record={record} />;
});
