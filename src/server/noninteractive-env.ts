export const NONINTERACTIVE_COMMAND_ENV = {
  GIT_PAGER: "cat",
  PAGER: "cat",
  TERM: "dumb",
  GIT_TERMINAL_PROMPT: "0",
} as const;

export function withNonInteractiveCommandEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...NONINTERACTIVE_COMMAND_ENV,
  };
}
