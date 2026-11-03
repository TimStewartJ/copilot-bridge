import { createElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolCall } from "../api";
import { COMPONENT_IMPORT_WARMUP_TIMEOUT_MS, createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";

let VerificationCard: typeof import("./VerificationCard").default;

beforeAll(async () => {
  const harness = await createReactDomHarness();
  try {
    ({ default: VerificationCard } = await import("./VerificationCard"));
  } finally {
    await harness.cleanup();
  }
}, COMPONENT_IMPORT_WARMUP_TIMEOUT_MS);

describe("VerificationCard", () => {
  it("shows the status, links web references, keeps other references literal and lists what was not checked", async () => {
    const harness = await createReactDomHarness();
    const toolCall: ToolCall = {
      toolCallId: "call-1",
      name: "verify_complete",
      success: true,
      // A result the card cannot read still shows, with the status worked out from the evidence.
      result: "Recorded.",
      args: {
        summary: "Saving works again",
        evidence: [
          { kind: "fixed", claim: "save succeeds", ref: "https://ci.example.test/run/7", result: "pass" },
          { kind: "live", claim: "checked in the app", ref: "npm run dev", result: "not_run" },
        ],
        unverified: ["the mobile layout"],
        notes: ["not pushed"],
      },
    };

    try {
      await harness.render(createElement(VerificationCard, { toolCall }));
      const container = harness.dom.container;
      const [section] = findAllByTag(container, "section");
      const [link] = findAllByTag(container, "a");
      const [literal] = findAllByTag(container, "button");

      expect(getReactProps(section)?.["data-verification-status"]).toBe("partial");
      expect(container.textContent).toContain("Partly verified");
      expect(getReactProps(link)?.href).toBe("https://ci.example.test/run/7");
      expect(literal?.textContent).toBe("npm run dev");
      expect(container.textContent).toContain("Not checked");
      expect(container.textContent).toContain("Notesnot pushed");
      expect(container.textContent).toContain("the mobile layout");
    } finally {
      await harness.cleanup();
    }
  });
});
