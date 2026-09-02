"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CreateWikiDialog } from "@/components/CreateWikiDialog";
import { useWikiWriteLatch } from "@/components/workbench/WikiWriteLatch";
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
  /**
   * The two sentences that can sit under the switcher row, and TWO ids because
   * they are two nodes (DW-517) — see the render for why they cannot be one.
   */
  const errorNoteId = useId();
  const latchNoteId = useId();
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
  /**
   * A create, rename, delete or SWITCH whose OUTCOME IS UNKNOWN, and whose
   * server render has not arrived yet (DW-375, DW-409) — and, since DW-516,
   * the CANVAS CARD's create or re-template too.
   *
   * SHARED STATE, not this component's own (`WikiWriteLatch.tsx`). `page.tsx`
   * renders `WikiWorkbench` under the same provider as the shell that holds
   * this header, and both surfaces open `CreateWikiDialog` onto the same
   * `POST /api/wikis`. While each held a flag of its own, a latch raised here
   * left the card's `Create Wiki` fully live — and nothing enforces unique wiki
   * names, so one click seeded the second wiki the latch exists to prevent.
   * Six writes now, across two components, one door.
   *
   * The shared state carries the SENTENCE as well as the fact, so a control
   * this component dims for the CARD's write can still say which write is in
   * doubt — the three dialogs' `error` fallbacks and the `<select>`'s
   * description all resolve to it.
   *
   * A shared RELEASE means the first holder whose effect runs on the arriving
   * server render drops the latch for both; `release()` is idempotent, so the
   * other's effect is a no-op. What is NOT shared is which errors get cleared:
   * `raisedLatchRef` below is this surface's private answer to "was the
   * standing latch mine", and only that clears these four messages.
   *
   * None of the three dialogs closes on that path — the owner's name is still in
   * the field, and the sentence explaining what happened is inside the overlay —
   * so all three are left standing with a live confirm over a write that may
   * already have landed. Pressing it again seeds a SECOND wiki, renames a wiki
   * twice, or paints the 404 of a repeat DELETE over a delete that succeeded.
   *
   * The fourth write has no dialog at all and is the one that costs most: the
   * `<select>` carries only `disabled={switching}`, which `finally` clears, so
   * the moment the unconfirmed sentence appears the picker is live again and a
   * second `PUT /api/wikis/current` can go out over a first nobody can account
   * for. The active wiki decides which `schema.md` every prompt executes, and
   * two of those settling out of order leaves the shell on whichever answered
   * last. So a switch latches here too, and `switchWiki` reads the flag.
   *
   * The latch rides `confirmDisabled` and NEVER `busy`: `busy` also kills
   * Cancel, Esc and the outside-click dismiss, and the sentence the owner has
   * just read tells them to go and look at the screen. A modal they cannot
   * dismiss is not a screen they can look at.
   *
   * ONE flag for all four, because a server render answers all four questions
   * at once: it names every wiki, every name and which one is live, so the
   * single arrival that releases a create releases a switch on the same commit.
   * NOT because only one write can be in flight — that is false in both
   * directions and P1's exception below depends on saying so. `switchWiki`
   * guards on `switching`, never on `busy`, and the `<select>` is not disabled
   * by `busy` either, so a switch can start mid-rename; and `New Wiki` is the
   * one action control WITHOUT `disabled={switching}`, so a create can start
   * mid-switch. What the shared flag costs is that a latch raised by one write
   * shuts the others' confirms too — deliberate, since an unknown outcome
   * anywhere here means the list on screen may be wrong for all of them.
   *
   * It is also what DROPS the sentence each write raised it beside: see the
   * release effect below.
   *
   * Mounted BARE — with no provider above it, which is how this component's own
   * suite renders it — the hook falls back to component-local state, so the
   * LATCH MECHANICS are exactly what they were: the same writes raise it, the
   * same release effect drops it, and nothing waits on a surface that is not
   * there. (The picker's DW-517 announcement rides on it either way, which is a
   * change a bare mount sees too.)
   */
  const {
    latched,
    message: latchMessage,
    raise: raiseLatch,
    release: releaseLatch,
  } = useWikiWriteLatch();
  /**
   * "THIS switcher raised the standing latch", mirrored where the release
   * effect can READ it without DEPENDING on it (DW-429).
   *
   * The effect has to know whether the latch was up AND whether it was ours,
   * because that is what separates a sentence the arriving render makes stale
   * from a stated refusal the owner is still reading — a 400 the route answered
   * is not made untrue by somebody else's page write moving `wikis`, and since
   * DW-516 not by the canvas card's latch releasing either. But the latch
   * cannot join `[wikis, currentWikiId]`: the effect would then fire on the very
   * commit that RAISES it and drop it again before the write it is guarding has
   * any answer. A ref changes no identity and triggers no effect, so it carries
   * the fact across without arming anything — which is why every `raiseLatch`
   * below sets it on the adjacent line.
   */
  const raisedLatchRef = useRef(false);

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

  /**
   * The confirms come back when a server render lands — whatever it says.
   *
   * `wikis` is a fresh array on every server render (`page.tsx` reads the
   * registry each time), so its identity is the arrival signal; `currentWikiId`
   * is here because a delete of the active wiki moves that and need not change
   * the array's length. This is `WikiWorkbench`'s `awaitingCreate` idiom exactly.
   *
   * Deliberately NOT "when the wiki appears / disappears / is renamed": a
   * refresh that answers WITHOUT the change must still give the owner their
   * button back, rather than leaving a control dead with no explanation. What
   * the render says is then on screen for them to read, which is what the
   * unconfirmed sentence sent them to do.
   *
   * And the SENTENCE goes with the latch (DW-429) — all four of them, because
   * one flag raised whichever one is showing and this render answered all four
   * questions at once. "The outcome is unknown, go and look at the screen" is a
   * statement about a question that has just been settled; leaving it standing
   * over a confirm this same commit made live tells the owner their write is
   * still in doubt while the button beside it says otherwise. That is what the
   * three openers below already promise when they KEEP their error across a
   * dismiss-and-reopen: the pair is dropped together, and here is where.
   *
   * Gated on the ref, never cleared unconditionally: a stated refusal ("Wiki
   * name is required.") is not made untrue by an unrelated server render, and
   * wiping it would leave the owner a live confirm and no idea what went wrong.
   * Since DW-516 that gate carries a second job — it is also what stops a latch
   * the CANVAS CARD raised and released from wiping a stated refusal standing
   * here. Only the surface that raised the standing latch clears its own
   * errors, and this ref is this surface's answer.
   *
   * `releaseLatch` is safe in the dependency list precisely because it is
   * stable, which `latched` and `latchMessage` are not — either would fire this
   * effect on the commit that RAISES the latch. The release is idempotent, so
   * the card's effect running on the same render is a no-op.
   */
  useEffect(() => {
    if (!raisedLatchRef.current) return;
    raisedLatchRef.current = false;
    releaseLatch();
    setCreateError(null);
    setRenameError(null);
    setDeleteError(null);
    setError(null);
  }, [wikis, currentWikiId, releaseLatch]);

  async function switchWiki(id: string) {
    // `switching` is the in-flight half; the shared latch is the half that
    // OUTLIVES it (DW-409). `finally` clears `switching` as soon as the aborted
    // PUT lands here, so without the latch the picker is live again the instant
    // the unconfirmed sentence appears — and a second PUT issued over one whose
    // outcome nobody knows can settle out of order, leaving the shell on a wiki
    // the owner had already left and every prompt on its `schema.md`.
    if (switching || latched) return;
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
      // NOTHING CAME BACK, so the active wiki may ALREADY have moved (DW-283):
      // every prompt on this shell would then be executing a different
      // `schema.md` than the tree, the header and this control are describing.
      //
      // Cause-neutral deliberately. Since DW-374 this branch is also reached by
      // a dropped connection and by a gateway that gave up, and the reason to
      // refresh is the same in all three: the request left and no verdict came
      // back. Naming the deadline here would be wrong for two of them.
      //
      // The latch is the other half, and it is what keeps the rolled-back
      // `<select>` above from being immediately overwritten by a second switch:
      // the picker keeps `disabled={switching}` alone, so its refusal is
      // `switchWiki`'s early return, and the door stays shut until a server
      // render says which wiki is actually live. The refresh below is what
      // fetches that render — and releasing the latch is what drops the
      // sentence beside it.
      if (unconfirmed) {
        // The other three sentences go NOW rather than on release, because this
        // latch is the SWITCH's and the flag is shared: it shuts the create,
        // rename and delete confirms too, and a stated refusal any of them left
        // standing ("A wiki with that name already exists.") would then be
        // re-presented by its opener beside a dead button — attached to a
        // request that is not the one in doubt. The openers'
        // `if (!latched)` guards keep an error precisely because the latch
        // is assumed to be that dialog's own; they cannot tell whose it is, and
        // this is the one place that is known.
        //
        // ONLY when THIS switcher did not already raise the standing latch, and
        // read off the ref. `New Wiki` is the one action control without
        // `disabled={switching}`, so a create HERE can latch while a switch is
        // still in flight — and that dialog's sentence is the one the owner is
        // actually reading, so this must not reach it. `latched` cannot answer
        // the question: it is the render snapshot this async closure captured
        // before the PUT left, so a write that latched in the meantime is
        // invisible to it. The ref is current.
        //
        // The condition asks ONLY about this surface's own raises, and sharing
        // the latch (DW-516) is what makes that the right question rather than
        // an accident of the old private flag. A latch the CANVAS CARD raised
        // is somebody else's: the sentence the owner is reading is in the
        // card's overlay, and these three are stale refusals of this switcher's
        // own dialogs — exactly the ones that would otherwise be re-presented
        // beside a confirm dead for a write they have nothing to do with,
        // because `error={createError ?? …}` makes a dialog's own message
        // outrank the shared fallback. So they are cleared then too.
        if (!raisedLatchRef.current) {
          setCreateError(null);
          setRenameError(null);
          setDeleteError(null);
        }
        raiseLatch(message);
        raisedLatchRef.current = true;
        router.refresh();
      }
    } finally {
      setSwitching(false);
    }
  }

  async function create(input: { name: string; scenario: CreatableScenario }) {
    // BEHIND the confirm's own `disabled={busy}`, never instead of it. The
    // button being dead is what the owner sees; this is what makes a second
    // entry impossible — `CreateWikiDialog.submit` also carries Enter, and a
    // handler that only the pointer path guards is a handler with a hole.
    if (busy || latched) return;
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
      if (unconfirmed) {
        // Nothing came back, so a wiki may exist that this list does not name —
        // and a second Create, on a dialog that stays open holding the owner's
        // name, would seed another one. The confirm goes dead until a server
        // render says what is actually there; the refresh is what fetches it.
        raiseLatch(message);
        raisedLatchRef.current = true;
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function rename(wiki: WikiRecord, name: string) {
    // Two ways in — the confirm button and the input's Enter — so the guard
    // sits on the handler rather than on either of them. A second PATCH could
    // settle out of order and leave the registry naming whichever answer
    // happened to land last.
    if (busy || latched) return;
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
      if (unconfirmed) {
        // The registry may already hold the new name while this <select> and the
        // canvas card go on showing the old one — and a second PATCH issued from
        // the still-open dialog could settle out of order behind the first.
        raiseLatch(message);
        raisedLatchRef.current = true;
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(wiki: WikiRecord) {
    // The irreversible one. A second DELETE issued behind the first answers 404
    // and paints a failure over an operation that in fact succeeded — and the
    // `refocusNewRef` bookkeeping below would run twice against one list.
    if (busy || latched) return;
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
      if (unconfirmed) {
        // The irreversible one, and therefore the one where a flat "couldn't
        // delete" is worst: the wiki may be gone. A second DELETE from the
        // still-open dialog would answer 404 and paint a failure over an
        // operation that in fact succeeded, so Delete goes dead; the refresh
        // replaces the list underneath — the same `wikis.length` gate that hides
        // the Delete control does the rest.
        raiseLatch(message);
        raisedLatchRef.current = true;
        router.refresh();
      }
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
  /**
   * The LATCH's own sentence under the switcher row — a description, never an
   * announcement (DW-517).
   *
   * Rendered SEPARATELY from the `<p role="alert">` that carries `error`, and
   * not as one node switching its role, for two reasons. A single node would
   * have to gain and lose `role="alert"` on an element React keeps and reuses,
   * and a live region that acquires its role while its text is already on
   * screen is not reliably announced — the announcement is a side effect of the
   * text ARRIVING in a region that already exists. And the two sentences can be
   * true at once about DIFFERENT writes: a stated switch refusal the route
   * answered ("That wiki no longer exists.") standing while the canvas card
   * raises an unconfirmed latch. The picker is then dimmed for the LATCH, so
   * the latch's sentence is the one that has to describe it, while the answered
   * 404 keeps its own alert node and stays on screen.
   *
   * No alert role here at all: the overlay that raised the latch is already
   * announcing exactly these words, and a second live region would say them
   * twice — and break every `findByRole("alert")` that expects one.
   *
   * Suppressed when `error` is already showing this same text, which is the
   * switch-raised case: `switchWiki` puts the sentence in `error` on the way
   * up, so the alert node is already carrying it and a second copy would be
   * the duplicate this is meant to avoid.
   *
   * Gated on the SELECT'S OWN gate, because the `<select>` is the only thing it
   * describes. With no wikis yet there is no picker to refuse, and the surface
   * that IS refusing — the canvas card's empty-state `Create Wiki` — is already
   * rendering this same sentence beside itself (DW-430); a second copy here
   * would describe nothing and say it twice.
   */
  const latchNoteShown = latched && wikis.length > 0 && latchMessage !== error;
  // `aria-describedby` takes a space-separated LIST, so the read-only sentence
  // is APPENDED to the scope sentence rather than replacing it: both are true at
  // once. Without it the switcher is the one refused control here with no reason
  // in its description — it would announce as "Active wiki, combobox, dimmed"
  // plus a sentence about what a switch shows, while `WIKI_READ_ONLY_COPY`
  // (which says wikis cannot be SWITCHED) was never reached.
  //
  // The LATCH's sentence joins the same list while and only while the latch is
  // up (DW-517). Until then a latched picker announced as an ordinary live
  // combobox: `disabled={switching}` was already false, `aria-disabled` spoke
  // only for `readOnly`, the change event was swallowed by `switchWiki`'s early
  // return and React put the value back — a refusal in total silence. The
  // sentence is the one `writeFailure` composed for whichever write is in
  // doubt, on THIS surface or on the canvas card.
  //
  // WHICHEVER NODE IS CARRYING THAT SENTENCE, which is the whole point of the
  // pick below: the latch note when it renders, and otherwise the alert node —
  // the switch-raised case, where `error` IS the latch's sentence and the two
  // would be identical. Nothing at all while the latch is down, so a stated
  // refusal on its own describes nothing: the picker is live then, and the
  // dimming a description explains does not exist.
  const latchDescribedById = latched
    ? latchNoteShown
      ? latchNoteId
      : error !== null
        ? errorNoteId
        : null
    : null;
  const selectDescribedBy =
    [
      wikis.length > 0 ? scopeNoteId : null,
      readOnly ? readOnlyNoteId : null,
      latchDescribedById,
    ]
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
          {/* Labelled, not placeholder-labelled (accessibility floor) — and
              VISIBLY labelled (DW-179). The label was clipped to `wb-sr-only`
              while the retired canvas card carried the only visible `Active
              wiki` caption; DW-33 removed that card control and nothing
              re-examined the tradeoff, so a sighted owner met a bare combobox.
              It sits ABOVE the row rather than beside the <select>: the column
              is 280px and has no room for a label next to the control and the
              button.

              The caps are CSS (`text-transform` on `.wb-wiki-switch-label`) and
              never retyped text, so the accessible name is still the DOM string
              `Active wiki` — the ~30 `getByLabelText("Active wiki")` call sites
              keep resolving, and a screen reader does not spell it out letter by
              letter. Same `wikis.length > 0` gate as the control it labels: no
              caption over a row that holds only the create button. */}
          {wikis.length > 0 && (
            <label htmlFor={selectId} className="wb-wiki-switch-label">
              Active wiki
            </label>
          )}
          <div className="wb-wiki-switch-row">
            {wikis.length > 0 && (
              <>
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
                  //
                  // `latched` joins `readOnly` here and NEVER `disabled`
                  // (DW-517), for the reason the prop's docstring gives in
                  // full: a keyboard owner must still be able to reach this
                  // control and read which wiki is active — which is exactly
                  // what the unconfirmed sentence has just sent them to do.
                  // What it buys is that the refusal is ANNOUNCED: the control
                  // reads as dimmed, and `selectDescribedBy` above carries the
                  // sentence saying why. `.wb-wiki-switch-select[aria-disabled]`
                  // already paints the dimmed face, so no new rule is needed.
                  aria-disabled={readOnly || latched || undefined}
                  onChange={(event) => {
                    // Committing nothing IS the refusal — see the `readOnly`
                    // prop's docstring for why the control puts itself back.
                    if (readOnly) return;
                    // A LATCHED switch is refused by that same route (DW-409):
                    // `switchWiki` returns early on the shared latch, commits no
                    // state, and React re-applies `value` — so the picker is
                    // back on the wiki the server last confirmed with no second
                    // affordance to build and nothing here to put it back by
                    // hand. The sentence beneath the control is what explains
                    // it, and `aria-disabled` above is what makes the refusal
                    // audible rather than a value that silently snaps back.
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
                // The standing message SURVIVES a reopen while the latch is up.
                // The unconfirmed sentence invites exactly this move — dismiss
                // the dialog, look at the screen — and clearing it here would
                // hand the owner back a dead Create with nothing on screen
                // saying why. The release effect drops both together, because a
                // server render is what makes both stale at once.
                if (!latched) setCreateError(null);
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
              // Kept while the latch is up — see the New Wiki opener above.
              if (!latched) setRenameError(null);
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
                // Kept while the latch is up — see the New Wiki opener above.
                // It matters most here: the wiki may already be gone, and a
                // reopened Delete with no sentence beside it reads as a fresh
                // start on an operation that may have finished.
                if (!latched) setDeleteError(null);
                setDeleteOpen(true);
              }}
            >
              Delete Wiki
            </button>
          )}
        </div>
      )}

      {/* The SWITCH's own failure — unchanged except for the id, which is what
          `selectDescribedBy` points the `<select>` at when this node is the one
          carrying the latch's sentence. It keeps `role="alert"` unconditionally:
          nothing else on screen announces a failed switch, and a role that came
          and went would leave the region unreliable in both directions. */}
      {error && (
        <p id={errorNoteId} role="alert" className="wb-wiki-switch-error">
          {error}
        </p>
      )}
      {/* And the latch's sentence, when it is not already the one above — see
          `latchNoteShown` for why this is a second node and not a role toggle
          on the first. Description-only: the overlay that raised the latch owns
          the announcement. */}
      {latchNoteShown && (
        <p id={latchNoteId} className="wb-wiki-switch-error">
          {latchMessage}
        </p>
      )}

      <CreateWikiDialog
        open={createOpen}
        busy={busy}
        // Cancel and Esc stay live behind it — see the shared latch above.
        confirmDisabled={latched}
        // Falls back to the SWITCHER's sentence while the latch is up, because
        // the latch is shared and this dialog may be dead over a write from the
        // OTHER SURFACE entirely (DW-409, DW-516). The switcher's own `<p role="alert">` sits behind this
        // overlay's `fixed inset-0` backdrop and outside its `aria-modal`
        // subtree, so it is covered for a sighted owner and unreachable for a
        // screen-reader one — leaving exactly the dimmed-control-that-says-
        // nothing shape DW-430 removes on the canvas card. `createError` still
        // outranks it: this dialog's own refusal is the more specific answer.
        // A STATED switch refusal raises no latch, so it never leaks in here.
        error={createError ?? (latched ? latchMessage : null)}
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
        // The switcher's sentence stands in while a switch holds the shared
        // latch — see the create dialog above for why the alert behind this
        // backdrop cannot do that job.
        error={renameError ?? (latched ? latchMessage : null)}
        fallbackFocusRef={newRef}
        confirmDisabled={!renameReady || latched}
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
              // `busy` ALONE. The latch is the confirm's and nothing else's —
              // see the shared latch above, which says so in as many words. A disabled
              // input leaves the tab order, so a keyboard owner could not reach
              // the name they were about to submit, let alone correct it; and
              // the sentence they have just read tells them to go and look at
              // what is on screen, which includes this field.
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
                // Gated on exactly what Rename is gated on — the shared latch
                // included. The field stays LIVE (see `disabled` above), so this
                // is the only thing standing between a keystroke in an editable
                // input and a second PATCH; a rule the button carries and the key
                // does not is a guard with a hole.
                if (busy || latched || !renameReady) return;
                event.preventDefault();
                if (current) void rename(current, renameName);
              }}
            />
            {/* The confirm NAMES its target (DW-284), on DW-148's premise: with
                "this wiki" in the body, a rename aimed at the wrong wiki reads
                identically to the right one. `wikiOptionLabel` and not
                `current.name` — one disambiguated spelling, the same the
                switcher options and the delete picker use, because name alone
                is not unique. `open` is gated on `current !== null`, so no body
                without a target is ever SHOWN — but `body` is a prop, built on
                every render whether the dialog is open or not, so the call still
                has to survive a null `current`. */}
            <p className="mt-2">
              Renames <strong>{current && wikiOptionLabel(current)}</strong> and the
              heading of its purpose.md. The Scenario Template, Schema, Pages and
              Sources are not changed.
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
        // Same fallback as the two dialogs above, and it matters most here:
        // this confirm names an irreversible delete, so a dead button with no
        // sentence in the overlay reads as the operation having been refused.
        error={deleteError ?? (latched ? latchMessage : null)}
        fallbackFocusRef={newRef}
        confirmDisabled={deleteTarget === null || latched}
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
