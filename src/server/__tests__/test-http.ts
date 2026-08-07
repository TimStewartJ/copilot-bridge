import { afterAll } from "vitest";
import { Agent, createServer, type RequestListener } from "node:http";
import rawRequest from "supertest";

type TestClient = ReturnType<typeof rawRequest>;

const TEST_ROUTE_PREFIX = "/__bridge_test_app__/";
const handlers = new Map<string, RequestListener>();
const handlerIds = new WeakMap<RequestListener, string>();
const keepAliveAgent = new Agent({
  keepAlive: true,
  maxSockets: 8,
  maxFreeSockets: 8,
});
let nextHandlerId = 1;

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (!url.startsWith(TEST_ROUTE_PREFIX)) {
    res.statusCode = 404;
    res.end("Unknown test application");
    return;
  }

  const appPath = url.slice(TEST_ROUTE_PREFIX.length);
  const separator = appPath.indexOf("/");
  const handlerId = separator >= 0 ? appPath.slice(0, separator) : appPath;
  const handler = handlers.get(handlerId);
  if (!handler) {
    res.statusCode = 404;
    res.end("Test application is no longer registered");
    return;
  }

  req.url = separator >= 0 ? appPath.slice(separator) : "/";
  try {
    handler(req, res);
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  }
});

function ensureServer(): void {
  if (server.listening) return;
  server.listen(0);
  server.unref();
}

function registerHandler(handler: RequestListener): string {
  const existing = handlerIds.get(handler);
  if (existing) return existing;

  const id = String(nextHandlerId);
  nextHandlerId += 1;
  handlerIds.set(handler, id);
  handlers.set(id, handler);
  return id;
}

function withKeepAlive(client: TestClient, pathPrefix: string): TestClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;

      return (path: string, ...args: unknown[]) => {
        if (typeof path !== "string" || !path.startsWith("/")) {
          throw new Error(`Test HTTP request paths must start with '/': ${String(path)}`);
        }
        const test = value.call(target, `${pathPrefix}${path}`, ...args);
        test.agent(keepAliveAgent);
        return test;
      };
    },
  });
}

export default function request(target: RequestListener): TestClient {
  ensureServer();
  const handlerId = registerHandler(target);
  return withKeepAlive(rawRequest(server), `${TEST_ROUTE_PREFIX}${handlerId}`);
}

afterAll(async () => {
  keepAliveAgent.destroy();
  handlers.clear();
  if (!server.listening) return;

  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});
