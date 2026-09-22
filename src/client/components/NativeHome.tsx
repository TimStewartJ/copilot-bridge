import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Clock3, MessageCircle, RefreshCw } from "lucide-react";
import { fetchHome, fetchHomeInput, patchChecklistItem, submitElicitationResponse, submitUserInputResponse } from "../api";
import type { HomeInputSummary, HomePage, HomeSection } from "../../shared/home";
import { Badge, Button, EmptyHint, Notice, Section } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import Dialog from "../design/Dialog";
import { GROUP_COLOR_DOT } from "../group-colors";
import { getSessionPath } from "../lib/session-path";
import { formatSearchExcerpt } from "../lib/search-text";
import ElicitationCard from "./ElicitationCard";
import UserInputQuestionCard from "./UserInputQuestionCard";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import TaskDeferralDialog, { type DeferralTask } from "./TaskDeferralDialog";

const SECTIONS: HomeSection[] = ["overview", "tasks", "inputs", "follow-ups", "actions", "replies"];
const LABELS: Record<HomeSection, string> = { overview: "Home", tasks: "Your tasks", inputs: "Questions for you", "follow-ups": "Ready to revisit", actions: "Checklist", replies: "New from your conversations" };
const ROW = "min-w-0 border-t border-border py-4";
interface Props {
  onSelectTask: (id: string, opts?: { checklistItemId?: string }) => void;
  onSelectSession: (id: string, taskId?: string) => void;
  scrollRestoration?: PullToRefreshScrollRestoration;
}
export default function NativeHome({ onSelectTask, onSelectSession, scrollRestoration }: Props) {
  const navigate = useNavigate(), client = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const requested = search.get("section");
  const section = SECTIONS.find(value => value === requested) ?? "overview";
  const rawOffset = Number(search.get("offset") ?? 0);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 && rawOffset <= 100000 ? rawOffset : 0;
  const query = useQuery({ queryKey: ["dashboard", "home", section, offset], queryFn: ({ signal }) => fetchHome(section, offset, signal),
    refetchInterval: 10000, refetchIntervalInBackground: false, refetchOnWindowFocus: true });
  const data = query.data;
  const [openInput, setOpenInput] = useState<HomeInputSummary>();
  const [deferralTask, setDeferralTask] = useState<DeferralTask>();
  const deferralRow = data?.tasks.items.find(task => task.id === deferralTask?.id);
  const deferralRevisit = data?.followUps.items.find(task => task.taskId === deferralTask?.id);
  const currentDeferralTask = deferralRow ?? (deferralRevisit
    ? { id: deferralRevisit.taskId, title: deferralRevisit.title, deferred: deferralRevisit.deferred, nextTouchAt: deferralRevisit.at }
    : deferralTask);
  const inputQuery = useQuery({ queryKey: ["dashboard", "home-input", openInput?.sessionId, openInput?.kind, openInput?.requestId],
    queryFn: ({ signal }) => fetchHomeInput(openInput!, signal), enabled: !!openInput, refetchInterval: openInput ? 10000 : false });
  const [pending, setPending] = useState(false), [mutationError, setMutationError] = useState("");
  const selectedInput = !query.error && openInput && data?.inputs.items.find(item => item.sessionId === openInput.sessionId
    && item.kind === openInput.kind && item.requestId === openInput.requestId);
  const input = inputQuery.data;
  const answerable = !!selectedInput && !!input && !inputQuery.error;
  function visit(target: HomeSection, targetOffset = 0) {
    const params = new URLSearchParams(search);
    params.set("section", target); params.set("offset", String(targetOffset));
    setSearch(params);
  }
  async function changed() {
    await Promise.all([client.invalidateQueries({ queryKey: ["dashboard"] }), client.invalidateQueries({ queryKey: ["tasks"] }),
      client.invalidateQueries({ queryKey: ["task"] }), client.invalidateQueries({ queryKey: ["checklist-items", "open"] })]);
  }
  async function completeAction(id: string) {
    if (pending) return;
    setPending(true); setMutationError("");
    try { await patchChecklistItem(id, { done: true }); await changed(); }
    catch (error) { setMutationError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  }
  function more<T>(page: HomePage<T>, target: HomeSection) {
    return section === "overview" ? <Button variant="ghost" size="sm" onClick={() => visit(target)}>{target === "tasks" ? "View all tasks" : "View all"} <ArrowRight size={14} /></Button>
      : <div className="flex items-center gap-2">
        <span className={DS.text.meta}>{page.total === null ? "Total unavailable" : `${page.total} total`}</span>
        {offset > 0 && <Button variant="ghost" size="sm" aria-label="Previous page" onClick={() => visit(target, Math.max(0, offset - 20))}><ChevronLeft size={16} /></Button>}
        {page.hasMore && <Button variant="ghost" size="sm" aria-label="Next page" onClick={() => visit(target, offset + 20)}><ChevronRight size={16} /></Button>}
      </div>;
  }
  const questions = data && <Section label="Needs your answer" surface action={more(data.inputs, "inputs")}>
    <p className={DS.text.prose}>One question per waiting conversation. Open the conversation to see any others.</p>
    {data.inputs.items.map(item => <div key={`${item.sessionId}/${item.kind}/${item.requestId}`} className={ROW}>
      <div className="flex items-start gap-3"><MessageCircle size={17} className={cx(DS.text.attention, "mt-1 shrink-0")} />
        <div className="min-w-0 flex-1"><p className={cx(DS.text.content, "line-clamp-3")}>{item.question}</p>
          <p className={cx(DS.text.meta, "mt-2")}>{item.taskTitle ?? "Standalone conversation"} · {item.title}{item.pendingCount > 1 ? ` · ${item.pendingCount} questions waiting` : ""}</p></div></div>
      <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => setOpenInput(item)}>Answer</Button><Button size="sm" variant="ghost" onClick={() => onSelectSession(item.sessionId, item.taskId)}>Open conversation</Button></div>
    </div>)}
    {data.inputErrors.map(item => <Notice key={item.sessionId} tone="warning" title="Question status unavailable">{item.title}: {item.error}<Button variant="ghost" onClick={() => onSelectSession(item.sessionId, item.taskId)}>Open conversation</Button></Notice>)}
    {!data.inputs.items.length && !data.inputErrors.length && <EmptyHint>{data.inputs.total === null ? "Question sources could not be fully read." : "No live questions on this page."}</EmptyHint>}
  </Section>;
  const followUps = data && <Section label="Ready to revisit" surface action={more(data.followUps, "follow-ups")}>
    <p className={DS.text.prose}>Dates you chose to check back, not deadlines or automatic restarts.</p>
    {data.followUps.items.map(item => <div key={item.taskId} className={ROW}>
      <button className={cx(DS.text.content, DS.focus, "text-left font-medium")} onClick={() => onSelectTask(item.taskId)}>{item.title}</button>
      <p className={cx(DS.text.meta, "mt-1")}>{new Date(item.at).toLocaleString(undefined, { timeZone: data.timezone })} · {data.timezone}</p>
      {item.deferred && <Badge className="mt-2">Deferred</Badge>}
      <p className={cx(DS.text.prose, "mt-2 line-clamp-2")}>{item.waitingOn ? `Waiting for: ${item.waitingOn}` : item.nextAction ? `Next step: ${item.nextAction}` : "Revisit this task."}</p>
      <div className="mt-2 flex flex-wrap gap-2"><Button variant="ghost" size="sm" onClick={() => onSelectTask(item.taskId)}>Review task <ArrowRight size={14} /></Button>
        {item.deferred && <Button variant="ghost" size="sm" onClick={() => setDeferralTask({ id: item.taskId, title: item.title, deferred: item.deferred, nextTouchAt: item.at })}>Resume task</Button>}</div>
    </div>)}
    {!data.followUps.items.length && <EmptyHint>No revisit dates have arrived on this page.</EmptyHint>}
  </Section>;
  const actions = data && <Section label={section === "actions" ? "Your checklist" : "Checklist deadlines"} surface action={more(data.actions, "actions")}>
    {section === "overview" && <p className={DS.text.prose}>{data.openActionTotal} open items across your tasks and global checklist. Only due deadlines appear here.</p>}
    {data.actions.items.map(item => <div key={item.id} className={cx(ROW, "flex gap-3")}>
      {section !== "actions" && (item.text.length > 160 || item.text.includes("\n"))
        ? <Button size="sm" aria-label={`Read checklist item: ${item.text.slice(0, 80)}`} onClick={() => item.taskId ? onSelectTask(item.taskId, { checklistItemId: item.id }) : visit("actions")}>Read</Button>
        : <Button size="sm" aria-label={`Complete ${item.text}`} disabled={pending} onClick={() => void completeAction(item.id)}><Check size={15} /></Button>}
      <div className="min-w-0 flex-1"><p className={cx(DS.text.content, section === "actions" ? "whitespace-pre-wrap" : "line-clamp-3")}>{item.text}</p>
        <p className={cx(DS.text.meta, "mt-1")}>{item.taskTitle ?? "Global checklist"}{item.deadline ? ` · Due ${item.deadline}` : ""}</p>
        {item.taskId && <Button size="sm" variant="ghost" onClick={() => onSelectTask(item.taskId!, { checklistItemId: item.id })}>Open task</Button>}</div>
    </div>)}
    {!data.actions.items.length && <EmptyHint>{section === "actions" ? "No open checklist items on this page." : "No checklist deadlines are due. Undated items remain in your checklist."}</EmptyHint>}
  </Section>;
  const tasks = data && <Section label={section === "tasks" ? "Your tasks" : "Continue working"} level="page" surface action={more(data.tasks, "tasks")}>
    <p className={DS.text.prose}>{section === "tasks" ? "All active, unmuted tasks, including those you set aside." : "Tasks you have not deferred, with any next step you recorded."}</p>
    {data.deferredTaskTotal > 0 && <p className={cx(DS.text.meta, "mt-2")}>{data.deferredTaskTotal} deferred {data.deferredTaskTotal === 1 ? "task is" : "tasks are"} available in View all tasks. Muted tasks remain in the task list.</p>}
    {data.tasks.items.map(task => <div key={task.id} className={ROW}>
      <div className="flex items-start justify-between gap-3"><div className="min-w-0">
        <div className="flex items-center gap-2">{task.groupColor && <span className={cx("h-2 w-2 shrink-0 rounded-sm", GROUP_COLOR_DOT[task.groupColor] ?? GROUP_COLOR_DOT.slate)} />}
          <button className={cx(DS.text.content, DS.focus, "text-left text-base font-semibold")} onClick={() => onSelectTask(task.id)}>{task.title}</button></div>
        {(task.groupName || task.kind === "ongoing") && <p className={cx(DS.text.meta, "mt-1")}>{[task.groupName, task.kind === "ongoing" ? "Ongoing" : undefined].filter(Boolean).join(" · ")}</p>}
      </div>{task.inputCount ? <Badge tone="warning">Needs answer</Badge> : task.stalledCount ? <Badge tone="warning">{task.stalledCount} stalled</Badge>
        : task.runningCount > 0 && <Badge tone="info">{task.runningCount === 1 ? "Agent working" : `${task.runningCount} sessions working`}</Badge>}</div>
      {task.deferred && <Badge className="mt-2">Deferred</Badge>}
      <p className={cx(task.nextAction || task.waitingOn ? DS.text.content : DS.text.prose, "mt-3 line-clamp-2")}>{task.nextAction ? `${task.deferred ? "When resumed" : "Next step"}: ${task.nextAction}` : task.waitingOn ? `Waiting for: ${task.waitingOn}` : "No next step recorded."}</p>
      {task.nextAction && task.waitingOn && <p className={cx(DS.text.meta, "mt-1 line-clamp-2")}>Waiting for: {task.waitingOn}</p>}
      {task.nextTouchAt && <p className={cx(DS.text.meta, "mt-1")}>Revisit on {new Date(task.nextTouchAt).toLocaleString(undefined, { timeZone: data.timezone })}</p>}
      <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" onClick={() => onSelectTask(task.id)}>Open task</Button>
        {task.sessionId && <Button size="sm" variant="ghost" onClick={() => onSelectSession(task.sessionId!, task.id)}>Continue conversation <ArrowRight size={14} /></Button>}
        {task.deferred && <Button size="sm" variant="ghost" onClick={() => setDeferralTask(task)}>Resume task</Button>}</div>
    </div>)}
    {!data.tasks.items.length && <EmptyHint>{section === "tasks" ? "No active, unmuted tasks on this page." : "No tasks to continue on this page. Deferred tasks remain in View all tasks."} Archived work remains in the task list.</EmptyHint>}
  </Section>;
  const replies = data && <Section label="New from your conversations" level="page" surface action={more(data.replies, "replies")}>
    <p className={DS.text.prose}>{section === "replies" ? "All unread conversations" : "The latest unread conversation per task"}, not a claim that work is complete.</p>
    {data.replies.items.map(reply => <div key={reply.sessionId} className={ROW}>
      <p className={cx(DS.text.content, "font-medium")}>{reply.taskTitle ?? reply.title}</p>
      <p className={cx(reply.excerpt ? DS.text.content : DS.text.prose, "mt-2 line-clamp-3")}>{reply.excerpt ? formatSearchExcerpt(reply.excerpt) : reply.error}</p>
      <p className={cx(DS.text.meta, "mt-2")}>{reply.title}{reply.timestamp ? ` · ${new Date(reply.timestamp).toLocaleString()}` : ""}</p>
      <Button className="mt-2" variant="ghost" size="sm" onClick={() => reply.sourceEventId
        ? navigate(`${getSessionPath({ sessionId: reply.sessionId, taskId: reply.taskId })}?message=${encodeURIComponent(reply.sourceEventId)}`)
        : onSelectSession(reply.sessionId, reply.taskId)}>Open {reply.sourceEventId ? "reply" : "conversation"} <ArrowRight size={14} /></Button>
    </div>)}
    {!data.replies.items.length && <EmptyHint>{data.replies.total === null ? "Conversation sources could not be fully read." : "No unread conversation returns on this page."}</EmptyHint>}
  </Section>;
  return <div className="flex-1 min-h-0 relative"><PullToRefresh className="absolute inset-0" scrollRestoration={scrollRestoration} onRefresh={async () => { await query.refetch(); }}>
    <div className={cx(DS.layout.pageColumn, "max-w-6xl space-y-7")}>
      <header className="flex items-start justify-between gap-4"><div>
        {section !== "overview" && <Button variant="ghost" size="sm" onClick={() => visit("overview")}><ChevronLeft size={14} />Home</Button>}
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{section === "overview" ? "Pick up where you left off." : LABELS[section]}</h1>
        <p className={cx(DS.text.prose, "mt-2")}>Your tasks, conversations, and next steps. Nothing to manage twice.</p>
      </div><Button variant="ghost" aria-label="Refresh Home" onClick={() => void query.refetch()}><RefreshCw size={16} /></Button></header>
      {query.error && <Notice tone="warning" title="Home could not refresh">{query.error.message} {data && "Showing the last successful read."}</Notice>}
      {mutationError && <Notice tone="danger" title="The change was not saved">{mutationError}</Notice>}
      {data?.sourceErrors.map(error => <Notice key={error} tone="warning" title="Partial source information">{error}</Notice>)}
      {!data ? <EmptyHint>{query.error ? "Source data is unavailable, not empty." : "Loading your tasks and conversations…"}</EmptyHint> : section === "overview"
        ? <div className="grid items-start gap-7 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
          <div className="min-w-0 space-y-7">{(data.inputs.items.length > 0 || data.inputErrors.length > 0) && <div className="xl:hidden">{questions}</div>}{tasks}{replies}</div>
          <div className="min-w-0 space-y-7"><div className={data.inputs.items.length > 0 || data.inputErrors.length > 0 ? "hidden xl:block" : undefined}>{questions}</div>{followUps}{actions}</div>
        </div>
        : <div className="space-y-7">{section === "tasks" ? tasks : section === "inputs" ? questions : section === "follow-ups" ? followUps : section === "actions" ? actions : replies}</div>}
      <footer className={cx(DS.text.meta, "flex flex-wrap items-center gap-2")}><Clock3 size={13} />Home reads the same sources as your tasks and chats.{data && ` Dates assessed in ${data.timezone}.`}
        <Button size="sm" variant="ghost" onClick={() => navigate("/dashboard/archive")}>Previous dashboard records</Button></footer>
    </div>
  </PullToRefresh>{currentDeferralTask && <TaskDeferralDialog task={currentDeferralTask}
    onClose={() => setDeferralTask(undefined)} />}
  {openInput && <Dialog title="Answer in this conversation"
    description={`${openInput.taskTitle ?? "Standalone conversation"} · ${openInput.title}`}
    pending={pending} onClose={() => setOpenInput(undefined)}>
    {!answerable && !inputQuery.isPending && <Notice title="This question cannot currently be verified as answerable">Open the conversation to check its current state. It may have been answered or ended, or Home may be unable to refresh. Your draft is retained, but no answer is being sent.
      <Button onClick={() => onSelectSession(openInput.sessionId, openInput.taskId)}>Open conversation</Button></Notice>
    }
    {!input && inputQuery.isPending && <EmptyHint>Loading the native question…</EmptyHint>}
    {input && <fieldset disabled={!answerable} aria-disabled={!answerable}>
      {input.kind === "user_input" ? <UserInputQuestionCard key={input.request.requestId} request={input.request} onSubmit={async (id, value) => {
        if (!answerable) throw new Error("The native question is not currently verified as answerable. Open its conversation.");
        setPending(true);
        try { await submitUserInputResponse(openInput.sessionId, id, value); await changed(); setOpenInput(undefined); }
        finally { setPending(false); }
      }} /> : <ElicitationCard key={input.request.requestId} request={input.request} onSubmit={async (id, value) => {
        if (!answerable) throw new Error("The native question is not currently verified as answerable. Open its conversation.");
        setPending(true);
        try { await submitElicitationResponse(openInput.sessionId, id, value); await changed(); setOpenInput(undefined); }
        finally { setPending(false); }
      }} />}</fieldset>}
  </Dialog>}</div>;
}
