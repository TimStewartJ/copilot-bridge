import { describe, expect, it } from "vitest";
import { formatSearchExcerpt } from "./search-text";

describe("saved document and note excerpts", () => {
  it("reuses Markdown text normalization without showing formatting noise", () => {
    expect(formatSearchExcerpt("## Release\r\n\r\n**Ready** _today_ with [the guide](https://example.com).")).toBe("Release Ready today with the guide.");
    expect(formatSearchExcerpt("- [x] Reviewed\r\n> Confirmed")).toBe("Reviewed Confirmed");
  });

  it("preserves code identifiers and inline code text", () => {
    expect(formatSearchExcerpt("Use `snake_case*value` and snake_case_name.")).toBe("Use snake_case*value and snake_case_name.");
  });

  it("keeps a literal excerpt when cleaning would remove the user's actual match", () => {
    const link = "Read [the guide](https://example.com/release)";
    expect(formatSearchExcerpt(link, "example.com/release")).toBe(link);
    expect(formatSearchExcerpt(link, "guide")).toBe("Read the guide");
    const html = "Example <img src=x> syntax";
    expect(formatSearchExcerpt(html, "<img")).toBe(html);
  });

  it("does not render HTML and preserves a literal-only match instead of returning nothing", () => {
    expect(formatSearchExcerpt("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
    expect(formatSearchExcerpt("")).toBe("");
  });
});
