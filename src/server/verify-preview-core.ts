// Argument parsing and the result summary of `npm run verify:preview` (see verify-preview.ts).

export interface VerifyPreviewOptions {
  /** The preview's page root, with a trailing slash, e.g. http://127.0.0.1:3333/staging/abc123/. */
  baseUrl: string;
  /** Where the preview's API is mounted: `<baseUrl>api`. */
  apiBase: string;
  outDir?: string;
  screens: boolean;
  requireScreens: boolean;
  chat: boolean;
  model?: string;
  readOnly: boolean;
}

export type VerifyPreviewArgs =
  | { ok: true; options: VerifyPreviewOptions }
  | { ok: false; error: string }
  | { ok: false; help: true };

export const VERIFY_PREVIEW_USAGE = [
  "Usage: npm run verify:preview -- --url <previewBaseUrl> [options]",
  "",
  "  --url <url>         Preview page root, e.g. http://127.0.0.1:3333/staging/<prefix>/",
  "  --out <dir>         Folder for screenshots and summary.json (default: a new temp folder)",
  "  --no-screens        Skip the browser screenshots",
  "  --require-screens   Fail when agent-browser is not installed instead of skipping screenshots",
  "  --chat              Also run one live chat turn (costs a model call)",
  "  --model <id>        Model for --chat (default: the cheapest the preview lists)",
  "  --read-only         Only read: no fixtures and no theme changes (the only mode a non-preview Bridge allows)",
].join("\n");

export function parseVerifyPreviewArgs(argv: readonly string[]): VerifyPreviewArgs {
  let url: string | undefined;
  let outDir: string | undefined;
  let model: string | undefined;
  let screens = true;
  let requireScreens = false;
  let chat = false;
  let readOnly = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const valueOf = (): string | undefined => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return undefined;
      index++;
      return value;
    };
    switch (arg) {
      case "--help":
      case "-h":
        return { ok: false, help: true };
      case "--url":
        url = valueOf();
        if (!url) return { ok: false, error: "--url needs a value" };
        break;
      case "--out":
        outDir = valueOf();
        if (!outDir) return { ok: false, error: "--out needs a value" };
        break;
      case "--model":
        model = valueOf();
        if (!model) return { ok: false, error: "--model needs a value" };
        break;
      case "--no-screens":
        screens = false;
        break;
      case "--require-screens":
        requireScreens = true;
        break;
      case "--chat":
        chat = true;
        break;
      case "--read-only":
        readOnly = true;
        break;
      default:
        return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }

  if (!url) return { ok: false, error: "--url is required" };
  if (!screens && requireScreens) return { ok: false, error: "--no-screens and --require-screens cannot be combined" };
  if (chat && readOnly) return { ok: false, error: "--chat creates a session, so it cannot be combined with --read-only" };
  if (model && !chat) return { ok: false, error: "--model only applies with --chat" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `--url is not a valid URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "--url must be an http or https URL" };
  }
  parsed.search = "";
  parsed.hash = "";
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  const baseUrl = parsed.toString();

  return {
    ok: true,
    options: {
      baseUrl,
      apiBase: new URL("api", baseUrl).toString(),
      ...(outDir ? { outDir } : {}),
      screens,
      requireScreens,
      chat,
      ...(model ? { model } : {}),
      readOnly,
    },
  };
}

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  durationMs: number;
  detail?: string;
}

export interface ScreenshotResult {
  page: string;
  viewport: string;
  theme: string;
  path: string;
}

export interface VerifyPreviewSummary {
  ok: boolean;
  url: string;
  apiBase: string;
  outDir: string;
  startedAt: string;
  finishedAt: string;
  counts: Record<CheckStatus, number>;
  checks: CheckResult[];
  screenshots: ScreenshotResult[];
}

export function buildVerifyPreviewSummary(input: {
  options: Pick<VerifyPreviewOptions, "baseUrl" | "apiBase">;
  outDir: string;
  startedAt: Date;
  finishedAt: Date;
  checks: readonly CheckResult[];
  screenshots: readonly ScreenshotResult[];
}): VerifyPreviewSummary {
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, skip: 0 };
  for (const check of input.checks) counts[check.status]++;
  return {
    ok: counts.fail === 0 && counts.pass > 0,
    url: input.options.baseUrl,
    apiBase: input.options.apiBase,
    outDir: input.outDir,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    counts,
    checks: [...input.checks],
    screenshots: [...input.screenshots],
  };
}
