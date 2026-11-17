// Above the routes, so hands-free keeps running while the user opens what Helm pointed to.
import { createContext, useContext, type ReactNode } from "react";
import { useVoiceMode, type VoiceModeController } from "./useVoiceMode";

const HandsFreeContext = createContext<VoiceModeController | null>(null);

export function HandsFreeProvider({ children }: { children: ReactNode }) {
  const controller = useVoiceMode();
  return <HandsFreeContext.Provider value={controller}>{children}</HandsFreeContext.Provider>;
}

export function useHandsFree(): VoiceModeController {
  const controller = useContext(HandsFreeContext);
  if (!controller) throw new Error("useHandsFree must be used inside HandsFreeProvider");
  return controller;
}
