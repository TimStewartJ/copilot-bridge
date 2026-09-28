import { haptic } from "./haptics";

/**
 * Copies text to the clipboard, falling back to a hidden textarea plus
 * `document.execCommand("copy")` when the async Clipboard API is unavailable
 * (insecure origins, embedded webviews). Rejects when the copy genuinely fails
 * so callers can surface a failure instead of a false "Copied" confirmation.
 * A copy that worked gives a light haptic in a host app that offers it; the caller reports failures.
 */
export async function writeClipboardText(text: string) {
  await copyText(text);
  haptic("light");
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  document.body.appendChild(textArea);
  textArea.select();
  try {
    const copied = document.execCommand("copy");
    if (!copied) throw new Error("Browser copy command returned false");
  } finally {
    document.body.removeChild(textArea);
  }
}
