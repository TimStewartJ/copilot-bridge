import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import {
  deleteSkill,
  fetchSkill,
  fetchSkills,
  type Skill,
  type SkillDetail,
} from "../../api";
import EmptyState from "../shared/EmptyState";
import { SettingsSection } from "./SettingsSection";

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
    <div className="bg-bg-elevated border border-border rounded-md p-4 group">
      <div className="flex items-start justify-between gap-2">
        <button
          onClick={toggleExpanded}
          className="flex flex-1 min-w-0 items-start gap-2 text-left"
          aria-expanded={expanded}
        >
          <span className="mt-0.5 text-text-muted">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium text-accent">{skill.name}</span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                  isBundled
                    ? "bg-bg-surface text-text-muted"
                    : "bg-accent-surface text-accent"
                }`}
              >
                {skill.source}
              </span>
            </span>
            {skill.description && (
              <span className="mt-1 block text-xs text-text-muted">{skill.description}</span>
            )}
          </span>
        </button>
        {!isBundled && (
          <button
            onClick={onRemove}
            disabled={removing}
            className="p-1.5 text-text-muted hover:text-error transition-colors disabled:opacity-50"
            title="Delete skill"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-3 border-t border-border pt-3">
          {skill.allowedTools.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1">
              <span className="text-[11px] font-medium text-text-secondary">Allowed tools:</span>
              {skill.allowedTools.map((tool) => (
                <code
                  key={tool}
                  className="rounded bg-bg-surface px-1.5 py-0.5 text-[11px] text-text-secondary"
                >
                  {tool}
                </code>
              ))}
            </div>
          )}
          {loadingDetail && <div className="text-xs text-text-muted">Loading…</div>}
          {detailError && <div className="text-xs text-error">{detailError}</div>}
          {detail && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-surface p-3 text-[11px] leading-relaxed text-text-secondary">
              {detail.body || "(empty)"}
            </pre>
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
      description="On-disk Copilot skills. Home skills can be deleted; bundled skills ship with the app and are read-only. Changes apply to new sessions."
    >
      <div className="space-y-2">
        {error && (
          <div className="rounded-md border border-error/20 bg-error/10 px-3 py-2 text-xs text-error">
            {error}
          </div>
        )}

        {skills.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            removing={removingId === skill.id}
            onRemove={() => removeSkill(skill)}
          />
        ))}

        {loading && (
          <div className="rounded-md border border-border bg-bg-elevated px-3 py-2 text-xs text-text-muted">
            Loading skills…
          </div>
        )}

        {!loading && skills.length === 0 && (
          <EmptyState
            message="No skills"
            sub="Add a SKILL.md under ~/.copilot/skills to define one"
          />
        )}
      </div>
    </SettingsSection>
  );
}
