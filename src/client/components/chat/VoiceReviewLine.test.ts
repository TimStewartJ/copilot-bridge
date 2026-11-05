import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../../test-react-harness";
import { VoiceReviewLine } from "./VoiceReviewLine";

class FakeAudio {
  static made: FakeAudio[] = [];
  currentTime = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(async () => undefined);
  constructor(readonly src: string) {
    FakeAudio.made.push(this);
  }
}

describe("VoiceReviewLine", () => {
  let harness: ReactDomHarness | undefined;

  beforeEach(() => {
    FakeAudio.made = [];
    vi.stubGlobal("Audio", FakeAudio);
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
    vi.unstubAllGlobals();
  });

  const clickPlay = async () => {
    const button = findAllByTag(harness!.dom.container, "BUTTON")[0];
    await harness!.act(async () => { getReactProps(button)?.onClick?.(); });
  };

  it("plays each chat's own recording and stops the last one when the chat changes", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(VoiceReviewLine, { review: { reason: "coverage", recordingJobId: "job-a", gapStartSeconds: 7 } }));
    await clickPlay();
    const first = FakeAudio.made[0]!;
    expect(first.src).toContain("job-a");
    expect(first.currentTime).toBe(6);

    await harness.render(createElement(VoiceReviewLine, { review: { reason: "unchecked", recordingJobId: "job-b" } }));
    expect(first.pause).toHaveBeenCalled();
    expect(findAllByTag(harness.dom.container, "BUTTON")[0]?.textContent).toBe("Play recording");

    await clickPlay();
    expect(FakeAudio.made[1]?.src).toContain("job-b");
    expect(FakeAudio.made[1]?.currentTime).toBe(0);
  });

  it("offers no playback when the transcript has no recording on the server", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(VoiceReviewLine, { review: { reason: "coverage", gapStartSeconds: 3 } }));
    expect(findAllByTag(harness.dom.container, "BUTTON")).toHaveLength(0);
  });
});
