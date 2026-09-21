import { CircleAlert } from "lucide-react";

import type { ElicitationCancellationNotice as CancellationNotice } from "../useSessionStream";
import { DS } from "../design/tokens";
import { Notice } from "../design/primitives";

export default function ElicitationCancellationNotice({ notice }: { notice: CancellationNotice }) {
  return (
    <div className={DS.layout.readingColumn}>
      <Notice
        tone="warning"
        role="status"
        icon={<CircleAlert size={14} />}
        title="Question no longer active"
        className="max-w-xl"
      >
        {notice.question && (
          <div className="mt-0.5 whitespace-pre-wrap text-[13px] text-text-secondary">
            {notice.question}
          </div>
        )}
        <div className="mt-1 text-text-muted">
          {notice.detail} Send another message if you still want the agent to continue.
        </div>
      </Notice>
    </div>
  );
}