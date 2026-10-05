import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  COMPONENT_IMPORT_WARMUP_TIMEOUT_MS,
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
} from "../test-react-harness";

vi.mock("./image-viewer", () => ({ openImageViewer: vi.fn(async () => {}) }));
// What a tab sees when it cannot fetch pdf.js: offline, or older than the running build.
vi.mock("./PdfPreview", () => {
  throw new Error("chunk unavailable");
});

type FilePreviewModule = typeof import("./FilePreview");
let mod: FilePreviewModule;
let preview: typeof import("./file-preview");

beforeAll(async () => {
  const harness = await createReactDomHarness();
  try {
    mod = await import("./FilePreview");
    preview = await import("./file-preview");
  } finally {
    await harness.cleanup();
  }
}, COMPONENT_IMPORT_WARMUP_TIMEOUT_MS);

afterEach(() => {
  preview.showFile(null);
  vi.unstubAllGlobals();
});

function stubFile(body: BodyInit, status = 200) {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const byLabel = (root: unknown, tag: string, label: string) => (
  findAllByTag(root, tag).find((node) => node.getAttribute?.("aria-label") === label)
);

describe("OutboundAttachment", () => {
  it("shows a markdown file rendered in place, with opening and downloading beside it", async () => {
    const fetchMock = stubFile("# Findings\n\nAll **good**.");
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement("div", null,
        createElement(mod.OutboundAttachment, { url: "/api/x/report.md", name: "report.md" }),
        createElement(mod.FileViewerHost),
      ));
      await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "H1").length > 0);

      expect(fetchMock).toHaveBeenCalledWith("/api/x/report.md", { headers: { Range: "bytes=0-16383" } });
      expect(findAllByTag(harness.dom.container, "H1")[0].textContent).toBe("Findings");
      expect(findAllByTag(harness.dom.container, "STRONG")[0].textContent).toBe("good");
      const download = byLabel(harness.dom.container, "A", "Download report.md");
      expect(download.getAttribute("href")).toBe("/api/x/report.md");
      expect(download.getAttribute("download")).toBe("report.md");

      await harness.act(async () => {
        getReactProps(byLabel(harness.dom.container, "BUTTON", "Open report.md"))?.onClick?.({});
      });
      expect(findAllByTag(harness.dom.container, "H2")[0].textContent).toBe("report.md");
      expect(fetchMock).toHaveBeenCalledWith("/api/x/report.md", { headers: { Range: "bytes=0-524287" } });
    } finally {
      await harness.cleanup();
    }
  });

  it("offers a PDF as a download when pdf.js cannot be loaded, instead of failing the page", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement("div", null,
        createElement("p", null, "still here"),
        createElement(mod.OutboundAttachment, { url: "/api/x/flyer.pdf", name: "flyer.pdf" }),
      ));
      await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "BUTTON").length === 0);

      expect(harness.dom.container.textContent).toContain("still here");
      expect(findAllByTag(harness.dom.container, "A").map((link) => link.getAttribute("aria-label"))).toEqual(["Download flyer.pdf"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("shows a CSV file as a table, with a column for every value of its widest row", async () => {
    stubFile('item,cost\n"Tea, green",4\nMilk,2,note\n');
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(mod.OutboundAttachment, { url: "/api/x/costs.csv", name: "costs.csv" }));
      await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "TABLE").length > 0);

      expect(findAllByTag(harness.dom.container, "TH").map((cell) => cell.textContent)).toEqual(["item", "cost", ""]);
      expect(findAllByTag(harness.dom.container, "TD").map((cell) => cell.textContent)).toEqual(["Tea, green", "4", "", "Milk", "2", "note"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("shows a web page in a sandboxed frame, a player for audio, and an image as an image", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement("div", null,
        createElement(mod.OutboundAttachment, { url: "/api/x/mockup.html", name: "mockup.html" }),
        createElement(mod.OutboundAttachment, { url: "/api/x/take.mp3", name: "take.mp3" }),
        createElement(mod.OutboundAttachment, { url: "/api/x/chart.png", name: "chart.png" }),
      ));

      const frame = findAllByTag(harness.dom.container, "IFRAME")[0];
      expect(frame.getAttribute("src")).toBe("/api/x/mockup.html?inline=1");
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(findAllByTag(harness.dom.container, "AUDIO")[0].getAttribute("src")).toBe("/api/x/take.mp3");
      expect(findAllByTag(harness.dom.container, "IMG")[0].getAttribute("src")).toBe("/api/x/chart.png");
      expect(byLabel(harness.dom.container, "BUTTON", "View full size: take.mp3")).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  it("offers a file it cannot show as a download: a known binary format, and one that turns out not to be text", async () => {
    stubFile(new Uint8Array([1, 0, 2, 0]));
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement("div", null,
        createElement(mod.OutboundAttachment, { url: "/api/x/bundle.zip", name: "bundle.zip" }),
        createElement(mod.OutboundAttachment, { url: "/api/x/capture.dat", name: "capture.dat" }),
      ));
      await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "A").length === 2);

      const links = findAllByTag(harness.dom.container, "A");
      expect(links.map((link) => link.getAttribute("aria-label"))).toEqual(["Download bundle.zip", "Download capture.dat"]);
      expect(links.map((link) => link.getAttribute("download"))).toEqual(["bundle.zip", "capture.dat"]);
      expect(findAllByTag(harness.dom.container, "BUTTON")).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("FileViewerHost", () => {
  it("shows nothing until a file is opened, then the whole file with a way to download and close it", async () => {
    const fetchMock = stubFile("diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n");
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(mod.FileViewerHost));
      expect(harness.dom.container.textContent).toBe("");

      await harness.act(async () => {
        preview.showFile({ url: "/api/x/change.diff", name: "change.diff" });
      });
      await waitUntilAct(harness.act, () => findAllByTag(harness.dom.container, "PRE").length > 0);

      expect(fetchMock).toHaveBeenCalledWith("/api/x/change.diff", { headers: { Range: "bytes=0-524287" } });
      expect(findAllByTag(harness.dom.container, "H2")[0].textContent).toBe("change.diff");
      expect(findAllByTag(harness.dom.container, "PRE")[0].textContent).toContain("+new");
      expect(byLabel(harness.dom.container, "A", "Download change.diff").getAttribute("href")).toBe("/api/x/change.diff");

      await harness.act(async () => {
        getReactProps(byLabel(harness.dom.container, "BUTTON", "Close"))?.onClick?.({});
      });
      expect(harness.dom.container.textContent).toBe("");
    } finally {
      await harness.cleanup();
    }
  });
});
