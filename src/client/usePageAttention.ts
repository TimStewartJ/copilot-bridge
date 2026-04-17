import { useEffect, useRef, useState } from "react";

type AttentionDocument = Pick<Document, "visibilityState" | "hasFocus">;

export function hasPageAttention(doc?: AttentionDocument | null): boolean {
  return doc?.visibilityState === "visible" && doc.hasFocus();
}

export function usePageAttention(): {
  hasAttention: boolean;
  hasAttentionRef: React.MutableRefObject<boolean>;
} {
  const initialAttention = hasPageAttention(typeof document === "undefined" ? null : document);
  const [attention, setAttention] = useState(initialAttention);
  const attentionRef = useRef(initialAttention);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;

    const updateAttention = () => {
      const nextAttention = hasPageAttention(document);
      attentionRef.current = nextAttention;
      setAttention(nextAttention);
    };

    updateAttention();
    document.addEventListener("visibilitychange", updateAttention);
    window.addEventListener("focus", updateAttention);
    window.addEventListener("blur", updateAttention);

    return () => {
      document.removeEventListener("visibilitychange", updateAttention);
      window.removeEventListener("focus", updateAttention);
      window.removeEventListener("blur", updateAttention);
    };
  }, []);

  return { hasAttention: attention, hasAttentionRef: attentionRef };
}
