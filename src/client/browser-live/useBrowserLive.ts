import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { BrowserLiveConnection, type BrowserLiveDeps, type BrowserLiveSnapshot } from "./live-connection";

/**
 * Keeps a live connection to one browser session for as long as the component is mounted. The
 * connection is opened on mount, reopened if the session id changes, and closed on unmount.
 * `deps` is read once per connection; tests use it to replace the network.
 */
export function useBrowserLive(
  browserSessionId: string,
  deps?: Partial<BrowserLiveDeps>,
): { connection: BrowserLiveConnection; state: BrowserLiveSnapshot } {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const [connection, setConnection] = useState(() => new BrowserLiveConnection(browserSessionId, deps));
  if (connection.browserSessionId !== browserSessionId) {
    setConnection(new BrowserLiveConnection(browserSessionId, depsRef.current));
  }

  useEffect(() => {
    connection.start();
    return () => connection.stop();
  }, [connection]);

  const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
  return { connection, state };
}
