import type { ChatSkillEntry } from "../api";
import { DisclosureRow } from "../design/primitives";

interface SkillLoadedCardProps {
  entry: ChatSkillEntry;
}

/** Skill context the agent pulled in: one quiet line, like any other step, that opens onto its text. */
export default function SkillLoadedCard({ entry }: SkillLoadedCardProps) {
  const label = entry.skill.label || "skill";
  const content = entry.content?.trim() ?? "";

  return (
    <DisclosureRow inline label="Skill loaded" detail={label} disabled={content.length === 0}>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words py-1 font-mono text-xs leading-relaxed text-text-muted">
        {content}
      </pre>
    </DisclosureRow>
  );
}
