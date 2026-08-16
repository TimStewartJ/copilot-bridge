export type AgentInstructionKind = "task" | "follow_up";

export interface AgentInstruction {
  kind: AgentInstructionKind;
  content: string;
}

export function normalizeAgentInstructions(value: unknown): AgentInstruction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const instructions = value.flatMap((item): AgentInstruction[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content : "";
    if (!content.trim() || (record.kind !== "task" && record.kind !== "follow_up")) return [];
    return [{ kind: record.kind, content }];
  });
  return instructions.length > 0 ? instructions : undefined;
}
