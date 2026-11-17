import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, normalizePath } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveBridgePort } from "./src/server/port-config";

// langium imports vscode-jsonrpc/lib/* undeclared; our copy's exports hide lib/, so alias it.
const vscodeJsonrpcLib = normalizePath(fileURLToPath(new URL("./node_modules/vscode-jsonrpc/lib/", import.meta.url)));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const bridgePort = resolveBridgePort({ ...env, ...process.env });

  return {
    plugins: [
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: [{ find: /^vscode-jsonrpc\/lib\//, replacement: vscodeJsonrpcLib }],
    },
    root: "src/client",
    publicDir: "../../public",
    build: {
      outDir: "../../dist/client",
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: {
        // Only the API itself: a bare "/api" prefix also caught client modules such as /api.ts.
        "^/api(?:/|$)": `http://localhost:${bridgePort}`,
      },
    },
  };
});
