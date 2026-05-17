import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { __testing } from "../staging-tools.js";
import type { RuntimePaths } from "../runtime-paths.js";
import { makeTestDir } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
type StagingBackendHandle = Awaited<ReturnType<typeof __testing.startStagingBackendProcess>>;
const startedBackends: StagingBackendHandle[] = [];

async function cleanupBackend(backend: StagingBackendHandle): Promise<void> {
  const index = startedBackends.indexOf(backend);
  if (index >= 0) startedBackends.splice(index, 1);
  await backend.cleanup();
}

afterEach(async () => {
  const cleanupResults = await Promise.allSettled(
    startedBackends.splice(0).reverse().map((backend) => backend.cleanup()),
  );
  const failures = cleanupResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Failed to clean up staging backend children");
});

function createTempStagingDir(): string {
  const stagingDir = makeTestDir("stage-child-backend");
  mkdirSync(join(stagingDir, "src", "server"), { recursive: true });
  writeFileSync(join(stagingDir, "package.json"), '{"type":"module"}\n');
  symlinkSync(
    join(REPO_ROOT, "node_modules"),
    join(stagingDir, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return stagingDir;
}

function writePreviewBackend(stagingDir: string): void {
  writeFileSync(join(stagingDir, "src", "server", "staging-preview-server.ts"), `
import { createServer } from "node:http";
import { value } from "./future-store.ts";

const server = createServer((req, res) => {
  if (req.url === "/__health") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/api/future") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ value }));
    return;
  }
  if (req.url === "/api/headers") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      host: req.headers.host,
      forwardedHost: req.headers["x-forwarded-host"],
    }));
    return;
  }
  if (req.url === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    res.write(\`data: \${value}\\n\\n\`);
    res.end();
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    process.exit(1);
    return;
  }
  process.send?.({ type: "ready", port: address.port });
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
`);
}

function writeFutureStore(stagingDir: string, value: string): void {
  writeFileSync(join(stagingDir, "src", "server", "future-store.ts"), `export const value = ${JSON.stringify(value)};\n`);
}

function runtimePathsFor(stagingDir: string): RuntimePaths {
  const dataDir = join(stagingDir, "data");
  const docsDir = join(dataDir, "docs");
  const copilotHome = join(dataDir, ".copilot");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(copilotHome, { recursive: true });
  return {
    demoMode: false,
    dataDir,
    docsDir,
    copilotHome,
    env: {
      BRIDGE_DEMO_MODE: "false",
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_DOCS_DIR: docsDir,
      COPILOT_HOME: copilotHome,
    },
  };
}

describe("staging preview backend child process", () => {
  it("proxies opaque staged backend dependencies and reloads nested imports per child process", async () => {
    const stagingDir = createTempStagingDir();
    writePreviewBackend(stagingDir);
    const runtimePaths = runtimePathsFor(stagingDir);
    const prefix = "opaque-preview";

    writeFutureStore(stagingDir, "first");
    const firstBackend = await __testing.startStagingBackendProcess(
      prefix,
      stagingDir,
      runtimePaths,
      `/staging/${prefix}/api`,
      { startupTimeoutMs: 30_000 },
    );
    startedBackends.push(firstBackend);
    try {
      const app = express();
      app.use(`/staging/${prefix}/api`, __testing.createStagingProxyHandler(prefix, firstBackend));

      const firstResponse = await request(app).get(`/staging/${prefix}/api/future`);
      expect(firstResponse.status).toBe(200);
      expect(firstResponse.body).toEqual({ value: "first" });

      const streamResponse = await request(app).get(`/staging/${prefix}/api/events`);
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.text).toContain("data: first");

      const headerResponse = await request(app)
        .get(`/staging/${prefix}/api/headers`)
        .set("Host", "preview.example.test");
      expect(headerResponse.status).toBe(200);
      expect(headerResponse.body.host).not.toBe("preview.example.test");
      expect(headerResponse.body.forwardedHost).toBe("preview.example.test");
    } finally {
      await cleanupBackend(firstBackend);
    }

    writeFutureStore(stagingDir, "second");
    const secondBackend = await __testing.startStagingBackendProcess(
      prefix,
      stagingDir,
      runtimePaths,
      `/staging/${prefix}/api`,
      { startupTimeoutMs: 30_000 },
    );
    startedBackends.push(secondBackend);
    try {
      const app = express();
      app.use(`/staging/${prefix}/api`, __testing.createStagingProxyHandler(prefix, secondBackend));

      const secondResponse = await request(app).get(`/staging/${prefix}/api/future`);
      expect(secondResponse.status).toBe(200);
      expect(secondResponse.body).toEqual({ value: "second" });
    } finally {
      await cleanupBackend(secondBackend);
    }
  }, 60_000);
});
