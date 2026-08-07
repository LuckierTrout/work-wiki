import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  buildRawSourceContext,
  extractRawCitedPageSlugs,
} from "../raw-source-search";
import { saveRawSource, saveRawSourceFor } from "../raw";
import { serializeSources } from "../sources";
import type { IndexEntry, SourceEntry } from "../types";
import { serializeFrontmatter } from "../frontmatter";
import { _resetStorage } from "../storage";
import { writeWikiPage } from "../wiki";

let tmpDir: string;
let originalDataDir: string | undefined;

const ENTRY: IndexEntry = {
  slug: "launch-memo",
  title: "Launch memo",
  summary: "Generated summary that must not become source evidence.",
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-source-search-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSourcedPage(source: SourceEntry, rawContent: string) {
  await writeWikiPage(
    ENTRY.slug,
    serializeFrontmatter(
      { sources: serializeSources([source]) },
      "# Launch memo\n\nGENERATED-WIKI-ONLY-CLAIM",
    ),
  );
  if (source.raw_id) {
    await saveRawSourceFor(ENTRY.slug, source.raw_id, rawContent);
  } else {
    await saveRawSource(ENTRY.slug, rawContent);
  }
}

describe("original-source retrieval context", () => {
  it("uses raw snapshots, preserves line ranges, and never adds generated page text", async () => {
    await writeSourcedPage(
      {
        type: "url",
        url: "https://docs.example.com/launch",
        fetched: "2026-08-06",
        triggered_by: "alice",
        raw_id: "abc123",
      },
      "First line.\nThe launch owner is Priya.\nDelivery is due Friday.",
    );

    const result = await buildRawSourceContext(
      [ENTRY.slug],
      [ENTRY],
      "Who owns launch delivery?",
    );

    expect(result.context).toContain("The launch owner is Priya.");
    expect(result.context).not.toContain("GENERATED-WIKI-ONLY-CLAIM");
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      pageSlug: ENTRY.slug,
      startLine: 1,
      endLine: 3,
      citationHref: "/api/raw/launch-memo?source=abc123",
    });
    expect(result.context).toContain(
      "[original source for launch-memo, lines 1-3](/api/raw/launch-memo?source=abc123)",
    );
  });

  it("supports legacy latest-raw blobs without inventing a snapshot id", async () => {
    await writeSourcedPage(
      {
        type: "text",
        url: "text-paste",
        fetched: "2026-08-06",
        triggered_by: "alice",
      },
      "Legacy source evidence.",
    );

    const result = await buildRawSourceContext([ENTRY.slug], [ENTRY], "legacy evidence");
    expect(result.chunks[0].citationHref).toBe("/api/raw/launch-memo");
    expect(result.context).toContain("Legacy source evidence.");
  });

  it("keeps citation line numbers aligned when a raw source starts with blank lines", async () => {
    await writeSourcedPage(
      {
        type: "url",
        url: "https://docs.example.com/launch",
        fetched: "2026-08-06",
        triggered_by: "alice",
        raw_id: "abc123",
      },
      "\n\nEvidence starts on raw line three.\n",
    );
    const result = await buildRawSourceContext([ENTRY.slug], [ENTRY], "evidence");
    expect(result.chunks[0]).toMatchObject({ startLine: 3, endLine: 3 });
    expect(result.chunks[0].citation).toContain("line 3");
  });

  it("returns only page slugs whose raw links the answer actually cites", async () => {
    await writeSourcedPage(
      {
        type: "url",
        url: "https://docs.example.com/launch",
        fetched: "2026-08-06",
        triggered_by: "alice",
        raw_id: "abc123",
      },
      "The owner is Priya.",
    );
    const result = await buildRawSourceContext([ENTRY.slug], [ENTRY], "owner");
    expect(extractRawCitedPageSlugs("No citation.", result.chunks)).toEqual([]);
    expect(extractRawCitedPageSlugs(
      `Priya owns it [source](${result.chunks[0].citationHref}).`,
      result.chunks,
    )).toEqual([ENTRY.slug]);
  });

  it("returns empty context when the authorized candidate has no captured original", async () => {
    await writeWikiPage(ENTRY.slug, "# Launch memo\n\nGenerated only.");
    await expect(buildRawSourceContext([ENTRY.slug], [ENTRY], "launch")).resolves.toEqual({
      context: "",
      chunks: [],
      pageSlugs: [],
    });
  });
});
