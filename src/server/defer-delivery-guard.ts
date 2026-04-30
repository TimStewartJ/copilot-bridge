export interface DeferDeliveryGuard {
  isActive(sessionId: string): boolean;
  tryClaim(sessionId: string): boolean;
  release(sessionId: string): void;
  clear(): void;
}

export function createDeferDeliveryGuard(): DeferDeliveryGuard {
  const activeSessions = new Set<string>();
  return {
    isActive: (sessionId) => activeSessions.has(sessionId),
    tryClaim: (sessionId) => {
      if (activeSessions.has(sessionId)) return false;
      activeSessions.add(sessionId);
      return true;
    },
    release: (sessionId) => {
      activeSessions.delete(sessionId);
    },
    clear: () => {
      activeSessions.clear();
    },
  };
}
