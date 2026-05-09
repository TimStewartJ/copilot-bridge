export function isSessionStatePathSegment(sessionId: string): boolean {
  return sessionId !== "." && sessionId !== ".." && !sessionId.includes("/") && !sessionId.includes("\\");
}

function normalizeWorkspaceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized === "null") return undefined;
  return normalized;
}

function parseQuotedString(rawValue: string): string | undefined {
  if (rawValue.length < 2) return undefined;
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
    try {
      return normalizeWorkspaceString(JSON.parse(rawValue));
    } catch {
      return normalizeWorkspaceString(rawValue.slice(1, -1));
    }
  }
  if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
    return normalizeWorkspaceString(rawValue.slice(1, -1).replace(/''/g, "'"));
  }
  return undefined;
}

function countLeadingSpaces(line: string): number {
  const match = line.match(/^ */);
  return match?.[0].length ?? 0;
}

function parseBlockScalar(lines: string[], startIndex: number, style: "|" | ">"): string | undefined {
  const blockLines: string[] = [];
  let indent: number | undefined;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() && !line.startsWith(" ")) break;
    if (!line.trim()) {
      blockLines.push("");
      continue;
    }
    indent ??= countLeadingSpaces(line);
    blockLines.push(line.slice(Math.min(indent, countLeadingSpaces(line))));
  }
  const value = style === ">"
    ? blockLines.join(" ")
    : blockLines.join("\n");
  return normalizeWorkspaceString(value);
}

export function parseWorkspaceYamlScalar(content: string, key: string): string | undefined {
  const pattern = new RegExp(`^${key}:\\s*(.*)$`);
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith(" ")) continue;
    const match = line.match(pattern);
    if (!match) continue;
    const rawValue = match[1]?.trim() ?? "";
    if (!rawValue || rawValue === "null" || rawValue.startsWith("[") || rawValue.startsWith("{")) return undefined;
    const blockStyle = rawValue[0];
    if (blockStyle === "|" || blockStyle === ">") {
      return parseBlockScalar(lines, index, blockStyle);
    }
    return parseQuotedString(rawValue) ?? normalizeWorkspaceString(rawValue);
  }
  return undefined;
}

export function parseWorkspaceYamlSessionName(content: string): string | undefined {
  return parseWorkspaceYamlScalar(content, "name") ?? parseWorkspaceYamlScalar(content, "summary");
}
