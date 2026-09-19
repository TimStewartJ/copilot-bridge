import { describe, expect, it } from "vitest";
import type { DbEntry, DbSchema, DocTreeNode } from "../../api";
import {
  ancestorFolderPaths,
  buildBreadcrumbs,
  buildTreeIndex,
  canonicalDocPath,
  compactTreeLabel,
  defaultNewPageFolder,
  docsRoute,
  entryFieldsPayload,
  entryFormValues,
  estimateReadingMinutes,
  extractHeadings,
  extractWikilinkTargets,
  filterDbEntries,
  findHeadingByAnchor,
  findNeighbours,
  flattenVisibleTree,
  formatDocDate,
  formatRelativeTime,
  isExternalHref,
  joinDocPath,
  leadingTitle,
  listPageFolders,
  matchPagesByTitle,
  mergePageFrontmatter,
  nextDbSort,
  normalizeTag,
  owningCollection,
  pageDraftFromFrontmatter,
  parseSnippet,
  recentPages,
  resolveRelativeDocPath,
  selectFilterOptions,
  slugifyHeading,
  slugifyPageName,
  sortDbEntries,
  stripLeadingTitle,
  stripMarkdownInline,
  summarizeFolders,
  tocHeadings,
  validateEntryForm,
  validateNewPagePath,
  validatePageDraft,
} from "./docs-model";

const tree: DocTreeNode[] = [
  {
    name: "guides",
    type: "folder",
    path: "guides",
    hasIndex: true,
    title: "Guides",
    modified: "2026-03-01T00:00:00.000Z",
    children: [
      {
        name: "setup",
        type: "folder",
        path: "guides/setup",
        children: [
          { name: "windows", type: "file", path: "guides/setup/windows", title: "Windows setup", modified: "2026-05-01T00:00:00.000Z", tags: ["windows"] },
        ],
      },
      { name: "deploy", type: "file", path: "guides/deploy", title: "Deploying", description: "How releases ship.", modified: "2026-04-01T00:00:00.000Z" },
      { name: "rollback", type: "file", path: "guides/rollback", title: "Guides — Rolling back" },
    ],
  },
  {
    name: "recipes",
    type: "folder",
    path: "recipes",
    isDb: true,
    title: "Recipes",
    children: [
      { name: "ramen", type: "file", path: "recipes/ramen", title: "Ramen", modified: "2026-06-01T00:00:00.000Z" },
      { name: "pho", type: "file", path: "recipes/pho", title: "Pho" },
    ],
  },
  { name: "plan", type: "file", path: "plan" },
];

const index = buildTreeIndex(tree);

describe("tree index", () => {
  it("lists pages in reading order and separates collection entries", () => {
    expect(index.pages.map((page) => page.path)).toEqual([
      "guides", "guides/setup/windows", "guides/deploy", "guides/rollback", "recipes/ramen", "recipes/pho", "plan",
    ]);
    expect(index.stats).toEqual({ pages: 5, folders: 2, collections: 1, entries: 2 });
    expect(index.pageByPath.get("recipes/ramen")?.isEntry).toBe(true);
    expect(index.pageByPath.get("guides")?.folder).toBe("guides");
  });

  it("falls back to the slug when the index has no title for a page", () => {
    expect(index.pageByPath.get("plan")?.title).toBe("plan");
  });

  it("treats collections as leaves so their entries never flood the tree", () => {
    const rows = flattenVisibleTree(tree, new Set(["guides", "recipes"]));
    expect(rows.map((row) => `${row.depth}:${row.node.path}`)).toEqual([
      "0:guides", "1:guides/setup", "1:guides/deploy", "1:guides/rollback", "0:recipes", "0:plan",
    ]);
    expect(rows.find((row) => row.node.path === "recipes")).toMatchObject({ kind: "collection", hasChildren: false });
    expect(rows.find((row) => row.node.path === "guides/setup")).toMatchObject({ expanded: false, hasChildren: true });
  });

  it("drops a title prefix that only repeats the folder the page sits under", () => {
    const rows = flattenVisibleTree(tree, new Set(["guides"]));
    expect(rows.find((row) => row.node.path === "guides/rollback")?.label).toBe("Rolling back");
    expect(rows.find((row) => row.node.path === "guides/deploy")?.label).toBe("Deploying");

    expect(compactTreeLabel("The Mighty Architectury — Build & Code", ["themightyarchitectury"])).toBe("Build & Code");
    expect(compactTreeLabel("The Mighty Architect — Logic Audit", ["themightyarchitectury"])).toBe("Logic Audit");
    expect(compactTreeLabel("Project Tellus: Plan", ["tellus"])).toBe("Plan");
    expect(compactTreeLabel("RCA: Bridge server freezes", ["bridge"])).toBe("RCA: Bridge server freezes");
    expect(compactTreeLabel("Vectorized Game Engine — Design", ["star-realms"])).toBe("Vectorized Game Engine — Design");
    expect(compactTreeLabel("Guides — ", ["guides"])).toBe("Guides — ");
    expect(compactTreeLabel("Anything — Else", [])).toBe("Anything — Else");
  });

  it("finds the folders that reveal a nested page", () => {
    expect(ancestorFolderPaths("guides/setup/windows")).toEqual(["guides", "guides/setup"]);
    expect(ancestorFolderPaths("plan")).toEqual([]);
  });

  it("builds routes that survive spaces and mark collections", () => {
    expect(docsRoute("guides/my page", "#part")).toBe("/docs/guides/my%20page#part");
    expect(docsRoute({ path: "recipes", kind: "collection" })).toBe("/docs/recipes?db");
    expect(docsRoute("")).toBe("/docs");
  });
});

describe("navigation helpers", () => {
  it("makes every ancestor breadcrumb navigable", () => {
    expect(buildBreadcrumbs("guides/setup/windows", index)).toEqual([
      { label: "Guides", target: { path: "guides", kind: "folder" } },
      { label: "setup", target: { path: "guides/setup", kind: "folder" } },
      { label: "Windows setup", target: null },
    ]);
    expect(buildBreadcrumbs("recipes/ramen", index, "Tonkotsu ramen")).toEqual([
      { label: "Recipes", target: { path: "recipes", kind: "collection" } },
      { label: "Tonkotsu ramen", target: null },
    ]);
  });

  it("walks previous and next within a folder, never into a neighbouring project", () => {
    expect(findNeighbours(index, "guides/deploy")).toMatchObject({ previous: null, next: { path: "guides/rollback" } });
    expect(findNeighbours(index, "guides/rollback")).toMatchObject({ previous: { path: "guides/deploy" }, next: null });
    expect(findNeighbours(index, "guides")).toEqual({ previous: null, next: null });
    expect(findNeighbours(index, "recipes/ramen")).toEqual({ previous: null, next: null });
    expect(findNeighbours(index, "missing")).toEqual({ previous: null, next: null });
  });

  it("orders recent pages by modification time, skipping undated pages and collection entries", () => {
    expect(recentPages(index, 3).map((page) => page.path)).toEqual(["guides/setup/windows", "guides/deploy", "guides"]);
  });

  it("summarizes top-level folders with counts and their latest change", () => {
    expect(summarizeFolders(tree)).toEqual([
      expect.objectContaining({ label: "Guides", kind: "folder", itemCount: 4, modified: "2026-05-01T00:00:00.000Z" }),
      expect.objectContaining({ label: "Recipes", kind: "collection", itemCount: 2 }),
    ]);
  });

  it("offers only page folders as locations and defaults to where the reader is", () => {
    expect(listPageFolders(index)).toEqual(["guides", "guides/setup"]);
    expect(defaultNewPageFolder(index, "guides/setup/windows")).toBe("guides/setup");
    expect(defaultNewPageFolder(index, "guides/setup")).toBe("guides/setup");
    expect(defaultNewPageFolder(index, "recipes/ramen")).toBe("");
    expect(defaultNewPageFolder(index, null)).toBe("");
  });

  it("knows which collection a path belongs to", () => {
    expect(owningCollection(index, "recipes/ramen")?.path).toBe("recipes");
    expect(owningCollection(index, "recipes")?.path).toBe("recipes");
    expect(owningCollection(index, "guides/deploy")).toBeNull();
  });
});

describe("search helpers", () => {
  it("matches half-typed titles and ranks closer matches first", () => {
    expect(matchPagesByTitle(index, "dep").map((page) => page.path)).toEqual(["guides/deploy"]);
    expect(matchPagesByTitle(index, "setup win").map((page) => page.path)).toEqual(["guides/setup/windows"]);
    expect(matchPagesByTitle(index, "r").map((page) => page.path)).toContain("recipes/ramen");
    expect(matchPagesByTitle(index, "   ")).toEqual([]);
  });

  it("keeps everything except the server's mark tags as literal text", () => {
    expect(parseSnippet("see <mark>ramen</mark> and <script>alert(1)</script>")).toEqual([
      { text: "see ", highlighted: false },
      { text: "ramen", highlighted: true },
      { text: " and <script>alert(1)</script>", highlighted: false },
    ]);
    expect(parseSnippet("plain\n  text")).toEqual([{ text: "plain text", highlighted: false }]);
    expect(parseSnippet("> **Status:** `done` | [[plan]]")).toEqual([{ text: " Status: done plan ", highlighted: false }]);
  });
});

describe("links", () => {
  it("resolves relative links against a page or a folder index", () => {
    expect(resolveRelativeDocPath("guides/deploy", "./setup/windows.md#install", false)).toBe("guides/setup/windows#install");
    expect(resolveRelativeDocPath("guides/deploy", "../plan", false)).toBe("plan");
    expect(resolveRelativeDocPath("guides", "deploy", true)).toBe("guides/deploy");
    expect(resolveRelativeDocPath("guides/deploy", "/plan/", false)).toBe("plan");
    expect(resolveRelativeDocPath("guides/deploy", "#top", false)).toBe("guides/deploy#top");
    expect(resolveRelativeDocPath("guides/deploy", "my%20page", false)).toBe("guides/my page");
    // The root index page resolves its links against the docs root.
    expect(resolveRelativeDocPath("", "guides/deploy.md", true)).toBe("guides/deploy");
  });

  it("points folder/index links at the folder's canonical page", () => {
    expect(canonicalDocPath("guides/index", index)).toBe("guides");
    expect(canonicalDocPath("guides/setup/index", index)).toBe("guides/setup/index");
    expect(canonicalDocPath("plan", index)).toBe("plan");
  });

  it("recognises external links and collects wikilink targets once", () => {
    expect(isExternalHref("https://example.com")).toBe(true);
    expect(isExternalHref("mailto:a@b.c")).toBe(true);
    expect(isExternalHref("guides/deploy")).toBe(false);
    expect(extractWikilinkTargets("[[b]] then [[a|Label]] and [[b]]")).toEqual(["a", "b"]);
  });
});

describe("headings", () => {
  it("slugs headings the way GitHub does, because that is how authors link", () => {
    expect(slugifyHeading("Build & Code Architecture")).toBe("build--code-architecture");
    expect(slugifyHeading("Use `min_format` now!")).toBe("use-min_format-now");
    expect(slugifyHeading("Überblick: Größe")).toBe("überblick-größe");
    expect(slugifyHeading("!!!")).toBe("section");
  });

  it("strips inline markup but keeps code and snake_case intact", () => {
    expect(stripMarkdownInline("**Bold** _and_ [link](https://x.y) `a_b*c`")).toBe("Bold and link a_b*c");
    expect(stripMarkdownInline("snake_case_name stays")).toBe("snake_case_name stays");
    expect(stripMarkdownInline("See [[guides/deploy|the guide]] and [[plan]]")).toBe("See the guide and plan");
  });

  it("extracts headings with source lines, ignoring fenced code and numbering duplicates", () => {
    const markdown = ["# Title", "", "## Setup", "```sh", "# not a heading", "```", "## Setup", "~~~", "## nor this", "~~~", "### Deep ##"].join("\n");
    expect(extractHeadings(markdown)).toEqual([
      { level: 1, text: "Title", id: "title", line: 1 },
      { level: 2, text: "Setup", id: "setup", line: 3 },
      { level: 2, text: "Setup", id: "setup-1", line: 7 },
      { level: 3, text: "Deep", id: "deep", line: 11 },
    ]);
  });

  it("finds a heading from a fragment even when hyphens were collapsed", () => {
    const headings = extractHeadings("## Build & Code\n## Other");
    expect(findHeadingByAnchor(headings, "build--code")?.text).toBe("Build & Code");
    expect(findHeadingByAnchor(headings, "build-code")?.text).toBe("Build & Code");
    expect(findHeadingByAnchor(headings, "missing")).toBeNull();
    expect(findHeadingByAnchor(headings, "")).toBeNull();
  });

  it("drops only a leading H1, so the page title is not printed twice", () => {
    expect(stripLeadingTitle("\n# Title\n\nBody\n# Later")).toBe("Body\n# Later");
    expect(stripLeadingTitle("Intro\n# Title")).toBe("Intro\n# Title");
    expect(stripLeadingTitle("## Not a title\nBody")).toBe("## Not a title\nBody");
    expect(leadingTitle("# The **real** title\n\nBody")).toBe("The real title");
    expect(leadingTitle("Body only")).toBeNull();
  });

  it("lists the top three heading levels that occur in the contents", () => {
    const headings = extractHeadings("## A\n### B\n#### C\n##### D");
    expect(tocHeadings(headings).map((heading) => heading.text)).toEqual(["A", "B", "C"]);
    expect(tocHeadings([])).toEqual([]);
  });

  it("estimates reading time without counting code blocks", () => {
    expect(estimateReadingMinutes("word ".repeat(440))).toBe(2);
    expect(estimateReadingMinutes("```\n" + "code ".repeat(2000) + "\n```")).toBe(1);
  });
});

describe("formatting", () => {
  it("formats relative times and falls back to a date for old changes", () => {
    const now = Date.parse("2026-06-10T12:00:00.000Z");
    expect(formatRelativeTime("2026-06-10T11:59:40.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-06-10T11:30:00.000Z", now)).toBe("30m ago");
    expect(formatRelativeTime("2026-06-10T07:00:00.000Z", now)).toBe("5h ago");
    expect(formatRelativeTime("2026-06-07T12:00:00.000Z", now)).toBe("3d ago");
    expect(formatRelativeTime("2026-05-20T12:00:00.000Z", now)).toBe("3w ago");
    expect(formatRelativeTime("2025-01-01T12:00:00.000Z", now)).toContain("2025");
    expect(formatRelativeTime("not a date", now)).toBe("");
    expect(formatRelativeTime(undefined, now)).toBe("");
  });

  it("shows a calendar date as the day it names, in any time zone", () => {
    expect(formatDocDate("2026-09-17")).toMatch(/17/);
    expect(formatDocDate("2026-09-17T00:00:00.000Z")).toMatch(/17/);
    expect(formatDocDate("")).toBe("");
    expect(formatDocDate("soon")).toBe("soon");
  });
});

describe("new pages", () => {
  it("slugs titles the same way the server does", () => {
    expect(slugifyPageName("  Release Checklist: v2.0!  ")).toBe("release-checklist-v2-0");
    expect(slugifyPageName("Crème brûlée")).toBe("creme-brulee");
    expect(joinDocPath(" guides/setup ", "windows")).toBe("guides/setup/windows");
    expect(joinDocPath("", "plan")).toBe("plan");
  });

  it("explains why a path cannot be used", () => {
    expect(validateNewPagePath("guides/new-page", index)).toBeNull();
    expect(validateNewPagePath("brand/new/folder/page", index)).toBeNull();
    expect(validateNewPagePath("guides/deploy", index)).toMatch(/already exists/);
    expect(validateNewPagePath("guides", index)).toMatch(/already exists/);
    expect(validateNewPagePath("recipes/soup", index)).toMatch(/collection/);
    expect(validateNewPagePath("plan/child", index)).toMatch(/is a page, not a folder/);
    expect(validateNewPagePath("_private/page", index)).toMatch(/reserved/);
    expect(validateNewPagePath("guides/../etc", index)).toMatch(/\. or \.\./);
    expect(validateNewPagePath("what?", index)).toMatch(/cannot contain/);
    expect(validateNewPagePath("CON", index)).toMatch(/reserved name/);
    expect(validateNewPagePath("guides//page", index)).toMatch(/Enter a name/);
  });
});

const schema: DbSchema = {
  name: "Recipes",
  fields: [
    { name: "title", type: "text" },
    { name: "cuisine", type: "select", options: ["japanese", "vietnamese"], required: true },
    { name: "minutes", type: "number" },
    { name: "cooked", type: "boolean" },
    { name: "first_made", type: "date" },
    { name: "source", type: "url" },
  ],
};

function entry(slug: string, title: string, fields: Record<string, unknown>, modified = ""): DbEntry {
  return { path: `recipes/${slug}`, slug, title, fields, created: "", modified };
}

const entries: DbEntry[] = [
  entry("ramen", "Ramen", { cuisine: "japanese", minutes: 240, cooked: true }, "2026-06-01T00:00:00.000Z"),
  entry("pho", "Pho", { cuisine: "vietnamese", minutes: 90 }, "2026-05-01T00:00:00.000Z"),
  entry("toast", "Toast", { cuisine: "other", minutes: "5" }),
  entry("mystery", "Mystery", {}),
];

describe("collections", () => {
  it("sorts by any field and always sinks blanks to the bottom", () => {
    const paths = (sorted: DbEntry[]) => sorted.map((item) => item.slug);
    expect(paths(sortDbEntries(entries, { field: "minutes", order: "asc" }, schema))).toEqual(["toast", "pho", "ramen", "mystery"]);
    expect(paths(sortDbEntries(entries, { field: "minutes", order: "desc" }, schema))).toEqual(["ramen", "pho", "toast", "mystery"]);
    expect(paths(sortDbEntries(entries, { field: "title", order: "asc" }, schema))).toEqual(["mystery", "pho", "ramen", "toast"]);
    expect(paths(sortDbEntries(entries, { field: "modified", order: "desc" }, schema)).slice(0, 2)).toEqual(["ramen", "pho"]);
  });

  it("toggles direction on the same column and picks a natural first direction otherwise", () => {
    expect(nextDbSort({ field: "modified", order: "desc" }, "modified")).toEqual({ field: "modified", order: "asc" });
    expect(nextDbSort({ field: "modified", order: "desc" }, "title")).toEqual({ field: "title", order: "asc" });
    expect(nextDbSort({ field: "title", order: "asc" }, "minutes")).toEqual({ field: "minutes", order: "desc" });
  });

  it("filters by text across fields and by exact select values", () => {
    const slugs = (filtered: DbEntry[]) => filtered.map((item) => item.slug);
    expect(slugs(filterDbEntries(entries, schema, { text: "viet", selects: {} }))).toEqual(["pho"]);
    expect(slugs(filterDbEntries(entries, schema, { text: "", selects: { cuisine: "japanese" } }))).toEqual(["ramen"]);
    expect(slugs(filterDbEntries(entries, schema, { text: "90", selects: { cuisine: "japanese" } }))).toEqual([]);
    expect(filterDbEntries(entries, schema, { text: " ", selects: { cuisine: "" } })).toBe(entries);
  });

  it("offers stray values in a select filter alongside the schema's options", () => {
    expect(selectFilterOptions(schema.fields[1], entries)).toEqual(["japanese", "vietnamese", "other"]);
  });
});

describe("entry forms", () => {
  it("round-trips stored values through form state", () => {
    const values = entryFormValues(schema, { cuisine: "japanese", minutes: 240, cooked: "true", first_made: "2026-02-03T10:00:00.000Z" });
    expect(values).toEqual({ cuisine: "japanese", minutes: "240", cooked: true, first_made: "2026-02-03", source: "" });
    expect(entryFieldsPayload(schema, values, "create")).toEqual({ cuisine: "japanese", minutes: 240, cooked: true, first_made: "2026-02-03" });
  });

  it("sends null for a cleared field on update, which the server accepts where an empty string fails", () => {
    const values = entryFormValues(schema, {});
    expect(entryFieldsPayload(schema, values, "update")).toEqual({ cuisine: null, minutes: null, cooked: false, first_made: null, source: null });
    expect(entryFieldsPayload(schema, values, "create")).toEqual({ cooked: false });
  });

  it("reports problems per field before anything is sent", () => {
    expect(validateEntryForm(schema, " ", { cuisine: "", minutes: "soon", cooked: false, first_made: "", source: "example.com" })).toEqual({
      title: "A title is required.",
      cuisine: "This field is required.",
      minutes: "Enter a number.",
      source: "Enter a full URL, including https://.",
    });
    expect(validateEntryForm(schema, "Ramen", { cuisine: "japanese", minutes: "", cooked: false, first_made: "", source: "" })).toEqual({});
  });
});

describe("page drafts", () => {
  it("reads editable fields from frontmatter and tolerates odd shapes", () => {
    expect(pageDraftFromFrontmatter({ title: "Plan", description: "What next", tags: "solo" }, "Body", "plan")).toEqual({
      title: "Plan", description: "What next", tags: ["solo"], body: "Body",
    });
    expect(pageDraftFromFrontmatter({ tags: ["a", 3, ""] }, "", "fallback")).toEqual({ title: "fallback", description: "", tags: ["a"], body: "" });
  });

  it("keeps every frontmatter key it does not manage, and drops emptied ones", () => {
    const merged = mergePageFrontmatter(
      { title: "Old", description: "Old description", tags: ["x"], created: "2026-01-01", owner: { team: "core" } },
      { title: " New: title ", description: "  ", tags: [] },
    );
    expect(merged).toEqual({ title: "New: title", created: "2026-01-01", owner: { team: "core" } });
    expect(Object.keys(merged)[0]).toBe("title");
  });

  it("enforces the rule that tagged pages carry a description", () => {
    expect(validatePageDraft({ title: "", description: "", tags: [], body: "" })).toMatch(/title/);
    expect(validatePageDraft({ title: "Plan", description: "", tags: ["bridge"], body: "" })).toMatch(/description/);
    expect(validatePageDraft({ title: "Plan", description: "Why", tags: ["bridge"], body: "" })).toBeNull();
  });

  it("tidies typed tags without changing their case", () => {
    expect(normalizeTag("  #Mighty   Architectury, ")).toBe("Mighty Architectury");
    expect(normalizeTag("##")).toBe("");
  });
});
