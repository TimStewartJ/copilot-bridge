import { vi } from "vitest";

export async function runAndCountEventLoopYields<T>(
  operation: () => Promise<T>,
): Promise<{ result: T; yieldCount: number }> {
  const immediateSpy = vi.spyOn(globalThis, "setImmediate");
  try {
    const result = await operation();
    return { result, yieldCount: immediateSpy.mock.calls.length };
  } finally {
    immediateSpy.mockRestore();
  }
}
