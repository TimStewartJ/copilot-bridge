export const DEFAULT_BRIDGE_PORT = 3333;
export const BRIDGE_PORT_ENV = "BRIDGE_PORT";

const MIN_PORT = 1;
const MAX_PORT = 65_535;

type BridgePortEnv = {
  BRIDGE_PORT?: string;
};

export function resolveBridgePort(env: BridgePortEnv = process.env): number {
  const rawPort = env.BRIDGE_PORT?.trim();
  if (!rawPort) return DEFAULT_BRIDGE_PORT;

  if (!/^\d+$/.test(rawPort)) {
    throw new Error(formatBridgePortError(rawPort));
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(formatBridgePortError(rawPort));
  }

  return port;
}

function formatBridgePortError(value: string): string {
  return `${BRIDGE_PORT_ENV} must be an integer from ${MIN_PORT} to ${MAX_PORT}; received "${value}".`;
}
