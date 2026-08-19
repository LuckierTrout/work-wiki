/**
 * The read-only sentences, server side against client side (DW-187, DW-188).
 *
 * `READ_ONLY_REFUSAL` in `read-only.ts` owns every sentence a SERVER answers.
 * It cannot own the ones client components render beside a dimmed control:
 * importing it into a `"use client"` module would drag `./config` — the
 * settings/storage/embeddings graph, and `process.env` — into the browser
 * bundle. So each surface carries its own exported constant, and the price of
 * that boundary is that the two halves can drift apart silently: the owner reads
 * one sentence before pressing and a different one in the 403 body afterwards,
 * and nothing fails.
 *
 * This file is the seam. Every client constant is compared against the server
 * sentence it mirrors — CHARACTER-IDENTICAL where the door answers its own
 * refusal, and explicitly recorded where it deliberately does not.
 *
 * Node project (no mount): these are two string constants, and importing the
 * component modules for their exported copy needs no DOM.
 */
import { describe, expect, it } from "vitest";
import { READ_ONLY_REFUSAL } from "../read-only";
import { DELETE_PAGE_READ_ONLY_COPY } from "@/components/DeletePageButton";
import { REINGEST_READ_ONLY_COPY } from "@/components/ReingestButton";
import { REVERT_READ_ONLY_COPY } from "@/components/RevisionHistory";

describe("client refusal copy mirrors the server's", () => {
  it("Delete says exactly what DELETE /api/wiki/[slug] answers", () => {
    expect(DELETE_PAGE_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.pageDelete);
  });

  it("Re-ingest says exactly what POST /api/ingest/reingest answers", () => {
    // The drift this file exists for: these two were one word apart ("This page
    // cannot be re-ingested…" vs "Pages cannot be re-ingested…") with every
    // other assertion in the suite green.
    expect(REINGEST_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.reingest);
  });

  it("Revert is narrower than the kernel sentence behind it, on purpose", () => {
    // `POST /api/wiki/[slug]/revisions` spells no refusal of its own — it maps
    // the kernel writer's, which covers create, edit, revert and re-ingest
    // alike. "Pages cannot be written…" is true there and useless beside a
    // button labelled Revert, so the surface narrows it. Pinned as a DIFFERENCE
    // rather than left to look like the bug above.
    expect(REVERT_READ_ONLY_COPY).not.toBe(READ_ONLY_REFUSAL.pageWrite);
    expect(REVERT_READ_ONLY_COPY).toContain("reverted");
    // Both still name the deployment state, which is the property that makes
    // either sentence actionable.
    expect(READ_ONLY_REFUSAL.pageWrite).toContain("read-only");
    expect(REVERT_READ_ONLY_COPY).toContain("read-only");
  });

  it("every server sentence names read-only and reads as a sentence", () => {
    // "Forbidden" alone would leave the owner hunting a permission they do not
    // lack, which is the whole reason these are owned in one place.
    for (const [key, sentence] of Object.entries(READ_ONLY_REFUSAL)) {
      expect(sentence, key).toContain("read-only");
      expect(sentence, key).toMatch(/^[A-Z].*\.$/);
      expect(sentence, key).toContain("while this deployment is read-only.");
    }
  });

  it("no two server sentences are the same string", () => {
    // One owner per sentence is only meaningful if the sentences are distinct —
    // two identical values would mean a door is borrowing another's wording and
    // could be re-pointed without any test noticing.
    const values = Object.values(READ_ONLY_REFUSAL);
    expect(new Set(values).size).toBe(values.length);
  });
});
