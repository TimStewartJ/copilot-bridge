import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveBridgePort } from "./src/server/port-config";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const bridgePort = resolveBridgePort({ ...env, ...process.env });

  return {
    plugins: [
      react(),
      tailwindcss(),
    ],
    root: "src/client",
    publicDir: "../../public",
    build: {
      outDir: "../../dist/client",
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: {
        "/api": `http://localhost:${bridgePort}`,
      },
    },
  };
});
