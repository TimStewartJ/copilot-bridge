import express from "express";
import { describe, expect, it } from "vitest";
import request from "./test-http.js";
import {
  API_GET_CACHE_CONTROL,
  API_MUTATION_CACHE_CONTROL,
  allowScriptConditionalRevalidation,
  createApiCacheControlMiddleware,
  createResponseCompressionMiddleware,
  resolveApiCacheControl,
} from "../response-transport.js";

function createApp() {
  const app = express();
  app.use(createResponseCompressionMiddleware());
  app.use("/api", createApiCacheControlMiddleware(), express.json());

  const largePayload = { sessions: Array.from({ length: 200 }, (_, index) => ({
    sessionId: `session-${index}`,
    summary: `Session ${index} with a long enough title to matter`,
    workspace: { cwd: "D:\\repo", repository: "TimStewartJ/copilot-bridge", branch: "master" },
  })) };
  app.get("/api/sessions", (_req, res) => {
    res.json(largePayload);
  });
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/api/chat", (_req, res) => {
    res.json({ ok: true, ...largePayload });
  });
  app.get("/api/status-stream", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(largePayload)}\n\n`);
    res.end();
  });
  return app;
}

describe("response transport", () => {
  it("compresses large JSON responses when the client accepts it", async () => {
    const res = await request(createApp())
      .get("/api/sessions")
      .set("Accept-Encoding", "br, gzip");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toMatch(/^(br|gzip)$/);
    expect(res.headers.vary).toContain("Accept-Encoding");
    expect(res.body.sessions).toHaveLength(200);
  });

  it("leaves small responses and clients without Accept-Encoding alone", async () => {
    const app = createApp();
    const small = await request(app).get("/api/health").set("Accept-Encoding", "gzip");
    expect(small.headers["content-encoding"]).toBeUndefined();
    expect(small.body).toEqual({ ok: true });

    const identity = await request(app).get("/api/sessions").set("Accept-Encoding", "identity");
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.body.sessions).toHaveLength(200);
  });

  it("never compresses server-sent event streams", async () => {
    const res = await request(createApp())
      .get("/api/status-stream")
      .set("Accept-Encoding", "br, gzip")
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(String(res.body)).toMatch(/^data: \{"sessions"/);
  });

  it("lets GET API reads revalidate and answers matching If-None-Match with 304", async () => {
    const app = createApp();
    const first = await request(app).get("/api/sessions").set("Accept-Encoding", "gzip");
    expect(first.headers["cache-control"]).toBe(API_GET_CACHE_CONTROL);
    expect(first.headers.etag).toBeTruthy();

    const revalidated = await request(app)
      .get("/api/sessions")
      .set("Accept-Encoding", "gzip")
      .set("If-None-Match", first.headers.etag);
    expect(revalidated.status).toBe(304);
    expect(revalidated.text ?? "").toBe("");
  });

  it("keeps mutations uncacheable", async () => {
    const res = await request(createApp()).post("/api/chat").send({ prompt: "hi" });
    expect(res.headers["cache-control"]).toBe(API_MUTATION_CACHE_CONTROL);
  });

  it("still answers 304 when a browser adds Cache-Control: no-cache to a script-set conditional request", async () => {
    const app = createApp();
    const first = await request(app).get("/api/sessions").set("Accept-Encoding", "br, gzip");
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    // What fetch() sends when page script supplies If-None-Match (Fetch spec forces
    // cache mode "no-store", which appends these two request headers).
    const revalidated = await request(app)
      .get("/api/sessions")
      .set("Accept-Encoding", "br, gzip")
      .set("If-None-Match", etag)
      .set("Cache-Control", "no-cache")
      .set("Pragma", "no-cache");
    expect(revalidated.status).toBe(304);

    // A changed body still wins over the validator.
    const stale = await request(app)
      .get("/api/sessions")
      .set("If-None-Match", 'W/"something-else"')
      .set("Cache-Control", "no-cache");
    expect(stale.status).toBe(200);
    expect(stale.body.sessions).toHaveLength(200);
  });

  it("only relaxes request cache directives for conditional GET/HEAD requests", () => {
    const conditional = { method: "GET", headers: { "if-none-match": 'W/"a"', "cache-control": "no-cache", pragma: "no-cache" } };
    expect(allowScriptConditionalRevalidation(conditional)).toBe(true);
    expect(conditional.headers).toEqual({ "if-none-match": 'W/"a"' });

    const unconditional = { method: "GET", headers: { "cache-control": "no-cache" } };
    expect(allowScriptConditionalRevalidation(unconditional)).toBe(false);
    expect(unconditional.headers).toEqual({ "cache-control": "no-cache" });

    const mutation = { method: "POST", headers: { "if-none-match": 'W/"a"', "cache-control": "no-cache" } };
    expect(allowScriptConditionalRevalidation(mutation)).toBe(false);
    expect(mutation.headers["cache-control"]).toBe("no-cache");

    expect(allowScriptConditionalRevalidation({ method: "GET", headers: { "if-none-match": 'W/"a"' } })).toBe(false);
  });

  it("resolves cache control by method", () => {
    expect(resolveApiCacheControl("get")).toBe(API_GET_CACHE_CONTROL);
    expect(resolveApiCacheControl("HEAD")).toBe(API_GET_CACHE_CONTROL);
    expect(resolveApiCacheControl("POST")).toBe(API_MUTATION_CACHE_CONTROL);
    expect(resolveApiCacheControl("DELETE")).toBe(API_MUTATION_CACHE_CONTROL);
  });
});
