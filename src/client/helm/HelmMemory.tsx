// What Helm knows: the memory Helm's chat and its looks start from, Tim's to read, correct and
// forget, plus when Helm looks over everything, and its recent looks.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchModelRoles } from "../api";
import { useSettingsQuery } from "../hooks/queries/useSettings";
import { MODEL_TIER_INFO } from "../../shared/model-roles";
import { ArrowLeft, Pencil, Plus } from "lucide-react";
import {
  HELM_MEMORY_LIMITS, HELM_PICTURE_MAX_WORDS, HELM_STALE_AFTER_DAYS,
  type HelmMemoryEntry, type HelmMemoryKind, type HelmPeer, type HelmThinkerSettings,
} from "../../shared/helm-thinker";
import { Badge, Button, EmptyHint, Notice, Section, Select, Switch, TextArea, TextInput } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import { useModelsQuery } from "../hooks/queries/useModels";
import {
  addHelmMemory, formatAgo, formatCredits, formatClock, formatDuration, patchThinkerSettings, updateHelmMemory,
  useHelmBrief, useHelmMemory, useHelmRuns, useInvalidateHelm,
} from "./thinker-api";

const SECTIONS: Array<{ kind: HelmMemoryKind; label: string; hint: string; addable: boolean }> = [
  { kind: "priority", label: "Priorities", hint: "What matters now. Yours: Helm can suggest, never rewrite.", addable: true },
  { kind: "rule", label: "Rules", hint: "How Helm judges and handles things, learned from your answers or written by you.", addable: true },
  { kind: "thread", label: "Threads", hint: "One line per live task, rewritten only when the task changes.", addable: false },
  { kind: "person", label: "People", hint: "Who matters, and why.", addable: true },
  { kind: "date", label: "Dates", hint: "Dates Helm should keep in mind.", addable: true },
];

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export default function HelmMemory() {
  const navigate = useNavigate();
  const memory = useHelmMemory();
  const brief = useHelmBrief();
  const runs = useHelmRuns();
  const invalidate = useInvalidateHelm();
  const [error, setError] = useState("");
  const entries = memory.data?.entries ?? [];
  const picture = entries.find((entry) => entry.kind === "picture");
  const save = async (work: () => Promise<unknown>) => {
    setError("");
    try { await work(); await invalidate(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return <div className="flex-1 min-h-0 overflow-y-auto">
    <div className={cx(DS.layout.pageColumn, "max-w-4xl space-y-6")}>
      <header className="space-y-2">
        <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard/home")}><ArrowLeft size={14} />Home</Button>
        <h1 className={DS.text.pageTitle}>What Helm knows</h1>
        <p className={cx(DS.text.prose, "max-w-3xl")}>Helm reads this before every look, together with only what changed since its last one. It points to your tasks and conversations instead of copying them. Correct or forget anything here; what you write or keep is yours, and Helm follows it but never changes it.</p>
      </header>
      {error && <Notice tone="danger" title="Not saved">{error}</Notice>}
      {memory.error && <Notice tone="warning" title="Memory unavailable">{memory.error.message}</Notice>}

      <Section label="Standing picture" level="page" surface action={picture && <span className={DS.text.meta}>{wordCount(picture.text).toLocaleString()} of {HELM_PICTURE_MAX_WORDS.toLocaleString()} words · {formatAgo(picture.updatedAt)}</span>}>
        {picture
          ? <>
            <div className="h-1.5 overflow-hidden rounded-full bg-bg-hover"><div className="h-full rounded-full bg-success" style={{ width: `${Math.min(100, (wordCount(picture.text) / HELM_PICTURE_MAX_WORDS) * 100)}%` }} /></div>
            <PictureText entry={picture} onSave={(text) => save(() => updateHelmMemory(picture.id, { text }))} />
          </>
          : <EmptyHint>Helm writes its picture of your world on its first look.</EmptyHint>}
      </Section>

      {SECTIONS.map((section) => <MemorySection key={section.kind} section={section}
        entries={entries.filter((entry) => entry.kind === section.kind)}
        onAdd={(text) => save(() => addHelmMemory(section.kind, text))}
        onEdit={(id, text) => save(() => updateHelmMemory(id, { text }))}
        onKeep={(id) => save(() => updateHelmMemory(id, { status: "active" }))}
        onForget={(id) => save(() => updateHelmMemory(id, { status: "forgotten" }))} />)}

      {brief.data && <SettingsSection settings={brief.data.settings} preview={brief.data.preview} nextRunAt={brief.data.nextRunAt} onSave={(patch) => save(() => patchThinkerSettings(patch))} />}

      <Section label="Recent looks" level="page" surface>
        {(runs.data?.runs ?? []).length === 0 && <EmptyHint>No runs yet.</EmptyHint>}
        <div className="space-y-1">
          {(runs.data?.runs ?? []).map((run) => <div key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-2 text-[13px] first:border-t-0">
            <Badge tone={run.status === "done" ? "success" : run.status === "failed" ? "danger" : "info"}>{run.status === "running" ? "thinking" : run.status}</Badge>
            <span className="text-text-primary">{formatClock(run.startedAt)}</span>
            <span className={DS.text.meta}>{run.trigger === "schedule" ? "scheduled" : "asked"}{run.rebuild ? " · full re-read" : ""}</span>
            {run.finishedAt && <span className={DS.text.meta}>{formatDuration(run)}</span>}
            {run.credits != null && <span className={DS.text.meta}>{formatCredits(run.credits)}</span>}
            {run.changeCount != null && <span className={DS.text.meta}>{run.changeCount} changes read</span>}
            {run.model && <span className={DS.text.meta}>{run.model}{run.effort ? ` · ${run.effort}` : ""}</span>}
            {run.transcriptAvailable
              ? <Link to={`/sessions/${run.sessionId}`} className={cx(DS.text.meta, DS.focus, "ml-auto rounded hover:text-text-primary hover:underline")}>Transcript</Link>
              : <span className={cx(DS.text.meta, "ml-auto")}>Transcript expired</span>}
            {run.error && <p className="w-full text-xs text-error">{run.error}</p>}
          </div>)}
        </div>
      </Section>
    </div>
  </div>;
}

function PictureText({ entry, onSave }: { entry: HelmMemoryEntry; onSave: (text: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.text);
  useEffect(() => { if (!editing) setText(entry.text); }, [entry.text, editing]);
  if (editing) return <div className="mt-3 space-y-2">
    <TextArea rows={14} value={text} onChange={(event) => setText(event.target.value)} />
    <p className={DS.text.meta}>Helm rewrites the picture as things change; your corrections guide the next rewrite.</p>
    <div className="flex gap-2"><Button size="sm" variant="primary" onClick={async () => { await onSave(text); setEditing(false); }}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
  </div>;
  return <div className="mt-3">
    <div className={cx(DS.text.content, "whitespace-pre-wrap")}>{entry.text}</div>
    <Button size="sm" variant="ghost" className="mt-2" onClick={() => setEditing(true)}><Pencil size={13} />Correct</Button>
  </div>;
}

function MemorySection({ section, entries, onAdd, onEdit, onKeep, onForget }: {
  section: (typeof SECTIONS)[number]; entries: HelmMemoryEntry[];
  onAdd: (text: string) => Promise<void>; onEdit: (id: string, text: string) => Promise<void>;
  onKeep: (id: string) => Promise<void>; onForget: (id: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const now = Date.now();
  return <Section label={section.label} count={`${entries.length}/${HELM_MEMORY_LIMITS[section.kind]}`} level="page" surface
    action={section.addable && <Button size="sm" variant="ghost" onClick={() => setAdding((value) => !value)}><Plus size={13} />Add</Button>}>
    <p className={cx(DS.text.prose, "mb-2")}>{section.hint}</p>
    {adding && <div className="mb-3 space-y-2">
      <TextInput value={text} placeholder={`A ${section.label.toLowerCase().replace(/s$/, "")}, in your words`} onChange={(event) => setText(event.target.value)} />
      <div className="flex gap-2"><Button size="sm" variant="primary" disabled={!text.trim()} onClick={async () => { await onAdd(text.trim()); setText(""); setAdding(false); }}>Save</Button>
        <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button></div>
    </div>}
    {entries.length === 0 && !adding && <EmptyHint>Nothing yet.</EmptyHint>}
    {entries.map((entry) => <MemoryRow key={entry.id} entry={entry} stale={now - Date.parse(entry.confirmedAt) > HELM_STALE_AFTER_DAYS * 86_400_000}
      onEdit={(value) => onEdit(entry.id, value)} onKeep={() => onKeep(entry.id)} onForget={() => onForget(entry.id)} />)}
  </Section>;
}

function MemoryRow({ entry, stale, onEdit, onKeep, onForget }: { entry: HelmMemoryEntry; stale: boolean; onEdit: (text: string) => Promise<void>; onKeep: () => Promise<void>; onForget: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.text);
  return <div className="border-t border-border py-2.5 first:border-t-0">
    {editing
      ? <div className="space-y-2"><TextArea rows={2} value={text} onChange={(event) => setText(event.target.value)} />
        <div className="flex gap-2"><Button size="sm" variant="primary" onClick={async () => { await onEdit(text.trim()); setEditing(false); }}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div></div>
      : <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-relaxed text-text-primary">
            <Badge tone={entry.author === "user" ? "info" : "agent"} className="mr-1.5 align-[1px]">{entry.author === "user" ? "You" : "Helm"}</Badge>
            {entry.status === "proposed" && <Badge tone="warning" className="mr-1.5 align-[1px]">Suggested</Badge>}
            {entry.text}
          </p>
          <p className={cx(DS.text.meta, "mt-0.5")}>{[entry.source, `confirmed ${formatAgo(entry.confirmedAt)}`, entry.uses ? `used ${entry.uses}×` : "", stale ? "will be re-checked" : ""].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          {entry.status === "proposed" && <Button size="sm" onClick={() => void onKeep()}>Keep</Button>}
          <Button size="sm" variant="ghost" onClick={() => { setText(entry.text); setEditing(true); }}>Correct</Button>
          <Button size="sm" variant="ghost" onClick={() => void onForget()}>Forget</Button>
        </div>
      </div>}
  </div>;
}

function SettingsSection({ settings, preview, nextRunAt, onSave }: { settings: HelmThinkerSettings; preview: boolean; nextRunAt: string | null; onSave: (patch: Partial<HelmThinkerSettings>) => Promise<void> }) {
  const models = useModelsQuery({ enabled: true });
  const roles = useQuery({ queryKey: ["models", "roles"], queryFn: ({ signal }) => fetchModelRoles(signal) });
  const settingsQuery = useSettingsQuery();
  const resolved = roles.data?.roles.find((role) => role.role === "helm");
  // "Own" keeps its model in Helm's settings rather than in the role.
  const ownModel = !settingsQuery.data?.modelRoles?.helm ? settingsQuery.data?.helm?.model : undefined;
  const helm = resolved?.model ? resolved : ownModel ? { ...resolved, model: ownModel } : resolved;
  const helmModel = helm?.model
    ? [((models.data ?? []) as Array<{ id: string; name?: string }>).find((model) => model.id === helm.model)?.name ?? helm.model, helm.reasoningEffort && `${helm.reasoningEffort} effort`, helm.tier && `${MODEL_TIER_INFO[helm.tier].label} tier`].filter(Boolean).join(" · ")
    : undefined;
  const [times, setTimes] = useState(settings.times.join(", "));
  const [label, setLabel] = useState(settings.label);
  const [peers, setPeers] = useState<HelmPeer[]>(settings.peers);
  useEffect(() => { setTimes(settings.times.join(", ")); setLabel(settings.label); setPeers(settings.peers); }, [settings]);
  return <Section label="How Helm thinks" level="page" surface>
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div><p className="text-[13px] text-text-primary">Think on a schedule</p><p className={DS.text.meta}>{preview ? "Off in staged previews" : settings.enabled && nextRunAt ? `Next look ${formatClock(nextRunAt)}` : "Only when asked"}</p></div>
        <Switch checked={settings.enabled} onChange={(event) => void onSave({ enabled: event.target.checked })} aria-label="Think on a schedule" />
      </div>
      <label className="block space-y-1"><span className="text-[13px] text-text-primary">Times</span>
        <div className="flex gap-2"><TextInput value={times} onChange={(event) => setTimes(event.target.value)} placeholder="08:00, 18:00" />
          <Button size="sm" onClick={() => void onSave({ times: times.split(/[,\s]+/).filter(Boolean) })}>Save</Button></div>
        <span className={DS.text.meta}>The last look on Sunday re-reads everything from scratch.</span>
      </label>
      <div className="space-y-1">
        <p className="text-[13px] text-text-primary">Model</p>
        <p className={DS.text.meta}>{helmModel ?? "Automatic: your default chat model, or the most capable one when that is a router"}</p>
        <p className={DS.text.meta}>Set under Helm in <Link to="/settings?group=chat" className="text-accent hover:underline">Settings › Models</Link>, with the tiers everything else uses.</p>
      </div>
      <label className="block space-y-1"><span className="text-[13px] text-text-primary">What Helm may do by itself</span>
        <Select value={settings.autonomy} onChange={(event) => void onSave({ autonomy: event.target.value as "propose" | "routine" })}>
          <option value="routine">Mark replies that need nothing from me as read (with undo)</option>
          <option value="propose">Nothing: only propose</option>
        </Select></label>
      <label className="block space-y-1"><span className="text-[13px] text-text-primary">This Bridge's name in briefs</span>
        <div className="flex gap-2"><TextInput value={label} onChange={(event) => setLabel(event.target.value)} />
          <Button size="sm" onClick={() => void onSave({ label })}>Save</Button></div></label>
      <div className="space-y-2">
        <p className="text-[13px] text-text-primary">Other Bridges Helm reads</p>
        <p className={DS.text.meta}>Helm reads them over your network and changes nothing there unless you click. Leave out any Bridge whose work should stay separate.</p>
        {peers.map((peer, index) => <div key={index} className="grid gap-2 sm:grid-cols-[6rem_8rem_1fr_1fr_auto]">
          <TextInput value={peer.id} placeholder="id" onChange={(event) => setPeers(peers.map((item, i) => i === index ? { ...item, id: event.target.value } : item))} />
          <TextInput value={peer.label} placeholder="Name" onChange={(event) => setPeers(peers.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} />
          <TextInput value={peer.apiUrl} placeholder="API URL" onChange={(event) => setPeers(peers.map((item, i) => i === index ? { ...item, apiUrl: event.target.value } : item))} />
          <TextInput value={peer.webUrl} placeholder="Web URL" onChange={(event) => setPeers(peers.map((item, i) => i === index ? { ...item, webUrl: event.target.value } : item))} />
          <Button size="sm" variant="ghost" onClick={() => setPeers(peers.filter((_, i) => i !== index))}>Remove</Button>
        </div>)}
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setPeers([...peers, { id: "", label: "", apiUrl: "", webUrl: "" }])}><Plus size={13} />Add a Bridge</Button>
          <Button size="sm" onClick={() => void onSave({ peers })}>Save Bridges</Button>
        </div>
      </div>
    </div>
  </Section>;
}
