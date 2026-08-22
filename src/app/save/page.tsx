import type { Metadata } from "next";
import { SaveCapture } from "@/components/SaveCapture";
import { SaveGuide } from "@/components/SaveGuide";
import { captureFromQuery } from "@/lib/share-target";

export const metadata: Metadata = {
  title: "Save to work-wiki",
  description: "Send any link to work-wiki for ingesting — bookmarklet, share sheet, or shortcut.",
  // The capture action shouldn't be indexed; the guide (no ?url) is fine but low value.
  robots: { index: false, follow: false },
};

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * Dual-mode capture route:
 *  - `/save?url=…`  → the capture action (bookmarklet popup / PWA share / Shortcut)
 *  - `/save`        → the how-to guide for setting up those surfaces
 *
 * A `text` query that is not a URL is still a capture attempt: show Capture
 * with the empty sentence rather than silently opening only the guide.
 */
export default async function SavePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { url, clip, attempted } = captureFromQuery(first(sp.url), first(sp.text));

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "56px 24px 88px" }}>
      {attempted ? <SaveCapture url={url} clip={clip} /> : <SaveGuide />}
    </div>
  );
}
