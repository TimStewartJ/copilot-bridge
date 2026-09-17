// The local speech engine shared by voice mode and chat mic transcription: one install,
// one engine process, one set of models.
import type { RuntimePaths } from "../runtime-paths.js";
import { resolveVoicePaths, type VoicePaths } from "./voice-catalog.js";
import { VoiceEngine } from "./voice-engine.js";
import { VoiceInstaller } from "./voice-installer.js";

export interface VoiceRuntime {
  readonly paths: VoicePaths;
  readonly installer: VoiceInstaller;
  readonly engine: VoiceEngine;
}

export function createVoiceRuntime(runtimePaths: Pick<RuntimePaths, "dataDir" | "env">): VoiceRuntime {
  const paths = resolveVoicePaths(runtimePaths);
  return {
    paths,
    installer: new VoiceInstaller({ paths, env: runtimePaths.env }),
    engine: new VoiceEngine({ paths, env: runtimePaths.env }),
  };
}
