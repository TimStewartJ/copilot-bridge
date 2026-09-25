import { useRef, useState } from "react";
import type { VisualArtifact } from "../api";
import VisualArtifactModal from "./VisualArtifactModal";
import VisualArtifactRenderer from "./VisualArtifactRenderer";
import { Download, Maximize2 } from "lucide-react";
import { DS, cx } from "../design/tokens";
import { describeVisualKind } from "./visualDisplay";
import { formatFileSize, showImages } from "./ChatAttachments";

interface VisualArtifactCardProps {
  visual: VisualArtifact;
}

/**
 * A visual the agent published, shown the way a chat app shows an artifact: the content in one
 * frame, and beneath it a line that says what it is, with Expand and Download beside it.
 */
export default function VisualArtifactCard({ visual }: VisualArtifactCardProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const isImage = visual.kind === "image";
  const { label: kindLabel, Icon: KindIcon } = describeVisualKind(visual.kind);
  const meta = [kindLabel, formatFileSize(visual.size)].filter(Boolean).join(" · ");
  const actionClass = cx(DS.button.base, DS.button.icon.sm, DS.button.variant.ghost);
  const mediaRef = useRef<HTMLButtonElement>(null);
  const expand = () => {
    if (!isImage) {
      setModalOpen(true);
      return;
    }
    showImages([{
      src: visual.url,
      name: visual.title,
      fileName: visual.displayName,
      downloadUrl: visual.downloadUrl,
      alt: visual.altText ?? visual.title,
      element: mediaRef.current?.querySelector("img"),
    }], 0);
  };

  return (
    <>
      <figure className={cx("m-0 flex min-w-0 flex-col gap-2", isImage ? "w-fit min-w-[min(100%,15rem)] max-w-full" : "w-full")}>
        {isImage ? (
          <button
            ref={mediaRef}
            type="button"
            onClick={expand}
            className={cx(
              "group/visual relative block min-w-0 max-w-full cursor-zoom-in overflow-hidden rounded-2xl border border-surface-edge bg-surface-inset",
              DS.focus,
            )}
            aria-label={`View full size: ${visual.title}`}
          >
            <VisualArtifactRenderer visual={visual} mode="inline" />
          </button>
        ) : (
          <div className="min-w-0 overflow-hidden rounded-2xl border border-surface-edge bg-surface-group">
            <VisualArtifactRenderer visual={visual} mode="inline" />
          </div>
        )}

        <figcaption className={cx("flex min-w-0 items-start gap-2 px-0.5", isImage && "w-0 min-w-full")}>
          <KindIcon size={14} className="mt-[3px] shrink-0 text-text-faint" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium leading-5 text-text-primary" title={visual.title}>{visual.title}</div>
            <div className="truncate text-xs tabular-nums leading-4 text-text-faint">{meta}</div>
            {visual.caption && (
              <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">{visual.caption}</p>
            )}
          </div>
          <div className="-my-1 flex shrink-0 items-center">
            <button
              type="button"
              onClick={expand}
              title="Expand"
              className={actionClass}
              aria-label={`View full size: ${visual.title}`}
            >
              <Maximize2 size={14} aria-hidden="true" />
            </button>
            <a
              href={visual.downloadUrl}
              download={visual.displayName}
              title={`Download ${visual.displayName}`}
              className={actionClass}
              aria-label={`Download ${visual.displayName}`}
            >
              <Download size={14} aria-hidden="true" />
            </a>
          </div>
        </figcaption>
      </figure>

      {modalOpen && (
        <VisualArtifactModal visual={visual} onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
