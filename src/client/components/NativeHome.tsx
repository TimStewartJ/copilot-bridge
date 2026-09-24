import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowRight, CalendarDays, ChevronLeft, ChevronRight, Clock3, MessageCircle, Pin, RefreshCw } from "lucide-react";
import { fetchHome, fetchHomeInput, patchTask, submitElicitationResponse, submitUserInputResponse } from "../api";
import type { HomeInputSummary, HomePage, HomeSection } from "../../shared/home";
import type { TaskOverviewRow } from "../../shared/task-overview";
import { Badge, Button, EmptyHint, IdentitySwatch, Notice, Section } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import Dialog from "../design/Dialog";
import { getSessionPath } from "../lib/session-path";
import { formatSearchExcerpt } from "../lib/search-text";
import { contextLine, describeIdle, stateBadge } from "../lib/task-state-ui";
import { useTaskOutcomes } from "../hooks/useTaskOutcomes";
import { useTaskOverviewQuery } from "../hooks/queries/useTaskOverview";
import ElicitationCard from "./ElicitationCard";
import HomeChecklist from "./HomeChecklist";
import UserInputQuestionCard from "./UserInputQuestionCard";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./PullToRefresh";
import TaskDeferralDialog, { type DeferralTask } from "./TaskDeferralDialog";
import { OutcomeNotice, QuietReviewDialog, QuietTaskActions, quietLabel } from "./QuietTasks";

const SECTIONS: HomeSection[] = ["overview", "inputs", "actions", "replies"];
const LABELS: Record<HomeSection, string> = { overview: "Home", tasks: "All tasks", inputs: "Needs your answer", "follow-ups": "Home", actions: "Checklist", replies: "New replies", quiet: "Worth a look" };
const ROW = "min-w-0 border-t border-border py-4";
const WEEK_MS = 7 * 86_400_000;
// A server from before checklist counts omits `today`; the browser's date is the closest stand-in.
function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function greeting(now = new Date()): string {
  const hour = now.getHours();
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
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
  const outcomes = useTaskOutcomes();
  const [reviewing, setReviewing] = useState(false);
  const overview = useTaskOverviewQuery(reviewing);
  const [openInput, setOpenInput] = useState<HomeInputSummary>();
  const [deferralTask, setDeferralTask] = useState<DeferralTask>();
  const inputQuery = useQuery({ queryKey: ["dashboard", "home-input", openInput?.sessionId, openInput?.kind, openInput?.requestId],
    queryFn: ({ signal }) => fetchHomeInput(openInput!, signal), enabled: !!openInput, refetchInterval: openInput ? 10000 : false });
  const [pending, setPending] = useState(false), [mutationError, setMutationError] = useState("");
  const selectedInput = !query.error && openInput && data?.inputs.items.find(item => item.sessionId === openInput.sessionId
    && item.kind === openInput.kind && item.requestId === openInput.requestId);
  const input = inputQuery.data;
  const answerable = !!selectedInput && !!input && !inputQuery.error;
  const quietForReview = useMemo(() => (overview.data?.tasks ?? []).filter(row => row.state === "gone_quiet")
    .sort((a, b) => (a.lastEngagedAt ? Date.parse(a.lastEngagedAt) : 0) - (b.lastEngagedAt ? Date.parse(b.lastEngagedAt) : 0)), [overview.data]);
  if (requested === "tasks") return <Navigate to="/dashboard/tasks" replace />;
  function visit(target: HomeSection, targetOffset = 0) {
    const params = new URLSearchParams(search);
    params.set("section", target); params.set("offset", String(targetOffset));
    setSearch(params);
  }
  async function changed() {
    await Promise.all([client.invalidateQueries({ queryKey: ["dashboard"] }), client.invalidateQueries({ queryKey: ["tasks"] }),
      client.invalidateQueries({ queryKey: ["task"] }), client.invalidateQueries({ queryKey: ["checklist-items", "open"] })]);
  }
  async function revisitNextWeek(row: TaskOverviewRow) {
    setMutationError("");
    try { await patchTask(row.id, { nextTouchAt: new Date(Date.now() + WEEK_MS).toISOString() }); await changed(); }
    catch (error) { setMutationError(error instanceof Error ? error.message : String(error)); }
  }
  const resumeRow = (row: TaskOverviewRow) => row.sessionId ? onSelectSession(row.sessionId, row.id) : onSelectTask(row.id);
  function more<T>(page: HomePage<T>, target: HomeSection) {
    return section === "overview" ? <Button variant="ghost" size="sm" onClick={() => visit(target)}>View all <ArrowRight size={14} /></Button>
      : <div className="flex items-center gap-2">
        <span className={DS.text.meta}>{page.total === null ? "Total unavailable" : `${page.total} total`}</span>
        {offset > 0 && <Button variant="ghost" size="sm" aria-label="Previous page" onClick={() => visit(target, Math.max(0, offset - 20))}><ChevronLeft size={16} /></Button>}
        {page.hasMore && <Button variant="ghost" size="sm" aria-label="Next page" onClick={() => visit(target, offset + 20)}><ChevronRight size={16} /></Button>}
      </div>;
  }
  const questionRows = data && <>
    {data.inputs.items.map(item => <div key={`${item.sessionId}/${item.kind}/${item.requestId}`} className={ROW}>
      <div className="flex items-start gap-3"><MessageCircle size={17} className={cx(DS.text.attention, "mt-1 shrink-0")} />
        <div className="min-w-0 flex-1"><p className={cx(DS.text.content, "line-clamp-3")}>{item.question}</p>
          <p className={cx(DS.text.meta, "mt-2")}>{item.taskTitle ?? "Standalone conversation"} · {item.title}{item.pendingCount > 1 ? ` · ${item.pendingCount} questions waiting` : ""}</p>
          <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => setOpenInput(item)}>Answer</Button><Button size="sm" variant="ghost" onClick={() => onSelectSession(item.sessionId, item.taskId)}>Open conversation</Button></div></div></div>
    </div>)}
    {data.inputErrors.map(item => <Notice key={item.sessionId} tone="warning" title="Question status unavailable">{item.title}: {item.error}<Button variant="ghost" onClick={() => onSelectSession(item.sessionId, item.taskId)}>Open conversation</Button></Notice>)}
  </>;
  const attention = data?.attention ?? [], resume = data?.resume ?? [], quiet = data?.quiet ?? { items: [], total: 0, offset: 0, hasMore: false };
  const needsCount = data ? (data.inputs.total ?? data.inputs.items.length) + attention.length : 0;
  const needsYou = data && <Section label="Needs you" count={needsCount || undefined} level="page" surface
    action={data.inputs.hasMore ? <Button variant="ghost" size="sm" onClick={() => visit("inputs")}>All questions <ArrowRight size={14} /></Button> : undefined}>
    {questionRows}
    {attention.map(row => {
      const badge = stateBadge(row), context = contextLine(row), stalled = row.reasons.includes("stalled");
      return <div key={row.id} className={ROW}>
        <div className="flex items-start gap-3">
          {stalled ? <AlertTriangle size={17} className={cx(DS.tone.warning, "mt-0.5 shrink-0")} /> : <CalendarDays size={17} className={cx(DS.tone.warning, "mt-0.5 shrink-0")} />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">{row.groupColor && <IdentitySwatch color={row.groupColor} />}
              <button className={cx(DS.text.content, DS.focus, "text-left font-semibold")} onClick={() => onSelectTask(row.id)}>{row.title}</button>
              {badge && <Badge tone={badge.tone === "warning" ? "warning" : badge.tone === "info" ? "info" : "neutral"}>{stalled ? "Conversation stalled" : badge.label}</Badge>}
              {row.deferred && <Badge>Deferred</Badge>}</div>
            <p className={cx(context.empty ? DS.text.prose : DS.text.content, "mt-1 line-clamp-2")}>{context.text}</p>
            <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" onClick={() => onSelectTask(row.id)}>Open task</Button>
              {row.sessionId && <Button size="sm" variant="ghost" onClick={() => onSelectSession(row.sessionId!, row.id)}>Continue conversation</Button>}
              {row.reasons.includes("revisit") && <Button size="sm" variant="ghost" onClick={() => void revisitNextWeek(row)}>Revisit next week</Button>}
              {row.deferred && <Button size="sm" variant="ghost" onClick={() => setDeferralTask({ id: row.id, title: row.title, deferred: row.deferred, nextTouchAt: row.nextTouchAt })}>Resume</Button>}</div>
          </div>
        </div>
      </div>;
    })}
    {!needsCount && !data.inputErrors.length && <EmptyHint>{data.inputs.total === null ? "Question status unavailable." : "Nothing needs you right now."}</EmptyHint>}
  </Section>;
  const pickUp = data && <Section label="Pick up where you left off" level="page" surface
    action={<Button variant="ghost" size="sm" onClick={() => navigate("/dashboard/tasks")}>All tasks <ArrowRight size={14} /></Button>}>
    {resume.length > 0 && <p className={DS.text.prose}>Tasks you touched this week, most recent first.</p>}
    {resume.map(row => {
      const badge = stateBadge(row), context = contextLine(row);
      return <div key={row.id} className="flex min-w-0 items-center gap-3 border-t border-border py-2.5 first:border-t-0">
        {row.groupColor ? <IdentitySwatch color={row.groupColor} /> : <span className="w-2 shrink-0" />}
        <button className={cx(DS.focus, "min-w-0 flex-1 text-left")} onClick={() => onSelectTask(row.id)}>
          <span className="flex min-w-0 flex-col gap-0.5 md:flex-row md:items-baseline md:gap-3">
            <span className="shrink-0 truncate font-semibold text-text-primary">{row.title}</span>
            <span className={cx("min-w-0 truncate text-[13px]", context.empty ? "text-text-secondary" : "text-text-muted")}>{context.text}</span>
          </span>
        </button>
        {badge ? <Badge tone={badge.tone === "info" ? "info" : badge.tone === "warning" ? "warning" : "neutral"}>{badge.label}</Badge>
          : <span className={cx(DS.text.meta, "hidden shrink-0 sm:inline")}>{describeIdle(row)}</span>}
        <Button size="sm" variant="ghost" onClick={() => resumeRow(row)}>Resume <ChevronRight size={14} /></Button>
      </div>;
    })}
    {!resume.length && <EmptyHint>Nothing in motion this week. <button className={cx(DS.focus, "underline")} onClick={() => navigate("/dashboard/tasks")}>See all tasks</button></EmptyHint>}
  </Section>;
  const quietTotal = quiet.total ?? 0;
  const worthALook = data && quietTotal > 0 && <Section label="Worth a look" count={`${quiet.items.length} of ${quietTotal}`} surface
    action={<Button variant="ghost" size="sm" onClick={() => setReviewing(true)}>Review all <ArrowRight size={14} /></Button>}>
    <p className={DS.text.prose}>Tasks you haven't touched in a month. Keep, set aside or close them.</p>
    {quiet.items.map(row => {
      const context = contextLine(row);
      return <div key={row.id} className={ROW}>
        <div className="flex items-center gap-2">{row.groupColor && <IdentitySwatch color={row.groupColor} />}
          <button className={cx(DS.text.content, DS.focus, "min-w-0 truncate text-left font-semibold")} onClick={() => onSelectTask(row.id)}>{row.title}</button>
          {row.kind === "ongoing" && <Pin size={12} className="shrink-0 rotate-45 text-text-faint" aria-label="Ongoing" />}</div>
        <p className={cx(DS.text.meta, "mt-1")}><span className={cx("font-medium", DS.tone.warning)}>{row.staleWait ? context.text : quietLabel(row)}</span>
          {!row.staleWait && !context.empty && <> · {context.text}</>}</p>
        <div className="mt-2.5"><QuietTaskActions row={row} disabled={outcomes.pending}
          onOutcome={outcome => void outcomes.apply([row], outcome)}
          onLater={() => setDeferralTask({ id: row.id, title: row.title, deferred: row.deferred, nextTouchAt: row.nextTouchAt })} /></div>
      </div>;
    })}
  </Section>;
  const checklistUrgent = !!data?.actionCounts && data.actionCounts.overdue + data.actionCounts.dueToday > 0;
  const actions = data && <HomeChecklist mode={section === "actions" ? "full" : "overview"} grouping={section === "actions" ? "task" : "date"} items={data.actions.items}
    counts={data.actionCounts ?? { open: data.actions.total ?? data.actions.items.length, overdue: 0, dueToday: 0 }} today={data.today ?? localDate()}
    action={section === "actions" ? more(data.actions, "actions") : (data.actionCounts?.open ?? 0) > data.actions.items.length
      ? <Button variant="ghost" size="sm" onClick={() => visit("actions")}>Full checklist <ArrowRight size={14} /></Button> : undefined}
    onSelectTask={onSelectTask} onChanged={changed} onError={setMutationError} />;
  const questions = data && <Section label="Needs your answer" surface action={more(data.inputs, "inputs")}>
    {data.inputs.items.length > 0 && <p className={DS.text.prose}>One question per conversation.</p>}
    {questionRows}
    {!data.inputs.items.length && !data.inputErrors.length && <EmptyHint>{data.inputs.total === null ? "Question status unavailable." : "No questions on this page."}</EmptyHint>}
  </Section>;
  const replies = data && <Section label="New replies" level="page" surface action={more(data.replies, "replies")}>
    {data.replies.items.length > 0 && <p className={DS.text.prose}>{section === "replies" ? "All unread conversations." : "Latest unread conversation per task."}</p>}
    {data.replies.items.map(reply => <div key={reply.sessionId} className={ROW}>
      <p className={cx(DS.text.content, "font-medium")}>{reply.taskTitle ?? reply.title}</p>
      <p className={cx(reply.excerpt ? DS.text.content : DS.text.prose, "mt-2 line-clamp-3")}>{reply.excerpt ? formatSearchExcerpt(reply.excerpt) : reply.error}</p>
      <p className={cx(DS.text.meta, "mt-2")}>{reply.title}{reply.timestamp ? ` · ${new Date(reply.timestamp).toLocaleString()}` : ""}</p>
      <Button className="mt-2" variant="ghost" size="sm" onClick={() => reply.sourceEventId
        ? navigate(`${getSessionPath({ sessionId: reply.sessionId, taskId: reply.taskId })}?message=${encodeURIComponent(reply.sourceEventId)}`)
        : onSelectSession(reply.sessionId, reply.taskId)}>Open {reply.sourceEventId ? "reply" : "conversation"} <ArrowRight size={14} /></Button>
    </div>)}
    {!data.replies.items.length && <EmptyHint>{data.replies.total === null ? "Conversation status unavailable." : section === "replies" ? "No unread replies on this page." : "You're caught up on replies."}</EmptyHint>}
  </Section>;
  const summary = data && [
    needsCount ? `${needsCount} need${needsCount === 1 ? "s" : ""} you` : "Nothing needs you",
    data.actionCounts?.overdue ? `${data.actionCounts.overdue} overdue to-do${data.actionCounts.overdue === 1 ? "" : "s"}` : "",
    quietTotal ? `${quietTotal} worth a look` : "",
  ].filter(Boolean);
  return <div className="flex-1 min-h-0 relative"><PullToRefresh className="absolute inset-0" scrollRestoration={scrollRestoration} onRefresh={async () => { await query.refetch(); }}>
    <div className={cx(DS.layout.pageColumn, "max-w-6xl space-y-7")}>
      <header className="flex items-start justify-between gap-4"><div>
        {section !== "overview" && <Button variant="ghost" size="sm" onClick={() => visit("overview")}><ChevronLeft size={14} />Home</Button>}
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{section === "overview" ? greeting() : LABELS[section]}</h1>
        {section === "overview" && summary && <p className={cx(DS.text.prose, "mt-2")}><span className="font-semibold text-text-primary">{summary[0]}</span>{summary.slice(1).map(part => ` · ${part}`)}</p>}
      </div><Button variant="ghost" aria-label="Refresh Home" onClick={() => void query.refetch()}><RefreshCw size={16} /></Button></header>
      {query.error && <Notice tone="warning" title="Couldn't refresh">{query.error.message} {data && "Showing saved results."}</Notice>}
      {mutationError && <Notice tone="danger" title="The change was not saved">{mutationError}</Notice>}
      <OutcomeNotice receipt={outcomes.receipt} error={outcomes.error} pending={outcomes.pending} onUndo={() => void outcomes.undoLast()} onDismiss={outcomes.dismiss} />
      {data?.sourceErrors.map(error => <Notice key={error} tone="warning" title="Some information is unavailable">{error}</Notice>)}
      {!data ? <EmptyHint>{query.error ? "Home is unavailable. Try refreshing." : "Loading Home…"}</EmptyHint> : section === "overview"
        ? <div className="grid items-start gap-7 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
          {/* On one column the stacks dissolve into the grid so urgent regions lead: needs you, due to-dos, then resuming. */}
          <div className="contents xl:block xl:min-w-0 xl:space-y-7">
            <div className="order-1 min-w-0">{needsYou}</div>
            <div className="order-3 min-w-0">{pickUp}</div>
            <div className="order-4 min-w-0">{replies}</div>
          </div>
          <div className="contents xl:block xl:min-w-0 xl:space-y-7">
            {worthALook && <div className="order-5 min-w-0">{worthALook}</div>}
            <div className={cx("min-w-0", checklistUrgent ? "order-2" : "order-6")}>{actions}</div>
          </div>
        </div>
        : <div className="space-y-7">{section === "inputs" ? questions : section === "actions" ? actions : replies}</div>}
      <footer className={cx(DS.text.meta, "flex flex-wrap items-center gap-2")}><Clock3 size={13} />{data && `Dates: ${data.timezone}`}
        <Button size="sm" variant="ghost" onClick={() => navigate("/dashboard/archive")}>Previous dashboard records</Button></footer>
    </div>
  </PullToRefresh>{deferralTask && <TaskDeferralDialog task={deferralTask}
    onClose={() => setDeferralTask(undefined)} onSaved={() => void changed()} />}
  {reviewing && (overview.data
    ? <QuietReviewDialog rows={quietForReview} pending={outcomes.pending}
      onOutcome={(row, outcome) => outcomes.apply([row], outcome)} onSetAside={(row, revisitAt) => outcomes.apply([row], "set_aside", revisitAt)}
      onOpenTask={row => { setReviewing(false); onSelectTask(row.id); }} onClose={() => setReviewing(false)} />
    : <Dialog title="Review quiet tasks" pending={false} onClose={() => setReviewing(false)}>
      {overview.error ? <Notice tone="warning" title="Task states unavailable">{overview.error.message}</Notice> : <EmptyHint>Loading quiet tasks…</EmptyHint>}
    </Dialog>)}
  {openInput && <Dialog title="Answer question"
    description={`${openInput.taskTitle ?? "Standalone conversation"} · ${openInput.title}`}
    pending={pending} onClose={() => setOpenInput(undefined)}>
    {!answerable && !inputQuery.isPending && <Notice title="Question unavailable">It may have ended, or Home couldn't refresh. Your draft is retained here; nothing was sent.
      <Button onClick={() => onSelectSession(openInput.sessionId, openInput.taskId)}>Open conversation</Button></Notice>
    }
    {!input && inputQuery.isPending && <EmptyHint>Loading question…</EmptyHint>}
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
