// Which part of a streamed reply to say: sentences are spoken, structure is shown.

type SpokenLineKind = "prose" | "structure" | "fence";

const DIVIDER_LINE_RE = /^\s*([-*_])\1{2,}\s*$/;

/**
 * Decides what a line is from as little of its start as possible, so prose can be spoken the
 * moment it begins streaming. Undefined means "not enough characters yet".
 */
function classifyLineStart(line: string, context: { inFence: boolean; afterStructure: boolean }): SpokenLineKind | undefined {
  const trimmed = line.trimStart();
  const indent = line.length - trimmed.length;
  const fence = /^(`{3,}|~{3,})/.test(trimmed);
  if (context.inFence) {
    if (fence) return "fence";
    return trimmed.length < 3 && /^(`*|~*)$/.test(trimmed) ? undefined : "structure";
  }
  if (!trimmed) return undefined;
  // Indented text under a list item or quote belongs to it.
  if (context.afterStructure && indent >= 2) return "structure";
  const first = trimmed[0]!;
  if (first === "`" || first === "~") {
    if (fence) return "fence";
    return trimmed.length < 3 && /^(`+|~+)$/.test(trimmed) ? undefined : "prose";
  }
  if (first === "|" || first === ">") return "structure";
  if (first === "#") {
    if (/^#{1,6}$/.test(trimmed)) return undefined;
    return /^#{1,6}\s/.test(trimmed) ? "structure" : "prose";
  }
  if (first === "-" || first === "*" || first === "+" || first === "_") {
    if (trimmed.length === 1) return undefined;
    if (first !== "_" && /\s/.test(trimmed[1]!)) return "structure";
    // A run of the same marker may still become a divider ("---") or emphasis ("**bold**").
    if (/^([-*_])\1*\s*$/.test(trimmed)) return undefined;
    return "prose";
  }
  if (first >= "0" && first <= "9") {
    if (/^\d{1,9}[.)]?$/.test(trimmed)) return undefined;
    return /^\d{1,9}[.)]\s/.test(trimmed) ? "structure" : "prose";
  }
  return "prose";
}

/**
 * Picks the speakable part out of a streamed reply: sentences are spoken, structure is shown.
 * Lists, tables, headings, quotes and code are withheld from speech, and so is everything after
 * a divider line ("---"). This is deliberately structural rather than a convention the model
 * has to follow, because fast models often don't.
 *
 * Feed it text deltas as they arrive and speak what `push` returns. One filter handles one
 * message: call `flush` when the message ends, then `reset` before the next.
 */
export class SpokenTextFilter {
  private line = "";
  private kind: SpokenLineKind | undefined;
  private inFence = false;
  private afterStructure = false;
  private silenced = false;
  private withheldValue = false;

  /** True once anything in this message was withheld from speech. */
  get withheld(): boolean {
    return this.withheldValue;
  }

  /** Takes the next piece of the message and returns the part of it to speak, which may be empty. */
  push(delta: string): string {
    let spoken = "";
    for (const char of delta) spoken += this.accept(char);
    return spoken;
  }

  /** The message ended: settle a last line that never got its newline. */
  flush(): string {
    const spoken = this.kind === undefined ? this.settleUndecided(false) : "";
    this.line = "";
    this.kind = undefined;
    return spoken;
  }

  reset(): void {
    this.line = "";
    this.kind = undefined;
    this.inFence = false;
    this.afterStructure = false;
    this.silenced = false;
    this.withheldValue = false;
  }

  private accept(char: string): string {
    if (this.silenced) {
      if (char.trim()) this.withheldValue = true;
      return "";
    }
    if (char === "\n") return this.endLine();
    if (this.kind === "prose") return char;
    if (this.kind !== undefined) return "";
    this.line += char;
    const kind = classifyLineStart(this.line, { inFence: this.inFence, afterStructure: this.afterStructure });
    if (!kind) return "";
    this.kind = kind;
    const started = this.line;
    this.line = "";
    if (kind === "prose") return started;
    this.withheldValue = true;
    if (kind === "fence") this.inFence = !this.inFence;
    return "";
  }

  private endLine(): string {
    const kind = this.kind;
    const spoken = kind === undefined ? this.settleUndecided(true) : kind === "prose" ? "\n" : "";
    if (kind === "prose") this.afterStructure = false;
    else if (kind !== undefined) this.afterStructure = true;
    this.line = "";
    this.kind = undefined;
    return spoken;
  }

  /** A line that ended before it could be classified: blank, a divider, or a stray marker. */
  private settleUndecided(endedWithNewline: boolean): string {
    const line = this.line;
    if (this.inFence) {
      if (line.trim()) this.withheldValue = true;
      return "";
    }
    if (!line.trim()) {
      this.afterStructure = false;
      return endedWithNewline ? "\n" : "";
    }
    if (DIVIDER_LINE_RE.test(line)) {
      this.silenced = true;
      return endedWithNewline ? "\n" : "";
    }
    // A bare number is still something to say ("42"); a stray "-" or "#" is not.
    if (/^\s*\d+[.)]?\s*$/.test(line)) return endedWithNewline ? `${line}\n` : line;
    this.withheldValue = true;
    this.afterStructure = true;
    return "";
  }
}
