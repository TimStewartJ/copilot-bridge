// Configuration for the Copilot Web Bridge

import { resolveBridgePort } from "./port-config.js";

export const config = {
  // Web server
  web: {
    port: resolveBridgePort(),
  },
};
