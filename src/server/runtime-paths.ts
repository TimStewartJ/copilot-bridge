import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

export interface RuntimePaths {
  demoMode: boolean;
  dataDir: string;
  docsDir: string;
  copilotHome?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}

export interface RuntimePathOverrides {
  demoMode?: boolean;
  dataDir?: string;
  docsDir?: string;
  copilotHome?: string;
  workspaceDir?: string;
}

export function resolveRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  overrides: RuntimePathOverrides = {},
): RuntimePaths {
  const demoMode = overrides.demoMode ?? env.BRIDGE_DEMO_MODE === "true";
  const dataDir = overrides.dataDir ?? env.BRIDGE_DATA_DIR ?? join(REPO_ROOT, demoMode ? "demo-data" : "data");
  const docsDir = overrides.docsDir ?? env.BRIDGE_DOCS_DIR ?? join(dataDir, "docs");
  const copilotHome = overrides.copilotHome ?? env.COPILOT_HOME ?? (demoMode ? join(dataDir, ".copilot") : undefined);
  const workspaceDir = overrides.workspaceDir ?? (demoMode ? join(dataDir, "workspace") : undefined);

  return {
    demoMode,
    dataDir,
    docsDir,
    copilotHome,
    workspaceDir,
    env: {
      ...env,
      BRIDGE_DEMO_MODE: demoMode ? "true" : "false",
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_DOCS_DIR: docsDir,
      ...(copilotHome ? { COPILOT_HOME: copilotHome } : {}),
    },
  };
}
