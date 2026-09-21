export const RESPONSE_DETAIL_OPTIONS = [
  { value: "adaptive", label: "Adaptive", description: "Match the request and the complexity of the task." },
  { value: "concise", label: "Concise", description: "Prefer compact answers without losing necessary information." },
  { value: "detailed", label: "Detailed", description: "Prefer fuller explanations with relevant reasoning and examples." },
] as const;

export type ResponseDetail = typeof RESPONSE_DETAIL_OPTIONS[number]["value"];

export interface ResponseStyleSettings {
  detail: ResponseDetail;
  guidance: string;
}

export const MAX_RESPONSE_STYLE_GUIDANCE_LENGTH = 4000;

export const DEFAULT_RESPONSE_STYLE_GUIDANCE = [
  "Answer naturally and directly. Avoid canned praise, empty preambles, hype, redundant summaries, and automatic trailing offers.",
  "Prefer concrete, specific explanations. Keep context, caveats, edge cases, and alternatives when they matter to correctness, safety, or a real decision; omit unrelated padding.",
  "Stay appropriately warm, especially in emotional conversations. Give creative work and requested reports the space their form needs.",
  "Use formatting that aids comprehension. Do not impose blanket bans on punctuation, emojis, or ordinary vocabulary. Preserve technical syntax and quoted material.",
].join("\n");

export function isResponseDetail(value: unknown): value is ResponseDetail {
  return RESPONSE_DETAIL_OPTIONS.some((option) => option.value === value);
}

export function resolveResponseStyle(style?: ResponseStyleSettings): ResponseStyleSettings {
  return {
    detail: style?.detail ?? "adaptive",
    guidance: style?.guidance.trim() || DEFAULT_RESPONSE_STYLE_GUIDANCE,
  };
}

const DETAIL_GUIDANCE: Record<ResponseDetail, string> = {
  adaptive: "Match depth to the user's request and the task's complexity. Keep simple answers short; expand for substantive explanations, reports, creative work, and sensitive support.",
  concise: "Prefer compact answers with the necessary explanation. Retain information needed for correctness, safety, and the user's decision. Explicit requests for detail or long-form work still win.",
  detailed: "Prefer fuller explanations with relevant reasoning, examples, and meaningful trade-offs. Do not add unrelated padding or repeat points. Honor explicit requests for a short answer.",
};

export function renderResponseStyle(style?: ResponseStyleSettings): string {
  const resolved = resolveResponseStyle(style);
  return [
    "<response_style>",
    "These are default presentation preferences for user-facing responses. The user's explicitly requested tone, detail, and format override these defaults. Style never weakens response quality, safety, or tool and workflow requirements.",
    `Default detail: ${resolved.detail}.`,
    DETAIL_GUIDANCE[resolved.detail],
    "",
    "Style guidance:",
    resolved.guidance,
    "",
    "Required progress, permission, clarification, and machine-readable output requirements still apply.",
    "</response_style>",
  ].join("\n");
}
