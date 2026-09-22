import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { fetchDashboardArchive, fetchDashboardArchiveObject, fetchDashboardRetirement } from "../api";
import { Button, EmptyHint, Notice, Section, TextInput } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import PromptMarkdown from "./chat/PromptMarkdown";

export default function DashboardArchive() {
  const [search, setSearch] = useSearchParams(), navigate = useNavigate();
  const id = search.get("id");
  const rawOffset = Number(search.get("offset") ?? 0);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 && rawOffset <= 1000000 ? rawOffset : 0;
  const query = search.get("q") ?? "", openOnly = search.get("open") === "true";
  const rawRecordOffset = Number(search.get("recordOffset") ?? 0);
  const recordOffset = Number.isInteger(rawRecordOffset) && rawRecordOffset >= 0 && rawRecordOffset <= 1000000 ? rawRecordOffset : 0;
  const [draft, setDraft] = useState(query);
  const list = useQuery({ queryKey: ["dashboard", "archive", offset, query, openOnly],
    queryFn: ({ signal }) => fetchDashboardArchive(offset, query, openOnly, signal), enabled: !id });
  const detail = useQuery({ queryKey: ["dashboard", "archive", "object", id, recordOffset],
    queryFn: ({ signal }) => fetchDashboardArchiveObject(id!, recordOffset, signal), enabled: !!id });
  const readiness = useQuery({ queryKey: ["dashboard", "retirement"], queryFn: ({ signal }) => fetchDashboardRetirement(signal) });
  function page(next: number) { const params = new URLSearchParams(search); params.set("offset", String(next)); setSearch(params); }
  return <div className="flex-1 min-h-0 overflow-y-auto"><div className={cx(DS.layout.pageColumn, "max-w-5xl space-y-6")}>
    <header><Button size="sm" variant="ghost" onClick={() => id ? setSearch({}) : navigate("/dashboard/home")}><ArrowLeft size={15} />{id ? "Archive" : "Home"}</Button>
      <h1 className={DS.text.pageTitle}>Previous dashboard records</h1></header>
    <Notice title="Read-only history, not current attention">
      Alerts, Decisions and Events were retired as a separate work system. Their recorded states are preserved, not resolved by this change.
      Existing checklist items, tasks and conversations remain the source of current work. Historical notification grants do not authorize new delivery.
    </Notice>
    {search.get("invalidLink") === "true" && <Notice tone="warning" title="The previous dashboard link is ambiguous">It did not identify one object and episode. No source was selected or changed; search the archive instead.</Notice>}
    {search.get("episode") && <Notice title="Historical episode link">Requested episode: {search.get("episode")}. The headline below is the retirement snapshot; preserved source/history rows retain episode IDs. No current outcome is inferred.</Notice>}
    {id ? detail.error ? <Notice tone="warning" title="Historical record unavailable">{detail.error.message}</Notice>
      : !detail.data ? <EmptyHint>Loading retained record…</EmptyHint>
      : <Section level="page" surface label={detail.data.title}>
        <p className={DS.text.prose}>{detail.data.type} · {detail.data.lifecycle ?? detail.data.status ?? "State not recorded"} at retirement · {detail.data.taskTitle ?? "No task recorded"}</p>
        {detail.data.interventionBy && <p className={DS.text.prose}>Previously recorded intervention date: {detail.data.interventionBy}. This archive does not assert that the concern is handled.</p>}
        {detail.data.body && <div className="mt-4"><PromptMarkdown content={detail.data.body} trusted /></div>}
        {detail.data.taskId && <Button className="mt-4" variant="ghost" onClick={() => navigate(`/tasks/${detail.data!.taskId}`)}>Open original task</Button>}
        <details className="mt-5"><summary className={cx(DS.text.rowLabel, DS.focus, "cursor-pointer")}>Retained source and history records ({detail.data.recordsTotal} total)</summary>
          <pre className={cx(DS.text.literal, "mt-3 overflow-auto whitespace-pre-wrap break-words")}>{JSON.stringify(detail.data.records, null, 2)}</pre>
          <div className="mt-3 flex gap-2">
            {recordOffset > 0 && <Button onClick={() => { const params = new URLSearchParams(search); params.set("recordOffset", String(Math.max(0, recordOffset - 100))); setSearch(params); }}>Previous source rows</Button>}
            {detail.data.hasMoreRecords && <Button onClick={() => { const params = new URLSearchParams(search); params.set("recordOffset", String(recordOffset + 100)); setSearch(params); }}>Next source rows</Button>}
          </div></details>
      </Section>
      : <>
        <form className="flex flex-wrap items-center gap-3" onSubmit={event => { event.preventDefault(); setSearch({ q: draft, open: String(openOnly) }); }}>
          <TextInput aria-label="Search historical records" value={draft} onChange={event => setDraft(event.target.value)} className="max-w-md" />
          <Button type="submit">Search</Button>
          <label className={cx(DS.text.prose, "flex items-center gap-2")}><input type="checkbox" checked={openOnly} onChange={event => setSearch({ q: query, open: String(event.target.checked) })} />Previously open Alerts and Decisions</label>
        </form>
        {list.error && <Notice tone="warning" title="Archive unavailable">{list.error.message}</Notice>}
        {list.data ? <Section level="page" surface label="Retained records" count={list.data.total}>
          <p className={cx(DS.text.prose, "mb-3")}>{list.data.openConcerns} Alert/Decision records had an open state at retirement. Review them before relying on their former notification or follow-up behavior.</p>
          <div className={DS.surface.divided}>{list.data.items.map(item => <button key={item.id} className={DS.row.stacked} onClick={() => setSearch({ id: item.id })}>
            <p className={DS.text.objectTitle}>{item.title}</p><p className={cx(DS.text.meta, "mt-1")}>{item.type} · {item.lifecycle ?? item.status} · {item.taskTitle ?? "No task"}</p>
          </button>)}</div>
          {!list.data.items.length && <EmptyHint>No matching historical records.</EmptyHint>}
          <div className="mt-4 flex gap-2">{offset > 0 && <Button onClick={() => page(Math.max(0, offset - 30))}><ChevronLeft size={14} />Previous</Button>}
            {list.data.hasMore && <Button onClick={() => page(offset + 30)}>Next<ChevronRight size={14} /></Button>}</div>
        </Section> : !list.error && <EmptyHint>Loading retained records…</EmptyHint>}
        <details><summary className={cx(DS.text.rowLabel, DS.focus, "cursor-pointer")}>Retirement manifest and old publisher references</summary>
          <p className={cx(DS.text.prose, "mt-3")}>Schedules and task instructions were not automatically edited or disabled. References below require review before depending on retired dashboard publishing. Native work still reports in its conversation.</p>
          {readiness.error ? <Notice tone="warning" title="Manifest unavailable">{readiness.error.message}</Notice>
            : <pre className={cx(DS.text.literal, "mt-3 whitespace-pre-wrap break-words")}>{JSON.stringify(readiness.data, null, 2)}</pre>}
        </details>
      </>}
  </div></div>;
}
