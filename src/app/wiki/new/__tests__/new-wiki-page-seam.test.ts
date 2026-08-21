/**
 * The one seam that carries the read-only fact to `/wiki/new` (DW-264).
 *
 * `src/components/__tests__/new-wiki-form-read-only.test.tsx` pins what the
 * form DOES when it is told; what a mounted test cannot see is how it gets
 * told, because it hands the prop in itself. Between the env and the refusal
 * there are exactly three links — a server component, one JSX attribute, and
 * the `dynamic` declaration that keeps the component from being prerendered —
 * and every one of them could be deleted with the mounted suite still green and
 * the owner back to composing a whole page before a 403.
 *
 * Source-scan, in the convention of `article-actions-gate.test.ts`, which pins
 * the article page's equivalent hop the same way: the `node` project has no DOM
 * and cannot render a server component, and "is the seam PRESENT" is a property
 * of the file rather than of a request.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const HERE = path.resolve(__dirname, "..");

const read = (file: string) => readFile(path.join(HERE, file), "utf8");

describe("the read-only fact reaches the new-page form (DW-264)", () => {
  it("is read on the server and handed to the form, never fetched", async () => {
    const page = await read("page.tsx");

    // A server component, so the env fact is read where it already lives.
    expect(page).toContain('import { isReadOnly } from "@/lib/config";');
    // Anchored to the ELEMENT, not to the attribute: a bare
    // `toContain("readOnly={isReadOnly()}")` would keep passing the moment any
    // other element in this file grew the same attribute, and the hop this
    // pins could then be deleted with the suite still green.
    expect(page).toMatch(/<NewWikiForm\b[^>]*\breadOnly=\{isReadOnly\(\)\}/s);
  });

  it("declares itself dynamic, or the flag would be baked in at build", async () => {
    // THE case the mounted suite cannot make, and the one that matters most on
    // a real deployment. This page has no other dynamic API — no `params` to
    // await, no principal, no data fetch — so without this declaration Next
    // prerenders it and `isReadOnly()` is evaluated ONCE, at build. Flipping
    // `YOPEDIA_READONLY` on a running deployment would never reach the form,
    // and the whole refusal would be inert while every other assertion in this
    // change stayed green.
    const page = await read("page.tsx");

    expect(page).toMatch(/export const dynamic = "force-dynamic";/);
  });

  it("keeps the form a client island with no second source of truth", async () => {
    // One seam, not two. A `"use client"` module cannot read `process.env`
    // usefully in the browser anyway, so an `isReadOnly` here would be a second
    // answer free to disagree with the prop — the rule
    // `ArticleActions.tsx` is held to for the same reason.
    const form = await read("NewWikiForm.tsx");

    expect(form).toContain('"use client"');
    // `isReadOnly` and not the env NAME: the prop's doc comment names
    // `YOPEDIA_READONLY` to say where the value came from, which is
    // documentation rather than a second read. The function call is the thing
    // that would actually constitute one.
    expect(form).not.toContain("isReadOnly");
  });
});
