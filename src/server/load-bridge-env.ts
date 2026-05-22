import { loadBridgeEnv } from "./env-loader.js";

loadBridgeEnv(process.env.BRIDGE_ENV_FILE?.trim() || undefined);
