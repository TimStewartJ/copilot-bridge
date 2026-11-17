import { createContext, useContext } from "react";

/** A step with no end is running only while this is true; else it never finished (no spinner). */
const ChatRunActiveContext = createContext(true);

export const ChatRunActiveProvider = ChatRunActiveContext.Provider;

export function useChatRunActive(): boolean {
  return useContext(ChatRunActiveContext);
}
