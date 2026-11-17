import { createContext, useContext, useMemo } from "react";
import {
  EMPTY_TRANSCRIPT_AGENT_DIRECTORY,
  type TranscriptAgentDirectory,
} from "../../../shared/transcript-agents.js";

/** What the rows of a transcript know about the session's sub-agents. */
export interface TranscriptAgentsContextValue {
  directory: TranscriptAgentDirectory;
  /** Per launching call, the stretch with the agent's newest row, the only one shown working. */
  latestBlockByAgent: ReadonlyMap<string, string>;
}

const NO_AGENTS: TranscriptAgentsContextValue = {
  directory: EMPTY_TRANSCRIPT_AGENT_DIRECTORY,
  latestBlockByAgent: new Map(),
};

const TranscriptAgentsContext = createContext<TranscriptAgentsContextValue>(NO_AGENTS);

export const TranscriptAgentsProvider = TranscriptAgentsContext.Provider;

export function useTranscriptAgents(): TranscriptAgentsContextValue {
  return useContext(TranscriptAgentsContext);
}

/** Turns the runtime id a `read_agent` or `write_agent` call carries into the agent's name. */
export function useAgentNameResolver(): (agentId: string) => string | undefined {
  const { directory } = useTranscriptAgents();
  return useMemo(() => (agentId: string) => directory.byAgentId.get(agentId)?.name, [directory]);
}

/** The stretch of work a row is shown in. */
const ActivityBlockKeyContext = createContext<string | null>(null);

export const ActivityBlockKeyProvider = ActivityBlockKeyContext.Provider;

export function useActivityBlockKey(): string | null {
  return useContext(ActivityBlockKeyContext);
}
