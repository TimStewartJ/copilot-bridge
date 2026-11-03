import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { fetchSkills, type Skill } from "../../api";
import { SettingsSection } from "./SettingsSection";
import SkillDetailDialog from "./SkillDetailDialog";
import { DS, cx } from "../../design/tokens";
import { Badge, Button, EmptyHint, MetaLine, Notice } from "../../design/primitives";
import { queryKeys } from "../../queryClient";
import { describePlaybook } from "../../../shared/workflow-vocabulary.js";
import { groupSkills, isCustomizedSkill, skillKindLabel, skillSourceLabel, skillUsageLabel } from "../../lib/skills";

function SkillRow({ skill, onOpen }: { skill: Skill; onOpen: () => void }) {
  const kindLabel = skillKindLabel(skill);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx(DS.row.base, DS.row.touch, DS.row.interactive, "gap-2.5 py-2")}
    >
      <ChevronRight size={13} aria-hidden="true" className={DS.row.chevron} />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-medium text-text-primary">{skill.label ?? skill.name}</span>
          <Badge>{skillSourceLabel(skill)}</Badge>
          {kindLabel && <Badge>{kindLabel}</Badge>}
          {isCustomizedSkill(skill) && <Badge tone="info">Customized</Badge>}
        </span>
        {skill.description && (
          <span className="block truncate text-xs text-text-secondary" title={skill.description}>{skill.kind === "playbook" ? describePlaybook(skill.description) : skill.description}</span>
        )}
        <MetaLine items={[
          skill.roles.length > 0 && `Fills ${skill.roles.join(", ")}`,
          skill.extends.length > 0 && `Extends ${skill.extends.join(", ")}`,
          skillUsageLabel(skill),
        ]} />
      </span>
    </button>
  );
}

function SkillGroup({ label, skills, onOpen }: { label: string; skills: Skill[]; onOpen: (id: string) => void }) {
  if (skills.length === 0) return null;
  return (
    <div className="min-w-0 pb-3 last:pb-0">
      <h4 className={cx(DS.text.sectionLabel, "pb-1")}>{label} <span className="tabular-nums text-text-faint">{skills.length}</span></h4>
      <div className={DS.surface.divided}>
        {skills.map((skill) => <SkillRow key={skill.id} skill={skill} onOpen={() => onOpen(skill.id)} />)}
      </div>
    </div>
  );
}

export function SkillsSection() {
  const queryClient = useQueryClient();
  const skillsQuery = useQuery({ queryKey: queryKeys.skills, queryFn: fetchSkills });
  const [openId, setOpenId] = useState<string | null>(null);
  const groups = groupSkills(skillsQuery.data ?? []);
  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.skills });
    void queryClient.invalidateQueries({ queryKey: queryKeys.playbooks });
  };

  return (
    <SettingsSection title="Skills" description="Changes apply to new sessions.">
      {skillsQuery.error && (
        <Notice
          tone="danger"
          className="mb-2"
          title="Skills could not load"
          action={<Button size="sm" onClick={() => void skillsQuery.refetch()}>Retry</Button>}
        >
          {skillsQuery.error instanceof Error ? skillsQuery.error.message : String(skillsQuery.error)}
        </Notice>
      )}
      {skillsQuery.isLoading && <p role="status" className={DS.field.help}>Loading skills…</p>}
      {skillsQuery.data && skillsQuery.data.length === 0 && <EmptyHint>No skills.</EmptyHint>}
      <SkillGroup label="Playbooks" skills={groups.playbooks} onOpen={setOpenId} />
      <SkillGroup label="Helpers" skills={groups.helpers} onOpen={setOpenId} />
      <SkillGroup label="Other skills" skills={groups.other} onOpen={setOpenId} />
      {openId && <SkillDetailDialog skillId={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </SettingsSection>
  );
}
