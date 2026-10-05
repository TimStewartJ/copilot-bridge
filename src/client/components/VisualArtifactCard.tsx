import { useRef, useState } from "react";
import type { VisualArtifact } from "../api";
import VisualArtifactModal from "./VisualArtifactModal";
import VisualArtifactRenderer from "./VisualArtifactRenderer";
import { DS, cx } from "../design/tokens";
import { describeVisualKind } from "./visualDisplay";
import { formatFileSize, PreviewCaption, showImages } from "./ChatAttachments";

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

        <PreviewCaption
          Icon={KindIcon}
          title={visual.title}
          meta={meta}
          note={visual.caption}
          onExpand={expand}
          downloadUrl={visual.downloadUrl}
          downloadName={visual.displayName}
          className={isImage ? "w-0 min-w-full" : undefined}
        />
      </figure>

      {modalOpen && (
        <VisualArtifactModal visual={visual} onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
