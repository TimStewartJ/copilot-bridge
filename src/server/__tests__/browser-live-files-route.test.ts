import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { getBrowserRuntime } from "../browser-runtime.js";
import { makeTestDir } from "./helpers.js";
import { createTestApp } from "./test-app.js";
import request from "./test-http.js";

/** An app whose live-view gateway has one file chooser open, `c1`, that takes files into `folder`. */
async function appWithChooser(multiple: boolean) {
  const { app, ctx } = createTestApp();
  const live = getBrowserRuntime(ctx).live;
  const folder = join(makeTestDir("live-files-route"), "files-1");
  await mkdir(folder, { recursive: true });
  const claim = vi.spyOn(live, "claimFileChooser").mockImplementation(async (id) => (id === "c1" ? { folder, multiple } : undefined));
  const choose = vi.spyOn(live, "chooseFiles").mockResolvedValue({ ok: true, value: undefined });
  const release = vi.spyOn(live, "releaseFileChooser").mockImplementation(() => {});
  return { app, folder, claim, choose, release };
}

describe("POST /api/browser/live/files", () => {
  it("refuses files that no page is waiting for, before taking any", async () => {
    const { app, folder, choose } = await appWithChooser(true);

    await request(app).post("/api/browser/live/files?chooser=other").attach("files", Buffer.from("a"), "a.jpg")
      .expect(409, { error: "The page is no longer asking for a file. Use its button again." });
    await request(app).post("/api/browser/live/files").attach("files", Buffer.from("a"), "a.jpg").expect(409);

    expect(choose).not.toHaveBeenCalled();
    await expect(readdir(folder)).resolves.toEqual([]);
  });

  it("writes the files where the gateway says, under the names they had, and gives them to the page", async () => {
    const { app, folder, choose } = await appWithChooser(true);

    await request(app).post("/api/browser/live/files?chooser=c1")
      .attach("files", Buffer.from("one"), "été 2026.png")
      .attach("files", Buffer.from("two"), "image.jpg")
      .attach("files", Buffer.from("three"), "../Image.JPG")
      .expect(200, { files: 3 });

    const names = ["été 2026.png", "image.jpg", "Image (1).JPG"];
    expect(choose).toHaveBeenCalledWith("c1", names.map((name) => join(folder, name)));
    await expect(readFile(join(folder, "Image (1).JPG"), "utf-8")).resolves.toBe("three");
    expect((await readdir(folder)).sort()).toEqual([...names].sort());
  });

  it("takes one file for a chooser that takes one, and leaves the chooser open with nothing kept", async () => {
    const { app, folder, choose, release } = await appWithChooser(false);

    await request(app).post("/api/browser/live/files?chooser=c1")
      .attach("files", Buffer.from("one"), "a.jpg")
      .attach("files", Buffer.from("two"), "b.jpg")
      .expect(400);

    expect(choose).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith("c1");
    await expect(stat(folder)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the chooser open when no file was sent", async () => {
    const { app, choose, release } = await appWithChooser(true);

    await request(app).post("/api/browser/live/files?chooser=c1").field("note", "no files").expect(400, { error: "No file was sent." });

    expect(choose).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith("c1");
  });

  it("keeps nothing when the page did not take the files, and says why", async () => {
    const { app, folder, choose } = await appWithChooser(false);
    choose.mockResolvedValue({ ok: false, error: "The page is no longer asking for a file. Use its button again." });

    await request(app).post("/api/browser/live/files?chooser=c1").attach("files", Buffer.from("one"), "a.jpg")
      .expect(409, { error: "The page is no longer asking for a file. Use its button again." });

    await expect(stat(folder)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is for the Bridge's own pages only", async () => {
    const { app, claim } = await appWithChooser(true);

    await request(app).post("/api/browser/live/files?chooser=c1").set("sec-fetch-site", "cross-site")
      .attach("files", Buffer.from("one"), "a.jpg").expect(403);

    expect(claim).not.toHaveBeenCalled();
  });
});
