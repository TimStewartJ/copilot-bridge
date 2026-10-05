import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, PDFWorker, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { cx } from "../design/tokens";
import { pdfCanvasScale } from "./file-preview";

/**
 * A PDF drawn by pdf.js, because a phone's web view shows only the first page of an embedded PDF
 * and cannot zoom it. The card shows page one and the viewer every page. A page is drawn while it
 * is near the screen and let go when it leaves, so neither a long document nor a transcript with
 * many PDFs holds its pages in memory. Loaded on first use: the chat does not carry pdf.js until a
 * PDF comes near the screen.
 */

GlobalWorkerOptions.workerSrc = workerUrl;
/** One worker for every PDF on the page; pdf.js would otherwise start one per document. */
let sharedWorker: PDFWorker | undefined;

/** A phone allows about 16 million pixels in one canvas and little memory for many; stay well under it there. */
const MAX_CANVAS_PIXELS = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? 5_000_000 : 16_000_000;
const LETTER_RATIO = 11 / 8.5;

export interface PdfPreviewProps {
  url: string;
  viewer: boolean;
  zoom: number;
  onError: () => void;
}

interface PdfPageProps {
  pdf: PDFDocumentProxy;
  number: number;
  /** The width the page is laid out at, in CSS pixels. */
  width: number;
  /** Height over width to hold the page's place with until it has been read: the first page's. */
  placeholderRatio: number;
  /** The scrolling element pages are watched against: the viewer's own, or the window for a card. */
  scroller: HTMLElement | null;
}

function PdfPage({ pdf, number, width, placeholderRatio, scroller }: PdfPageProps) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    // Pages within a screen of the visible ones are drawn ahead, so scrolling does not show blanks.
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: scroller, rootMargin: "100% 0px" });
    observer.observe(holder);
    return () => observer.disconnect();
  }, [scroller]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas || width <= 0) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    void pdf.getPage(number).then((page) => {
      if (cancelled) return;
      const size = page.getViewport({ scale: 1 });
      setRatio(size.height / size.width);
      const fit = width / size.width;
      const viewport = page.getViewport({
        scale: fit * pdfCanvasScale(width, size.height * fit, window.devicePixelRatio, MAX_CANVAS_PIXELS),
      });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvas, viewport });
      return task.promise;
    }).catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
      // Releases the bitmap at once instead of when the element is collected.
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [pdf, number, visible, width]);

  return (
    <div ref={holderRef} className="bg-white" style={{ aspectRatio: `1 / ${ratio ?? placeholderRatio}` }}>
      {visible && <canvas ref={canvasRef} className="block h-full w-full" role="img" aria-label={`Page ${number}`} />}
    </div>
  );
}

/** At its natural zoom a page is no wider than a comfortable sheet on a large screen. */
const PAGE_MAX_REM = 56;

export default function PdfPreview({ url, viewer, zoom, onError }: PdfPreviewProps) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [firstRatio, setFirstRatio] = useState(LETTER_RATIO);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    sharedWorker ??= new PDFWorker();
    const loading = getDocument({ url, worker: sharedWorker });
    loading.promise.then(async (loaded) => {
      const size = (await loaded.getPage(1)).getViewport({ scale: 1 });
      if (cancelled) return;
      setFirstRatio(size.height / size.width);
      setPdf(loaded);
    }).catch(() => { if (!cancelled) onError(); });
    return () => {
      cancelled = true;
      void loading.destroy();
    };
  }, [url, onError]);

  useEffect(() => {
    const pages = pagesRef.current;
    if (!pages) return;
    const measure = () => setWidth(pages.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(pages);
    return () => observer.disconnect();
  }, []);

  // Zooming keeps the place: what was at the top left of the view stays there.
  const shownZoom = useRef(zoom);
  useLayoutEffect(() => {
    if (scroller) {
      scroller.scrollTop *= zoom / shownZoom.current;
      scroller.scrollLeft *= zoom / shownZoom.current;
    }
    shownZoom.current = zoom;
  }, [zoom, scroller]);

  const numbers = pdf ? Array.from({ length: viewer ? pdf.numPages : 1 }, (_, index) => index + 1) : [];
  return (
    <div
      ref={viewer ? setScroller : undefined}
      className={cx("not-prose w-full", viewer && "h-full overflow-auto bg-surface-inset")}
      role={pdf ? undefined : "status"}
      aria-label={pdf ? undefined : "Loading"}
    >
      <div
        ref={pagesRef}
        className="mx-auto flex flex-col gap-2"
        style={viewer ? { width: `min(${zoom * 100}%, ${zoom * PAGE_MAX_REM}rem)` } : undefined}
      >
        {pdf && (!viewer || scroller) && numbers.map((number) => (
          <PdfPage key={number} pdf={pdf} number={number} width={width} placeholderRatio={firstRatio} scroller={scroller} />
        ))}
      </div>
    </div>
  );
}
