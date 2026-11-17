/** Thinking persists only as assistant.message reasoningText; commit folds open blocks into one. */
export interface LiveReasoningBlock {
  id: string;
  content: string;
  /** Event id of the `assistant.message` that persisted this thinking; absent until committed. */
  sourceEventId?: string;
  startedAt?: string;
  /** Set once the model moved on to text or tool calls, or the message was persisted. */
  completedAt?: string;
  /** The persisting message's timestamp; unlike `completedAt`, comparable with disk history. */
  committedAt?: string;
  turnId?: string;
  turnInstanceId?: string;
}

export interface ReasoningTurnScope {
  turnId?: string;
  turnInstanceId?: string;
}

export interface ReasoningDeltaInput extends ReasoningTurnScope {
  reasoningId?: string;
  content: string;
  timestamp?: string;
}

export interface ReasoningCompleteInput extends ReasoningTurnScope {
  reasoningId?: string;
  content: string;
  timestamp?: string;
}

export interface ReasoningCommitInput extends ReasoningTurnScope {
  content: string;
  sourceEventId?: string;
  timestamp?: string;
}

function scopeFields(scope: ReasoningTurnScope): ReasoningTurnScope {
  return {
    ...(scope.turnId ? { turnId: scope.turnId } : {}),
    ...(scope.turnInstanceId ? { turnInstanceId: scope.turnInstanceId } : {}),
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Append streamed thinking to its block, opening one when the id has not been seen. */
export function appendReasoningDelta(
  blocks: LiveReasoningBlock[],
  input: ReasoningDeltaInput,
): LiveReasoningBlock[] {
  if (!input.content) return blocks;
  const index = input.reasoningId
    ? blocks.findIndex((block) => block.id === input.reasoningId)
    // A delta without an id can only continue the block that is still open.
    : blocks.findIndex((block) => !block.completedAt && !block.sourceEventId);
  if (index >= 0) {
    const current = blocks[index]!;
    // Text for a block the disk already owns is a late echo, not new thinking.
    if (current.sourceEventId) return blocks;
    const { completedAt: _reopened, ...open } = current;
    const next: LiveReasoningBlock = { ...open, content: current.content + input.content };
    return blocks.map((block, blockIndex) => blockIndex === index ? next : block);
  }
  return [
    ...closeOpenReasoning(blocks, input.timestamp),
    {
      id: input.reasoningId ?? `reasoning-${blocks.length}-${input.timestamp ?? "live"}`,
      content: input.content,
      ...(input.timestamp ? { startedAt: input.timestamp } : {}),
      ...scopeFields(input),
    },
  ];
}

/** Mark every block still streaming as finished; the model has moved on. */
export function closeOpenReasoning(
  blocks: LiveReasoningBlock[],
  completedAt?: string,
): LiveReasoningBlock[] {
  if (!blocks.some((block) => !block.completedAt)) return blocks;
  const at = completedAt ?? new Date().toISOString();
  return blocks.map((block) => block.completedAt ? block : { ...block, completedAt: at });
}

/** Repairs a block whose deltas were missed; ignored when the commit already holds the text. */
export function completeReasoningBlock(
  blocks: LiveReasoningBlock[],
  input: ReasoningCompleteInput,
): LiveReasoningBlock[] {
  if (!input.content.trim()) return blocks;
  const completedAt = input.timestamp ?? new Date().toISOString();
  const index = input.reasoningId
    ? blocks.findIndex((block) => block.id === input.reasoningId)
    : -1;
  if (index >= 0) {
    const current = blocks[index]!;
    if (current.sourceEventId) return blocks;
    return blocks.map((block, blockIndex) => blockIndex === index
      ? { ...block, content: input.content, completedAt: block.completedAt ?? completedAt }
      : block);
  }
  const text = normalizeText(input.content);
  const alreadyShown = blocks.some((block) => {
    const existing = normalizeText(block.content);
    return existing.length > 0 && (existing.includes(text) || text.includes(existing));
  });
  if (alreadyShown) return blocks;
  return [
    ...blocks,
    {
      id: input.reasoningId ?? `reasoning-${blocks.length}-${completedAt}`,
      content: input.content,
      startedAt: completedAt,
      completedAt,
      ...scopeFields(input),
    },
  ];
}

/** Folds every uncommitted block into one with the persisted text and the message's event id. */
export function commitReasoning(
  blocks: LiveReasoningBlock[],
  input: ReasoningCommitInput,
): LiveReasoningBlock[] {
  if (!input.content.trim()) return blocks;
  if (input.sourceEventId && blocks.some((block) => block.sourceEventId === input.sourceEventId)) {
    return blocks;
  }
  const completedAt = input.timestamp ?? new Date().toISOString();
  const open = blocks.filter((block) => !block.sourceEventId);
  const first = open[0];
  const committed: LiveReasoningBlock = {
    id: first?.id ?? `reasoning-${input.sourceEventId ?? completedAt}`,
    content: input.content,
    ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}),
    startedAt: first?.startedAt ?? completedAt,
    completedAt: open[open.length - 1]?.completedAt ?? completedAt,
    ...(input.timestamp ? { committedAt: input.timestamp } : {}),
    ...scopeFields({
      turnId: first?.turnId ?? input.turnId,
      turnInstanceId: first?.turnInstanceId ?? input.turnInstanceId,
    }),
  };
  return [...blocks.filter((block) => block.sourceEventId), committed];
}

/** Blocks with a disk counterpart. Thinking that was never persisted ends with its run. */
export function keepCommittedReasoning(blocks: LiveReasoningBlock[]): LiveReasoningBlock[] {
  return blocks.some((block) => !block.sourceEventId)
    ? blocks.filter((block) => block.sourceEventId)
    : blocks;
}
