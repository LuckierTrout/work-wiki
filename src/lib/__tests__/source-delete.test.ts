import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sourceIdentityKeys, sourceRestFromPath } from "../source-delete";

describe("source-delete", () => {
  it("is free of server-only imports", async () => {
    const source = await readFile(
      path.join(__dirname, "../source-delete.ts"),
      "utf8",
    );
    expect(source).not.toContain("action-items");
    expect(source).not.toContain("from \"./storage\"");
    expect(source).not.toContain("from \"./lifecycle\"");
    expect(source).not.toMatch(/from ["']node:/);
  });

  it("uses exact identity keys only", () => {
    const keys = sourceIdentityKeys("raw/sources/papers/energy/note.md");
    expect(keys).toContain("raw/sources/papers/energy/note.md");
    expect(keys).toContain("papers/energy/note.md");
    expect(keys).not.toContain("note.md");
    expect(keys).not.toContain("note");
    expect(sourceRestFromPath("raw/sources/../secret")).toBeNull();
    expect(
      sourceRestFromPath("/tmp/wiki/raw/sources/papers/energy/note.md"),
    ).toBe("papers/energy/note.md");
  });
});
