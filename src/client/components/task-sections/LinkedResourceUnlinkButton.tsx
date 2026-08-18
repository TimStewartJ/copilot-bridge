import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Check, Loader2, Unlink } from "lucide-react";

const CONFIRM_RESET_MS = 3000;

export interface LinkedResourceUnlinkButtonProps {
  resourceLabel: string;
  iconSize: number;
  isUnlinking: boolean;
  onConfirm: () => void;
  className?: string;
}

export default function LinkedResourceUnlinkButton({
  resourceLabel,
  iconSize,
  isUnlinking,
  onConfirm,
  className,
}: LinkedResourceUnlinkButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const confirmResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearConfirmResetTimer = useCallback(() => {
    if (!confirmResetTimerRef.current) return;
    clearTimeout(confirmResetTimerRef.current);
    confirmResetTimerRef.current = null;
  }, []);

  const resetConfirmation = useCallback(() => {
    clearConfirmResetTimer();
    setConfirming(false);
  }, [clearConfirmResetTimer]);

  useEffect(() => clearConfirmResetTimer, [clearConfirmResetTimer]);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (isUnlinking) return;

    if (!confirming) {
      clearConfirmResetTimer();
      setConfirming(true);
      confirmResetTimerRef.current = setTimeout(() => {
        confirmResetTimerRef.current = null;
        setConfirming(false);
      }, CONFIRM_RESET_MS);
      return;
    }

    resetConfirmation();
    onConfirm();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Escape" || !confirming) return;
    event.preventDefault();
    event.stopPropagation();
    resetConfirmation();
  };

  const unlinkState = isUnlinking ? "unlinking" : confirming ? "confirming" : "idle";
  const label = isUnlinking
    ? `Unlinking ${resourceLabel} from task`
    : confirming
      ? `Confirm unlink ${resourceLabel} from task`
      : `Unlink ${resourceLabel} from task`;

  return (
    <button
      type="button"
      onClick={handleClick}
      onBlur={resetConfirmation}
      onKeyDown={handleKeyDown}
      disabled={isUnlinking}
      title={label}
      aria-label={label}
      data-unlink-state={unlinkState}
      className={`linked-resource-unlink-button inline-flex shrink-0 items-center justify-center gap-1 self-start transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40 ${
        confirming
          ? "rounded bg-warning/10 text-warning hover:text-warning"
          : "text-text-muted hover:text-warning"
      } ${className ?? ""}`}
    >
      {isUnlinking && <Loader2 size={iconSize} className="animate-spin" />}
      {confirming && (
        <>
          <Check size={iconSize} />
          <span className="text-[10px] font-medium leading-none">Confirm</span>
        </>
      )}
      {!isUnlinking && !confirming && <Unlink size={iconSize} />}
    </button>
  );
}
