import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { combineModelComparison, dismissModelComparison, voteModelComparison } from "../api";
import { useModelComparisonQuery } from "../hooks/queries/useModelComparison";
import { useModelsQuery } from "../hooks/queries/useModels";
import { queryKeys } from "../queryClient";
import { X } from "lucide-react";
import { Button, IconButton, MetaLine, SegmentedControl } from "../design/primitives";
import type { ModelAbTestSetup, ModelComparisonSide, ModelComparisonView } from "../../shared/model-ab-test.js";
import { judgeDetail, judgeSummary, verdictLabel } from "../lib/model-comparison-display";

const WORKING = new Set<ModelComparisonView["status"]>(["starting", "running", "judging"]);
/** Y stays shut while a first reply is still coming, so its progress and speed hint nothing. */
const ANSWERING = new Set<ModelComparisonView["status"]>(["starting", "running"]);
const SIDES: ReadonlyArray<{ value: ModelComparisonSide; label: string }> = [
  { value: "x", label: "X" },
  { value: "y", label: "Y" },
];
const VOTES: ReadonlyArray<{ value: ModelComparisonSide | "tie"; label: string }> = [
  { value: "x", label: "X better" },
  { value: "tie", label: "Tie" },
  { value: "y", label: "Y better" },
];

/** A line under the status line of a chat in a comparison; `busy` refetches once a turn starts. */
export default function ModelComparisonBar({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { taskId: routeTaskId } = useParams<{ taskId?: string }>();
  const { data: models } = useModelsQuery();
  const query = useModelComparisonQuery(sessionId);
  const { refetch } = query;
  useEffect(() => { void refetch(); }, [busy, refetch]);
  const comparison = query.data;
  const taskId = routeTaskId ?? comparison?.taskId;
  const chatPath = (id: string) => (taskId ? `/tasks/${taskId}/sessions/${id}` : `/sessions/${id}`);
  const mainSessionId = comparison?.side === "x" ? sessionId : comparison?.otherSessionId;
  const vote = useMutation({
    mutationFn: ({ id, winner }: { id: string; winner: ModelComparisonSide | "tie" }) => voteModelComparison(id, sessionId, winner),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.modelComparison(sessionId), next),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => dismissModelComparison(id, sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["model-comparison"] });
      if (mainSessionId) void queryClient.invalidateQueries({ queryKey: queryKeys.sessionModel(mainSessionId) });
    },
  });
  const combine = useMutation({
    mutationFn: ({ id, keep }: { id: string; keep: ModelComparisonSide }) => combineModelComparison(id, keep),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["model-comparison"] });
      // Keeping Y switched X's model; the header shows it once revealed.
      if (mainSessionId) void queryClient.invalidateQueries({ queryKey: queryKeys.sessionModel(mainSessionId) });
      if (mainSessionId && mainSessionId !== sessionId) navigate(chatPath(mainSessionId));
    },
  });
  // Combined or dismissed: the user is done with the pair, so the bar goes.
  if (!comparison || comparison.status === "awaiting_prompt" || comparison.combinedKeep || comparison.dismissed) return null;

  const modelLabel = (id: string) => models?.find((model) => model.id === id)?.name ?? id;
  const name = (setup: ModelAbTestSetup) => modelLabel(setup.model);
  const { revealed } = comparison;
  const error = vote.error ?? combine.error ?? dismiss.error;
  const yShut = comparison.side === "x" && ANSWERING.has(comparison.status);
  const barClass = "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-1.5 text-xs text-text-muted sm:px-4";
  return (
    <div className={barClass} role="status">
      <SegmentedControl<ModelComparisonSide> ariaLabel="Compared chats" size="sm" value={comparison.side}
        options={yShut ? SIDES.map((side) => (side.value === "y" ? { ...side, disabled: true, title: "Y opens once both replies are done" } : side)) : SIDES}
        disabled={!comparison.otherSessionId}
        onChange={(side) => { if (side !== comparison.side && comparison.otherSessionId) navigate(chatPath(comparison.otherSessionId)); }} />
      {comparison.votable && (
        <div className="flex items-center gap-1">
          {VOTES.map((option) => (
            <Button key={option.value} size="sm" variant="ghost" disabled={vote.isPending}
              onClick={() => vote.mutate({ id: comparison.id, winner: option.value })}>
              {option.label}
            </Button>
          ))}
        </div>
      )}
      {comparison.combinable && (
        <div className="flex items-center gap-1">
          {SIDES.map((side) => (
            <Button key={side.value} size="sm" variant={comparison.suggestedKeep === side.value ? "secondary" : "ghost"}
              disabled={combine.isPending} title={`Merge both replies into X and carry on there with ${side.label}'s model`}
              onClick={() => combine.mutate({ id: comparison.id, keep: side.value })}>
              Combine, keep {side.label}
            </Button>
          ))}
        </div>
      )}
      <MetaLine className="min-w-0 basis-full sm:basis-auto sm:flex-1" items={[
        WORKING.has(comparison.status) && "First replies running",
        comparison.status === "incomplete" && comparison.failure,
        comparison.status === "failed" && comparison.failure,
        comparison.vote && `You: ${verdictLabel(comparison.vote)}`,
        revealed?.judge && <span key="judge" title={judgeDetail(revealed.judge, modelLabel)}>{judgeSummary(revealed.judge)}</span>,
        revealed && `X ${name(revealed.x)}, Y ${name(revealed.y)}`,
      ]} />
      {error && <span role="alert" className="text-error">{error instanceof Error ? error.message : String(error)}</span>}
      <IconButton label="Dismiss comparison" title="Keep this chat as it is and hide this bar" size="sm" variant="ghost"
        className="ml-auto" disabled={dismiss.isPending} onClick={() => dismiss.mutate(comparison.id)}>
        <X size={14} aria-hidden="true" />
      </IconButton>
    </div>
  );
}
