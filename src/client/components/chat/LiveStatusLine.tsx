interface LiveStatusLineProps {
  /** One or two words for what the run is doing: "Sending", "Thinking". */
  label: string;
  /** What the agent says it is working on, when it has said. */
  detail?: string;
  /** The longer explanation, shown on hover. */
  description?: string;
}

/** The run's state while there is nothing of its own to show yet, as a line of text, not a badge. */
export default function LiveStatusLine({ label, detail, description }: LiveStatusLineProps) {
  return (
    <div
      className="flex min-w-0 items-center gap-2 py-1 text-[13px]"
      role="status"
      title={description}
      data-live-status={label}
    >
      <span className="shimmer-text shrink-0 font-medium">{label}</span>
      {detail && detail !== label && <span className="min-w-0 truncate text-text-muted">{detail}</span>}
    </div>
  );
}
