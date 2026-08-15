"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { CreateWikiDialog } from "@/components/CreateWikiDialog";
import { TREE_UNAVAILABLE_COPY } from "@/lib/workbench-tree";
import type { CreatableScenario } from "@/lib/wiki-scenarios";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The left column header's Wiki controls (UX-DR5): the switcher and New Wiki,
 * sitting under the product title.
 *
 * This is a SECOND switcher, not a moved one. `WikiWorkbench.tsx` keeps the
 * canvas card it has shipped since Story 1.2, because
 * `create-wiki-ui.test.ts:118-209` counts literals inside that file — moving
 * its switcher or its create path would break a frozen assertion. The two stay
 * consistent because both refresh the server tree after a write and
 * `page.tsx` keys `WikiWorkbench` on the current Wiki id, so the card remounts
 * with fresh props when this header switches.
 *
 * A native `<select>`, not a popover: there is no DOM test environment in this
 * repo (DW-15, DW-24), so a hand-rolled listbox's focus management, Esc and
 * outside-click dismissal would ship entirely unverified. The platform's
 * control gets all three for free.
 */

export interface WikiSwitcherProps {
  wikis: readonly WikiRecord[];
  currentWikiId: string | null;
  /**
   * The server could not read the registry. Rendering an empty switcher here
   * would say "you have no wikis" on the strength of a transient read error,
   * and New Wiki would invite a duplicate.
   */
  unavailable?: boolean;
}

/**
 * A request that never settles would leave `switching` true for the rest of the
 * session and the switcher disabled with no error to explain it. `finally`
 * cannot rescue a promise that never resolves, so the deadline is the rescue.
 */
const REQUEST_TIMEOUT_MS = 15_000;

async function send<T>(url: string, init: RequestInit): Promise<T> {
  // `init` FIRST: both of the fields below are invariants of this helper, and
  // spreading the caller over them would let a future call silently drop the
  // JSON content type or the deadline the comment above promises.
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

/**
 * What to show the owner. A timeout's own message ("signal timed out") names
 * the mechanism rather than the thing that failed, so those fall back to the
 * caller's sentence; a server-supplied message is always preferred.
 */
function failureMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError" || cause.name === "AbortError") return fallback;
    if (cause.message) return cause.message;
  }
  return fallback;
}

export function WikiSwitcher({
  wikis,
  currentWikiId,
  unavailable = false,
}: WikiSwitcherProps) {
  const router = useRouter();
  const selectId = useId();
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The optimistic selection. `currentWikiId` only catches up once
  // `router.refresh()` lands, so without this the <select> visibly snaps back
  // to the old Wiki for the length of the round trip. On success it is left in
  // place — it already equals what the refresh will deliver.
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Creating the first Wiki does not unmount this button (unlike the canvas
  // empty state), but the dialog still needs a landing place if it ever does.
  const newRef = useRef<HTMLButtonElement>(null);

  // The optimism ends the moment the server's answer arrives. Without this the
  // stale `pendingId` outranks `currentWikiId` forever, so a later switch made
  // from Story 1.2's canvas card would leave this <select> naming the previous
  // Wiki — and re-picking the option it is already showing fires no change
  // event, so the owner could not correct it from here.
  useEffect(() => {
    setPendingId(null);
  }, [currentWikiId]);

  async function switchWiki(id: string) {
    if (switching) return;
    setSwitching(true);
    setPendingId(id);
    setError(null);
    try {
      await send("/api/wikis/current", { method: "PUT", body: JSON.stringify({ id }) });
      router.refresh();
    } catch (cause) {
      setPendingId(null);
      setError(failureMessage(cause, "Couldn’t switch wiki."));
    } finally {
      setSwitching(false);
    }
  }

  async function create(input: { name: string; scenario: CreatableScenario }) {
    setBusy(true);
    setCreateError(null);
    try {
      const { wiki } = await send<{ wiki?: WikiRecord }>("/api/wikis", {
        method: "POST",
        body: JSON.stringify(input),
      });
      // A 2xx whose body is not the documented shape must not reach state.
      if (!wiki?.id) throw new Error("Couldn’t create the wiki.");
      // Deliberately NOT optimistic: the new Wiki is not in `wikis` yet, so
      // seeding the select with its id would leave the control on a value that
      // matches no option. It shows the previous Wiki — stale but real — for
      // the length of the refresh.
      setCreateOpen(false);
      setError(null);
      router.refresh();
    } catch (cause) {
      setCreateError(failureMessage(cause, "Couldn’t create the wiki."));
    } finally {
      setBusy(false);
    }
  }

  const value = pendingId ?? currentWikiId ?? "";

  return (
    <div className="wb-wiki-switch" data-no-localize>
      {unavailable ? (
        <p className="wb-wiki-switch-note" role="alert">
          {TREE_UNAVAILABLE_COPY}
        </p>
      ) : (
        <div className="wb-wiki-switch-row">
          {wikis.length > 0 && (
            <>
              {/* Labelled, not placeholder-labelled (accessibility floor). The
                  label is clipped rather than absent: the column is 280px and
                  the control's own option text already names the Wiki. */}
              <label htmlFor={selectId} className="wb-sr-only">
                Active wiki
              </label>
              <select
                id={selectId}
                className="wb-wiki-switch-select"
                value={value}
                disabled={switching}
                onChange={(event) => void switchWiki(event.target.value)}
              >
                {wikis.map((wiki) => (
                  <option key={wiki.id} value={wiki.id}>
                    {wiki.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <button
            type="button"
            ref={newRef}
            className="wb-wiki-switch-new"
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
          >
            New Wiki
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="wb-wiki-switch-error">
          {error}
        </p>
      )}

      <CreateWikiDialog
        open={createOpen}
        busy={busy}
        error={createError}
        fallbackFocusRef={newRef}
        onCancel={() => setCreateOpen(false)}
        onCreate={(input) => void create(input)}
      />
    </div>
  );
}
