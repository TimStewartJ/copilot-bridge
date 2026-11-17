import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Agent shells get a scratch COPILOT_HOME so scripts' chats stay out of the Bridge's store. */
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
