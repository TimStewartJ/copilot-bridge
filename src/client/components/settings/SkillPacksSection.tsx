import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { fetchSkillPacks, syncSkillPack, type AppSettings, type SkillPackConfig, type SkillPackStatus, type Tag } from "../../api";
import { SettingsSection } from "./SettingsSection";
import { DS, cx } from "../../design/tokens";
import { Button, EmptyHint, FormRow, MetaLine, SegmentedControl, Switch, TextInput } from "../../design/primitives";
import { queryKeys } from "../../queryClient";
import { settingsWriter, useSettingsWriter } from "../../hooks/queries/useSettings";
import { useTagsQuery } from "../../hooks/queries/useTags";
import TagPicker from "../TagPicker";
import TagPill from "../TagPill";
import {
  buildSkillPack,
  EMPTY_SKILL_PACK_FORM,
  skillPackSourceLabel,
  skillPackStatusLabel,
  type SkillPackForm,
} from "../../lib/skill-packs";
import { MAX_SKILL_PACKS } from "../../../shared/skill-packs.js";

function PackTags({ names, tags }: { names: readonly string[]; tags: readonly Tag[] }) {
  if (names.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {names.map((name) => {
        const tag = tags.find((candidate) => candidate.name === name);
        return tag ? <TagPill key={name} tag={tag} /> : <span key={name} className={DS.text.meta}>{name}</span>;
      })}
    </span>
  );
}

function PackRow({ pack, status, tags, busy, onToggle, onSync, onRemove }: {
  pack: SkillPackConfig;
  status?: SkillPackStatus;
  tags: readonly Tag[];
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onSync: () => void;
  onRemove: () => void;
}) {
  const enabled = pack.enabled !== false;
  const statusLabel = status?.state === "syncing" || busy ? "Syncing" : skillPackStatusLabel(status);
  const failed = status?.state === "error" || status?.state === "missing";
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-text-primary">{pack.name}</span>
          <PackTags names={pack.tags ?? []} tags={tags} />
        </div>
        <div className={cx(DS.text.literal, "truncate")} title={skillPackSourceLabel(pack.source)}>{skillPackSourceLabel(pack.source)}</div>
        <MetaLine items={[
          <span key="status" className={cx(failed && "text-error", (busy || status?.state === "syncing") && DS.motion.live)} title={status?.error}>
            {statusLabel}
          </span>,
        ]} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Switch aria-label={`Use ${pack.name}`} checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} disabled={busy} onClick={onSync}>Sync</Button>
        <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={onRemove} aria-label={`Remove ${pack.name}`}>Remove</Button>
      </div>
    </div>
  );
}

function AddPackForm({ packs, tags, onAdd, onCancel }: {
  packs: readonly SkillPackConfig[];
  tags: readonly Tag[];
  onAdd: (pack: SkillPackConfig) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<SkillPackForm>(EMPTY_SKILL_PACK_FORM);
  const [error, setError] = useState<string | null>(null);
  const update = (changes: Partial<SkillPackForm>) => {
    setForm((current) => ({ ...current, ...changes }));
    setError(null);
  };
  const selectedTagIds = tags.filter((tag) => form.tags.includes(tag.name)).map((tag) => tag.id);
  const submit = () => {
    const result = buildSkillPack(form, packs);
    if ("error" in result) setError(result.error);
    else onAdd(result.pack);
  };

  return (
    <div className={cx(DS.surface.inset, "space-y-3 p-3")}>
      <FormRow label="Name" htmlFor="skill-pack-name">
        <TextInput id="skill-pack-name" value={form.name} placeholder="Team skills" onChange={(event) => update({ name: event.target.value })} />
      </FormRow>
      <FormRow label="Source">
        <SegmentedControl
          ariaLabel="Pack source"
          options={[{ value: "git", label: "Git repository" }, { value: "folder", label: "Folder" }]}
          value={form.kind}
          onChange={(kind) => update({ kind })}
        />
      </FormRow>
      {form.kind === "git" ? (
        <>
          <FormRow label="URL" htmlFor="skill-pack-url">
            <TextInput
              id="skill-pack-url"
              className="font-mono"
              value={form.url}
              placeholder="https://git.example.com/team/skills.git"
              onChange={(event) => update({ url: event.target.value })}
            />
          </FormRow>
          <FormRow label="Branch or tag" htmlFor="skill-pack-ref">
            <TextInput
              id="skill-pack-ref"
              className="font-mono"
              value={form.ref}
              placeholder="Default branch"
              onChange={(event) => update({ ref: event.target.value })}
            />
          </FormRow>
        </>
      ) : (
        <FormRow label="Folder" htmlFor="skill-pack-path">
          <TextInput
            id="skill-pack-path"
            className="font-mono"
            value={form.path}
            placeholder="Absolute path"
            onChange={(event) => update({ path: event.target.value })}
          />
        </FormRow>
      )}
      <FormRow label="Tags">
        <div className="flex min-h-10 flex-wrap items-center gap-1.5 md:min-h-9">
          <PackTags names={form.tags} tags={tags} />
          <TagPicker
            selectedTagIds={selectedTagIds}
            onChange={(ids) => update({ tags: tags.filter((tag) => ids.includes(tag.id)).map((tag) => tag.name) })}
          />
          {form.tags.length === 0 && <span className={DS.text.meta}>All chats</span>}
        </div>
      </FormRow>
      {error && <p role="alert" className="text-xs text-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button onClick={submit}>Add pack</Button>
      </div>
    </div>
  );
}

/** Sets of skills synced from a git repository or read from a folder, on top of the bundled ones. */
export function SkillPacksSection({ draft, setDraft }: { draft: AppSettings; setDraft: (draft: AppSettings) => void }) {
  const queryClient = useQueryClient();
  const { failedKeys, error: writeError } = useSettingsWriter();
  const packsQuery = useQuery({ queryKey: queryKeys.skillPacks, queryFn: fetchSkillPacks });
  const tags = useTagsQuery().data ?? [];
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState<ReadonlySet<string>>(new Set());
  const [syncError, setSyncError] = useState<string | null>(null);
  const packs = draft.skillPacks ?? [];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.skillPacks });
    void queryClient.invalidateQueries({ queryKey: queryKeys.skills });
    void queryClient.invalidateQueries({ queryKey: queryKeys.playbooks });
  };
  const writePacks = (next: SkillPackConfig[]) => {
    setDraft({ ...draft, skillPacks: next.length > 0 ? next : undefined });
    void settingsWriter.whenIdle().then(refresh);
  };
  const sync = async (id: string) => {
    setSyncing((current) => new Set(current).add(id));
    setSyncError(null);
    try {
      const status = await syncSkillPack(id);
      queryClient.setQueryData<{ packs: SkillPackConfig[]; statuses: SkillPackStatus[] }>(queryKeys.skillPacks, (current) => current && {
        ...current,
        statuses: [...current.statuses.filter((entry) => entry.id !== id), status],
      });
      refresh();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };
  const remove = (pack: SkillPackConfig) => {
    // copy-ok: confirms a destructive action
    if (!window.confirm(`Remove skill pack "${pack.name}"? Its skills stop loading in new chats.`)) return;
    writePacks(packs.filter((entry) => entry.id !== pack.id));
  };
  const toggle = (pack: SkillPackConfig, enabled: boolean) => {
    writePacks(packs.map((entry) => {
      if (entry.id !== pack.id) return entry;
      const { enabled: _previous, ...rest } = entry;
      return enabled ? rest : { ...rest, enabled: false };
    }));
  };

  return (
    <SettingsSection
      title="Skill packs"
      count={packs.length}
      action={!adding && packs.length < MAX_SKILL_PACKS
        ? <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setAdding(true)}>Add pack</Button>
        : undefined}
    >
      <div className="space-y-3">
        {failedKeys.has("skillPacks") && writeError?.message && <p role="alert" className="text-xs text-error">{writeError.message}</p>}
        {syncError && <p role="alert" className="text-xs text-error">{syncError}</p>}
        {packsQuery.error && (
          <p role="alert" className="text-xs text-error">
            Pack status could not load. {packsQuery.error instanceof Error ? packsQuery.error.message : ""}
          </p>
        )}
        {packs.length > 0 && (
          <div className={DS.surface.divided}>
            {packs.map((pack) => (
              <PackRow
                key={pack.id}
                pack={pack}
                status={packsQuery.data?.statuses.find((status) => status.id === pack.id)}
                tags={tags}
                busy={syncing.has(pack.id)}
                onToggle={(enabled) => toggle(pack, enabled)}
                onSync={() => void sync(pack.id)}
                onRemove={() => remove(pack)}
              />
            ))}
          </div>
        )}
        {packs.length === 0 && !adding && <EmptyHint>No skill packs.</EmptyHint>}
        {adding && (
          <AddPackForm
            packs={packs}
            tags={tags}
            onCancel={() => setAdding(false)}
            onAdd={(pack) => {
              writePacks([...packs, pack]);
              setAdding(false);
            }}
          />
        )}
      </div>
    </SettingsSection>
  );
}
