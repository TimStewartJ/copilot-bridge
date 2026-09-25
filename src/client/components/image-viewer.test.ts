import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pswp = vi.hoisted(() => {
  const instances: Array<{ options: any; handlers: Record<string, Array<() => void>>; init: ReturnType<typeof vi.fn> }> = [];
  class FakePhotoSwipe {
    options: any;
    handlers: Record<string, Array<() => void>> = {};
    init = vi.fn();
    destroy = vi.fn();
    constructor(options: any) {
      this.options = options;
      instances.push(this);
    }
    on(name: string, handler: () => void) {
      (this.handlers[name] ??= []).push(handler);
    }
  }
  return { instances, FakePhotoSwipe };
});

vi.mock("photoswipe", () => ({ default: pswp.FakePhotoSwipe }));
vi.mock("photoswipe/style.css", () => ({}));
vi.mock("./image-viewer.css", () => ({}));

function fakeThumb(width: number, height: number) {
  const img = { tagName: "IMG", complete: true, naturalWidth: width, naturalHeight: height };
  return img as unknown as HTMLElement;
}

beforeEach(() => {
  pswp.instances.length = 0;
  vi.stubGlobal("document", { documentElement: { getAttribute: () => null } });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openImageViewer", () => {
  it("sizes slides from their loaded thumbnails and opens at the chosen image", async () => {
    const { openImageViewer } = await import("./image-viewer");
    const first = fakeThumb(1200, 800);
    const second = fakeThumb(640, 960);
    await openImageViewer([
      { src: "data:image/png;base64,AAA", name: "a.png", element: first, cropped: true },
      { src: "/api/x/b.png", name: "Chart", fileName: "b.png", downloadUrl: "/api/x/b.png?download=1", element: second },
    ], 1);

    expect(pswp.instances).toHaveLength(1);
    const { options, init } = pswp.instances[0];
    expect(init).toHaveBeenCalledTimes(1);
    expect(options.index).toBe(1);
    expect(options.showHideAnimationType).toBe("zoom");
    expect(options.dataSource[0]).toMatchObject({ width: 1200, height: 800, element: first, thumbCropped: true, fileName: "a.png" });
    expect(options.dataSource[1]).toMatchObject({ width: 640, height: 960, thumbCropped: false, fileName: "b.png", downloadUrl: "/api/x/b.png?download=1" });
  });

  it("skips the open animation when motion is reduced", async () => {
    vi.stubGlobal("document", { documentElement: { getAttribute: () => "reduce" } });
    const { openImageViewer } = await import("./image-viewer");
    await openImageViewer([{ src: "data:image/png;base64,BBB", name: "c.png", element: fakeThumb(10, 10) }], 0);
    expect(pswp.instances[0].options.showHideAnimationType).toBe("none");
  });
});
