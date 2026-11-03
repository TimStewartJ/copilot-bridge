import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { putSessionPlaybook, type SessionPlaybookView } from "../api";
import Sheet from "../design/Sheet";
import { DS, cx } from "../design/tokens";
import { Button, EmptyHint } from "../design/primitives";
import { usePlaybooksQuery } from "../hooks/queries/usePlaybooks";
import { projectSessionPlaybook } from "../hooks/queries/session-events";
import { queryClient } from "../queryClient";
import {
  canClearChatPlaybook,
  DIRECT_PLAYBOOK_LABEL,
  groupPlaybooksByFamily,
  PLAYBOOK_SOURCE_LABELS,
  playbookViewLabel,
} from "../lib/playbooks";
import { NO_PLAYBOOK } from "../../shared/workflow-vocabulary.js";

function PickerRow({ label, description, selected, disabled, onClick }: {
  label: string;
  description?: string;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cx(DS.menu.item, selected && DS.menu.selected)}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-text-primary">{label}</span>
        {description && <span className={cx(DS.text.meta, "block truncate")} title={description}>{description}</span>}
      </span>
      {selected && <Check size={14} className="shrink-0 text-text-secondary" aria-hidden="true" />}
    </button>
  );
}

/**
 * The chat's active playbook as a few quiet words in the chat header. Tapping it lists the
 * installed playbooks by family, so the user can pick one, take the direct path or clear the chat's
 * own choice.
 */
export default function SessionPlaybookChip({ sessionId, view, inTask }: {
  sessionId: string;
  view?: SessionPlaybookView;
  /** Clearing the chat's choice falls back to its task's pin. */
  inTask: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playbooksQuery = usePlaybooksQuery({ enabled: open });
  const label = playbookViewLabel(view, playbooksQuery.data);
  const sourceLabel = label && view?.source ? PLAYBOOK_SOURCE_LABELS[view.source] : undefined;
  const groups = groupPlaybooksByFamily(playbooksQuery.data ?? []);

  const choose = async (playbook: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const next = await putSessionPlaybook(sessionId, playbook);
      projectSessionPlaybook(queryClient, sessionId, next);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    setOpen(false);
    setError(null);
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="-mx-1 min-w-0 px-1.5 font-normal md:h-6"
        onClick={() => setOpen(true)}
        title={sourceLabel ? `Playbook set by ${sourceLabel}` : "Choose a playbook"}
        aria-label={`Playbook: ${label ?? "Automatic"}`}
      >
        <span className={cx("min-w-0 truncate", !label && "text-text-faint")}>{label ?? "Auto"}</span>
        {sourceLabel && <span className="hidden shrink-0 text-text-faint md:inline">· {sourceLabel}</span>}
        <ChevronDown className="h-3 w-3 shrink-0 text-text-faint" aria-hidden="true" />
      </Button>
      {open && (
        <Sheet
          title="Playbook"
          detail={sourceLabel ? `Set by ${sourceLabel}` : undefined}
          onClose={close}
          bodyClassName="px-3 pt-2"
        >
          {error && <p role="alert" className="px-3 pb-2 text-xs text-error">{error}</p>}
          {playbooksQuery.isLoading && <p role="status" className={cx(DS.field.help, "px-3 py-2")}>Loading playbooks…</p>}
          {playbooksQuery.error && (
            <p role="alert" className="px-3 py-2 text-xs text-error">
              Playbooks could not load. {playbooksQuery.error instanceof Error ? playbooksQuery.error.message : ""}
            </p>
          )}
          {!playbooksQuery.isLoading && !playbooksQuery.error && groups.length === 0 && (
            <EmptyHint className="px-3 py-2">No playbooks installed.</EmptyHint>
          )}
          {groups.map((group) => (
            <div key={group.family} role="group" aria-label={group.label} className="pb-2">
              <div className={cx(DS.text.sectionLabel, "px-3 pb-1 pt-2")}>{group.label}</div>
              {group.playbooks.map((playbook) => (
                <PickerRow
                  key={playbook.id}
                  label={playbook.label}
                  description={playbook.description}
                  selected={view?.playbook === playbook.id}
                  disabled={saving}
                  onClick={() => void choose(playbook.id)}
                />
              ))}
            </div>
          ))}
          <div className={DS.menu.divider} />
          <PickerRow
            label={`${DIRECT_PLAYBOOK_LABEL} (no playbook)`}
            selected={view?.playbook === NO_PLAYBOOK}
            disabled={saving}
            onClick={() => void choose(NO_PLAYBOOK)}
          />
          {canClearChatPlaybook(view) && (
            <PickerRow
              label={inTask ? "Follow task" : "Automatic"}
              selected={false}
              disabled={saving}
              onClick={() => void choose(null)}
            />
          )}
        </Sheet>
      )}
    </>
  );
}
