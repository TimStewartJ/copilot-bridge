import {
  NO_PLAYBOOK,
  PLAYBOOK_FAMILIES,
  PLAYBOOK_FAMILY_LABELS,
  type PlaybookFamily,
  type PlaybookInfo,
  type PlaybookSource,
  type SessionPlaybookView,
} from "../../shared/workflow-vocabulary.js";

export interface PlaybookFamilyGroup {
  family: PlaybookFamily;
  label: string;
  playbooks: PlaybookInfo[];
}

/** Playbooks under their family headings, in the vocabulary's family order, sorted by label. */
export function groupPlaybooksByFamily(playbooks: readonly PlaybookInfo[]): PlaybookFamilyGroup[] {
  return PLAYBOOK_FAMILIES.flatMap((family) => {
    const members = playbooks
      .filter((playbook) => playbook.family === family)
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
    return members.length > 0 ? [{ family, label: PLAYBOOK_FAMILY_LABELS[family], playbooks: members }] : [];
  });
}

export const PLAYBOOK_SOURCE_LABELS: Record<PlaybookSource, string> = {
  user: "You",
  agent: "Agent",
  task: "Task",
  schedule: "Schedule",
};

export const DIRECT_PLAYBOOK_LABEL = "Direct";

/** The words for a chat's playbook, or undefined when none is active. */
export function playbookViewLabel(view: SessionPlaybookView | null | undefined, playbooks?: readonly PlaybookInfo[]): string | undefined {
  if (!view?.playbook) return undefined;
  if (view.playbook === NO_PLAYBOOK) return DIRECT_PLAYBOOK_LABEL;
  return view.label ?? playbooks?.find((playbook) => playbook.id === view.playbook)?.label ?? view.playbook;
}

/** A pinned or stored playbook id in words; an id no longer installed shows as itself. */
export function playbookIdLabel(id: string | undefined, playbooks?: readonly PlaybookInfo[]): string | undefined {
  if (!id) return undefined;
  if (id === NO_PLAYBOOK) return DIRECT_PLAYBOOK_LABEL;
  return playbooks?.find((playbook) => playbook.id === id)?.label ?? id;
}

/**
 * Whether the picker offers "Follow task": only when the chat made its own choice, since clearing
 * it falls back to the task's or schedule's pin.
 */
export function canClearChatPlaybook(view: SessionPlaybookView | null | undefined): boolean {
  return view?.source === "user" || view?.source === "agent";
}
