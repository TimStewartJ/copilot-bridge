import { createContext, useContext } from "react";

/**
 * Whether the run that produced the transcript is still going. A tool call with no recorded
 * completion is "running" only while it is; in a run that ended without one (the server restarted,
 * the log was cut short) it simply never finished, and must not spin forever.
 */
const ChatRunActiveContext = createContext(true);

export const ChatRunActiveProvider = ChatRunActiveContext.Provider;

export function useChatRunActive(): boolean {
  return useContext(ChatRunActiveContext);
}
