import { isReadOnly } from "@/lib/config";
import { NewWikiForm } from "./NewWikiForm";

/**
 * REQUIRED, not a performance choice — this page has no other dynamic API.
 *
 * `isReadOnly()` reads `process.env.YOPEDIA_READONLY` at CALL time, and a
 * server component with no `params` to await, no cookies and no data fetch is
 * PRERENDERED AT BUILD: the flag would be baked into static HTML, and flipping
 * it on a running deployment would never reach {@link NewWikiForm}. The whole
 * refusal below would be inert in production while every test stayed green.
 * `src/app/wiki/new/__tests__/new-wiki-page-seam.test.ts` pins this line for
 * that reason. Same declaration `src/app/page.tsx` carries, for the same class
 * of reason.
 */
export const dynamic = "force-dynamic";

/**
 * `/wiki/new` — compose a page and create it through `POST /api/wiki`.
 *
 * A SERVER COMPONENT, and only just: everything interactive lives in
 * {@link NewWikiForm} beside it. The split exists for one fact — `isReadOnly()`
 * reads `process.env.YOPEDIA_READONLY`, which no `"use client"` module can do —
 * and the whole page used to be the form, so a read-only deployment let the
 * owner compose a title, a slug and an entire markdown body before the 403.
 *
 * The same SEAM as `src/app/u/[handle]/[slug]/edit/page.tsx`, which reads the
 * flag here and hands it to `WikiEditor` — but not the same rendering mode for
 * free: that page awaits `params` and calls `getPrincipal()`, so Next makes it
 * dynamic on its own. This one has nothing of the kind and has to say so
 * explicitly, which is what the `dynamic` export above is.
 */
export default function NewWikiPage() {
  return (
    <div className="shell paper-route fade" style={{ paddingTop: 48, paddingBottom: 92 }}>
      <p className="fmark" style={{ marginBottom: 16 }}>create knowledge</p>
      <h1 className="display" style={{ fontSize: "clamp(36px,4.5vw,58px)", margin: 0 }}>Create a new wiki page</h1>
      <p style={{ color: "var(--ink-2)", fontSize: 17, margin: "11px 0 32px", maxWidth: "64ch" }}>
        Start from a useful template, add source-aware content, and publish with a revision receipt.
      </p>

      <NewWikiForm readOnly={isReadOnly()} />
    </div>
  );
}
