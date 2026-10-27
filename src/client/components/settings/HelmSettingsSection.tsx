// Settings › Helm: when Helm looks over everything, which Bridges it reads, what it may do by
// itself, and what it runs on. What Helm knows (its memory) has its own page.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { fetchMcpServers, fetchModelRoles, type McpServer } from "../../api";
import { MODEL_TIER_INFO } from "../../../shared/model-roles";
import { HELM_MAX_SOURCE_TOOLS, type HelmPeer, type HelmSourceSelection, type HelmThinkerSettings } from "../../../shared/helm-thinker";
import { Badge, Button, Notice, Select, SettingList, SettingRow, Switch, TextInput } from "../../design/primitives";
import { DS } from "../../design/tokens";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { fetchSourceTools, formatClock, patchThinkerSettings, useHelmBrief, useInvalidateHelm, type HelmSourceTool } from "../../helm/thinker-api";
import { SettingsSection } from "./SettingsSection";

export function HelmSettingsSection() {
  const brief = useHelmBrief();
  const invalidate = useInvalidateHelm();
  const [error, setError] = useState("");
  const save = async (patch: Partial<HelmThinkerSettings>) => {
    setError("");
    try { await patchThinkerSettings(patch); await invalidate(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <SettingsSection title="How Helm thinks"
    action={<Link to="/helm/memory" className="text-xs text-accent hover:underline">What Helm knows</Link>}>
    {error && <Notice tone="danger" title="Not saved" className="mb-3">{error}</Notice>}
    {brief.error && <Notice tone="warning" title="Helm's settings couldn't load">{brief.error instanceof Error ? brief.error.message : String(brief.error)}</Notice>}
    {brief.data
      ? <HelmSettingsForm settings={brief.data.settings} preview={brief.data.preview} nextRunAt={brief.data.nextRunAt} onSave={save} />
      : !brief.error && <p role="status" className={DS.field.help}>Loading…</p>}
  </SettingsSection>;
}

function HelmSettingsForm({ settings, preview, nextRunAt, onSave }: { settings: HelmThinkerSettings; preview: boolean; nextRunAt: string | null; onSave: (patch: Partial<HelmThinkerSettings>) => Promise<void> }) {
  const models = useModelsQuery({ enabled: true });
  const roles = useQuery({ queryKey: ["models", "roles"], queryFn: ({ signal }) => fetchModelRoles(signal) });
  const helm = roles.data?.roles.find((role) => role.role === "helm");
  const helmModel = helm?.model
    ? [((models.data ?? []) as Array<{ id: string; name?: string }>).find((model) => model.id === helm.model)?.name ?? helm.model, helm.reasoningEffort && `${helm.reasoningEffort} effort`, helm.tier && `${MODEL_TIER_INFO[helm.tier].label} tier`].filter(Boolean).join(" · ")
    : undefined;
  const [times, setTimes] = useState(settings.times.join(", "));
  const [label, setLabel] = useState(settings.label);
  const [peers, setPeers] = useState<HelmPeer[]>(settings.peers);
  useEffect(() => { setTimes(settings.times.join(", ")); setLabel(settings.label); setPeers(settings.peers); }, [settings]);
  return <div className="space-y-4">
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
        <p className={DS.text.meta}>{helmModel ?? helm?.warning ?? "Loading…"}</p>
        <p className={DS.text.meta}>Change it in <Link to="/settings?group=chat" className="text-accent hover:underline">Settings › Models</Link>.</p>
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
        <p className={DS.text.meta}>Helm changes nothing there unless you click.</p>
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
      <HelmSources selected={settings.sources} onSave={(sources) => onSave({ sources })} />
  </div>;
}

/** Which tools of this Bridge's MCP servers Helm's looks may read, such as a mail reader. */
function HelmSources({ selected, onSave }: { selected: HelmSourceSelection[]; onSave: (sources: HelmSourceSelection[]) => Promise<void> }) {
  const servers = useQuery({ queryKey: ["mcp-servers"], queryFn: () => fetchMcpServers() });
  const local = (servers.data ?? []).filter((server) => server.config.type !== "http" && server.config.type !== "sse");
  const missing = selected.filter((source) => servers.data && !servers.data.some((server) => server.id === source.serverId));
  return <div className="space-y-2">
    <p className="text-[13px] text-text-primary">Sources Helm may read</p>
    <p className={DS.text.meta}>Only tools marked read-only can be chosen.</p>
    {servers.error && <Notice tone="warning" title="MCP servers couldn't load">{servers.error instanceof Error ? servers.error.message : String(servers.error)}</Notice>}
    {missing.length > 0 && <Notice tone="warning" title="A chosen server no longer exists">
      <Button size="sm" variant="ghost" onClick={() => void onSave(selected.filter((source) => !missing.includes(source)))}>Remove it from Helm's sources</Button>
    </Notice>}
    {servers.data && local.length === 0 && <p className={DS.text.meta}>No local MCP servers are set up. Add one under MCP servers.</p>}
    <SettingList>
      {local.map((server) => <SourceServerRow key={server.id} server={server} selected={selected.find((source) => source.serverId === server.id)}
        onSave={(tools) => onSave(withSourceTools(selected, server.id, tools))} />)}
    </SettingList>
  </div>;
}

/** The sources with one server's tools replaced, in the same order; no tools removes the server. */
function withSourceTools(selected: HelmSourceSelection[], serverId: string, tools: string[]): HelmSourceSelection[] {
  if (!selected.some((source) => source.serverId === serverId)) return tools.length ? [...selected, { serverId, tools }] : selected;
  return selected.flatMap((source) => source.serverId !== serverId ? [source] : tools.length ? [{ serverId, tools }] : []);
}

function SourceServerRow({ server, selected, onSave }: { server: McpServer; selected?: HelmSourceSelection; onSave: (tools: string[]) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<HelmSourceTool[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<string[]>(selected?.tools ?? []);
  const [dirty, setDirty] = useState(false);
  const saved = (selected?.tools ?? []).join("\n");
  // A refetch of the settings brings this row's saved tools back; it never overwrites edits not saved yet.
  useEffect(() => { if (!dirty) setDraft(saved ? saved.split("\n") : []); }, [saved, dirty]);
  const toggle = (name: string, on: boolean) => {
    setDirty(true);
    setDraft(on ? [...draft, name].slice(0, HELM_MAX_SOURCE_TOOLS) : draft.filter((item) => item !== name));
  };
  const save = async (next: string[]) => { await onSave(next); setDirty(false); };
  async function load() {
    setOpen(true); setLoading(true); setError("");
    try { setTools((await fetchSourceTools(server.id)).tools); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setLoading(false); }
  }
  const chosen = selected?.tools ?? [];
  const changed = draft.length !== chosen.length || draft.some((name) => !chosen.includes(name));
  // A chosen tool the server no longer offers stays listed, so it can be unticked.
  const rows: HelmSourceTool[] = tools ? [...tools, ...draft.filter((name) => !tools.some((tool) => tool.name === name)).map((name) => ({ name, readOnly: false, gone: true }))] : [];
  return <SettingRow label={server.name}
    hint={chosen.length ? `Helm reads: ${chosen.join(", ")}` : "Not read by Helm"}
    control={<div className="flex gap-1">
      {chosen.length > 0 && <Button size="sm" variant="ghost" onClick={() => void save([])}>Stop reading</Button>}
      <Button size="sm" variant="ghost" disabled={loading} onClick={() => (open ? setOpen(false) : void load())}>{open ? "Close" : "Choose tools"}</Button>
    </div>}>
    {open && <div className="space-y-2">
      {loading && <p role="status" className={DS.field.help}>Starting {server.name} to read its tools…</p>}
      {error && <Notice tone="warning" title={`${server.name} couldn't be read`}>{error}</Notice>}
      {tools && tools.length === 0 && <p className={DS.text.meta}>{server.name} offers no tools.</p>}
      {rows.length > 0 && <SettingList>
        {rows.map((tool) => <SettingRow key={tool.name} label={<span className={DS.text.literal}>{tool.name}</span>}
          hint={<>{tool.gone
            ? <Badge tone="warning" className="mr-1.5 align-[1px]">No longer offered</Badge>
            : !tool.readOnly && <Badge tone="warning" className="mr-1.5 align-[1px]">Not marked read-only</Badge>}{tool.description}</>}
          control={<Switch aria-label={`Let Helm use ${tool.name}`} disabled={!tool.readOnly && !draft.includes(tool.name)}
            checked={draft.includes(tool.name)} onChange={(event) => toggle(tool.name, event.target.checked)} />} />)}
      </SettingList>}
      {tools && <Button size="sm" disabled={!changed} onClick={() => void save(draft)}>Save</Button>}
    </div>}
  </SettingRow>;
}
