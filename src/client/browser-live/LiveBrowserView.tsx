import { ArrowLeft, ArrowRight, CornerDownLeft, Delete, RotateCw } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { BrowserLivePageCommand, BrowserLiveTicket } from "../../shared/browser-live.js";
import { Button, EmptyHint, IconButton, Notice, SegmentedControl, Select, StatusIcon, TextInput } from "../design/primitives";
import { DS, cx } from "../design/tokens";
import type { BrowserLiveDeps, BrowserLiveLogin, BrowserLivePhase } from "./live-connection";
import {
  addressToUrl,
  chainScroll,
  fitDisplaySize,
  keyDownMessages,
  keyModifiers,
  keyUpMessages,
  namedKeyMessages,
  pointerToViewport,
  routeKey,
  textMessages,
  wheelDelta,
  type LiveKeyEvent,
  type LiveNamedKey,
  type LivePoint,
  type LiveSize,
} from "./live-input";
import { createMouseSender, createTouchMouse, type LiveMouseButton } from "./mouse-input";
import { useBrowserLive } from "./useBrowserLive";

const ZOOM_OPTIONS = [
  { value: "1", label: "Fit" },
  { value: "2", label: "2×" },
  { value: "3", label: "3×" },
] as const;
type ZoomValue = typeof ZOOM_OPTIONS[number]["value"];

const PHASE_LABEL: Record<BrowserLivePhase, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  ended: "Ended",
};

/** Keys the text row passes on while it is empty, so a keyboard's own Enter and Backspace work. */
const TEXT_ROW_KEYS: ReadonlySet<string> = new Set([
  "Enter", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
]);

const MOUSE_BUTTONS: Record<number, LiveMouseButton> = { 0: "left", 1: "middle", 2: "right" };

interface KeyboardEventLike {
  key: string;
  code: string;
  keyCode: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  nativeEvent?: { isComposing?: boolean };
  getModifierState?: (key: "AltGraph") => boolean;
}

function keepFocus(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

function liveKey(event: KeyboardEventLike): LiveKeyEvent {
  return {
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent?.isComposing === true,
    altGraph: event.getModifierState?.("AltGraph") === true,
  };
}

function loginTitle(login: BrowserLiveLogin): string {
  if (login.state === "saved") return "Login saved";
  if (login.state === "fill") return "A login is saved for this site";
  return login.replaces ? "Update the saved login?" : "Save this login for agents?";
}

function loginText(login: BrowserLiveLogin): string {
  const account = `${login.username ?? "This login"} on ${login.host ?? "this site"}`;
  if (login.state === "saved") return `Agents can now sign in as ${account} when it signs them out.`;
  if (login.state === "fill") {
    return login.failed ? "It could not be filled in. Sign in by hand; you can save what you type." : `${account}.`;
  }
  return login.failed ? "It could not be saved. Try again." : `${account}. Agents can then sign in again without asking you.`;
}

/**
 * The page an agent's browser is showing, live, and the controls to act in it. A mouse, a wheel and
 * a keyboard work on the page directly once it is clicked. On a touch screen one finger is the
 * mouse and two fingers scroll, and the text row below the page is where a phone keyboard types.
 */
export function LiveBrowserView({
  browserSessionId,
  requestTicket,
  deps,
  className,
}: {
  /** The browser session to show, or a name for the view when `requestTicket` finds the session. */
  browserSessionId: string;
  /** Gets permission to open the view of a browser that is not one chat's session. */
  requestTicket?: () => Promise<BrowserLiveTicket>;
  /** Replaces the network in tests. */
  deps?: Partial<BrowserLiveDeps>;
  className?: string;
}) {
  const { connection, state } = useBrowserLive(browserSessionId, requestTicket ? { ...deps, requestTicket } : deps);
  /** What is being typed into the address field. Null while it shows where the page is. */
  const [address, setAddress] = useState<string | null>(null);
  const [addressRefused, setAddressRefused] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState<ZoomValue>("1");
  const [stageSize, setStageSize] = useState<LiveSize | null>(null);
  const [keyboardOnPage, setKeyboardOnPage] = useState(false);
  const [text, setText] = useState("");
  const hintId = useId();
  const filePickerRef = useRef<HTMLInputElement>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRowRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef(state.viewport);
  viewportRef.current = state.viewport;
  const lastPointRef = useRef<LivePoint>({ x: 0, y: 0 });
  const heldMouseRef = useRef<{ button: LiveMouseButton; clickCount: number } | null>(null);
  const heldKeysRef = useRef(new Map<string, LiveKeyEvent>());
  const composingRef = useRef(false);

  const pagePoint = useCallback((clientX: number, clientY: number): LivePoint | null => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return null;
    const point = pointerToViewport(clientX, clientY, canvas.getBoundingClientRect(), viewport);
    if (point) lastPointRef.current = point;
    return point;
  }, []);

  const mouse = useMemo(() => createMouseSender((message) => { connection.send(message); }), [connection]);

  /**
   * Scrolls by a distance in screen pixels. A zoomed view pans first; what it cannot take scrolls
   * the remote page, scaled by `pagePerScreen` into the page's pixels.
   */
  const scrollBy = useCallback((deltaX: number, deltaY: number, at: LivePoint, pagePerScreen: number, modifiers?: number) => {
    const stage = stageRef.current;
    let restX = deltaX;
    let restY = deltaY;
    if (stage) {
      const x = chainScroll(stage.scrollLeft, stage.scrollWidth - stage.clientWidth, deltaX);
      const y = chainScroll(stage.scrollTop, stage.scrollHeight - stage.clientHeight, deltaY);
      stage.scrollLeft = x.position;
      stage.scrollTop = y.position;
      restX = x.rest;
      restY = y.rest;
    }
    mouse.wheel(at, restX * pagePerScreen, restY * pagePerScreen, modifiers);
  }, [mouse]);

  const touch = useMemo(() => createTouchMouse(mouse, (movedX, movedY, at) => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    const shownWidth = canvas?.getBoundingClientRect().width ?? 0;
    if (!viewport || !(shownWidth > 0)) return;
    // Content follows the fingers: dragging up scrolls down.
    scrollBy(-movedX, -movedY, at, viewport.width / shownWidth);
  }), [mouse, scrollBy]);

  useEffect(() => () => mouse.dispose(), [mouse]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      setStageSize((current) => (
        current && current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height }
      ));
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Frames are drawn through one reused image, one at a time, so nothing piles up or is left behind.
  useEffect(() => {
    if (typeof Image === "undefined") return;
    const image = new Image();
    let settle: (() => void) | null = null;
    connection.setFrameSink((data) => new Promise<void>((resolve) => {
      settle = resolve;
      image.onload = () => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext?.("2d");
        if (canvas && context) {
          if (canvas.width !== image.naturalWidth) canvas.width = image.naturalWidth;
          if (canvas.height !== image.naturalHeight) canvas.height = image.naturalHeight;
          context.drawImage(image, 0, 0);
        }
        resolve();
      };
      image.onerror = () => resolve();
      image.src = `data:image/jpeg;base64,${data}`;
    }));
    return () => {
      connection.setFrameSink(null);
      image.onload = null;
      image.onerror = null;
      image.src = "";
      settle?.();
    };
  }, [connection]);

  // React's wheel listener is passive, and the page behind must not scroll with the remote one.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Ctrl with the wheel is a pinch on a trackpad. Passing it on would change the remote page's zoom for good.
      if (event.ctrlKey) return;
      const viewport = viewportRef.current;
      const point = pagePoint(event.clientX, event.clientY);
      if (!viewport || !point) return;
      const delta = wheelDelta(event, viewport);
      scrollBy(delta.deltaX, delta.deltaY, point, 1, keyModifiers(event));
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, [pagePoint, scrollBy]);

  const releaseHeldKeys = useCallback(() => {
    for (const held of heldKeysRef.current.values()) {
      for (const message of keyUpMessages({ ...held, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })) {
        connection.send(message);
      }
    }
    heldKeysRef.current.clear();
  }, [connection]);

  const releaseHeldMouse = useCallback(() => {
    const held = heldMouseRef.current;
    if (!held) return;
    heldMouseRef.current = null;
    mouse.release(lastPointRef.current, held.button, held.clickCount);
  }, [mouse]);

  // A layout effect, so on unmount whatever is held is let go before the connection closes.
  useLayoutEffect(() => () => {
    touch.dispose();
    releaseHeldKeys();
    releaseHeldMouse();
  }, [touch, releaseHeldKeys, releaseHeldMouse]);

  const sendText = useCallback((value: string) => {
    for (const message of textMessages(value)) connection.send(message);
  }, [connection]);

  const pressNamedKey = useCallback((name: LiveNamedKey) => {
    for (const message of namedKeyMessages(name)) connection.send(message);
  }, [connection]);

  const pageCommand = useCallback((command: BrowserLivePageCommand) => {
    connection.send(command);
  }, [connection]);

  const viewport = state.viewport;
  const display = viewport && stageSize ? fitDisplaySize(stageSize, viewport, Number(zoom)) : null;
  const live = state.phase === "live";
  const shownTab = state.tabs.find((tab) => tab.active);

  return (
    <div className={cx("flex min-h-0 min-w-0 flex-col", className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 sm:px-4">
        <span role="status" aria-live="polite" className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-text-secondary">
          {state.phase === "live" && <StatusIcon kind="on" decorative />}
          {(state.phase === "connecting" || state.phase === "reconnecting") && <StatusIcon kind="working" decorative />}
          {state.phase === "ended" && <StatusIcon kind="closed" decorative />}
          {PHASE_LABEL[state.phase]}
        </span>
        <SegmentedControl
          ariaLabel="Page size"
          className="ml-auto sm:order-last sm:ml-0"
          size="sm"
          options={ZOOM_OPTIONS}
          value={zoom}
          onChange={setZoom}
        />
        {/* Pressing these must not take focus from the text row, or a phone hides its keyboard. */}
        <div className="flex min-w-0 basis-full items-center gap-1 sm:flex-1 sm:basis-0">
          <IconButton label="Back" size="md" disabled={!live} onMouseDown={keepFocus} onClick={() => pageCommand({ type: "history", direction: "back" })}>
            <ArrowLeft size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label="Forward" size="md" disabled={!live} onMouseDown={keepFocus} onClick={() => pageCommand({ type: "history", direction: "forward" })}>
            <ArrowRight size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label="Reload" size="md" disabled={!live} onMouseDown={keepFocus} onClick={() => pageCommand({ type: "reload" })}>
            <RotateCw size={14} aria-hidden="true" />
          </IconButton>
          <TextInput
            ref={addressRef}
            className={cx(DS.text.literal, "min-w-0 flex-1")}
            value={address ?? state.url ?? ""}
            placeholder="Web address"
            aria-label="Page address"
            aria-invalid={addressRefused || undefined}
            title={address === null ? state.url ?? undefined : undefined}
            disabled={!live}
            inputMode="url"
            enterKeyHint="go"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onFocus={(event) => {
              setAddress(state.url ?? "");
              event.currentTarget.select();
            }}
            onBlur={() => {
              setAddress(null);
              setAddressRefused(false);
            }}
            onChange={(event) => {
              setAddress(event.target.value);
              setAddressRefused(false);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") {
                // Like a browser's own field: the first Escape puts the page's address back.
                if (address === null || address === (state.url ?? "")) return;
                event.preventDefault();
                event.stopPropagation();
                setAddress(state.url ?? "");
                setAddressRefused(false);
                return;
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              const url = addressToUrl(address ?? "");
              if (!url) {
                setAddressRefused(true);
                return;
              }
              pageCommand({ type: "navigate", url });
              // On to the page: the keyboard is for it now, and a phone puts its own away.
              surfaceRef.current?.focus({ preventScroll: true });
            }}
          />
        </div>
      </div>
      {state.tabs.length > 1 && (
        <div className="flex min-w-0 shrink-0 items-center gap-1.5 px-3 pb-2 sm:px-4">
          <Select
            aria-label="Tab"
            inputSize="sm"
            className="min-w-0 flex-1"
            value={shownTab?.id ?? ""}
            disabled={!live}
            onChange={(event) => pageCommand({ type: "tab", action: "select", tabId: event.target.value })}
          >
            {state.tabs.map((tab, index) => (
              <option key={tab.id} value={tab.id}>{`${index + 1}. ${tab.title || tab.url || "New tab"}`}</option>
            ))}
          </Select>
          <Button size="sm" disabled={!live || !shownTab} onClick={() => shownTab && pageCommand({ type: "tab", action: "close", tabId: shownTab.id })}>
            Close tab
          </Button>
        </div>
      )}

      {state.fileChooser && (
        // The page's own file chooser is a window of the browser, which the view cannot show.
        <Notice
          tone={state.fileChooser.error ? "warning" : "info"}
          title={state.fileChooser.over
            ? "The file did not reach the page"
            : state.fileChooser.multiple ? "The page asks for files" : "The page asks for a file"}
          className="mx-3 mb-2 shrink-0 sm:mx-4"
          action={(
            <div className="flex items-center gap-1.5">
              {!state.fileChooser.over && (
                <Button size="sm" variant="primary" disabled={state.fileChooser.sending} onClick={() => filePickerRef.current?.click()}>
                  {state.fileChooser.sending ? "Sending…" : state.fileChooser.multiple ? "Choose files" : "Choose file"}
                </Button>
              )}
              <Button size="sm" disabled={state.fileChooser.sending} onClick={() => connection.dismissFileChooser()}>
                {state.fileChooser.over ? "Close" : "Cancel"}
              </Button>
            </div>
          )}
        >
          {state.fileChooser.error ?? "Pick from this device."}
          <input
            ref={filePickerRef}
            type="file"
            className="hidden"
            aria-label={state.fileChooser.multiple ? "Files for the page" : "File for the page"}
            multiple={state.fileChooser.multiple}
            accept={state.fileChooser.accept}
            onChange={(event) => {
              void connection.chooseFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </Notice>
      )}

      {state.login && (
        // What a password manager shows beside a sign-in form: keep what was typed, or use what is kept.
        <Notice
          tone={state.login.failed ? "warning" : state.login.state === "saved" ? "success" : "info"}
          title={loginTitle(state.login)}
          className="mx-3 mb-2 shrink-0 sm:mx-4"
          action={(
            <div className="flex items-center gap-1.5">
              {state.login.state === "save" && (
                <Button size="sm" variant="primary" disabled={state.login.working} onClick={() => connection.answerLogin("save")}>
                  {state.login.working ? "Saving…" : "Save"}
                </Button>
              )}
              {state.login.state === "fill" && (
                <Button size="sm" variant="primary" disabled={state.login.working} onClick={() => connection.answerLogin("fill")}>
                  {state.login.working ? "Signing in…" : "Sign in"}
                </Button>
              )}
              {state.login.state !== "fill" && (
                <Button size="sm" disabled={state.login.working} onClick={() => connection.answerLogin("dismiss")}>
                  {state.login.state === "saved" ? "OK" : "Not now"}
                </Button>
              )}
            </div>
          )}
        >
          {loginText(state.login)}
        </Notice>
      )}

      {state.phase === "ended" && (
        <Notice
          tone="warning"
          role="alert"
          title={state.viewport ? "The live view stopped" : "The browser could not be shown"}
          className="mx-3 mb-2 shrink-0 sm:mx-4"
          action={state.canRetry ? <Button size="sm" onClick={() => connection.retry()}>Try again</Button> : undefined}
        >
          {state.message}
        </Notice>
      )}

      <div
        ref={stageRef}
        className={cx("relative flex min-h-0 flex-1 overflow-auto overscroll-contain border-y bg-surface-inset", DS.surface.hairline)}
      >
        {!state.hasFrame && state.phase !== "ended" && (
          <EmptyHint className="absolute inset-0 flex items-center justify-center px-4 text-center">Waiting for the page…</EmptyHint>
        )}
        <div
          ref={surfaceRef}
          role="application"
          aria-label="Live browser page"
          aria-describedby={hintId}
          tabIndex={0}
          className={cx("relative mx-auto shrink-0 select-none", DS.focus, !display && "w-full")}
          style={{ touchAction: "none", WebkitTouchCallout: "none", ...(display ?? {}) }}
          onFocus={() => setKeyboardOnPage(true)}
          onBlur={() => {
            releaseHeldKeys();
            setKeyboardOnPage(false);
          }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            // Stops the press from selecting text, starting a scroll, or moving focus off the text row.
            event.preventDefault();
            const touchInput = event.pointerType === "touch";
            if (!touchInput) surfaceRef.current?.focus({ preventScroll: true });
            // A tap leaves the text row its focus, and with it the phone's keyboard. The address
            // field is done with once the page is touched.
            else if (document.activeElement === addressRef.current) addressRef.current?.blur();
            const point = pagePoint(event.clientX, event.clientY);
            if (!point) return;
            if (touchInput) {
              touch.down({ id: event.pointerId, clientX: event.clientX, clientY: event.clientY, page: point });
              return;
            }
            if (heldMouseRef.current) return;
            const button = MOUSE_BUTTONS[event.button] ?? "left";
            try {
              event.currentTarget.setPointerCapture?.(event.pointerId);
            } catch {
              // Without capture a drag still works while the pointer stays over the page.
            }
            heldMouseRef.current = { button, clickCount: mouse.press(point, button, keyModifiers(event)) };
          }}
          onPointerMove={(event) => {
            const point = pagePoint(event.clientX, event.clientY);
            if (!point) return;
            if (event.pointerType === "touch") {
              touch.move({ id: event.pointerId, clientX: event.clientX, clientY: event.clientY, page: point });
              return;
            }
            mouse.move(point, heldMouseRef.current?.button ?? "none", keyModifiers(event));
          }}
          onPointerUp={(event) => {
            const point = pagePoint(event.clientX, event.clientY) ?? lastPointRef.current;
            if (event.pointerType === "touch") {
              touch.up({ id: event.pointerId, clientX: event.clientX, clientY: event.clientY, page: point });
              return;
            }
            const held = heldMouseRef.current;
            if (!held || (MOUSE_BUTTONS[event.button] ?? "left") !== held.button) return;
            heldMouseRef.current = null;
            mouse.release(point, held.button, held.clickCount, keyModifiers(event));
          }}
          onPointerCancel={(event) => {
            if (event.pointerType === "touch") touch.cancel(event.pointerId);
            else releaseHeldMouse();
          }}
          onLostPointerCapture={(event) => {
            // After an ordinary release nothing is held and this does nothing.
            if (event.pointerType !== "touch") releaseHeldMouse();
          }}
          onKeyDown={(event) => {
            const key = liveKey(event);
            const route = routeKey(key);
            if (route === "ignore") return;
            // Keys pressed on the page never also act as Bridge shortcuts.
            event.stopPropagation();
            if (route === "local") {
              if (key.key !== "Escape") return;
              // Escape is the way out for a keyboard: the page takes Tab too. Focus moves on to the
              // text row, the next control, so the rest of the view is a Tab away.
              event.preventDefault();
              textRowRef.current?.focus();
              return;
            }
            event.preventDefault();
            for (const message of keyDownMessages(key)) {
              connection.send(message);
              if (message.eventType === "keyDown") heldKeysRef.current.set(key.code || key.key, key);
            }
          }}
          onKeyUp={(event) => {
            const key = liveKey(event);
            const id = key.code || key.key;
            if (!heldKeysRef.current.delete(id)) return;
            event.preventDefault();
            event.stopPropagation();
            for (const message of keyUpMessages(key)) connection.send(message);
          }}
          onPaste={(event) => {
            event.preventDefault();
            sendText(event.clipboardData.getData("text/plain"));
          }}
        >
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className={cx("block size-full", !state.hasFrame && "invisible", !live && "opacity-60")}
            style={viewport && !display ? { aspectRatio: `${viewport.width} / ${viewport.height}` } : undefined}
          />
          {keyboardOnPage && (
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 border-2 border-text-secondary" />
          )}
        </div>
      </div>

      <div className="shrink-0 space-y-1.5 px-3 py-2 sm:px-4">
        <p id={hintId} className={cx(DS.field.help, "hidden md:block")}>
          {keyboardOnPage
            ? "Keys you press go to the page. Press Esc to stop."
            : "Click the page to use your keyboard in it."}
        </p>
        <div className="flex min-w-0 items-center gap-1.5">
          <TextInput
            ref={textRowRef}
            className="min-w-0 flex-1"
            value={text}
            placeholder="Type here"
            aria-label="Text to type in the page"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="enter"
            onChange={(event) => {
              const value = event.target.value;
              // An input method is still putting the text together; it is sent when it is finished.
              if (composingRef.current) {
                setText(value);
                return;
              }
              sendText(value);
              setText("");
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              sendText(event.currentTarget.value);
              setText("");
            }}
            onKeyDown={(event) => {
              const key = liveKey(event);
              if (composingRef.current || text || !TEXT_ROW_KEYS.has(key.key) || routeKey(key) !== "forward") return;
              event.preventDefault();
              event.stopPropagation();
              for (const message of [...keyDownMessages(key), ...keyUpMessages(key)]) connection.send(message);
            }}
          />
          {/* Pressing a key button must not take focus from the text row, or a phone hides its keyboard. */}
          <IconButton label="Press Enter" variant="secondary" size="md" onMouseDown={keepFocus} onClick={() => pressNamedKey("Enter")}>
            <CornerDownLeft size={15} aria-hidden="true" />
          </IconButton>
          <IconButton label="Press Backspace" variant="secondary" size="md" onMouseDown={keepFocus} onClick={() => pressNamedKey("Backspace")}>
            <Delete size={15} aria-hidden="true" />
          </IconButton>
          <Button aria-label="Press Tab" onMouseDown={keepFocus} onClick={() => pressNamedKey("Tab")}>Tab</Button>
          <Button aria-label="Press Esc" onMouseDown={keepFocus} onClick={() => pressNamedKey("Escape")}>Esc</Button>
        </div>
      </div>
    </div>
  );
}
