// Settings › Helm: when Helm looks over everything, which Bridges it reads, what it may do by
// itself, and what it runs on. What Helm knows (its memory) has its own page.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { fetchModelRoles } from "../../api";
import { MODEL_TIER_INFO } from "../../../shared/model-roles";
import type { HelmPeer, HelmThinkerSettings } from "../../../shared/helm-thinker";
import { Button, Notice, Select, Switch, TextInput } from "../../design/primitives";
import { DS } from "../../design/tokens";
import { useModelsQuery } from "../../hooks/queries/useModels";
import { formatClock, patchThinkerSettings, useHelmBrief, useInvalidateHelm } from "../../helm/thinker-api";
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
  </div>;
}
