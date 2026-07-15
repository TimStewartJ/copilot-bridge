import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  createReactDomHarness,
  type ReactDomHarness,
} from "../test-react-harness";
import ElicitationCancellationNotice from "./ElicitationCancellationNotice";

describe("ElicitationCancellationNotice", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("keeps the closed question and recovery guidance visible", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(ElicitationCancellationNotice, {
      notice: {
        requestId: "el-closed",
        question: "Choose a deployment target",
        detail: "The run ended before this question was answered.",
      },
    }));

    expect(harness.dom.container.textContent).toContain("Question no longer active");
    expect(harness.dom.container.textContent).toContain("Choose a deployment target");
    expect(harness.dom.container.textContent).toContain("Send another message");
  });
});
