import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, normalizePath } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveBridgePort } from "./src/server/port-config";

// langium, which mermaid parses with, imports vscode-jsonrpc/lib/common/* without depending on
// vscode-jsonrpc, so it gets the copy the Bridge shares with the Copilot SDK. That copy's exports
// map hides lib/, so point those imports at its files.
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
