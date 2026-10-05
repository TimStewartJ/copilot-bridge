import { API_BASE } from "../api";
import {
  BROWSER_LIVE_MODIFIERS,
  BROWSER_LIVE_WS_PATH,
  type BrowserLiveKeyboardMessage,
  type BrowserLiveTicket,
} from "../../shared/browser-live.js";

/**
 * Pure rules of the live browser view: where a pointer is on the remote page, what a key press
 * becomes, how far a wheel turn scrolls. The view and the connection hold the state.
 */

/** The remote page's size in CSS pixels, as the server reports it. */
export interface LiveViewport {
  width: number;
  height: number;
}

export interface LivePoint {
  x: number;
  y: number;
}

export interface LiveSize {
  width: number;
  height: number;
}

/** Where the page image is drawn on screen, as getBoundingClientRect reports it. */
export interface DisplayedImageBox extends LiveSize {
  left: number;
  top: number;
}

export function buildBrowserLiveWebSocketUrl(
  ticket: Pick<BrowserLiveTicket, "browserSessionId" | "token">,
  location: Pick<Location, "protocol" | "host"> = window.location,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ browserSessionId: ticket.browserSessionId, token: ticket.token });
  return `${protocol}//${location.host}${API_BASE}${BROWSER_LIVE_WS_PATH}?${params.toString()}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * A screen position as a position on the remote page. The image is drawn at another size than the
 * page, so the position inside the image is scaled to the page's CSS pixels. Null while the image
 * has no size on screen.
 */
export function pointerToViewport(
  clientX: number,
  clientY: number,
  box: DisplayedImageBox,
  viewport: LiveViewport,
): LivePoint | null {
  if (!(box.width > 0) || !(box.height > 0) || !(viewport.width > 0) || !(viewport.height > 0)) return null;
  const x = ((clientX - box.left) / box.width) * viewport.width;
  const y = ((clientY - box.top) / box.height) * viewport.height;
  return {
    x: clamp(Math.round(x), 0, Math.max(0, Math.round(viewport.width) - 1)),
    y: clamp(Math.round(y), 0, Math.max(0, Math.round(viewport.height) - 1)),
  };
}

/**
 * The size to draw the page at. At zoom 1 the whole page fits the stage and is never drawn larger
 * than it really is; a higher zoom multiplies that size and the stage scrolls. Null until both
 * sizes are known.
 */
export function fitDisplaySize(stage: LiveSize, viewport: LiveViewport, zoom: number): LiveSize | null {
  if (!(stage.width > 0) || !(stage.height > 0) || !(viewport.width > 0) || !(viewport.height > 0)) return null;
  const fit = Math.min(stage.width / viewport.width, stage.height / viewport.height, 1);
  const scale = fit * Math.max(1, zoom);
  return {
    width: Math.max(1, Math.floor(viewport.width * scale)),
    height: Math.max(1, Math.floor(viewport.height * scale)),
  };
}

/**
 * Scrolls a local scroller by `delta` and says how much it could not take, so a gesture pans the
 * zoomed view first and scrolls the remote page with what is left.
 */
export function chainScroll(position: number, max: number, delta: number): { position: number; rest: number } {
  const next = clamp(position + delta, 0, Math.max(0, max));
  return { position: next, rest: delta - (next - position) };
}

const WHEEL_LINE_PX = 40;
const WHEEL_MAX_PX = 2000;

export interface LiveWheelEvent {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages, as on a DOM WheelEvent. */
  deltaMode: number;
}

/** A wheel turn in CSS pixels, whatever unit the device reports it in. */
export function wheelDelta(event: LiveWheelEvent, page: LiveSize): { deltaX: number; deltaY: number } {
  const unitX = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? page.width : 1;
  const unitY = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? page.height : 1;
  return {
    deltaX: clamp(Math.round(event.deltaX * unitX), -WHEEL_MAX_PX, WHEEL_MAX_PX),
    deltaY: clamp(Math.round(event.deltaY * unitY), -WHEEL_MAX_PX, WHEEL_MAX_PX),
  };
}

/** The parts of a DOM KeyboardEvent the live view reads. */
export interface LiveKeyEvent {
  key: string;
  code: string;
  keyCode: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  /** `getModifierState("AltGraph")`: the key that picks a third character on many layouts. */
  altGraph?: boolean;
}

export function keyModifiers(event: Pick<LiveKeyEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): number {
  return (event.altKey ? BROWSER_LIVE_MODIFIERS.alt : 0)
    | (event.ctrlKey ? BROWSER_LIVE_MODIFIERS.ctrl : 0)
    | (event.metaKey ? BROWSER_LIVE_MODIFIERS.meta : 0)
    | (event.shiftKey ? BROWSER_LIVE_MODIFIERS.shift : 0);
}

/**
 * What happens to a key pressed on the live view:
 * - `forward`: it goes to the remote page and must not also act on the Bridge page.
 * - `local`: the Bridge page keeps it. Escape hands the keyboard back, and the paste shortcut
 *   lets the browser raise a paste event, whose text is then sent (the remote clipboard is not
 *   this device's clipboard).
 * - `ignore`: an input method is composing, so there is no key to send.
 */
export type LiveKeyRoute = "forward" | "local" | "ignore";

function isPrintable(key: string): boolean {
  return [...key].length === 1;
}

function isComposingKey(event: LiveKeyEvent): boolean {
  return event.isComposing === true
    || event.keyCode === 229
    || event.key === "Process"
    || event.key === "Dead"
    || event.key === "Unidentified";
}

export function routeKey(event: LiveKeyEvent): LiveKeyRoute {
  if (isComposingKey(event)) return "ignore";
  if (event.key === "Escape") return "local";
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "v") return "local";
  if (!event.keyCode && !typedText(event)) return "ignore";
  return "forward";
}

/**
 * The character a key press types, if it types one. A shortcut (Ctrl, Meta or Alt held) types
 * nothing, with two exceptions where the held keys only select the character: AltGr, which Windows
 * reports as Ctrl+Alt, and Option on a Mac, which shows as Alt with a character outside ASCII.
 */
function typedText(event: LiveKeyEvent): { text: string; modifiers: number } | null {
  if (event.key === "Enter") return { text: "\r", modifiers: keyModifiers(event) };
  if (!isPrintable(event.key)) return null;
  const shift = event.shiftKey ? BROWSER_LIVE_MODIFIERS.shift : 0;
  if (event.altGraph) return { text: event.key, modifiers: shift };
  if (event.ctrlKey || event.metaKey) return null;
  if (event.altKey) return event.key.charCodeAt(0) > 127 ? { text: event.key, modifiers: shift } : null;
  return { text: event.key, modifiers: shift };
}

function withModifiers(message: BrowserLiveKeyboardMessage, modifiers: number): BrowserLiveKeyboardMessage {
  return modifiers ? { ...message, modifiers } : message;
}

/**
 * The messages for a key going down. A key the remote browser can identify is a `keyDown` with its
 * key code, carrying the character when it types one. A character that arrives without a key code
 * (some on-screen keyboards) can only be sent as text, so it is a `char`.
 */
export function keyDownMessages(event: LiveKeyEvent): BrowserLiveKeyboardMessage[] {
  if (routeKey(event) !== "forward") return [];
  const typed = typedText(event);
  if (!event.keyCode) {
    return typed ? [{ type: "input_keyboard", eventType: "char", text: typed.text }] : [];
  }
  return [withModifiers({
    type: "input_keyboard",
    eventType: "keyDown",
    key: event.key,
    code: event.code,
    windowsVirtualKeyCode: event.keyCode,
    ...(typed ? { text: typed.text } : {}),
  }, typed ? typed.modifiers : keyModifiers(event))];
}

/** The message for a key coming up. Only keys sent as a `keyDown` have one. */
export function keyUpMessages(event: LiveKeyEvent): BrowserLiveKeyboardMessage[] {
  if (routeKey(event) !== "forward" || !event.keyCode) return [];
  return [withModifiers({
    type: "input_keyboard",
    eventType: "keyUp",
    key: event.key,
    code: event.code,
    windowsVirtualKeyCode: event.keyCode,
  }, keyModifiers(event))];
}

/** Text with no key behind it: typed in the text row, pasted, or composed by an input method. */
export function textMessages(text: string): BrowserLiveKeyboardMessage[] {
  return text ? [{ type: "input_keyboard", eventType: "char", text }] : [];
}

/** The keys offered as buttons, for keyboards that cannot press them. */
const LIVE_NAMED_KEYS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
} as const;

export type LiveNamedKey = keyof typeof LIVE_NAMED_KEYS;

/** One full press of a named key: down, then up. */
export function namedKeyMessages(name: LiveNamedKey): BrowserLiveKeyboardMessage[] {
  const { key, code, keyCode } = LIVE_NAMED_KEYS[name];
  const base = { type: "input_keyboard" as const, key, code, windowsVirtualKeyCode: keyCode };
  return [
    { ...base, eventType: "keyDown", ...(name === "Enter" ? { text: "\r" } : {}) },
    { ...base, eventType: "keyUp" },
  ];
}
