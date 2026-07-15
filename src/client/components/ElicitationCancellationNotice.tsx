import { CircleAlert } from "lucide-react";

import type { ElicitationCancellationNotice as Notice } from "../useSessionStream";

const CHAT_RAIL_CLASS = "mx-auto w-full max-w-4xl px-3 sm:px-4 md:px-6 lg:px-8";

export default function ElicitationCancellationNotice({ notice }: { notice: Notice }) {
  return (
    <div className={CHAT_RAIL_CLASS}>
      <div
        className="max-w-xl rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 shadow-sm"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-start gap-3">
          <CircleAlert size={17} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-primary">Question no longer active</div>
            {notice.question && (
              <div className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">
                {notice.question}
              </div>
            )}
            <div className="mt-2 text-xs text-text-muted">
              {notice.detail} Send another message if you still want the agent to continue.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
