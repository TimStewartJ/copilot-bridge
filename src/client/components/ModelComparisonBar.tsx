import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { combineModelComparison, fetchModelComparison, voteModelComparison } from "../api";
import { useModelsQuery } from "../hooks/queries/useModels";
import { queryKeys } from "../queryClient";
import { Button, MetaLine, SegmentedControl } from "../design/primitives";
import type { ModelAbTestSetup, ModelComparisonSide, ModelComparisonView } from "../../shared/model-ab-test.js";

const WORKING = new Set<ModelComparisonView["status"]>(["starting", "running", "judging"]);
const SIDES: ReadonlyArray<{ value: ModelComparisonSide; label: string }> = [
  { value: "x", label: "X" },
  { value: "y", label: "Y" },
];
const VOTES: ReadonlyArray<{ value: ModelComparisonSide | "tie"; label: string }> = [
  { value: "x", label: "X better" },
  { value: "tie", label: "Tie" },
  { value: "y", label: "Y better" },
];

type JudgeView = NonNullable<NonNullable<ModelComparisonView["revealed"]>["judge"]>;

function verdictLabel(verdict: ModelComparisonSide | "tie"): string {
  return verdict === "tie" ? "tie" : verdict.toUpperCase();
}

/** "Judges: Y", "Judges split", or "Judge: X" for a verdict from before panels. */
function judgeSummary(judge: JudgeView): string {
  const counted = judge.judgesCounted < judge.judgesAsked ? ` (${judge.judgesCounted} of ${judge.judgesAsked})` : "";
  if (judge.verdict === "split") return `Judges split${counted}`;
  return `${judge.judgesAsked > 1 ? "Judges" : "Judge"}: ${verdictLabel(judge.verdict)}${counted}`;
}

/** Each judge's pick and reason; "Response 1" in a reason is the side shown first. */
function judgeDetail(judge: JudgeView, name: (model: string) => string): string {
  return judge.runs.map((run) => {
    const order = run.firstSide ? ` (${run.firstSide.toUpperCase()} first)` : "";
    return `${name(run.model)}${order}: ${verdictLabel(run.winner)}. ${run.reason}`;
  }).join("\n");
}

/** A line under the status line of a chat in a comparison; `busy` refetches once a turn starts. */
export default function ModelComparisonBar({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { taskId: routeTaskId } = useParams<{ taskId?: string }>();
  const { data: models } = useModelsQuery();
  const query = useQuery({
    queryKey: queryKeys.modelComparison(sessionId),
    queryFn: ({ signal }) => fetchModelComparison(sessionId, signal),
    refetchInterval: (current) => (current.state.data && WORKING.has(current.state.data.status) ? 15_000 : false),
  });
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
  const combine = useMutation({
    mutationFn: ({ id, keep }: { id: string; keep: ModelComparisonSide }) => combineModelComparison(id, keep),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["model-comparison"] });
      if (mainSessionId && mainSessionId !== sessionId) navigate(chatPath(mainSessionId));
    },
  });
  if (!comparison) return null;

  const modelLabel = (id: string) => models?.find((model) => model.id === id)?.name ?? id;
  const name = (setup: ModelAbTestSetup) => modelLabel(setup.model);
  const { revealed } = comparison;
  const error = vote.error ?? combine.error;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-1.5 text-xs text-text-muted sm:px-4" role="status">
      <SegmentedControl<ModelComparisonSide> ariaLabel="Compared chats" size="sm" options={SIDES} value={comparison.side}
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
        comparison.combinedKeep && `Combined into X, on ${comparison.combinedKeep.toUpperCase()}'s model`,
        comparison.vote && `You: ${verdictLabel(comparison.vote)}`,
        revealed?.judge && <span key="judge" title={judgeDetail(revealed.judge, modelLabel)}>{judgeSummary(revealed.judge)}</span>,
        revealed && `X ${name(revealed.x)}, Y ${name(revealed.y)}`,
      ]} />
      {error && <span role="alert" className="text-error">{error instanceof Error ? error.message : String(error)}</span>}
    </div>
  );
}
