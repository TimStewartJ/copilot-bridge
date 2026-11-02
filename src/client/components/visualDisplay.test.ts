import { describe, expect, it } from "vitest";
import { withAppBase } from "./visualDisplay";

describe("withAppBase", () => {
  const visual = (url: string) => ({ url, downloadUrl: `${url}?download` });

  it.each([
    { label: "an API-root URL under a preview prefix", base: "/staging/p1", url: "/api/sessions/s/images/a.png", expected: "/staging/p1/api/sessions/s/images/a.png" },
    { label: "an API-root URL at the site root", base: "", url: "/api/sessions/s/images/a.png", expected: "/api/sessions/s/images/a.png" },
    { label: "a published visual that already carries the prefix", base: "/staging/p1", url: "/staging/p1/api/sessions/s/visuals/v", expected: "/staging/p1/api/sessions/s/visuals/v" },
  ])("resolves $label", ({ base, url, expected }) => {
    expect(withAppBase(visual(url), base)).toEqual(visual(expected));
  });
});
