"use client";

import Link from "next/link";

/**
 * Compatibility callout used by the flat Settings page and Knowledge Studio.
 * Purpose has one editor now: the confirm-gated Workbench Preview for
 * purpose.md. This component owns no profile draft and performs no write.
 */
export function WorkspacePurposeSettings() {
  return (
    <section
      className="mt-12 border-t border-foreground/10 pt-10"
      aria-labelledby="workspace-purpose-heading"
    >
      <p className="fmark mb-2">Knowledge direction</p>
      <h2
        id="workspace-purpose-heading"
        className="text-xl font-semibold tracking-tight text-foreground"
      >
        Workspace Purpose
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-foreground/60">
        Purpose is canonical Markdown stored as purpose.md for the active Wiki.
        Open Workbench Settings → General to view or edit it in the same guarded
        Preview editor and history used from Files.
      </p>
      <Link href="/?mode=wiki&settings=1" className="btn ghost mt-4 inline-flex">
        Open Workbench Settings
      </Link>
    </section>
  );
}
