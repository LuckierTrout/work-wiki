import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("Purpose has one write path", () => {
  it("keeps the retired compatibility component free of a profile writer", async () => {
    const source = await readFile(
      path.resolve(__dirname, "../../components/WorkspacePurposeSettings.tsx"),
      "utf8",
    );
    expect(source).not.toContain("/api/workspace-profile");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("<form");
    expect(source).toContain("purpose.md");
  });
});
