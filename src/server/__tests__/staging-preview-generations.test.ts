import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPreviewGenerationTarget,
  prunePreviewGenerations,
  publishPreviewGeneration,
  readActivePreviewTarget,
  removePublishedPreview,
} from "../staging-preview-shared.js";
import { makeTestDir } from "./helpers.js";

function completeGeneration(
  stagingDir: string,
  generationId: string,
  previewParent: string,
) {
  const target = createPreviewGenerationTarget(stagingDir, generationId, previewParent);
  mkdirSync(target.outDir, { recursive: true });
  mkdirSync(target.dataDir!, { recursive: true });
  writeFileSync(join(target.outDir, "index.html"), `<!doctype html><p>${generationId}</p>`);
  writeFileSync(join(target.dataDir!, "bridge.db"), generationId);
  return target;
}

describe("staging preview generations", () => {
  it("publishes a completed generation atomically and prunes retired generations later", () => {
    const root = makeTestDir("preview-generations");
    const previewParent = join(root, "previews");
    const stagingDir = join(root, "worktrees", "preview-123");
    mkdirSync(stagingDir, { recursive: true });

    const first = completeGeneration(stagingDir, "generation-one", previewParent);
    publishPreviewGeneration(first, previewParent);
    expect(readActivePreviewTarget(first.prefix, previewParent)).toMatchObject({
      generationId: "generation-one",
      outDir: first.outDir,
      dataDir: first.dataDir,
    });
    expect(readActivePreviewTarget(
      first.prefix,
      previewParent,
      join(root, "different-worktrees"),
    )).toBeNull();

    const second = createPreviewGenerationTarget(
      stagingDir,
      "generation-incomplete",
      previewParent,
    );
    mkdirSync(second.outDir, { recursive: true });
    writeFileSync(join(second.outDir, "index.html"), "<!doctype html>");
    expect(() => publishPreviewGeneration(second, previewParent)).toThrow(/missing bridge\.db/);
    expect(readActivePreviewTarget(first.prefix, previewParent)?.generationId).toBe("generation-one");

    const completeSecond = completeGeneration(stagingDir, "generation-two", previewParent);
    publishPreviewGeneration(completeSecond, previewParent);
    expect(readActivePreviewTarget(first.prefix, previewParent)?.generationId).toBe("generation-two");
    expect(existsSync(dirname(first.outDir))).toBe(true);

    expect(prunePreviewGenerations(first.prefix, "generation-two", previewParent)).toBe(2);
    expect(existsSync(dirname(first.outDir))).toBe(false);
    expect(existsSync(dirname(second.outDir))).toBe(false);
    expect(existsSync(dirname(completeSecond.outDir))).toBe(true);

    removePublishedPreview(first.prefix, previewParent);
    expect(readActivePreviewTarget(first.prefix, previewParent)).toBeNull();
    expect(existsSync(dirname(completeSecond.outDir))).toBe(false);
  });
});
