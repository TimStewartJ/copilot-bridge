import type { ComponentProps } from "react";
import type { PlaybookInfo } from "../../api";
import { Select } from "../../design/primitives";
import { DIRECT_PLAYBOOK_LABEL, groupPlaybooksByFamily } from "../../lib/playbooks";
import { NO_PLAYBOOK } from "../../../shared/workflow-vocabulary.js";

/**
 * A native select of the installed playbooks, grouped by family. The empty value is the caller's
 * "nothing chosen" (Automatic for a new chat, None for a pin). A stored id that is no longer
 * installed stays listed, so the select never shows a different value than the one held.
 */
export default function PlaybookSelect({
  playbooks,
  value,
  onValueChange,
  emptyLabel,
  includeDirect = false,
  ...rest
}: Omit<ComponentProps<typeof Select>, "value" | "onChange" | "children"> & {
  playbooks: readonly PlaybookInfo[];
  value: string;
  onValueChange: (value: string) => void;
  emptyLabel: string;
  includeDirect?: boolean;
}) {
  const groups = groupPlaybooksByFamily(playbooks);
  const missing = value && value !== NO_PLAYBOOK && !playbooks.some((playbook) => playbook.id === value);
  return (
    <Select {...rest} value={value} onChange={(event) => onValueChange(event.target.value)}>
      <option value="">{emptyLabel}</option>
      {groups.map((group) => (
        <optgroup key={group.family} label={group.label}>
          {group.playbooks.map((playbook) => (
            <option key={playbook.id} value={playbook.id} title={playbook.description}>{playbook.label}</option>
          ))}
        </optgroup>
      ))}
      {missing && <option value={value}>{value}</option>}
      {(includeDirect || value === NO_PLAYBOOK) && <option value={NO_PLAYBOOK}>{DIRECT_PLAYBOOK_LABEL} (no playbook)</option>}
    </Select>
  );
}
