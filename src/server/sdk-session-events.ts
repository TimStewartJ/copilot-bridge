export interface SdkSessionEventSource {
  getEvents?: () => Promise<unknown>;
}

export async function readSdkSessionEvents(session: SdkSessionEventSource): Promise<unknown[]> {
  if (typeof session.getEvents !== "function") {
    throw new Error("Copilot SDK session event API is not available");
  }

  const events = await session.getEvents.call(session);
  if (!Array.isArray(events)) {
    throw new Error("Copilot SDK session event API returned a non-array result");
  }
  return events;
}
