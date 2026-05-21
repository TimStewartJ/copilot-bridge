export type ToolWithHandler<T extends { handler?: unknown }> = T & {
  handler: NonNullable<T["handler"]>;
};

export function requireToolHandler<T extends { name: string; handler?: unknown }>(
  tool: T | undefined,
  name?: string,
): ToolWithHandler<T> {
  const toolName = name ?? tool?.name ?? "tool";
  if (!tool) {
    throw new Error(`${toolName} tool not found`);
  }
  if (typeof tool.handler !== "function") {
    throw new Error(`${toolName} tool handler not found`);
  }
  return tool as ToolWithHandler<T>;
}

export function requireToolHandlers<T extends { name: string; handler?: unknown }>(
  tools: readonly T[],
): ToolWithHandler<T>[] {
  return tools.map((tool) => requireToolHandler(tool));
}
