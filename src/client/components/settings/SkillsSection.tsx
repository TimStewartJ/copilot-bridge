import { useEffect, useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import {
  deleteSkill,
  fetchSkill,
  fetchSkills,
  type Skill,
  type SkillDetail,
} from "../../api";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { Badge, Button, EmptyHint, Notice, SettingList } from "../../design/primitives";

function sortSkills(skills: Skill[]): Skill[] {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function SkillCard({
  skill,
  onRemove,
  removing,
}: {
  skill: Skill;
  onRemove: () => void;
  removing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const toggleExpanded = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail && !loadingDetail) {
      setLoadingDetail(true);
      setDetailError(null);
      try {
        setDetail(await fetchSkill(skill.id));
      } catch (err) {
        setDetailError(`Failed to load skill: ${err instanceof Error ? err.message : err}`);
      } finally {
        setLoadingDetail(false);
      }
    }
  };

  const isBundled = skill.source === "bundled";

  return (
    <div className="min-w-0 py-1.5 first:pt-0 last:pb-0">
      <button
        type="button"
        onClick={toggleExpanded}
        className={cx(DS.row.base, DS.row.touch, DS.row.interactive, "gap-2.5")}
        aria-expanded={expanded}
      >
        <ChevronRight size={13} aria-hidden="true" className={cx(DS.row.chevron, expanded && DS.row.chevronOpen)} />
        <span className="shrink-0 font-medium text-text-primary">{skill.name}</span>
        <Badge tone="neutral">{skill.source}</Badge>
        {skill.description && !expanded && (
          <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{skill.description}</span>
        )}
      </button>

      {expanded && (
        <div className={cx(DS.rail, DS.motion.reveal, "space-y-2 pb-2")}>
          {skill.description && <p className={DS.text.prose}>{skill.description}</p>}
          {skill.allowedTools.length > 0 && (
            <p className={DS.field.help}>
              Allowed tools: <span className={DS.text.literal}>{skill.allowedTools.join(", ")}</span>
            </p>
          )}
          {loadingDetail && <p role="status" className={DS.field.help}>Loading…</p>}
          {detailError && <p className="text-xs text-error">{detailError}</p>}
          {detail && (
            <pre className={cx(DS.surface.inset, "max-h-80 overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] leading-relaxed text-text-secondary")}>
              {detail.body || "(empty)"}
            </pre>
          )}
          {!isBundled && (
            <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={onRemove} disabled={removing} title="Delete skill">
              Delete skill
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function SkillsSection() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const loadSkills = async () => {
    setLoading(true);
    setError(null);
    try {
      setSkills(sortSkills(await fetchSkills()));
    } catch (err) {
      console.error("Failed to load skills:", err);
      setError(`Failed to load skills: ${err instanceof Error ? err.message : err}`);
      setSkills([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSkills();
  }, []);

  const removeSkill = async (skill: Skill) => {
    const confirmed = window.confirm(
      `Delete skill "${skill.name}"? This permanently removes its folder from the Copilot home skills directory.`,
    );
    if (!confirmed) return;
    setRemovingId(skill.id);
    setError(null);
    try {
      await deleteSkill(skill.id);
      // Reload rather than filtering locally: deleting a home skill that
      // shadows a bundled one should reveal the bundled skill again.
      await loadSkills();
    } catch (err) {
      console.error("Failed to delete skill:", err);
      setError(`Failed to delete skill: ${err instanceof Error ? err.message : err}`);
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <SettingsSection
      title="Skills"
      description="Changes apply to new sessions. Bundled skills are read-only."
    >
      <SettingList>
        {error && <Notice tone="danger" className="mb-2">{error}</Notice>}

        {skills.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            removing={removingId === skill.id}
            onRemove={() => removeSkill(skill)}
          />
        ))}

        {loading && <p role="status" className={DS.field.help}>Loading skills…</p>}

        {!loading && skills.length === 0 && (
          <EmptyHint>No skills. Add a SKILL.md under ~/.copilot/skills to define one.</EmptyHint>
        )}
      </SettingList>
    </SettingsSection>
  );
}
