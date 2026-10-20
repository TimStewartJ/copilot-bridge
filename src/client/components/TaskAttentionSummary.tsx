import type { TaskRowSignal } from "../task-row-signals";
import { DS } from "../design/tokens";

export default function TaskAttentionSummary({ signals }: { signals: ReadonlyMap<string, TaskRowSignal | null> }) {
  let input = 0, stalled = 0, review = 0, unread = 0, revisit = 0;
  for (const signal of signals.values()) {
    if (signal?.kind === "needs-input") input++;
    else if (signal?.kind === "stalled") stalled++;
    else if (signal?.kind === "needs-look") review++;
    else if (signal?.kind === "unread") unread++;
    else if (signal?.kind === "follow-up-overdue" || signal?.kind === "follow-up-due") revisit++;
  }
  const rest = [
    stalled > 0 && `${stalled} stalled`,
    review > 0 && `${review} need${review === 1 ? "s" : ""} a look`,
    unread > 0 && `${unread} new ${unread === 1 ? "reply" : "replies"}`,
    revisit > 0 && `${revisit} to revisit`,
  ].filter(Boolean).join(" · ");
  if (input === 0 && !rest) return null;
  return <p className={`${DS.text.meta} px-3 py-1`}>
    {input > 0 && <span className={DS.text.attention}>{input} need{input === 1 ? "s" : ""} an answer</span>}
    {input > 0 && rest && " · "}{rest}
  </p>;
}
