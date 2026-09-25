import { createElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../api";
import {
  COMPONENT_IMPORT_WARMUP_TIMEOUT_MS,
  createReactDomHarness,
  findAllByTag,
  getReactProps,
} from "../test-react-harness";

const viewerMocks = vi.hoisted(() => ({ openImageViewer: vi.fn(async () => {}) }));
vi.mock("./image-viewer", () => viewerMocks);

type ChatAttachmentsModule = typeof import("./ChatAttachments");
let mod: ChatAttachmentsModule;
const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

beforeAll(async () => {
  const harness = await createReactDomHarness();
  try {
    mod = await import("./ChatAttachments");
  } finally {
    await harness.cleanup();
  }
}, COMPONENT_IMPORT_WARMUP_TIMEOUT_MS);

beforeEach(() => {
  viewerMocks.openImageViewer.mockClear();
});

describe("file descriptions", () => {
  it("names a file by its extension and formats its size", () => {
    expect(mod.describeFile("report.pdf").kind).toBe("PDF");
    expect(mod.describeFile("data.CSV").kind).toBe("CSV");
    expect(mod.describeFile("README").kind).toBe("File");
    expect(mod.describeFile("clip", "image/png").kind).toBe("Image");
    expect(mod.formatFileSize(512)).toBe("512 B");
    expect(mod.formatFileSize(1536)).toBe("1.5 KB");
    expect(mod.formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
    expect(mod.formatFileSize(undefined)).toBeNull();
    expect(mod.base64ByteLength("aGVsbG8=")).toBe(5);
  });
});

describe("attachmentImageSrc", () => {
  it("uses the bytes when present and the session's copy when history dropped them", () => {
    expect(mod.attachmentImageSrc({ type: "blob", data: "AAAA", mimeType: "image/png", displayName: "a.png" }))
      .toBe("data:image/png;base64,AAAA");
    expect(mod.attachmentImageSrc({ type: "blob", data: "", mimeType: "image/png", displayName: "my shot.png" }, id))
      .toBe(`/api/sessions/${id}/files/my%20shot.png`);
    expect(mod.attachmentImageSrc({ type: "blob", data: "", mimeType: "image/png", displayName: "a.png" })).toBeNull();
    expect(mod.attachmentImageSrc({ type: "file", path: `C:\\Users\\me\\.copilot\\session-state\\${id}\\files\\b.jpg` }, id))
      .toBe(`/api/sessions/${id}/files/b.jpg`);
    expect(mod.attachmentImageSrc({ type: "file", path: "C:\\elsewhere\\b.jpg" }, id)).toBeNull();
    expect(mod.attachmentImageSrc({ type: "file", path: `/home/me/.copilot/session-state/${id}/files/outgoing/b.jpg` }, id)).toBeNull();
  });
});

describe("parseOutboundAttachmentLink", () => {

  it("recognises send_attachment links, including a staging prefix and encoded names", () => {
    expect(mod.parseOutboundAttachmentLink(`/api/sessions/${id}/attachments/report.csv`))
      .toEqual({ url: `/api/sessions/${id}/attachments/report.csv`, name: "report.csv" });
    expect(mod.parseOutboundAttachmentLink(`/staging/p1/api/sessions/${id}/attachments/my%20chart.png`)?.name)
      .toBe("my chart.png");
  });

  it("ignores other links", () => {
    expect(mod.parseOutboundAttachmentLink("https://example.com/report.csv")).toBeNull();
    expect(mod.parseOutboundAttachmentLink(`/api/sessions/${id}/files/report.csv`)).toBeNull();
    expect(mod.parseOutboundAttachmentLink(`/api/sessions/not-a-session/attachments/report.csv`)).toBeNull();
    expect(mod.parseOutboundAttachmentLink(undefined)).toBeNull();
  });
});

describe("MessageAttachments", () => {
  it("shows images as a gallery that opens full screen and files as cards", async () => {
    const harness = await createReactDomHarness();
    const attachments: Attachment[] = [
      { type: "blob", data: "aGVsbG8=", mimeType: "image/png", displayName: "shot.png" },
      { type: "file", path: "C:\\work\\notes.md" },
    ];
    try {
      await harness.render(createElement(mod.MessageAttachments, { attachments }));

      const images = findAllByTag(harness.dom.container, "IMG");
      expect(images).toHaveLength(1);
      expect(images[0].getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
      expect(harness.dom.container.textContent).toContain("notes.md");
      expect(harness.dom.container.textContent).toContain("MD");

      const open = findAllByTag(harness.dom.container, "BUTTON").find((button) => (
        button.getAttribute?.("aria-label") === "Open image shot.png"
      ));
      expect(open).toBeDefined();
      await harness.act(async () => {
        getReactProps(open)?.onClick?.({});
      });
      await vi.waitFor(() => expect(viewerMocks.openImageViewer).toHaveBeenCalledTimes(1));
      const [opened, index] = viewerMocks.openImageViewer.mock.calls[0] as unknown as [Array<Record<string, unknown>>, number];
      expect(index).toBe(0);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ src: "data:image/png;base64,aGVsbG8=", name: "shot.png", cropped: false });
      expect(opened[0].element).toBe(findAllByTag(harness.dom.container, "IMG")[0]);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("ComposerAttachmentTray", () => {
  it("links a sent file from history to the session's copy", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(mod.MessageAttachments, {
        sessionId: id,
        attachments: [{ type: "file", path: `C:\\h\\.copilot\\session-state\\${id}\\files\\data.csv`, displayName: "data.csv" }],
      }));
      const link = findAllByTag(harness.dom.container, "A")[0];
      expect(link.getAttribute("href")).toBe(`/api/sessions/${id}/files/data.csv?download=1`);
    } finally {
      await harness.cleanup();
    }
  });
  it("renders nothing when empty and shows an uploading tile while a file uploads", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(mod.ComposerAttachmentTray, { attachments: [], uploadingCount: 0, onRemove: () => {} }));
      expect(harness.dom.container.textContent).toBe("");

      await harness.render(createElement(mod.ComposerAttachmentTray, { attachments: [], uploadingCount: 1, onRemove: () => {} }));
      const status = findAllByTag(harness.dom.container, "DIV").find((node) => node.getAttribute?.("role") === "status");
      expect(status?.getAttribute("aria-label")).toBe("Uploading attachment");
    } finally {
      await harness.cleanup();
    }
  });
});

describe("OutboundAttachment", () => {
  it("offers a non-image file as a download card", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(mod.OutboundAttachment, { url: "/api/x/report.csv", name: "report.csv" }));
      const link = findAllByTag(harness.dom.container, "A")[0];
      expect(link.getAttribute("href")).toBe("/api/x/report.csv");
      expect(link.getAttribute("download")).toBe("report.csv");
      expect(harness.dom.container.textContent).toContain("CSV");
    } finally {
      await harness.cleanup();
    }
  });

  it("previews an image file inline", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(mod.OutboundAttachment, { url: "/api/x/chart.png", name: "chart.png" }));
      expect(findAllByTag(harness.dom.container, "IMG")[0]?.getAttribute("src")).toBe("/api/x/chart.png");
    } finally {
      await harness.cleanup();
    }
  });
});
