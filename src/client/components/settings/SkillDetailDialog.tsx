import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2, Wand2 } from "lucide-react";
import {
  customizeSkill,
  deleteSkill,
  fetchSkill,
  fetchSkillHistory,
  saveSkill,
  type SkillDetail,
} from "../../api";
import Dialog from "../../design/Dialog";
import { DS, cx } from "../../design/tokens";
import { Badge, Button, Details, MetaLine, TextArea } from "../../design/primitives";
import { queryKeys } from "../../queryClient";
import { isCustomizedSkill, skillKindLabel, skillSourceLabel, skillUsageLabel } from "../../lib/skills";
import { timeAgo } from "../../time";
import PromptMarkdown from "../chat/PromptMarkdown";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SkillHistory({ skillId }: { skillId: string }) {
  const historyQuery = useQuery({
    queryKey: queryKeys.skillHistory(skillId),
    queryFn: () => fetchSkillHistory(skillId),
  });
  const history = historyQuery.data;
  if (!history?.tracked) return null;
  return (
    <Details label="History" detail={`${history.commits.length} change${history.commits.length === 1 ? "" : "s"}`}>
      <ul className={cx(DS.surface.divided, "pt-1")}>
        {history.commits.map((commit) => (
          <li key={commit.hash} className="flex min-w-0 items-baseline gap-2 py-1.5 text-[13px]">
            <span className={DS.text.literal}>{commit.hash}</span>
            <span className="min-w-0 flex-1 truncate text-text-secondary" title={commit.subject}>{commit.subject}</span>
            <span className={DS.text.meta} title={commit.at}>{timeAgo(commit.at)}</span>
          </li>
        ))}
      </ul>
    </Details>
  );
}

/** One skill: what it is, its rendered instructions, and edit, customize, delete and history. */
export default function SkillDetailDialog({ skillId, onClose, onChanged }: {
  skillId: string;
  onClose: () => void;
  /** The list should reload: a skill was saved, customized or deleted. */
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: queryKeys.skill(skillId),
    queryFn: () => fetchSkill(skillId),
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skill = detailQuery.data;

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  const showSaved = (saved: SkillDetail) => {
    queryClient.setQueryData(queryKeys.skill(skillId), saved);
    void queryClient.invalidateQueries({ queryKey: queryKeys.skillHistory(skillId) });
    onChanged();
  };

  const save = () => run(async () => {
    if (editing === null) return;
    showSaved(await saveSkill(skillId, editing));
    setEditing(null);
  });

  const customize = () => run(async () => {
    const copy = await customizeSkill(skillId);
    showSaved(copy);
    setEditing(copy.raw);
  });

  const remove = () => {
    if (!skill) return;
    // copy-ok: confirms a destructive action
    if (!window.confirm(`Delete skill "${skill.name}"? Its folder is removed for good.`)) return;
    void run(async () => {
      await deleteSkill(skillId);
      onChanged();
      onClose();
    });
  };

  const kindLabel = skill ? skillKindLabel(skill) : undefined;
  const usage = skill ? skillUsageLabel(skill) : undefined;

  return (
    <Dialog title={skill?.label ?? skill?.name ?? skillId} pending={pending} onClose={onClose} closeLabel="Close skill">
      {detailQuery.isLoading && <p role="status" className={DS.field.help}>Loading…</p>}
      {detailQuery.error && <p role="alert" className="text-xs text-error">Skill could not load. {errorText(detailQuery.error)}</p>}
      {skill && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge>{skillSourceLabel(skill)}</Badge>
              {kindLabel && <Badge>{kindLabel}</Badge>}
              {isCustomizedSkill(skill) && <Badge tone="info">Customized</Badge>}
            </div>
            {skill.description && <p className={DS.text.prose}>{skill.description}</p>}
            <MetaLine items={[
              skill.roles.length > 0 && `Fills ${skill.roles.join(", ")}`,
              skill.extends.length > 0 && `Extends ${skill.extends.join(", ")}`,
              skill.evidence.length > 0 && `Evidence: ${skill.evidence.join(", ")}`,
              usage,
            ]} />
          </div>

          {error && <p role="alert" className="text-xs text-error">{error}</p>}

          {editing !== null ? (
            <div className="space-y-2">
              <TextArea
                aria-label="SKILL.md"
                className="min-h-[50dvh] font-mono text-[12px] md:text-[12px]"
                spellCheck={false}
                value={editing}
                onChange={(event) => setEditing(event.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" disabled={pending} onClick={() => { setEditing(null); setError(null); }}>Cancel</Button>
                <Button variant="primary" disabled={pending || editing === skill.raw} onClick={() => void save()}>Save</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {skill.editable ? (
                  <>
                    <Button icon={<Pencil size={13} />} disabled={pending} onClick={() => setEditing(skill.raw)}>Edit</Button>
                    <Button variant="danger" icon={<Trash2 size={13} />} disabled={pending} onClick={remove}>Delete</Button>
                  </>
                ) : (
                  <Button
                    icon={<Wand2 size={13} />}
                    disabled={pending}
                    title="Copy to your home skills folder, where it overrides this one"
                    onClick={() => void customize()}
                  >
                    Customize
                  </Button>
                )}
              </div>
              <div className={cx(DS.surface.inset, "px-4 py-3")}>
                <PromptMarkdown content={skill.body || "(empty)"} trusted />
              </div>
              {skill.source === "home" && <SkillHistory skillId={skillId} />}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
