/**
 * Live view of a Bridge browser session: the user watches the page an agent is working on and
 * can act in it (solve a check, sign in). The server relays between the client and the stream
 * that agent-browser serves for the session.
 */

/** The WebSocket path of the live view, under the API base. */
export const BROWSER_LIVE_WS_PATH = "/api/browser/live/ws";
/** Where a view posts the files for a file chooser, as multipart `files`, with `?chooser=<id>`. */
export const BROWSER_LIVE_FILES_PATH = "/api/browser/live/files";
/** What one file chooser takes at most. */
export const BROWSER_LIVE_FILE_LIMITS = { files: 20, bytes: 100 * 1024 * 1024 } as const;

/**
 * Whether the installed agent-browser can show a browser and pass input to it, as last seen: by
 * a check, or by a live view that worked or could not start. Absent until one of those happened.
 */
export interface BrowserLiveCheck {
  ok: boolean;
  checkedAt: string;
  /** Why it does not work, in words for the user. */
  message?: string;
}

/** Permission to open one browser session's live view for a short time. */
export interface BrowserLiveTicket {
  browserSessionId: string;
  token: string;
  expiresAt: string;
}

/**
 * Present on a pending form when it is an agent's request for the user to act in a browser
 * session. The form itself has one choice field whose values are BROWSER_HANDOFF_ANSWERS, so a
 * client that does not know about handoffs still shows something answerable.
 */
export interface BrowserHandoffView {
  browserSessionId: string;
  /** What the agent needs the user to do, in the agent's words. */
  reason: string;
}

export const BROWSER_HANDOFF_ANSWERS = {
  done: "done",
  notDone: "not_done",
} as const;

export type BrowserHandoffAnswer = typeof BROWSER_HANDOFF_ANSWERS[keyof typeof BROWSER_HANDOFF_ANSWERS];

/** Modifier bits of an input event, as the Chrome DevTools Protocol defines them. */
export const BROWSER_LIVE_MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

export interface BrowserLiveFrameMessage {
  type: "frame";
  /** Echoed in an `ack`; the next frame is sent only after the previous one is acknowledged. */
  seq: number;
  /** Base64 JPEG. Its pixel size is not the viewport's size; see BrowserLiveViewportMessage. */
  data: string;
}

/**
 * The page's real size in CSS pixels. Pointer positions are sent in these units: the position
 * inside the displayed image, scaled from the image's displayed size to this size.
 */
export interface BrowserLiveViewportMessage {
  type: "viewport";
  width: number;
  height: number;
}

export interface BrowserLiveUrlMessage {
  type: "url";
  url: string;
}

/** The live view is over. The socket closes after this message. */
export interface BrowserLiveClosedMessage {
  type: "closed";
  reason: "session_ended" | "stream_ended" | "unavailable";
  message: string;
}

export interface BrowserLiveTab {
  /** Names the tab in a `tab` message. */
  id: string;
  title: string;
  url: string;
  /** The tab the view shows and input goes to. */
  active: boolean;
}

/** The browser's open tabs, sent when they change. A popup window is a tab too. */
export interface BrowserLiveTabsMessage {
  type: "tabs";
  tabs: BrowserLiveTab[];
}

/**
 * The page opened its file chooser. A browser draws that outside the page, so the view asks the
 * person for the files on their own device and posts them to BROWSER_LIVE_FILES_PATH. A chooser
 * is answered once; a later one replaces it, and it ends with the view's connection.
 */
export interface BrowserLiveFileChooserMessage {
  type: "file_chooser";
  /** Names the chooser when the files are posted. */
  id: string;
  /** Whether the page takes more than one file. */
  multiple: boolean;
  /** The kinds of file the page asks for, as the `accept` of a file input. */
  accept?: string;
}

/**
 * What the view offers to do with a sign-in, as a password manager would:
 * - save: the person typed one into the page and can keep it for agents. `replaces` when one is
 *   kept for the site already.
 * - saved: it was kept.
 * - fill: the page shows a sign-in form whose login is kept, and the view can sign in with it.
 * - none: nothing to offer.
 * `failed` says that what the person last asked for did not work. A password is never part of it.
 */
export interface BrowserLiveLoginMessage {
  type: "login";
  state: "none" | "save" | "saved" | "fill";
  host?: string;
  username?: string;
  replaces?: boolean;
  failed?: boolean;
}

export type BrowserLiveServerMessage =
  | BrowserLiveFrameMessage
  | BrowserLiveViewportMessage
  | BrowserLiveUrlMessage
  | BrowserLiveTabsMessage
  | BrowserLiveFileChooserMessage
  | BrowserLiveLoginMessage
  | BrowserLiveClosedMessage;

export interface BrowserLiveAckMessage {
  type: "ack";
  seq: number;
}

export interface BrowserLiveMouseMessage {
  type: "input_mouse";
  eventType: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
  x: number;
  y: number;
  button?: "none" | "left" | "middle" | "right";
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}

/**
 * A key press is a `keyDown` and a `keyUp` carrying `key`, `code` and `windowsVirtualKeyCode`
 * (the DOM event's `keyCode`); without the key code, keys such as Backspace and the arrows do
 * nothing. Text is a `char` event with `text`, which may hold several characters; the server
 * hands them to the browser one at a time, as the browser requires.
 */
export interface BrowserLiveKeyboardMessage {
  type: "input_keyboard";
  eventType: "keyDown" | "keyUp" | "char";
  key?: string;
  code?: string;
  text?: string;
  windowsVirtualKeyCode?: number;
  modifiers?: number;
}

/** Opens an address in the tab the view shows. Web pages only. */
export interface BrowserLiveNavigateMessage {
  type: "navigate";
  url: string;
}

export interface BrowserLiveHistoryMessage {
  type: "history";
  direction: "back" | "forward";
}

export interface BrowserLiveReloadMessage {
  type: "reload";
}

/** Shows another tab, or closes one. The last tab cannot be closed. */
export interface BrowserLiveTabMessage {
  type: "tab";
  action: "select" | "close";
  tabId: string;
}

/** What a viewer does to the browser around the page, as its own toolbar would. */
export type BrowserLivePageCommand =
  | BrowserLiveNavigateMessage
  | BrowserLiveHistoryMessage
  | BrowserLiveReloadMessage
  | BrowserLiveTabMessage;

/** A sign-in the user saved for agents, as Settings lists it. */
export interface BrowserSavedLogin {
  id: string;
  host: string;
  username: string;
  savedAt: string;
  /** The site did not accept it when an agent last used it. */
  failed?: boolean;
}

/** The person's answer to what a BrowserLiveLoginMessage offers. */
export interface BrowserLiveLoginActionMessage {
  type: "login";
  action: "save" | "fill" | "dismiss";
}

export type BrowserLiveClientMessage =
  | BrowserLiveAckMessage
  | BrowserLiveMouseMessage
  | BrowserLiveKeyboardMessage
  | BrowserLivePageCommand
  | BrowserLiveLoginActionMessage;

export function isBrowserLivePageCommand(message: BrowserLiveClientMessage): message is BrowserLivePageCommand {
  return message.type === "navigate" || message.type === "history" || message.type === "reload" || message.type === "tab";
}

const MOUSE_EVENTS: ReadonlySet<string> = new Set<BrowserLiveMouseMessage["eventType"]>([
  "mouseMoved", "mousePressed", "mouseReleased", "mouseWheel",
]);
const MOUSE_BUTTONS: ReadonlySet<string> = new Set<NonNullable<BrowserLiveMouseMessage["button"]>>([
  "none", "left", "middle", "right",
]);
const KEYBOARD_EVENTS: ReadonlySet<string> = new Set<BrowserLiveKeyboardMessage["eventType"]>([
  "keyDown", "keyUp", "char",
]);
const MAX_KEY_NAME_LENGTH = 32;
const MAX_URL_LENGTH = 2048;
/** How agent-browser names a tab: t1, t2, … */
const TAB_ID = /^t\d{1,6}$/;

/**
 * The address as the browser will open it, when it is one of a web page. Everything else a
 * browser can open (files of the host, its own settings pages, scripts) is refused.
 */
export function normalizeBrowserLiveUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
const ALL_MODIFIERS = BROWSER_LIVE_MODIFIERS.alt | BROWSER_LIVE_MODIFIERS.ctrl
  | BROWSER_LIVE_MODIFIERS.meta | BROWSER_LIVE_MODIFIERS.shift;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function integerUpTo(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined;
}

function shortString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_KEY_NAME_LENGTH ? value : undefined;
}

/**
 * The live-view message in what a client sent, rebuilt from the fields the protocol defines and
 * nothing else. Undefined for anything that is not a well-formed message; what a client sends
 * goes on to the browser's input, so nothing is passed through as it came.
 */
export function parseBrowserLiveClientMessage(value: unknown): BrowserLiveClientMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const input = value as Record<string, unknown>;
  const modifiers = integerUpTo(input.modifiers, ALL_MODIFIERS);
  const eventType = typeof input.eventType === "string" ? input.eventType : "";
  switch (input.type) {
    case "ack":
      return finite(input.seq) ? { type: "ack", seq: input.seq } : undefined;
    case "input_mouse": {
      if (!MOUSE_EVENTS.has(eventType) || !finite(input.x) || !finite(input.y)) return undefined;
      const clickCount = integerUpTo(input.clickCount, 3);
      return {
        type: "input_mouse",
        eventType: eventType as BrowserLiveMouseMessage["eventType"],
        x: input.x,
        y: input.y,
        ...(typeof input.button === "string" && MOUSE_BUTTONS.has(input.button)
          ? { button: input.button as BrowserLiveMouseMessage["button"] }
          : {}),
        ...(clickCount !== undefined ? { clickCount } : {}),
        ...(finite(input.deltaX) ? { deltaX: input.deltaX } : {}),
        ...(finite(input.deltaY) ? { deltaY: input.deltaY } : {}),
        ...(modifiers !== undefined ? { modifiers } : {}),
      };
    }
    case "input_keyboard": {
      if (!KEYBOARD_EVENTS.has(eventType)) return undefined;
      const key = shortString(input.key);
      const code = shortString(input.code);
      const keyCode = integerUpTo(input.windowsVirtualKeyCode, 255);
      // Only a `char` event may carry more than one character; see BrowserLiveKeyboardMessage.
      const text = typeof input.text === "string" && (eventType === "char" || [...input.text].length <= 1)
        ? input.text
        : undefined;
      return {
        type: "input_keyboard",
        eventType: eventType as BrowserLiveKeyboardMessage["eventType"],
        ...(key !== undefined ? { key } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(keyCode !== undefined ? { windowsVirtualKeyCode: keyCode } : {}),
        ...(modifiers !== undefined ? { modifiers } : {}),
      };
    }
    case "navigate": {
      const url = normalizeBrowserLiveUrl(input.url);
      return url ? { type: "navigate", url } : undefined;
    }
    case "history":
      return input.direction === "back" || input.direction === "forward"
        ? { type: "history", direction: input.direction }
        : undefined;
    case "reload":
      return { type: "reload" };
    case "tab":
      return (input.action === "select" || input.action === "close") && typeof input.tabId === "string" && TAB_ID.test(input.tabId)
        ? { type: "tab", action: input.action, tabId: input.tabId }
        : undefined;
    case "login":
      return input.action === "save" || input.action === "fill" || input.action === "dismiss"
        ? { type: "login", action: input.action }
        : undefined;
    default:
      return undefined;
  }
}
