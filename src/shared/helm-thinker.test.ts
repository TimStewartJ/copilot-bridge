import { describe, expect, it } from "vitest";
import { isRebuildSlot, nextScheduledRun, previousScheduledRun, validateHelmThinkerSettingsPatch } from "./helm-thinker.js";

describe("Helm thinker settings", () => {
  it("accepts a valid patch and normalizes times and peers", () => {
    const patch = validateHelmThinkerSettingsPatch({
      times: ["18:00", "08:00", "08:00"],
      autonomy: "propose",
      peers: [{ id: "PC", label: "timmiepc", apiUrl: "http://100.127.79.59:3333/", webUrl: "https://timmiepc.example.ts.net" }],
    });
    expect(patch.times).toEqual(["08:00", "18:00"]);
    expect(patch.autonomy).toBe("propose");
    expect(patch.peers).toEqual([{ id: "pc", label: "timmiepc", apiUrl: "http://100.127.79.59:3333", webUrl: "https://timmiepc.example.ts.net" }]);
  });

  it("refuses unknown fields, bad times, credentials in URLs and a peer named local", () => {
    expect(() => validateHelmThinkerSettingsPatch({ nope: 1 })).toThrow(/Unknown setting/);
    expect(() => validateHelmThinkerSettingsPatch({ times: ["8am"] })).toThrow(/08:00/);
    expect(() => validateHelmThinkerSettingsPatch({ peers: [{ id: "pc", apiUrl: "http://user:pass@host:3333" }] })).toThrow(/credentials/);
    expect(() => validateHelmThinkerSettingsPatch({ peers: [{ id: "pc", apiUrl: "file:///etc/passwd" }] })).toThrow(/http/);
    expect(() => validateHelmThinkerSettingsPatch({ peers: [{ id: "local", apiUrl: "http://host" }] })).toThrow(/used twice/);
  });

  it("finds the next and previous scheduled slots in local time", () => {
    const at = new Date(2026, 9, 25, 12, 30);
    expect(nextScheduledRun(["08:00", "18:00"], at)).toEqual(new Date(2026, 9, 25, 18, 0));
    expect(nextScheduledRun(["08:00", "18:00"], new Date(2026, 9, 25, 19, 0))).toEqual(new Date(2026, 9, 26, 8, 0));
    expect(previousScheduledRun(["08:00", "18:00"], at)).toEqual(new Date(2026, 9, 25, 8, 0));
    expect(previousScheduledRun(["08:00"], new Date(2026, 9, 25, 7, 0))).toEqual(new Date(2026, 9, 24, 8, 0));
    expect(nextScheduledRun([], at)).toBeNull();
  });

  it("re-reads everything on the last slot of the rebuild weekday only", () => {
    const sunday = new Date(2026, 9, 25, 18, 0);
    expect(sunday.getDay()).toBe(0);
    expect(isRebuildSlot(["08:00", "18:00"], sunday, 0)).toBe(true);
    expect(isRebuildSlot(["08:00", "18:00"], new Date(2026, 9, 25, 8, 0), 0)).toBe(false);
    expect(isRebuildSlot(["08:00", "18:00"], new Date(2026, 9, 26, 18, 0), 0)).toBe(false);
    expect(isRebuildSlot(["08:00", "18:00"], sunday, -1)).toBe(false);
  });
});
