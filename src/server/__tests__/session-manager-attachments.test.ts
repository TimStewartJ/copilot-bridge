import { afterEach, describe, expect, it } from "vitest";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { setupTestDb, createTestBus } from "./helpers.js";
import { publishOutboundAttachment, resolveOutboundAttachment } from "../outbound-attachments.js";

describe("persistAndRouteAttachments", () => {
  const tempDirs: string[] = [];
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  function createManager(copilotHome: string) {
    const db = setupTestDb();
    return new SessionManager({
      tools: [],
      globalBus: createTestBus(),
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      taskStore: {} as any,
      config: { sessionMcpServers: {} },
      copilotHome,
    }) as any; // cast to access private method
  }

  function filesDir(copilotHome: string) {
    return join(copilotHome, "session-state", sessionId, "files");
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for empty/missing attachments", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-att-"));
    tempDirs.push(home);
    const mgr = createManager(home);

    expect(mgr.persistAndRouteAttachments(sessionId, undefined)).toBeUndefined();
    expect(mgr.persistAndRouteAttachments(sessionId, [])).toBeUndefined();
  });

  it("resolves uploaded non-image attachment as file type", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-att-"));
    tempDirs.push(home);
    const dir = filesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "data.csv"), "a,b,c\n1,2,3");

    const mgr = createManager(home);
    const result = mgr.persistAndRouteAttachments(sessionId, [
      { type: "uploaded", displayName: "data.csv", mimeType: "text/csv" },
    ]);

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      type: "file",
      displayName: "data.csv",
      path: join(dir, "data.csv"),
    });
  });

  it("resolves uploaded image attachment as blob type", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-att-"));
    tempDirs.push(home);
    const dir = filesDir(home);
    mkdirSync(dir, { recursive: true });
    const imgData = Buffer.from("fake-png-data");
    writeFileSync(join(dir, "photo.png"), imgData);

    const mgr = createManager(home);
    const result = mgr.persistAndRouteAttachments(sessionId, [
      { type: "uploaded", displayName: "photo.png", mimeType: "image/png" },
    ]);

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      type: "blob",
      mimeType: "image/png",
      displayName: "photo.png",
      data: imgData.toString("base64"),
    });
  });

  it("saves blob attachment to disk and returns file type for non-images", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-att-"));
    tempDirs.push(home);
    const mgr = createManager(home);
    const content = Buffer.from("notebook content");

    const result = mgr.persistAndRouteAttachments(sessionId, [
      { type: "blob", data: content.toString("base64"), mimeType: "application/json", displayName: "notebook.ipynb" },
    ]);

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ type: "file", displayName: "notebook.ipynb" });
    // File should be written to disk
    const dir = filesDir(home);
    expect(existsSync(join(dir, "notebook.ipynb"))).toBe(true);
    expect(readFileSync(join(dir, "notebook.ipynb")).toString()).toBe("notebook content");
  });

  it("passes blob image attachments through unchanged", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-att-"));
    tempDirs.push(home);
    const mgr = createManager(home);
    const att = { type: "blob" as const, data: "AAAA", mimeType: "image/png", displayName: "img.png" };

    const result = mgr.persistAndRouteAttachments(sessionId, [att]);

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ type: "blob", data: "AAAA", mimeType: "image/png" });
  });

  it("skips uploaded attachment when file does not exist on disk", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-att-"));
    tempDirs.push(home);
    const mgr = createManager(home);

    const result = mgr.persistAndRouteAttachments(sessionId, [
      { type: "uploaded", displayName: "missing.txt", mimeType: "text/plain" },
    ]);

    expect(result).toHaveLength(0);
  });

  it("rejects path traversal in uploaded displayName", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-att-"));
    tempDirs.push(home);
    const dir = filesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "legit.txt"), "ok");

    const mgr = createManager(home);
    const result = mgr.persistAndRouteAttachments(sessionId, [
      { type: "uploaded", displayName: "../../../etc/passwd", mimeType: "text/plain" },
    ]);

    // basename strips the path components, so it becomes "passwd" which doesn't exist
    expect(result).toHaveLength(0);
  });

  it("handles blob with displayName '.' safely", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-att-"));
    tempDirs.push(home);
    const mgr = createManager(home);

    // basename(".") returns "." which isn't empty, so deduplicateFilename sanitizes it
    const result = mgr.persistAndRouteAttachments(sessionId, [
      { type: "blob", data: "AAAA", mimeType: "text/plain", displayName: "." },
    ]);

    // Should succeed — file is saved with whatever sanitized name deduplicateFilename chose
    expect(result).toHaveLength(1);
    expect(result![0].type).toBe("file"); // non-image
  });

  it("handles filenames with special characters (parentheses, spaces)", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-att-"));
    tempDirs.push(home);
    const dir = filesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Timstewart(2).ipynb"), "notebook");

    const mgr = createManager(home);
    const result = mgr.persistAndRouteAttachments(sessionId, [
      { type: "uploaded", displayName: "Timstewart(2).ipynb", mimeType: "application/octet-stream" },
    ]);

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      type: "file",
      displayName: "Timstewart(2).ipynb",
    });
  });

  it("path guard works with platform-native separators", () => {
    // This is the core regression test for the Windows bug:
    // resolve() returns native separators, so the guard must use path.sep, not "/"
    const home = mkdtempSync(join(tmpdir(), "bridge-att-"));
    tempDirs.push(home);
    const dir = filesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "test.txt"), "content");

    const mgr = createManager(home);
    const result = mgr.persistAndRouteAttachments(sessionId, [
      { type: "uploaded", displayName: "test.txt", mimeType: "text/plain" },
    ]);

    // On ALL platforms (Linux, macOS, Windows), a legitimate file should pass the guard
    expect(result).toHaveLength(1);
    expect(result![0].type).toBe("file");
    expect(result![0].path).toBe(join(dir, "test.txt"));
  });

  it("handles multiple attachments of mixed types", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-att-"));
    tempDirs.push(home);
    const dir = filesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "doc.pdf"), "pdf-content");

    const mgr = createManager(home);
    const result = mgr.persistAndRouteAttachments(sessionId, [
      { type: "uploaded", displayName: "doc.pdf", mimeType: "application/pdf" },
      { type: "blob", data: Buffer.from("csv-data").toString("base64"), mimeType: "text/csv", displayName: "data.csv" },
      { type: "blob", data: "AAAA", mimeType: "image/jpeg", displayName: "photo.jpg" },
    ]);

    expect(result).toHaveLength(3);
    expect(result![0]).toMatchObject({ type: "file", displayName: "doc.pdf" });
    expect(result![1]).toMatchObject({ type: "file", displayName: "data.csv" });
    expect(result![2]).toMatchObject({ type: "blob", mimeType: "image/jpeg" });
  });
});

describe("outbound attachments", () => {
  const tempDirs: string[] = [];
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  function outgoingDir(copilotHome: string) {
    return join(copilotHome, "session-state", sessionId, "files", "outgoing");
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes an existing file and returns attachment metadata", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-outgoing-"));
    tempDirs.push(home);
    const sourceDir = mkdtempSync(join(tmpdir(), "bridge-source-"));
    tempDirs.push(sourceDir);
    const sourcePath = join(sourceDir, "report.csv");
    writeFileSync(sourcePath, "name,count\nalpha,2\n");

    const result = publishOutboundAttachment({
      copilotHome: home,
      sessionId,
      sourcePath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      attachmentId: "report.csv",
      displayName: "report.csv",
      mimeType: "text/csv",
      inline: false,
    });
    expect(readFileSync(join(outgoingDir(home), "report.csv"), "utf-8")).toBe("name,count\nalpha,2\n");
  });

  it("publishes generated text content with a required displayName", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-outgoing-"));
    tempDirs.push(home);

    const result = publishOutboundAttachment({
      copilotHome: home,
      sessionId,
      content: "# Notes\n\nHello there.\n",
      displayName: "notes.md",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.displayName).toBe("notes.md");
    expect(readFileSync(join(outgoingDir(home), "notes.md"), "utf-8")).toBe("# Notes\n\nHello there.\n");
  });

  it("deduplicates outgoing filenames", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-outgoing-"));
    tempDirs.push(home);

    const first = publishOutboundAttachment({
      copilotHome: home,
      sessionId,
      content: "first",
      displayName: "summary.txt",
    });
    const second = publishOutboundAttachment({
      copilotHome: home,
      sessionId,
      content: "second",
      displayName: "summary.txt",
    });

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) return;
    expect(second.value.attachmentId).toBe("summary (1).txt");
    expect(second.value.displayName).toBe("summary (1).txt");
    expect(second.value.filePath.endsWith(`${sep}summary (1).txt`)).toBe(true);
    expect(readFileSync(join(outgoingDir(home), "summary (1).txt"), "utf-8")).toBe("second");
  });

  it("resolves inline image attachments for serving", () => {
    const home = mkdtempSync(join(tmpdir(), "bridge-outgoing-"));
    tempDirs.push(home);

    const published = publishOutboundAttachment({
      copilotHome: home,
      sessionId,
      content: "fake image data",
      displayName: "chart.png",
    });
    expect(published).toMatchObject({ ok: true });
    if (!published.ok) return;

    const resolved = resolveOutboundAttachment(home, sessionId, published.value.attachmentId);
    expect(resolved).toMatchObject({
      ok: true,
      value: {
        displayName: "chart.png",
        mimeType: "image/png",
        inline: true,
      },
    });
  });
});
