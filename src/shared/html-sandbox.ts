/**
 * The sandbox every HTML document an agent writes runs in: published visuals, sent files and task
 * pages. It is the iframe's `sandbox` attribute and the `sandbox` directive of the CSP the server
 * sends with the document, so a page opened by itself in a tab is held the same way. Without
 * allow-same-origin the page has an opaque origin and can never act as the Bridge. allow-popups
 * lets a link open a new window, and allow-popups-to-escape-sandbox lets that window load its site
 * (a map, a booking page) normally.
 */
export const HTML_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";
