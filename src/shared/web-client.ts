/**
 * The web client sends this header when the user starts a chat. A chat started over the REST API without it
 * (or the browser's own Fetch Metadata) is a scratch chat: see src/server/scratch-sessions.ts.
 */
export const WEB_CLIENT_HEADER = "X-Bridge-Client";
export const WEB_CLIENT_HEADER_VALUE = "web";
