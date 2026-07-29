/**
 * Copies text to the clipboard, falling back to a hidden textarea plus
 * `document.execCommand("copy")` when the async Clipboard API is unavailable
 * (insecure origins, embedded webviews). Rejects when the copy genuinely fails
 * so callers can surface a failure instead of a false "Copied" confirmation.
 */
export async function writeClipboardText(text: string) {
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
