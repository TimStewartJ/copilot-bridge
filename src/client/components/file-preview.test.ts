import { afterEach, describe, expect, it, vi } from "vitest";
import { filePreviewKind, loadedFileText, loadFileText, parseDelimitedRows, pdfCanvasScale } from "./file-preview";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(respond: (url: string, range: string | null) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (
    respond(url, new Headers(init?.headers).get("Range"))
  ));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("filePreviewKind", () => {
  it("names how each kind of file is shown", () => {
    expect(filePreviewKind("chart.PNG")).toBe("image");
    expect(filePreviewKind("logo.svg")).toBe("image");
    expect(filePreviewKind("report.md")).toBe("markdown");
    expect(filePreviewKind("data.csv")).toBe("table");
    expect(filePreviewKind("mockup.html")).toBe("html");
    expect(filePreviewKind("flyer.pdf")).toBe("pdf");
    expect(filePreviewKind("take.mp3")).toBe("audio");
    expect(filePreviewKind("demo.webm")).toBe("video");
  });

  it("tries an unlisted extension as text and leaves known binary formats to download", () => {
    expect(filePreviewKind("change.diff")).toBe("text");
    expect(filePreviewKind("Code.gs")).toBe("text");
    expect(filePreviewKind("probe.mts")).toBe("text");
    expect(filePreviewKind("LICENSE")).toBe("text");
    expect(filePreviewKind("bundle.zip")).toBeNull();
    expect(filePreviewKind("budget.xlsx")).toBeNull();
  });
});

describe("loadFileText", () => {
  it("asks for the start of the file and reports when there is more", async () => {
    const fetchMock = stubFetch(() => new Response("line one\nline two\nline thr", {
      status: 206,
      headers: { "Content-Range": "bytes 0-25/9000" },
    }));

    await expect(loadFileText("/api/x/long.txt", 26)).resolves.toEqual({ text: "line one\nline two", truncated: true });
    expect(fetchMock.mock.calls[0][1]).toEqual({ headers: { Range: "bytes=0-25" } });
  });

  it("returns a whole short file, and reads a file once for the same size", async () => {
    const fetchMock = stubFetch(() => new Response("héllo", { status: 206, headers: { "Content-Range": "bytes 0-5/6" } }));

    expect(loadedFileText("/api/x/short.txt", 1024)).toBeNull();
    await expect(loadFileText("/api/x/short.txt", 1024)).resolves.toEqual({ text: "héllo", truncated: false });
    await loadFileText("/api/x/short.txt", 1024);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadedFileText("/api/x/short.txt", 1024)).toEqual({ text: "héllo", truncated: false });
  });

  it("leaves out a character the cut fell inside when there is no line to fall back to", async () => {
    const bytes = new TextEncoder().encode('{"note":"café"}');
    const cut = bytes.subarray(0, bytes.indexOf(0xc3) + 1);
    stubFetch(() => new Response(cut, { status: 206, headers: { "Content-Range": `bytes 0-${cut.length - 1}/${bytes.length}` } }));

    await expect(loadFileText("/api/x/min.json", cut.length)).resolves.toEqual({ text: '{"note":"caf', truncated: true });
  });

  it("stops at the limit when the range was ignored", async () => {
    stubFetch(() => new Response("a\n".repeat(5000), { status: 200 }));

    const loaded = await loadFileText("/api/x/unranged.txt", 100);
    expect(loaded.truncated).toBe(true);
    expect(loaded.text.length).toBeLessThanOrEqual(100);
  });

  it("treats an empty file as empty text", async () => {
    stubFetch(() => new Response(null, { status: 416 }));

    await expect(loadFileText("/api/x/empty.txt", 1024)).resolves.toEqual({ text: "", truncated: false });
  });

  it("rejects a binary or missing file, and tries again next time", async () => {
    let status = 404;
    const fetchMock = stubFetch(() => (
      status === 404 ? new Response("{}", { status }) : new Response(new Uint8Array([80, 75, 3, 4, 0, 0]), { status })
    ));

    await expect(loadFileText("/api/x/blob.dat", 1024)).rejects.toThrow("could not be read");
    status = 200;
    await expect(loadFileText("/api/x/blob.dat", 1024)).rejects.toThrow("not text");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("pdfCanvasScale", () => {
  it("draws as sharp as the screen, up to twice, within the canvas the device allows", () => {
    expect(pdfCanvasScale(600, 800, 1, 16_000_000)).toBe(1);
    expect(pdfCanvasScale(600, 800, 3, 16_000_000)).toBe(2);
    // A phone page zoomed to three times its width: the total stays at the limit.
    const scale = pdfCanvasScale(1170, 1514, 3, 5_000_000);
    expect(scale).toBeLessThan(2);
    expect(Math.round(1170 * scale * 1514 * scale)).toBe(5_000_000);
  });
});

describe("parseDelimitedRows", () => {
  it("reads quoted fields, doubled quotes and line breaks inside quotes", () => {
    expect(parseDelimitedRows('name,note\r\n"Smith, J","said ""hi""\nthen left"\n\nlast,row', ",", 10)).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
      ["last", "row"],
    ]);
  });

  it("splits on tabs and stops at the row limit", () => {
    expect(parseDelimitedRows("a\tb\n1\t2\n3\t4\n5\t6", "\t", 2)).toEqual([["a", "b"], ["1", "2"]]);
  });
});
