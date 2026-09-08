"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Why the button refuses, said out loud. One owner for the wording so the
 * render site and the test that pins it cannot drift, and phrased like every
 * other read-only sentence in the app ("… while this deployment is read-only").
 */
export const DELETE_PAGE_READ_ONLY_COPY =
  "Pages cannot be deleted while this deployment is read-only.";

interface DeletePageButtonProps {
  slug: string;
  /**
   * `YOPEDIA_READONLY=1`, read on the server by the page that renders this and
   * threaded down — no route and no client fetch is added for a fact the
   * process already holds.
   *
   * `DELETE /api/wiki/[slug]` answers 403 on such a deployment (DW-37), and
   * this button's first act is an irreversible-sounding `window.confirm`. Left
   * ungated the owner accepts "Delete this page? This cannot be undone." and
   * only THEN learns the deployment was never going to run it — the exact harm
   * DW-149 names. So the refusal is stated up front instead: `aria-disabled`
   * (never `disabled`, which would take the control out of the tab order) plus
   * a handler that returns before the confirm, and a sentence wired as the
   * button's own description.
   */
  readOnly?: boolean;
}

export function DeletePageButton({ slug, readOnly = false }: DeletePageButtonProps) {
  const router = useRouter();
  const noteId = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    // BEFORE the confirm, not after: a dialog the owner has to answer is the
    // harm, and the answer changes nothing.
    if (readOnly) return;
    if (
      !window.confirm("Delete this page? This cannot be undone.")
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/wiki/${slug}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `delete failed (${res.status})`);
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleDelete}
        disabled={busy}
        // `disabled` stays for the transient in-flight state; the standing
        // refusal is `aria-disabled`, so the control keeps its place in the tab
        // order and the sentence below can be announced with it.
        aria-disabled={readOnly || undefined}
        aria-describedby={readOnly ? noteId : undefined}
        aria-label="Delete this wiki page"
        className={`rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 ${
          readOnly
            ? "opacity-50 cursor-default"
            : "hover:bg-red-700"
        }`}
      >
        {busy ? "Deleting…" : "Delete page"}
      </button>
      {readOnly && (
        <p id={noteId} className="mt-3 text-sm text-foreground/60">
          {DELETE_PAGE_READ_ONLY_COPY}
        </p>
      )}
      {error && (
        <p className="mt-3 text-sm text-red-600">Error: {error}</p>
      )}
    </>
  );
}
