// Home as Helm's brief: what Helm decided needs Tim on its last look, with one-tap actions; what it
// handled, proposes and is watching. Talking to Helm is the conversation beside it. The full lists
// stay one link away (classic Home), and nothing here acts without Tim's click except what he
// allowed Helm to handle.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Brain, Check, ExternalLink, Loader2, RefreshCw, RotateCcw, Send, Sparkles } from "lucide-react";
import type { HelmAction, HelmBriefItem, HelmBriefResponse, HelmItemKind, HelmProposal } from "../../shared/helm-thinker";
import type { TaskOverviewRow } from "../../shared/task-overview";
import { Badge, Button, EmptyHint, Notice, Section, TextArea, TextInput } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "../components/PullToRefresh";
import { OutcomeNotice } from "../components/QuietTasks";
import { useTaskOutcomes } from "../hooks/useTaskOutcomes";
import { useTaskOverviewQuery } from "../hooks/queries/useTaskOverview";
import { useIsMobile } from "../useIsMobile";
import {
  actOnItem, formatAgo, formatCredits, formatClock, formatDuration, itemFeedback, thinkNow, undoHandled, updateHelmMemory, useHelmBrief, useInvalidateHelm,
} from "./thinker-api";

const KIND_LABEL: Record<HelmItemKind, string> = { question: "Question", decision: "Decision", due: "Due", connects: "Connects tasks", fyi: "Worth knowing" };
const KIND_TONE: Record<HelmItemKind, "accent" | "info" | "warning" | "agent" | "neutral"> = { question: "accent", decision: "info", due: "warning", connects: "agent", fyi: "neutral" };

function partOfDay(now = new Date()): string {
  const day = now.toLocaleDateString([], { weekday: "long" });
  const hour = now.getHours();
  return `${day} ${hour < 5 ? "night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 22 ? "evening" : "night"}`;
}

interface Props {
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  onSelectSession: (id: string, taskId?: string) => void;
  scrollRestoration?: PullToRefreshScrollRestoration;
  /** "column" when the brief shares the page with the Helm conversation: one narrow column. */
  layout?: "full" | "column";
  /** Home's link row above the brief already offers Everything (the classic Home). */
  everythingInNav?: boolean;
}

export default function HelmHome({ onSelectTask, onSelectSession, scrollRestoration, layout = "full", everythingInNav = false }: Props) {
  const column = layout === "column";
  const navigate = useNavigate();
  // On a phone, What Helm knows opens from the Helm tab's menu, so the day's title keeps the line.
  const phone = useIsMobile();
  const query = useHelmBrief();
  const invalidate = useInvalidateHelm();
  const data = query.data;
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const outcomes = useTaskOutcomes();
  const needsOverview = !!data?.brief && [...data.brief.items.flatMap((item) => item.actions), ...data.brief.proposals.flatMap((proposal) => proposal.actions)]
    .some((action) => action.do.type === "close_tasks");
  const overview = useTaskOverviewQuery(needsOverview);
  const labels = useMemo(() => new Map<string, string>([["local", data?.settings.label ?? "This Bridge"], ...(data?.settings.peers ?? []).map((peer) => [peer.id, peer.label] as [string, string])]), [data?.settings]);

  async function closeTasks(taskIds: string[]) {
    const rows = (overview.data?.tasks ?? []).filter((row: TaskOverviewRow) => taskIds.includes(row.id));
    if (rows.length !== taskIds.length) throw new Error("Some of those tasks couldn't be found (they may be closed already). Open them to check.");
    if (!await outcomes.applyAll(rows, "finished")) throw new Error("Not every task could be closed; see the note above.");
  }

  async function think() {
    setError(""); setStarting(true);
    try { await thinkNow(); await invalidate(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setStarting(false); }
  }

  function open(target: { bridge: string; sessionId?: string; taskId?: string; url?: string }) {
    if (target.bridge === "local") {
      if (target.sessionId) onSelectSession(target.sessionId, target.taskId);
      else if (target.taskId) onSelectTask(target.taskId);
    } else if (target.url) {
      window.open(target.url, "_blank", "noopener");
    }
  }

  const run = data?.run;
  const brief = data?.brief;
  const openItems = brief?.items.filter((item) => (data?.itemStates[item.id]?.status ?? "open") === "open") ?? [];
  const closedItems = brief?.items.filter((item) => data?.itemStates[item.id] && data.itemStates[item.id]!.status !== "open") ?? [];
  const bridgeNames = run?.bridges.filter((bridge) => bridge.ok).map((bridge) => bridge.label).join(" and ");

  return <div className="flex-1 min-h-0 relative"><PullToRefresh className="absolute inset-0" scrollRestoration={scrollRestoration} onRefresh={async () => { await query.refetch(); }}>
    <div className={column ? "space-y-6 px-4 py-5" : cx(DS.layout.pageColumn, "max-w-6xl space-y-6")}>
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <h1 className={DS.text.pageTitle}>{partOfDay()}</h1>
          {(!phone || !everythingInNav) && <div className="flex shrink-0 items-center gap-1">
            {!phone && <Button variant="ghost" size="sm" onClick={() => navigate("/helm/memory")}><Brain size={14} />What Helm knows</Button>}
            {!everythingInNav && <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard/home?view=classic")}>Everything<ArrowRight size={14} /></Button>}
          </div>}
        </div>
        {brief && <p className="max-w-3xl text-[15px] leading-relaxed text-text-primary">{brief.summary}</p>}
        <div className={cx(DS.text.meta, "flex flex-wrap items-center gap-x-3 gap-y-1")}>
          {run && <span>Helm thought at {formatClock(run.startedAt)}{run.finishedAt ? ` · ${formatDuration(run)}` : ""}</span>}
          {run?.changeCount != null && <span>read {run.changeCount} changes{bridgeNames ? ` on ${bridgeNames}` : ""}</span>}
          {run && run.sources.some((source) => source.used) && <span>also read {run.sources.filter((source) => source.used).map((source) => source.name).join(", ")}</span>}
          {run?.credits != null && <span>{formatCredits(run.credits)}</span>}
          {data?.nextRunAt && <span>next look {formatClock(data.nextRunAt)}</span>}
          {run?.transcriptAvailable && <button type="button" className={cx(DS.focus, "hover:text-text-primary hover:underline")} onClick={() => onSelectSession(run.sessionId)}>How Helm got here</button>}
          {data && !data.running && <Button variant="ghost" size="sm" disabled={starting} onClick={() => void think()}><RefreshCw size={13} />Think again</Button>}
        </div>
        {run?.bridges.filter((bridge) => !bridge.ok).map((bridge) => <Notice key={bridge.id} tone="warning" title={`${bridge.label} couldn't be read`}>{bridge.error}</Notice>)}
        {run?.sources.filter((source) => !source.ok).map((source) => <Notice key={source.serverId} tone="warning" title={`${source.name} couldn't be read`}>{source.error}</Notice>)}
      </header>

      {data?.running && <Notice tone="info" icon={<Loader2 size={15} className="animate-spin" />} title="Helm is thinking">
        Started {formatAgo(data.running.startedAt)} on {data.running.model ?? "its model"}.
      </Notice>}
      {data?.lastFailure && !data.running && <Notice tone="warning" title="Helm's last look didn't finish">{data.lastFailure.error ?? "Unknown error"} ({formatAgo(data.lastFailure.startedAt)})</Notice>}
      {data?.preview && <Notice tone="neutral" title="Staged preview">Previews don't think on a schedule or change other Bridges.</Notice>}
      {(error || query.error) && <Notice tone="danger" title="Something went wrong">{error || query.error?.message}</Notice>}
      <OutcomeNotice receipt={outcomes.receipt} error={outcomes.error} pending={outcomes.pending} onUndo={() => void outcomes.undoLast()} onDismiss={outcomes.dismiss} />
      {data && (data.since.questions > 0 || data.since.replies > 0) && <div className={cx(DS.surface.inset, "flex flex-wrap items-center gap-2 px-3 py-2 text-[13px] text-text-secondary")}>
        <Sparkles size={14} className="text-accent" />Since this brief: {[data.since.questions ? `${data.since.questions} new question${data.since.questions === 1 ? "" : "s"}` : "", data.since.replies ? `${data.since.replies} new repl${data.since.replies === 1 ? "y" : "ies"}` : ""].filter(Boolean).join(" · ")}
        <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard/home?view=classic")}>See them</Button>
        {!data.running && <Button variant="ghost" size="sm" onClick={() => void think()}>Think again</Button>}
      </div>}

      {!data ? <EmptyHint>{query.error ? "Helm's brief is unavailable." : "Loading Helm's brief…"}</EmptyHint>
        : !brief ? <Section label="Helm hasn't written a brief yet" level="page" surface>
          {data.settings.enabled && data.settings.times.length > 0 && <p className={DS.text.prose}>Runs at {data.settings.times.join(" and ")} by itself.</p>}
          <div className="mt-3 flex gap-2"><Button variant="primary" disabled={!!data.running || starting} onClick={() => void think()}><Brain size={15} />Think now</Button>
            <Button variant="ghost" onClick={() => navigate("/dashboard/home?view=classic")}>Use the classic Home</Button></div>
        </Section>
        : <div className={column ? "space-y-6" : "grid items-start gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,1fr)]"}>
          <div className="min-w-0 space-y-6">
            <Section label="Needs you" count={openItems.length || undefined} level="page" surface>
              {openItems.length === 0 && <EmptyHint>{closedItems.length ? "All done. Nothing else needs you right now." : "Nothing needs you right now."}</EmptyHint>}
              {openItems.map((item) => <ItemCard key={item.id} runId={run!.id} item={item} bridgeLabel={labels.get(item.bridge) ?? item.bridge} preview={data.preview}
                onOpen={open} onChanged={invalidate} onError={setError}
                onCloseTasks={closeTasks} />)}
              {closedItems.length > 0 && <div className="mt-2 space-y-1 border-t border-border pt-3">
                {closedItems.map((item) => <div key={item.id} className="flex items-center gap-2 text-[13px] text-text-muted">
                  <Check size={14} className="shrink-0 text-success" /><span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span className={DS.text.meta}>{data.itemStates[item.id]?.outcome}</span>
                  <Button variant="ghost" size="sm" onClick={async () => { await itemFeedback(run!.id, item.id, "reopen"); await invalidate(); }}>Reopen</Button>
                </div>)}
              </div>}
            </Section>
            {data.proposed.length > 0 && <Section label="Helm suggests remembering" level="page" surface>
              {data.proposed.map((entry) => <div key={entry.id} className="border-t border-border py-3 first:border-t-0 first:pt-0">
                <p className={DS.text.content}><span className="font-medium">{entry.kind === "rule" ? "Rule" : "Priority"}:</span> {entry.text}</p>
                {entry.source && <p className={cx(DS.text.meta, "mt-1")}>From {entry.source}</p>}
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={async () => { await updateHelmMemory(entry.id, { status: "active" }); await invalidate(); }}>Keep</Button>
                  <Button size="sm" variant="ghost" onClick={async () => { await updateHelmMemory(entry.id, { status: "forgotten" }); await invalidate(); }}>Forget</Button>
                </div>
              </div>)}
            </Section>}
          </div>
          <div className="min-w-0 space-y-6">
            <SideColumn data={data} labels={labels} onOpen={open} onChanged={invalidate} onError={setError}
              onCloseTasks={closeTasks} />
          </div>
        </div>}
    </div>
  </PullToRefresh></div>;
}

function describeOutbound(action: HelmAction): string | undefined {
  if (action.do.type === "answer") return action.do.answer;
  if (action.do.type === "send") return action.do.message;
  return undefined;
}

function ActionButtons({ runId, itemId, actions, preview, bridge, onOpen, onChanged, onError, onCloseTasks }: {
  runId: string; itemId: string; actions: HelmAction[]; preview: boolean; bridge: string;
  onOpen: (target: { bridge: string; sessionId?: string; taskId?: string; url?: string }) => void;
  onChanged: () => Promise<unknown>; onError: (message: string) => void; onCloseTasks: (taskIds: string[]) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<HelmAction>();
  const [pending, setPending] = useState(false);
  const blocked = preview && bridge !== "local";
  async function run(action: HelmAction) {
    setPending(true); onError("");
    try {
      if (action.do.type === "open") { onOpen({ bridge: action.do.bridge, sessionId: action.do.sessionId, taskId: action.do.taskId, url: action.url }); return; }
      if (action.do.type === "close_tasks") {
        await onCloseTasks(action.do.taskIds);
        await itemFeedback(runId, itemId, "done");
      } else {
        const result = await actOnItem(runId, itemId, { actionId: action.id });
        if (result.sessionId) onOpen({ bridge: "local", sessionId: result.sessionId });
      }
      setConfirming(undefined);
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }
  if (actions.length === 0) return null;
  return <div className="mt-3 space-y-2">
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => {
        const outbound = describeOutbound(action);
        const changes = action.do.type !== "open";
        return <Button key={action.id} size="sm" variant={action.primary ? "primary" : "secondary"} disabled={pending || (changes && blocked)}
          title={changes && blocked ? "Changes to other Bridges are off in a staged preview" : undefined}
          onClick={() => (outbound ? setConfirming(action) : void run(action))}>
          {action.do.type === "open" && action.do.bridge !== "local" && <ExternalLink size={13} />}{action.label}
        </Button>;
      })}
    </div>
    {confirming && <div className={cx(DS.surface.inset, "space-y-2 px-3 py-2")}>
      <p className={DS.text.rowLabel}>{confirming.do.type === "answer" ? "Helm will answer the question with:" : "Helm will send this to the conversation:"}</p>
      <blockquote className="whitespace-pre-wrap border-l-2 border-border pl-3 text-[13px] leading-relaxed text-text-primary">{describeOutbound(confirming)}</blockquote>
      <div className="flex gap-2"><Button size="sm" variant="primary" disabled={pending} onClick={() => void run(confirming)}><Send size={13} />Send</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(undefined)}>Cancel</Button></div>
    </div>}
  </div>;
}

function ItemCard({ runId, item, bridgeLabel, preview, onOpen, onChanged, onError, onCloseTasks }: {
  runId: string; item: HelmBriefItem; bridgeLabel: string; preview: boolean;
  onOpen: (target: { bridge: string; sessionId?: string; taskId?: string; url?: string }) => void;
  onChanged: () => Promise<unknown>; onError: (message: string) => void; onCloseTasks: (taskIds: string[]) => Promise<void>;
}) {
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const blocked = preview && item.bridge !== "local";
  async function sendReply() {
    setPending(true); onError("");
    try { await actOnItem(runId, item.id, { text: reply }); setReplying(false); setReply(""); await onChanged(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  async function feedback(kind: "not_for_helm" | "done") {
    setPending(true); onError("");
    try { await itemFeedback(runId, item.id, kind, kind === "not_for_helm" ? note.trim() || undefined : undefined); await onChanged(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  return <article className="border-t border-border py-4 first:border-t-0 first:pt-1">
    <div className={cx(DS.text.meta, "flex flex-wrap items-center gap-2")}>
      <Badge tone={KIND_TONE[item.kind]}>{KIND_LABEL[item.kind]}</Badge><span>{item.source ? `From ${item.source}` : bridgeLabel}</span>
    </div>
    <h3 className={cx(DS.text.objectTitle, "mt-2")}>{item.title}</h3>
    <p className={cx(DS.text.content, "mt-1")}><span className="font-semibold">Helm:</span> {item.recommendation}</p>
    {item.why && <p className={cx(DS.text.prose, "mt-1")}>{item.why}</p>}
    {item.evidence.length > 0 && <p className={cx(DS.text.meta, "mt-1.5 flex flex-wrap gap-x-3 gap-y-1")}>
      {item.evidence.map((evidence, index) => <button key={index} type="button" className={cx(DS.focus, "rounded text-accent hover:underline")}
        onClick={() => onOpen({ ...evidence.target, url: evidence.url })}>{evidence.label}{evidence.target.bridge !== "local" && " ↗"}</button>)}
    </p>}
    <ActionButtons runId={runId} itemId={item.id} actions={item.actions} preview={preview} bridge={item.bridge} onOpen={onOpen} onChanged={onChanged} onError={onError} onCloseTasks={onCloseTasks} />
    <div className="mt-2 flex flex-wrap gap-1">
      {item.reply && <Button size="sm" variant="ghost" disabled={pending || blocked} onClick={() => setReplying((value) => !value)}>{item.reply.requestId ? "Answer…" : "Reply…"}</Button>}
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => void feedback("done")}>Done</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDeclining((value) => !value)}>Not for Helm</Button>
    </div>
    {replying && <div className="mt-2 space-y-2">
      <TextArea rows={3} value={reply} placeholder={item.reply?.requestId ? "Your answer, sent to the agent's question" : "Your message, sent to the conversation"} onChange={(event) => setReply(event.target.value)} />
      <div className="flex gap-2"><Button size="sm" variant="primary" disabled={pending || !reply.trim()} onClick={() => void sendReply()}><Send size={13} />Send</Button>
        <Button size="sm" variant="ghost" onClick={() => setReplying(false)}>Cancel</Button></div>
    </div>}
    {declining && <div className="mt-2 space-y-2">
      <TextInput value={note} placeholder="Why not? Helm learns from this (optional)" onChange={(event) => setNote(event.target.value)} />
      <div className="flex gap-2"><Button size="sm" disabled={pending} onClick={() => void feedback("not_for_helm")}>Tell Helm</Button>
        <Button size="sm" variant="ghost" onClick={() => setDeclining(false)}>Cancel</Button></div>
    </div>}
  </article>;
}

function SideColumn({ data, labels, onOpen, onChanged, onError, onCloseTasks }: {
  data: HelmBriefResponse; labels: Map<string, string>;
  onOpen: (target: { bridge: string; sessionId?: string; taskId?: string; url?: string }) => void;
  onChanged: () => Promise<unknown>; onError: (message: string) => void; onCloseTasks: (taskIds: string[]) => Promise<void>;
}) {
  const run = data.run!;
  const brief = data.brief!;
  const handled = data.handled;
  const proposals = brief.proposals.filter((proposal) => (data.itemStates[proposal.id]?.status ?? "open") === "open");
  return <>
    <Section label={`Handled since ${formatClock(run.startedAt)}`} count={handled.filter((entry) => !entry.undoneAt).length || undefined} level="page" surface>
      {handled.length === 0 && <EmptyHint>{data.settings.autonomy === "routine" ? "Nothing needed handling." : "Helm only proposes."}</EmptyHint>}
      {handled.map((entry) => <div key={entry.id} className="flex items-start gap-2 border-t border-border py-2.5 first:border-t-0 first:pt-0">
        {entry.undoneAt ? <RotateCcw size={14} className="mt-0.5 shrink-0 text-text-faint" /> : <Check size={14} className="mt-0.5 shrink-0 text-success" />}
        <div className="min-w-0 flex-1">
          <button type="button" className={cx(DS.focus, "text-left text-[13px] text-text-primary hover:underline")} onClick={() => onOpen({ bridge: entry.bridge, sessionId: entry.sessionId, url: entry.url })}>Marked read: {entry.title}</button>
          <p className={DS.text.meta}>{entry.undoneAt ? "Undone" : entry.why}</p>
        </div>
        {!entry.undoneAt && <Button size="sm" variant="ghost" onClick={async () => { try { await undoHandled(entry.id); await onChanged(); } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); } }}>Undo</Button>}
      </div>)}
    </Section>
    {proposals.length > 0 && <Section label="Helm proposes" level="page" surface>
      {proposals.map((proposal: HelmProposal) => <div key={proposal.id} className="border-t border-border py-3 first:border-t-0 first:pt-0">
        <p className={DS.text.content}>{proposal.text}</p>
        <ActionButtons runId={run.id} itemId={proposal.id} actions={proposal.actions} preview={data.preview} bridge={proposal.actions[0]?.do.bridge ?? "local"} onOpen={onOpen} onChanged={onChanged} onError={onError} onCloseTasks={onCloseTasks} />
        <Button size="sm" variant="ghost" className="mt-1" onClick={async () => { await itemFeedback(run.id, proposal.id, "not_for_helm"); await onChanged(); }}>Not now</Button>
      </div>)}
    </Section>}
    {brief.watching.length > 0 && <Section label="Watching" level="page" surface>
      {brief.watching.map((watch, index) => <div key={index} className="border-t border-border py-2.5 first:border-t-0 first:pt-0">
        {watch.taskId
          ? <button type="button" className={cx(DS.focus, "text-left text-[13px] text-text-primary hover:underline")} onClick={() => onOpen({ bridge: watch.bridge, taskId: watch.taskId, url: watch.url })}>{watch.text}</button>
          : <p className="text-[13px] text-text-primary">{watch.text}</p>}
        <p className={DS.text.meta}>{labels.get(watch.bridge) ?? watch.bridge}</p>
      </div>)}
    </Section>}
    {data.changes.length > 0 && <Section label="What Helm learned" level="page" surface>
      <ul className="space-y-1.5">
        {data.changes.filter((change) => change.op !== "confirmed").slice(0, 12).map((change, index) => <li key={index} className="text-[13px] text-text-secondary">
          <span className={change.op === "removed" ? "text-text-faint line-through" : ""}>{change.text.length > 140 ? `${change.text.slice(0, 140)}…` : change.text}</span>
        </li>)}
      </ul>
      {data.changes.some((change) => change.op === "confirmed") && <p className={cx(DS.text.meta, "mt-2")}>{data.changes.filter((change) => change.op === "confirmed").length} facts confirmed still true</p>}
    </Section>}
  </>;
}

