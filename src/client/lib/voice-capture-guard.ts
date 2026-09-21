// A chat mic capture is at risk from the moment recording starts until the server has the audio:
// first it exists only in this tab's memory, then it is an upload that a reload would cut off.
// While any capture is at risk this keeps the screen awake, asks before the tab is closed, and lets
// the app hold back its own page reloads. Other work a reload would destroy, such as a chat message
// that has not reached the server, holds those reloads too.

interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
}

type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
};

let activeCaptures = 0;
let otherReloadHolds = 0;
let wakeLock: WakeLockSentinelLike | null = null;
const idleCallbacks = new Set<() => void>();

function runIdleCallbacksWhenSafe(): void {
  if (activeCaptures > 0 || otherReloadHolds > 0) return;
  for (const callback of [...idleCallbacks]) {
    idleCallbacks.delete(callback);
    callback();
  }
}

function confirmLeaving(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}

/** The browser drops a screen wake lock whenever the tab is hidden, so it is taken again on return. */
async function keepScreenAwake(): Promise<void> {
  if (activeCaptures === 0 || document.visibilityState !== "visible" || (wakeLock && !wakeLock.released)) return;
  try {
    const sentinel = await (navigator as WakeLockNavigator).wakeLock?.request("screen");
    if (!sentinel) return;
    if (activeCaptures === 0 || (wakeLock && !wakeLock.released)) void sentinel.release().catch(() => {});
    else wakeLock = sentinel;
  } catch {
    // Unsupported, or refused by a battery saver. Capturing works without it.
  }
}

function onVisibilityChange(): void {
  void keepScreenAwake();
}

/** Marks a capture as at risk. Call the returned function once its audio is stored or handed over. */
export function holdVoiceCapture(): () => void {
  activeCaptures += 1;
  if (activeCaptures === 1) {
    window.addEventListener("beforeunload", confirmLeaving);
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  void keepScreenAwake();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCaptures -= 1;
    if (activeCaptures > 0) return;
    window.removeEventListener("beforeunload", confirmLeaving);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    void wakeLock?.release().catch(() => {});
    wakeLock = null;
    runIdleCallbacksWhenSafe();
  };
}

/** Holds the app's own page reloads, and nothing else. Call the returned function once the work is safe. */
export function holdPageReload(): () => void {
  otherReloadHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    otherReloadHolds -= 1;
    runIdleCallbacksWhenSafe();
  };
}

/** Holds a capture while `work` runs, such as the upload that hands its audio to the server. */
export async function whileHoldingVoiceCapture<T>(work: () => Promise<T>): Promise<T> {
  const release = holdVoiceCapture();
  try {
    return await work();
  } finally {
    release();
  }
}

/** Rechecks safety at reload time, including captures or sends started after the timer was armed. */
export function schedulePageReloadWhenSafe(reload: () => void, onHeld: () => void): () => void {
  let cancelWait = () => {};
  const timer = setTimeout(() => {
    let ready = false;
    cancelWait = whenPageReloadSafe(() => {
      ready = true;
      reload();
    });
    if (!ready) onHeld();
  }, 1_000);
  return () => {
    clearTimeout(timer);
    cancelWait();
  };
}

/** Runs `callback` once a page reload would destroy nothing, which may be right away. Returns a cancel function. */
export function whenPageReloadSafe(callback: () => void): () => void {
  if (activeCaptures === 0 && otherReloadHolds === 0) {
    callback();
    return () => {};
  }
  idleCallbacks.add(callback);
  return () => {
    idleCallbacks.delete(callback);
  };
}
