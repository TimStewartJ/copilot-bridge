import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The Copilot CLI hands its own environment to the shells it starts for an agent, and that
 * environment's COPILOT_HOME is the Bridge's session store. A script an agent runs that creates a
 * CopilotClient would then write chats into that store, where the chat list shows them. The CLI
 * sources these scripts before every shell command, so agent shells get a scratch Copilot home
 * instead. A command that sets COPILOT_HOME itself still wins.
 */
export interface AgentShellInitScript {
  path: string;
  shell: "bash" | "powershell";
}

export const AGENT_SHELL_DIR_NAME = "agent-shell";

function bashSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powerShellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function writeAgentShellInitScripts(dir: string): Promise<AgentShellInitScript[]> {
  const copilotHome = join(dir, "copilot-home");
  await mkdir(copilotHome, { recursive: true });
  const bashPath = join(dir, "env.sh");
  const powerShellPath = join(dir, "env.ps1");
  await writeFile(bashPath, `export COPILOT_HOME=${bashSingleQuote(copilotHome)}\n`);
  await writeFile(powerShellPath, `$env:COPILOT_HOME = ${powerShellSingleQuote(copilotHome)}\n`);
  return [
    { path: bashPath, shell: "bash" },
    { path: powerShellPath, shell: "powershell" },
  ];
}
