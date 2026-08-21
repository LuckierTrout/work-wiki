"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CreateWikiDialog } from "@/components/CreateWikiDialog";
import {
  TREE_UNAVAILABLE_COPY,
  WIKI_READ_ONLY_COPY,
  WIKI_SCOPE_COPY,
} from "@/lib/workbench-tree";
import {
  MAX_WIKI_NAME_CHARS,
  wikiOptionLabel,
  type CreatableScenario,
} from "@/lib/wiki-scenarios";
import { send, writeFailure } from "@/lib/workbench-request";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The left column header's Wiki controls (UX-DR5): the switcher and New Wiki,
 * sitting under the product title.
 *
 * This is the ONLY switcher, and the only persistent New Wiki. It began as a
 * second copy beside Story 1.2's canvas card, which survived only because
 * `create-wiki-ui.test.ts` froze literal counts inside `WikiWorkbench.tsx`;
 * DW-33 retired that copy, so one viewport no longer offers two switchers and
 * two create controls. The canvas card keeps `Change template`, its artifact
 * receipt and the wiki heading — and it follows this header without a remount,
 * because it reads the same `WorkbenchData` these props come from rather than
 * seeding state from props of its own.
 *
 * A native `<select>`, not a popover. A hand-rolled listbox owns its own
 * roving focus, typeahead, Esc and outside-click dismissal, and — the part no
 * jsdom suite can stand in for — its own touch and screen-reader behaviour on
 * every platform the owner might open this on. The native control gets all of
 * that from the OS, which is why it stays even now that this component has a
 * mounted suite (`wiki-switcher-lifecycle.test.tsx`).
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
  /**
   * `YOPEDIA_READONLY=1`, read on the server and carried here by
   * `WorkbenchData`. All four controls below sit in front of routes that answer
   * 403 on such a deployment (`POST /api/wikis`, `PUT /api/wikis/current`,
   * `PATCH`/`DELETE /api/wikis/[id]`) — and Delete's refusal arrives only after
   * the owner has confirmed an irreversible-sounding action.
   *
   * The convention is `aria-disabled` plus a handler that returns early, NEVER
   * `disabled`: a `disabled` control leaves the tab order, so a keyboard user
   * cannot reach it, cannot read which Wiki is active, and never hears the
   * sentence that explains why it refuses. Read-only means read-only, not
   * hidden. `disabled` stays for `switching`, which is transient.
   *
   * THE EARLY RETURN IS THE WHOLE REFUSAL — no handler here puts a control back
   * by hand. React re-applies a controlled `<select>`'s (or checkbox's) value to
   * the DOM after a change event whose handler committed no state: it is the
   * same machinery behind the "you provided a `value` prop without an
   * `onChange` handler" warning, and it is why a controlled input cannot be
   * typed into at all without a handler that commits. So the picker is showing
   * the active Wiki again by the time anyone looks. This paragraph is the one
   * statement of that fact; the refused controls in `SettingsCanvas` follow the
   * same convention and point back here rather than restating it.
   */
  readOnly?: boolean;
}

export function WikiSwitcher({
  wikis,
  currentWikiId,
  unavailable = false,
  readOnly = false,
}: WikiSwitcherProps) {
  const router = useRouter();
  const selectId = useId();
  const scopeNoteId = useId();
  const readOnlyNoteId = useId();
  const renameInputId = useId();
  const deleteSelectId = useId();
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // The optimistic selection. `currentWikiId` only catches up once
  // `router.refresh()` lands, so without this the <select> visibly snaps back
  // to the old Wiki for the length of the round trip. On success it is left in
  // place — it already equals what the refresh will deliver.
  const [pendingId, setPendingId] = useState<string | null>(null);
  /**
   * New Wiki — the one control here that no operation unmounts, and therefore
   * the landing place for keyboard focus when an opener goes away.
   *
   * `useDialogA11y` only reaches `fallbackFocusRef` when the opener is already
   * detached at close time, which is NOT what a delete does: `remove()` closes
   * the dialog first, so focus is restored to a Delete button that is still
   * mounted, and only then does `router.refresh()` shrink `wikis` and take that
   * button away — dropping the keyboard user on <body> with no dialog left to
   * blame. So a successful delete moves focus here EXPLICITLY rather than
   * relying on the fallback branch.
   */
  const newRef = useRef<HTMLButtonElement>(null);
  /**
   * Set by a successful delete that also UNMOUNTS the Delete button; consumed
   * by the effect below. Only that case: when other deletable Wikis remain the
   * opener survives the refresh, `useDialogA11y` restores focus to it
   * correctly, and moving focus anyway would take the keyboard somewhere the
   * owner never navigated to.
   */
  const refocusNewRef = useRef(false);

  // The optimism ends the moment the server's answer arrives. Without this the
  // stale `pendingId` outranks `currentWikiId` forever, so any later change to
  // the live Wiki — a `create` here, a delete, or a refetch the shell's
  // `DataVersionWatcher` triggers — would leave this <select> naming the
  // previous Wiki. And re-picking the option it is already showing fires no
  // change event, so the owner could not correct it from here. (Before DW-33
  // the canvas card's own switcher was one more way in; retiring it removed a
  // route to this state, not the state itself.)
  useEffect(() => {
    setPendingId(null);
  }, [currentWikiId]);

  // React flushes every effect TEARDOWN before any effect body, so this lands
  // after `useDialogA11y` has restored focus to the Delete button — the button
  // the shrinking `wikis` list is about to unmount. Doing it any earlier would
  // simply be overwritten.
  useEffect(() => {
    if (deleteOpen || !refocusNewRef.current) return;
    refocusNewRef.current = false;
    newRef.current?.focus();
  }, [deleteOpen]);

  async function switchWiki(id: string) {
    if (switching) return;
    setSwitching(true);
    setPendingId(id);
    setError(null);
    try {
      await send("/api/wikis/current", { method: "PUT", body: JSON.stringify({ id }) });
      router.refresh();
    } catch (cause) {
      // The optimistic pick is rolled back to what the server last confirmed on
      // EITHER failure — including the unknown one, where a `<select>` left on
      // a wiki that may not be live would be a stronger claim than the message
      // beside it. The refresh below is what settles which it is.
      setPendingId(null);
      const { message, unconfirmed } = writeFailure(cause, "switch wiki");
      setError(message);
      // The deadline fired, so the active wiki may ALREADY have moved (DW-283):
      // every prompt on this shell would then be executing a different
      // `schema.md` than the tree, the header and this control are describing.
      if (unconfirmed) router.refresh();
    } finally {
      setSwitching(false);
    }
  }

  async function create(input: { name: string; scenario: CreatableScenario }) {
    // BEHIND the confirm's own `disabled={busy}`, never instead of it. The
    // button being dead is what the owner sees; this is what makes a second
    // entry impossible — `CreateWikiDialog.submit` also carries Enter, and a
    // handler that only the pointer path guards is a handler with a hole.
    if (busy) return;
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
      const { message, unconfirmed } = writeFailure(cause, "create the wiki");
      setCreateError(message);
      // The deadline fired, so a wiki may exist that this list does not name —
      // and a second press of a `New Wiki` button that never went dead would
      // seed another one. The dialog stays open holding the owner's name, and
      // the refresh is what tells them whether the first attempt landed.
      if (unconfirmed) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function rename(wiki: WikiRecord, name: string) {
    // Two ways in — the confirm button and the input's Enter — so the guard
    // sits on the handler rather than on either of them. A second PATCH could
    // settle out of order and leave the registry naming whichever answer
    // happened to land last.
    if (busy) return;
    setBusy(true);
    setRenameError(null);
    try {
      const { wiki: renamed } = await send<{ wiki?: WikiRecord }>(
        `/api/wikis/${encodeURIComponent(wiki.id)}`,
        { method: "PATCH", body: JSON.stringify({ name }) },
      );
      // A 2xx whose body is not the documented shape must not reach state.
      if (!renamed?.id) throw new Error("Couldn’t rename the wiki.");
      setRenameOpen(false);
      setError(null);
      router.refresh();
    } catch (cause) {
      const { message, unconfirmed } = writeFailure(cause, "rename the wiki");
      setRenameError(message);
      // The deadline fired, so the registry may already hold the new name while
      // this <select> and the canvas card go on showing the old one.
      if (unconfirmed) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(wiki: WikiRecord) {
    // The irreversible one. A second DELETE issued behind the first answers 404
    // and paints a failure over an operation that in fact succeeded — and the
    // `refocusNewRef` bookkeeping below would run twice against one list.
    if (busy) return;
    setBusy(true);
    setDeleteError(null);
    try {
      const { wiki: deleted } = await send<{ wiki?: WikiRecord }>(
        `/api/wikis/${encodeURIComponent(wiki.id)}`,
        { method: "DELETE" },
      );
      if (!deleted?.id) throw new Error("Couldn’t delete the wiki.");
      // Claimed BEFORE the close, consumed by the effect that runs once the
      // dialog has finished restoring focus to the doomed opener. Focusing
      // here would be too early — `setDeleteOpen(false)` has not rendered yet,
      // so `useDialogA11y`'s teardown would land after us and undo it.
      //
      // ONLY when this delete takes the Delete button with it: the control is
      // gated on `wikis.length > 1`, so it survives unless the refreshed list
      // drops to one. While it survives, the dialog's own focus restore is
      // right and this would override it.
      refocusNewRef.current = wikis.length <= 2;
      setDeleteOpen(false);
      setError(null);
      router.refresh();
    } catch (cause) {
      const { message, unconfirmed } = writeFailure(cause, "delete the wiki");
      setDeleteError(message);
      // The irreversible one, and therefore the one where a flat "couldn't
      // delete" is worst: the wiki may be gone. The dialog stays open with the
      // message, and the refresh replaces the list underneath it — the same
      // `wikis.length` gate that hides the Delete control does the rest.
      if (unconfirmed) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const value = pendingId ?? currentWikiId ?? "";
  // `value`, NOT `currentWikiId`: during an in-flight switch the <select> shows
  // the optimistic pick while `currentWikiId` still names the previous Wiki.
  // Deriving these from the prop would aim Rename at the Wiki the owner just
  // navigated AWAY from, and offer the one they navigated TO as a delete
  // target. The controls are disabled while `switching` as well, so neither
  // dialog can be opened against a selection the server has not confirmed.
  const current = wikis.find((wiki) => wiki.id === value) ?? null;
  // The server refuses to delete the ACTIVE Wiki — moving `current` as a side
  // effect would change which `schema.md` every prompt executes. So the picker
  // offers only the others, and a delete aimed at the selection is impossible
  // by construction rather than by a message after the round trip.
  const deletable = wikis.filter((wiki) => wiki.id !== value);
  // `aria-describedby` takes a space-separated LIST, so the read-only sentence
  // is APPENDED to the scope sentence rather than replacing it: both are true at
  // once. Without it the switcher is the one refused control here with no reason
  // in its description — it would announce as "Active wiki, combobox, dimmed"
  // plus a sentence about what a switch shows, while `WIKI_READ_ONLY_COPY`
  // (which says wikis cannot be SWITCHED) was never reached.
  const selectDescribedBy =
    [wikis.length > 0 ? scopeNoteId : null, readOnly ? readOnlyNoteId : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const deleteTarget = deletable.find((wiki) => wiki.id === deleteTargetId) ?? null;
  const renameReady = renameName.trim().length > 0;

  return (
    <div className="wb-wiki-switch">
      {unavailable ? (
        <p className="wb-wiki-switch-note" role="alert">
          {TREE_UNAVAILABLE_COPY}
        </p>
      ) : (
        <>
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
                  // Visual proximity is the whole affordance for a sighted
                  // owner and nothing at all for a screen-reader user, who
                  // would otherwise hear "Active wiki, combobox" with no hint
                  // that the switch leaves Pages and Sources where they are.
                  // Both are rendered under the same gate, so the id always
                  // resolves — but it is written from the same condition so a
                  // future edit cannot leave it dangling.
                  aria-describedby={selectDescribedBy}
                  value={value}
                  disabled={switching}
                  // `aria-disabled`, not `disabled`: the control keeps its place
                  // in the tab order, so a keyboard user can still reach it and
                  // still hear which Wiki is active. Omitted rather than set to
                  // "false" on a writable deployment, so the hover face below
                  // can key off the attribute's presence.
                  aria-disabled={readOnly || undefined}
                  onChange={(event) => {
                    // Committing nothing IS the refusal — see the `readOnly`
                    // prop's docstring for why the control puts itself back.
                    if (readOnly) return;
                    void switchWiki(event.target.value);
                  }}
                >
                  {/* Name alone is not unique, so the label carries the
                      template, the created date and the head of the id — one
                      spelling, shared with the delete picker below (DW-148). */}
                  {wikis.map((wiki) => (
                    <option key={wiki.id} value={wiki.id}>
                      {wikiOptionLabel(wiki)}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button
              type="button"
              ref={newRef}
              className="wb-wiki-switch-new"
              aria-disabled={readOnly || undefined}
              aria-describedby={readOnly ? readOnlyNoteId : undefined}
              onClick={() => {
                // No dialog at all: the create it opens onto is a 403, and a
                // form the owner fills in before being refused is worse than a
                // control that says up front it will not run.
                if (readOnly) return;
                setCreateError(null);
                setCreateOpen(true);
              }}
            >
              New Wiki
            </button>
          </div>
          {/* A Wiki is a lens, not a partition: switching swaps `purpose.md`
              and Schema into view while Pages and Sources stay put. The
              sentence describes the <select> and nothing else, so it tracks
              that control exactly — same gate, so it renders when and only when
              the switcher does, and never as a caption over a row that holds
              only `New Wiki`. Not an alert: nothing failed. */}
          {wikis.length > 0 && (
            <p id={scopeNoteId} className="wb-wiki-switch-note wb-wiki-switch-scope">
              {WIKI_SCOPE_COPY}
            </p>
          )}
          {/* AFTER the scope sentence, and ungated on `wikis.length`: `New Wiki`
              renders with or without a switcher and is refused either way, so
              this is the only thing on screen that explains why. Not an alert —
              nothing failed; it is the deployment's standing state. */}
          {readOnly && (
            <p
              id={readOnlyNoteId}
              className="wb-wiki-switch-note wb-wiki-switch-readonly"
            >
              {WIKI_READ_ONLY_COPY}
            </p>
          )}
        </>
      )}

      {/* Rename acts on the ACTIVE Wiki — the switcher's selection IS the
          target, so no second picker is needed. Delete cannot: see `deletable`.
          Both sit on their own row because three controls do not fit the 280px
          column beside the <select>. */}
      {!unavailable && current && (
        <div className="wb-wiki-switch-actions">
          <button
            type="button"
            className="wb-wiki-switch-action"
            disabled={switching}
            aria-disabled={readOnly || undefined}
            aria-describedby={readOnly ? readOnlyNoteId : undefined}
            onClick={() => {
              if (readOnly) return;
              setRenameName(current.name);
              setRenameError(null);
              setRenameOpen(true);
            }}
          >
            Rename Wiki
          </button>
          {wikis.length > 1 && (
            <button
              type="button"
              className="wb-wiki-switch-action"
              disabled={switching}
              aria-disabled={readOnly || undefined}
              aria-describedby={readOnly ? readOnlyNoteId : undefined}
              onClick={() => {
                // The one that matters most: without this the owner reads
                // "This deletes that wiki's purpose.md, Schema and Workspace
                // Purpose for good.", confirms it, and only then learns the
                // deployment was never going to run it.
                if (readOnly) return;
                setDeleteTargetId(deletable[0]?.id ?? "");
                setDeleteError(null);
                setDeleteOpen(true);
              }}
            >
              Delete Wiki
            </button>
          )}
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

      <ConfirmDialog
        open={renameOpen && current !== null}
        title="Rename Wiki"
        confirmLabel="Rename"
        cancelLabel="Cancel"
        busy={busy}
        error={renameError}
        fallbackFocusRef={newRef}
        confirmDisabled={!renameReady}
        onCancel={() => setRenameOpen(false)}
        onConfirm={() => {
          if (current) void rename(current, renameName);
        }}
        body={
          <>
            <label htmlFor={renameInputId} className="block font-medium">
              Wiki name
            </label>
            <input
              id={renameInputId}
              type="text"
              className="mt-1 w-full rounded-md border border-foreground/15 bg-background px-2 py-1"
              value={renameName}
              maxLength={MAX_WIKI_NAME_CHARS}
              disabled={busy}
              onChange={(event) => setRenameName(event.target.value)}
              // Enter is the whole keyboard path through a one-field dialog.
              // `CreateWikiDialog` gets it from the <form> it wraps its name
              // field in; this input sits bare in a ConfirmDialog body, so it
              // has to say so. Gated on exactly what Rename is gated on, or the
              // key would reach past a disabled button.
              //
              // `isComposing` is the IME guard: typing a CJK name commits each
              // candidate with Enter, and that keystroke reaches this handler
              // too. Without the check the first commit would submit a
              // half-composed name — the reason the platform exposes the flag.
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                if (busy || !renameReady) return;
                event.preventDefault();
                if (current) void rename(current, renameName);
              }}
            />
            <p className="mt-2">
              Renames this wiki and the heading of its purpose.md. The Scenario
              Template, Schema, Pages and Sources are not changed.
            </p>
          </>
        }
      />

      <ConfirmDialog
        open={deleteOpen && deletable.length > 0}
        title="Delete Wiki"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        busy={busy}
        error={deleteError}
        fallbackFocusRef={newRef}
        confirmDisabled={deleteTarget === null}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          if (deleteTarget) void remove(deleteTarget);
        }}
        body={
          <>
            <label htmlFor={deleteSelectId} className="block font-medium">
              Wiki to delete
            </label>
            <select
              id={deleteSelectId}
              className="mt-1 w-full rounded-md border border-foreground/15 bg-background px-2 py-1"
              value={deleteTargetId}
              disabled={busy}
              onChange={(event) => setDeleteTargetId(event.target.value)}
            >
              {/* The same disambiguated label the switcher uses, and it matters
                  most here: two wikis called `Acme` offered as bare names make
                  an irreversible delete a coin flip. */}
              {deletable.map((wiki) => (
                <option key={wiki.id} value={wiki.id}>
                  {wikiOptionLabel(wiki)}
                </option>
              ))}
            </select>
            <p className="mt-2">
              This deletes that wiki’s purpose.md, Schema and Workspace Purpose
              for good. The active wiki cannot be deleted — switch to another
              one first. Pages and Sources are shared and are not removed.
            </p>
          </>
        }
      />
    </div>
  );
}
