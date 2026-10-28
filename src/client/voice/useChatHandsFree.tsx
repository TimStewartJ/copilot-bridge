// Hands-free for one chat: the button that starts it, the one-time setup panel, and the dock that
// shows while it is on. Every chat, Helm included, starts it from this composer button. One chat
// listens at a time, so starting it here moves it from wherever it was.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AudioLines, Loader2 } from "lucide-react";
import { useHandsFree } from "./HandsFreeProvider";
import { HandsFreeDock, HandsFreeSetupPanel } from "./HandsFreeDock";
import type { ComposerTool } from "../components/ChatInput";

export interface ChatHandsFree {
  /** Hands-free is on for this chat. */
  here: boolean;
  /** Hands-free is on somewhere and owns the microphone. */
  micInUse: boolean;
  connecting: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  toggle(): Promise<void>;
  /** The setup panel or the dock, for the composer's accessory slot. */
  accessory: ReactNode;
  /** The composer tool that turns hands-free on and off. */
  composerTool: ComposerTool | null;
}

export function useChatHandsFree(sessionId: string | null, options: { ensureSessionId?: () => Promise<string>; onChange?: () => void } = {}): ChatHandsFree {
  const handsFree = useHandsFree();
  const [setupOpen, setSetupOpen] = useState(false);
  // Started from here while the chat was still being created (its id comes once it exists).
  const [startedHere, setStartedHere] = useState(false);
  const { ensureSessionId, onChange } = options;
  const here = handsFree.active && (handsFree.sessionId === null ? startedHere : handsFree.sessionId === sessionId);
  useEffect(() => {
    if (!handsFree.active) setStartedHere(false);
  }, [handsFree.active]);
  const connecting = handsFree.phase === "connecting";

  // Know whether the speech engine is installed before the first tap, so the tap can start audio at once.
  const { refreshStatus } = handsFree;
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (setupOpen && handsFree.status?.install.installed) setSetupOpen(false);
  }, [handsFree.status?.install.installed, setupOpen]);

  const start = useCallback(async () => {
    const status = handsFree.status ?? await handsFree.refreshStatus();
    if (!status?.install.installed) {
      setSetupOpen(true);
      return;
    }
    setSetupOpen(false);
    const target = sessionId ?? ensureSessionId;
    if (!target) return;
    if (handsFree.active && handsFree.sessionId !== sessionId) await handsFree.stop();
    setStartedHere(true);
    await handsFree.start(target);
    onChange?.();
  }, [ensureSessionId, handsFree, onChange, sessionId]);

  const stop = useCallback(async () => {
    await handsFree.stop();
    onChange?.();
  }, [handsFree, onChange]);

  const toggle = useCallback(() => (here ? stop() : start()), [here, start, stop]);

  const accessory = setupOpen
    ? <HandsFreeSetupPanel controller={handsFree} onClose={() => setSetupOpen(false)} />
    : here
      ? <HandsFreeDock controller={handsFree} onEnd={() => void stop()} />
      : null;

  const canStart = !!sessionId || !!ensureSessionId;
  const composerTool: ComposerTool | null = canStart
    ? {
        label: here ? "End hands-free" : "Hands-free",
        title: here ? "End hands-free" : "Hands-free: talk to this chat and hear its replies",
        icon: connecting ? <Loader2 size={18} className="animate-spin" /> : <AudioLines size={18} />,
        active: here,
        disabled: connecting,
        onSelect: () => void toggle(),
      }
    : null;

  return { here, micInUse: handsFree.active, connecting, start, stop, toggle, accessory, composerTool };
}
