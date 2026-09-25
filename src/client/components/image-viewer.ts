import PhotoSwipe, { type SlideData } from "photoswipe";
import "photoswipe/style.css";
import "./image-viewer.css";
import { prefersReducedMotion } from "../lib/motion";

/**
 * The full-screen image viewer. PhotoSwipe owns the gestures a phone photo viewer has: pinch to
 * zoom around the fingers, pan with momentum and edge springback, double-tap to zoom to a point,
 * swipe between images, drag down to close, and an open/close animation from the thumbnail.
 * Loaded with a dynamic import the first time an image opens, so chat pages do not pay for it.
 */

export interface ViewerImage {
  src: string;
  name: string;
  /** Where Download points; the image's own source when omitted. */
  downloadUrl?: string;
  /** The name Download saves as; \
ame\ when omitted. */
  fileName?: string;
  alt?: string;
  /** The thumbnail the viewer opens from and closes back into. */
  element?: HTMLElement | null;
  /** True when the thumbnail crops the image (object-cover), so the animation uncrops it. */
  cropped?: boolean;
}

interface Size {
  width: number;
  height: number;
}

const FALLBACK_SIZE: Size = { width: 1600, height: 1200 };
const sizeCache = new Map<string, Size>();

function measureFromElement(element: HTMLElement | null | undefined): Size | null {
  const img = element?.tagName === "IMG" ? element as HTMLImageElement : element?.querySelector("img");
  if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
    return { width: img.naturalWidth, height: img.naturalHeight };
  }
  return null;
}

function measureBySource(src: string): Promise<Size> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : FALLBACK_SIZE);
    img.onerror = () => resolve(FALLBACK_SIZE);
    img.src = src;
  });
}

async function measure(image: ViewerImage): Promise<Size> {
  const cached = sizeCache.get(image.src);
  if (cached) return cached;
  const size = measureFromElement(image.element) ?? await measureBySource(image.src);
  sizeCache.set(image.src, size);
  return size;
}

function svg(paths: string, size = 20): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const ICON_CLOSE = svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
const ICON_ZOOM = svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6" class="bridge-pswp-zoom-v"/><path d="M8 11h6"/>');
const ICON_DOWNLOAD = svg('<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>');
const ICON_PREV = `<span class="bridge-pswp-arrow">${svg('<path d="m15 18-6-6 6-6"/>', 18)}</span>`;
const ICON_NEXT = `<span class="bridge-pswp-arrow">${svg('<path d="m9 18 6-6-6-6"/>', 18)}</span>`;

function viewerPadding(viewport: { x: number }) {
  return viewport.x < 640
    ? { top: 56, bottom: 16, left: 0, right: 0 }
    : { top: 64, bottom: 32, left: 72, right: 72 };
}

let active: PhotoSwipe | null = null;

export async function openImageViewer(images: ViewerImage[], index = 0): Promise<void> {
  if (images.length === 0) return;
  const start = Math.min(Math.max(index, 0), images.length - 1);
  const sizes = await Promise.all(images.map(measure));
  const dataSource: SlideData[] = images.map((image, i) => ({
    src: image.src,
    msrc: image.src,
    width: sizes[i].width,
    height: sizes[i].height,
    alt: image.alt ?? image.name,
    element: image.element ?? undefined,
    thumbCropped: image.cropped === true,
    name: image.name,
    fileName: image.fileName ?? image.name,
    downloadUrl: image.downloadUrl ?? image.src,
  }));

  active?.destroy();
  const pswp = new PhotoSwipe({
    dataSource,
    index: start,
    mainClass: "bridge-pswp",
    bgOpacity: 1,
    spacing: 0.08,
    loop: false,
    wheelToZoom: true,
    paddingFn: viewerPadding,
    showHideAnimationType: prefersReducedMotion() ? "none" : "zoom",
    initialZoomLevel: "fit",
    secondaryZoomLevel: 2.5,
    maxZoomLevel: 4,
    imageClickAction: "zoom-or-close",
    tapAction: "toggle-controls",
    doubleTapAction: "zoom",
    bgClickAction: "close",
    counter: false,
    closeTitle: "Close (Esc)",
    zoomTitle: "Zoom",
    arrowPrevTitle: "Previous image",
    arrowNextTitle: "Next image",
    closeSVG: ICON_CLOSE,
    zoomSVG: ICON_ZOOM,
    arrowPrevSVG: ICON_PREV,
    arrowNextSVG: ICON_NEXT,
    errorMsg: "This image could not be loaded.",
  });

  pswp.on("uiRegister", () => {
    pswp.ui?.registerElement({
      name: "bridge-title",
      order: 5,
      appendTo: "bar",
      isButton: false,
      html: "",
      onInit: (element, instance) => {
        element.classList.add("bridge-pswp-title");
        const render = () => {
          const data = instance.currSlide?.data;
          const count = instance.getNumItems();
          const name = document.createElement("span");
          name.className = "bridge-pswp-name";
          name.textContent = typeof data?.name === "string" ? data.name : "";
          element.replaceChildren(name);
          if (count > 1) {
            const position = document.createElement("span");
            position.className = "bridge-pswp-count";
            position.textContent = `${instance.currIndex + 1} of ${count}`;
            element.appendChild(position);
          }
        };
        instance.on("change", render);
        render();
      },
    });
    pswp.ui?.registerElement({
      name: "bridge-download",
      order: 8,
      appendTo: "bar",
      isButton: true,
      tagName: "a",
      title: "Download",
      ariaLabel: "Download",
      html: ICON_DOWNLOAD,
      onInit: (element, instance) => {
        const link = element as HTMLAnchorElement;
        const update = () => {
          const data = instance.currSlide?.data;
          const name = typeof data?.fileName === "string" ? data.fileName : "image";
          link.href = typeof data?.downloadUrl === "string" ? data.downloadUrl : String(data?.src ?? "");
          link.download = name;
          link.setAttribute("aria-label", `Download ${name}`);
          link.title = `Download ${name}`;
        };
        instance.on("change", update);
        update();
      },
    });
  });

  pswp.on("destroy", () => {
    if (active === pswp) active = null;
  });
  active = pswp;
  pswp.init();
}
