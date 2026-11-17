import { haptic } from "./haptics";

/** Falls back to execCommand without the Clipboard API; rejects on failure so no false Copied. */
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
