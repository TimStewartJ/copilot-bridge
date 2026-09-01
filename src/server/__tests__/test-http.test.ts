import type { RequestListener } from "node:http";
import { describe, expect, it } from "vitest";
import request from "./test-http.js";

describe("shared test HTTP transport", () => {
  it("reuses one listener and one keep-alive connection across applications", async () => {
    const createApp = (name: string): RequestListener => ((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        name,
        url: req.url,
        localPort: req.socket.localPort,
        remotePort: req.socket.remotePort,
      }));
    });
    const firstApp = createApp("first");
    const secondApp = createApp("second");
    const responses: Array<Record<string, unknown>> = [];

    for (let index = 0; index < 20; index += 1) {
      const app = index % 2 === 0 ? firstApp : secondApp;
      const response = await request(app).get(`/value?index=${index}`);
      expect(response.status).toBe(200);
      expect(response.headers["keep-alive"]).toBe("timeout=120");
      responses.push(response.body as Record<string, unknown>);
    }

    expect(new Set(responses.map((response) => response.localPort)).size).toBe(1);
    expect(new Set(responses.map((response) => response.remotePort)).size).toBe(1);
    expect(responses[0]).toMatchObject({ name: "first", url: "/value?index=0" });
    expect(responses[1]).toMatchObject({ name: "second", url: "/value?index=1" });
  });
});
