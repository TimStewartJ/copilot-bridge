import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns2 } from "lucide-react";
import { Link } from "react-router-dom";
import { fetchModelComparison, voteModelComparison } from "../api";
import { useModelsQuery } from "../hooks/queries/useModels";
import { queryKeys } from "../queryClient";
import { Button, MetaLine } from "../design/primitives";
import type { ModelAbTestSetup, ModelComparisonSide, ModelComparisonView } from "../../shared/model-ab-test.js";

const WORKING = new Set<ModelComparisonView["status"]>(["starting", "running", "judging"]);
const VOTES: ReadonlyArray<{ value: ModelComparisonSide | "tie"; label: string }> = [
  { value: "x", label: "X better" },
  { value: "tie", label: "Tie" },
  { value: "y", label: "Y better" },
];

function verdictLabel(verdict: ModelComparisonSide | "tie"): string {
  return verdict === "tie" ? "tie" : verdict.toUpperCase();
}

/** A line under the status line of a chat in a comparison; `busy` refetches once a turn starts. */
export default function ModelComparisonBar({ sessionId, busy }: { sessionId: string; busy: boolean }) {
  const queryClient = useQueryClient();
  const { data: models } = useModelsQuery();
  const query = useQuery({
    queryKey: queryKeys.modelComparison(sessionId),
    queryFn: ({ signal }) => fetchModelComparison(sessionId, signal),
    refetchInterval: (current) => (current.state.data && WORKING.has(current.state.data.status) ? 15_000 : false),
  });
  const { refetch } = query;
  useEffect(() => { void refetch(); }, [busy, refetch]);
  const vote = useMutation({
    mutationFn: ({ id, winner }: { id: string; winner: ModelComparisonSide | "tie" }) => voteModelComparison(id, sessionId, winner),
    onSuccess: (comparison) => queryClient.setQueryData(queryKeys.modelComparison(sessionId), comparison),
  });
  const comparison = query.data;
  if (!comparison) return null;

  const name = (setup: ModelAbTestSetup) => models?.find((model) => model.id === setup.model)?.name ?? setup.model;
  const other: ModelComparisonSide = comparison.side === "x" ? "y" : "x";
  const canVote = comparison.votable && comparison.otherSessionId;
  const { revealed } = comparison;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5 text-xs text-text-muted sm:px-4" role="status">
      <Columns2 size={12} className="shrink-0" aria-hidden="true" />
      <MetaLine className="flex-1" items={[
        `This is ${comparison.side.toUpperCase()}`,
        comparison.otherSessionId && <Link key="other" to={`/sessions/${comparison.otherSessionId}`} className="underline">Open {other.toUpperCase()}</Link>,
        WORKING.has(comparison.status) && "First replies running",
        comparison.status === "incomplete" && comparison.failure,
        comparison.status === "failed" && comparison.failure,
        comparison.vote && `You: ${verdictLabel(comparison.vote)}`,
        revealed?.judge && <span key="judge" title={revealed.judge.reason}>Judge: {verdictLabel(revealed.judge.winner)}</span>,
        revealed && `X ${name(revealed.x)}, Y ${name(revealed.y)}`,
      ]} />
      {canVote && (
        <div className="ml-auto flex items-center gap-1">
          {VOTES.map((option) => (
            <Button key={option.value} size="sm" variant="ghost" disabled={vote.isPending}
              onClick={() => vote.mutate({ id: comparison.id, winner: option.value })}>
              {option.label}
            </Button>
          ))}
        </div>
      )}
      {vote.error && <span role="alert" className="text-error">{vote.error instanceof Error ? vote.error.message : String(vote.error)}</span>}
    </div>
  );
}
