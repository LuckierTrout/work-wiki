"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CreateWikiDialog } from "@/components/CreateWikiDialog";
import { useWikiWriteLatch } from "@/components/workbench/WikiWriteLatch";
import { useWorkbenchData } from "@/components/workbench/WorkbenchData";
import {
  CREATABLE_SCENARIOS,
  SCENARIO_LABELS,
  WIKI_ARTIFACT_FILES,
  wikiOptionLabel,
  type CreatableScenario,
} from "@/lib/wiki-scenarios";
import { PREVIEW_UNSELECTED_COPY } from "@/lib/workbench-preview";
import { send, writeFailure } from "@/lib/workbench-request";
import {
  WIKI_CREATE_READ_ONLY_COPY,
  WIKI_EMPTY_COPY,
  WIKI_TEMPLATE_READ_ONLY_COPY,
  WIKI_UNAVAILABLE_COPY,
} from "@/lib/workbench-tree";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The Wiki surface on the owner's landing page — the Wiki-mode canvas.
 *
 * It owns the artifact receipt (`purpose.md`, `schema.md`), the wiki's name and
 * scenario heading, `Change template`, and the {@link WIKI_EMPTY_COPY} empty
 * state whose `Create Wiki` action lands the owner somewhere real. It does NOT own
 * switching: the left column header's `WikiSwitcher` is the single owner of the
 * active-wiki `<select>` and of the persistent `New Wiki` control (DW-33), so
 * one viewport never offers two of either.
 *
 * The seeded file names are inert text here — opening one into a rendered
 * Preview is the shell's docked `PreviewColumn`. {@link PREVIEW_UNSELECTED_COPY}
 * is this card's undocked stand-in for that column and is mutually exclusive
 * with it: `wb-canvas-preview-note` is hidden by CSS while `.wb-shell` carries
 * `data-preview="true"` (DW-39), because the canvas reaches the shell as
 * `children` and cannot read that state as a prop.
 *
 * The SAME shell attribute also collapses the receipt's two-track grid to one
 * (DW-180), off the `wb-canvas-receipt-grid` hook below. Hiding a grid child
 * does not release its track: with only the `display: none` above, a docked
 * Preview left the receipt pinned at 320px beside an empty `1fr`. One
 * attribute, two consequences, and both decided in the stylesheet for the
 * reason the paragraph above gives.
 *
 * It takes NO PROPS (DW-174). Everything it renders is read from
 * `WorkbenchData` — the same context the header switcher reads — so a rename
 * or a switch made there reaches this card on the next render rather than only
 * on a remount. It used to seed `useState` from props behind a wiki-id `key` in
 * `page.tsx`; a Rename left the heading naming the old wiki because the key had
 * not moved, and the key itself was a second wire carrying facts the provider
 * already held.
 */

export function WikiWorkbench() {
  const router = useRouter();
  /**
   * The card's whole data input. `registryUnavailable` says the server could
   * not read the registry, so `wikis` is a degraded placeholder rather than an
   * observation: rendering the ordinary empty state on it would tell the owner
   * their wikis do not exist and invite them to create a duplicate — which
   * seeds a second wiki, makes it the active one, and moves every prompt onto
   * its template. Say the read failed instead.
   *
   * `readOnly` is `YOPEDIA_READONLY`, already on this context and already read
   * by the header switcher — so the card takes it from here rather than growing
   * the prop it deliberately does not have (DW-174). Both of its write actions
   * sit in front of routes that answer 403 on such a deployment.
   */
  const { wikis, currentWikiId, registryUnavailable, readOnly } =
    useWorkbenchData();
  /**
   * The SHARED unconfirmed-write latch, and the sentence it was raised beside
   * (DW-515, DW-516).
   *
   * Shared with the header `WikiSwitcher`, which `page.tsx` renders under the
   * same provider: both surfaces open `CreateWikiDialog` onto the same
   * `POST /api/wikis`, nothing enforces unique wiki names, and a latch that
   * shut only the surface that raised it left the other's create one click from
   * seeding the second wiki. It is also what `applyTemplate` raises now — see
   * there — so a re-template whose outcome nobody knows shuts every wiki write
   * on screen rather than only refreshing underneath a live `Overwrite`.
   *
   * `message` is `writeFailure`'s own sentence, never a copy constant, so a
   * control this card dims for the HEADER's write can still say why.
   */
  const {
    latched,
    message: latchMessage,
    raise: raiseLatch,
    release: releaseLatch,
    awaitingCreate,
    markCreate,
    clearCreate,
  } = useWikiWriteLatch();
  /**
   * Ids for the two standing refusal sentences below (DW-189, DW-282).
   *
   * Two, not one: `Change template` and this card's create action sit in
   * MUTUALLY EXCLUSIVE branches, so a single shared node would be unmounted for
   * whichever branch is not on screen and the surviving control's
   * `aria-describedby` would resolve to nothing at all.
   */
  const templateNoteId = useId();
  const createNoteId = useId();
  /**
   * The RETAINED unknown-outcome sentence's id (DW-430).
   *
   * A third id rather than a reuse of `createNoteId`: the read-only sentence and
   * this one are true independently — a writable deployment renders only this
   * one — and `aria-describedby` takes a LIST, so both can describe the opener
   * at once without either standing in for the other.
   */
  const createUnknownNoteId = useId();
  const [createOpen, setCreateOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [pendingScenario, setPendingScenario] = useState<CreatableScenario>("business");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  /**
   * A create that SUCCEEDED and whose server render has not arrived yet
   * (DW-407) — and, since DW-516, nothing else.
   *
   * The card is not optimistic, so on success the dialog closes and the empty
   * state — {@link WIKI_EMPTY_COPY} and an enabled `Create Wiki` — is still on
   * screen for the length of `router.refresh()`. Pressing it there seeds a
   * SECOND wiki and makes it active, moving every prompt onto its template.
   *
   * SHARED since DW-721, and still SENTENCE-LESS. It used to be local on the
   * argument that it shuts one control and has nothing to say for itself; the
   * second half of that is why it is not folded into the latch's `message`, but
   * the first half was simply wrong. The header `WikiSwitcher` opens the SAME
   * `POST /api/wikis`, so a create this card landed left the header's `Create`
   * fully live for the length of the refresh — one click there seeds the
   * duplicate wiki, exactly as an unconfirmed one did before DW-516. It is read
   * off {@link useWikiWriteLatch} above and raised with `markCreate`.
   *
   * Both halves ride `confirmDisabled` and the opener's `disabled`, and NEVER
   * `busy`: `busy` also kills Cancel, Esc and the outside-click dismiss, and
   * the sentence the owner has just read tells them to go and look at the
   * screen. A modal they cannot dismiss is not a screen they can look at.
   *
   * The door stays shut until a new server render lands (the effect below),
   * which is the only thing that can say what is actually there.
   */
  /**
   * `awaitingCreate` mirrored where the release effect can READ it without
   * DEPENDING on it (DW-429).
   *
   * The effect below has to know whether this card's own latch was up, because
   * that is what separates a sentence the arriving render makes stale from a
   * stated refusal the owner is still reading — a 400 the route answered is not
   * made untrue by somebody else's page write moving `wikis`. But
   * `awaitingCreate` cannot join `[wikis, currentWikiId]`: the effect would then
   * fire on the very commit that RAISES the latch and drop it again before the
   * request it is guarding has any answer. A ref changes no identity and
   * triggers no effect, so it carries the fact across without arming anything —
   * which is exactly why every `markCreate` below sets it on the adjacent line.
   *
   * It stays a per-surface ref even though the flag itself is now shared
   * (DW-721): the effect must clear only what THIS card raised, for the same
   * reason `raisedLatchRef` exists below.
   */
  const awaitingCreateRef = useRef(false);
  /**
   * "THIS card raised the standing shared latch" — the same trick, for the half
   * that is no longer this component's state (DW-516).
   *
   * `latched` says a wiki write somewhere is unresolved; it does not say whose,
   * and the release effect below must clear only ITS OWN surface's errors. So
   * every `raiseLatch` call in this file sets this on the adjacent line, exactly
   * as `setAwaitingCreate` sets the ref above, and the effect reads it without
   * depending on it.
   */
  const raisedLatchRef = useRef(false);
  // Confirming Create Wiki unmounts the empty state that holds the opening
  // button, so the dialogs need somewhere else to put focus on close.
  const headingRef = useRef<HTMLHeadingElement>(null);
  /**
   * Set by a create that succeeded; consumed by the effect below.
   *
   * `useDialogA11y` only reaches `fallbackFocusRef` when the opener is already
   * DETACHED at close time, which is not what a create does any more: the close
   * happens first, focus is restored to a `Create Wiki` button that is still
   * mounted because the card is no longer optimistic, and only then does the
   * refresh replace the empty state and take that button away — dropping the
   * keyboard user on <body> with no dialog left to blame. So a successful
   * create moves focus EXPLICITLY, exactly as `WikiSwitcher.remove` does.
   */
  const refocusHeadingRef = useRef(false);

  const current = wikis.find((wiki) => wiki.id === currentWikiId) ?? null;
  // `current?.id`, not just `currentWikiId`: the record can also go away
  // UNDER the id (a refresh that answers a shorter list), and the dialogs
  // below are aimed at the record, not at the id.
  const currentId = current?.id ?? null;
  /**
   * The unknown-outcome sentence, retained OUTSIDE the overlay it was raised in
   * (DW-430).
   *
   * The message tells the owner to dismiss the dialog and look at the screen —
   * and until this existed, doing so destroyed the only explanation on the page
   * and left them in front of a dimmed `Create Wiki` that says nothing at all.
   * So the sentence is rendered in the empty state too, and the opener points
   * its description at it.
   *
   * Derived from the SHARED latch's message, never a copy constant: it IS the
   * sentence `writeFailure` composed, and a second spelling of it would drift.
   * Read off the latch rather than off `createError` since DW-516, so a create
   * the HEADER switcher left unconfirmed dims this opener with the header's own
   * sentence beside it rather than with nothing at all. `createError` could not
   * do that job in either direction: it also carries stated refusals, which
   * belong to the dialog and are gone from the empty state's problem the moment
   * it closes, and it never sees the other surface's write.
   */
  const createUnknownNote = latched ? latchMessage : null;
  // `aria-describedby` takes a space-separated LIST, so the two sentences are
  // JOINED rather than one replacing the other — the switcher's
  // `selectDescribedBy` idiom. In practice they never co-occur (a read-only
  // deployment's `create` returns before it can latch), but writing it as an
  // either/or would make that accident load-bearing.
  const createDescribedBy =
    [readOnly ? createNoteId : null, createUnknownNote ? createUnknownNoteId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  /**
   * A new active Wiki invalidates every decision these dialogs are holding.
   *
   * The remount key in `page.tsx` used to do this by destroying the component;
   * dropping it (DW-174) is what makes the reset explicit. Without it a
   * `Change template` confirm opened against one Wiki survives a header switch
   * while `current` moves underneath it — and `confirmDisabled` compares
   * `pendingScenario` to the NEW wiki's scenario, so a confirm that was correctly
   * dead can come alive and overwrite the purpose.md, Schema and Workspace
   * Purpose of a Wiki the owner never opened the dialog for.
   *
   * Keyed on the ACTIVE WIKI only — never on `wikis` as a whole. Any page write
   * moves the shell's `dataVersion` and re-renders the tree, and a dialog that
   * vanished mid-confirm because somebody ingested a source would be its own
   * defect.
   */
  useEffect(() => {
    setCreateOpen(false);
    setTemplateOpen(false);
    setCreateError(null);
    setTemplateError(null);
  }, [currentWikiId, currentId]);

  /**
   * The create door reopens when a server render lands — whatever it says —
   * and the sentence the latch was raised beside goes with it (DW-429).
   *
   * `wikis` is a fresh array on every server render (`page.tsx` reads the
   * registry each time), so its identity is the arrival signal. Deliberately
   * NOT "when the new wiki appears": a refresh that answers without it must
   * still give the owner their button back rather than leaving a control dead
   * with no explanation.
   *
   * `createError` and `templateError` are dropped WITH the latch and only with
   * it. "The outcome is unknown, go and look at the screen" is a statement
   * about a question this render has just answered, so leaving it standing over
   * a live confirm — in either dialog and in the empty state alike — tells the
   * owner their write is still in doubt while the button beside it says
   * otherwise. But clearing either unconditionally would wipe a STATED refusal
   * ("Wiki name is required.", a 404 from the template route) on any unrelated
   * refresh, so `raisedLatchRef` gates that half: it is true only when THIS
   * card put the standing latch up, so a header-raised latch releasing here
   * never touches a sentence this card's own route answered with.
   *
   * `templateError` joined `createError` with DW-515, which is what gave the
   * re-template a latch to release in the first place.
   *
   * `releaseLatch` is safe in the dependency list precisely because it is
   * stable; `latched` and `message` are not, and either would fire this effect
   * on the commit that RAISES the latch. The release itself is idempotent, so
   * the switcher's effect running on the same render is a no-op.
   */
  useEffect(() => {
    const raisedLatch = raisedLatchRef.current;
    if (!awaitingCreateRef.current && !raisedLatch) return;
    awaitingCreateRef.current = false;
    raisedLatchRef.current = false;
    clearCreate();
    if (!raisedLatch) return;
    releaseLatch();
    setCreateError(null);
    setTemplateError(null);
  }, [wikis, currentWikiId, releaseLatch, clearCreate]);

  // React flushes every effect TEARDOWN before any effect body, so this lands
  // after `useDialogA11y` has restored focus to the `Create Wiki` button — the
  // button the arriving server render is about to unmount. Doing it any earlier
  // would simply be overwritten.
  useEffect(() => {
    if (createOpen || !refocusHeadingRef.current) return;
    refocusHeadingRef.current = false;
    headingRef.current?.focus();
  }, [createOpen]);

  async function create(input: { name: string; scenario: CreatableScenario }) {
    // A BACKSTOP behind the opener's own refusal, not a replacement for it.
    // `readOnly` arrives on a SERVER render, so `router.refresh()` and
    // `DataVersionWatcher` can flip it to true while this dialog is already
    // open — and the reset effect above keys on the active wiki, which such a
    // refresh need not move. Without this the owner's Create would POST into a
    // 403 the surface has meanwhile started refusing on screen.
    if (readOnly) return;
    // Behind `CreateWikiDialog`'s own `disabled={busy || confirmDisabled}` and
    // its `submit`'s Enter guard, never instead of them — a second POST seeds a
    // second wiki. Both latches ride ALONGSIDE `busy` because they shut the
    // same door for different lengths of time: `busy` for the length of the
    // request, the latches until a server render lands after one whose outcome
    // nobody knows — and the dialog is still open then, with `busy` back to
    // false. `latched` is the SHARED one, so a create the header switcher left
    // unconfirmed refuses this POST too (DW-516).
    if (busy || awaitingCreate || latched) return;
    setBusy(true);
    setCreateError(null);
    try {
      const { wiki } = await send<{ wiki?: WikiRecord }>("/api/wikis", {
        method: "POST",
        body: JSON.stringify(input),
      });
      // A 2xx whose body is not the documented shape must not reach state: a
      // refresh fired on it would close the dialog over a create that never
      // happened, leaving the empty state behind and no message at all.
      if (!wiki?.id) throw new Error("Couldn’t create the wiki.");
      // Deliberately NOT optimistic, for the reason `WikiSwitcher.create`
      // states: the provider is this card's single source, and a record written
      // into local state would be a second one. The empty state stays on screen
      // for the length of the refresh — stale but real, and with its one action
      // shut so the owner cannot seed a second wiki into that window.
      markCreate();
      awaitingCreateRef.current = true;
      // Claimed BEFORE the close, consumed by the effect that runs once the
      // dialog has finished restoring focus to the doomed opener.
      refocusHeadingRef.current = true;
      setCreateOpen(false);
      // The page is force-dynamic and this seeded a new wiki — its own
      // purpose.md, Schema and Workspace Purpose — and made it active, so the
      // wiki-derived server output is stale until the tree is refetched.
      router.refresh();
    } catch (cause) {
      const { message, unconfirmed } = writeFailure(cause, "create the wiki");
      setCreateError(message);
      if (unconfirmed) {
        // NOTHING CAME BACK, so this POST may have SEEDED A WIKI (DW-283) —
        // a fired deadline, a dropped connection or a gateway that gave up
        // alike, which since DW-374 all arrive here and all mean the same one
        // thing: the request left and no verdict came back.
        //
        // Two things follow, and neither is optional. The empty state behind
        // this dialog still shows `WIKI_EMPTY_COPY` and still offers a Create
        // Wiki button — pressing it now would seed a second wiki and move every
        // prompt onto its template — so the door is held shut exactly as a
        // succeeding create holds it, until a server render says what is
        // actually there. And the refresh is what fetches that render: without
        // it the owner is told the outcome is unknown in front of a screen that
        // will never resolve it.
        //
        // The SHARED latch, not `awaitingCreate` (DW-516): the header
        // switcher's `New Wiki` opens onto this same route, so a door shut only
        // here is a door with another frame standing open beside it. The
        // sentence rides with it so every control either surface dims can say
        // which write is in doubt.
        raiseLatch(message);
        raisedLatchRef.current = true;
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function applyTemplate() {
    // Same backstop as `create`, and it matters more here: a mid-flight flip to
    // read-only leaves an already-open DESTRUCTIVE confirm on screen, and its
    // Overwrite would post into the 403 this change exists to stop AFTER the
    // owner has agreed to a rewrite that discards purpose.md and the Workspace
    // Purpose for good. (The Schema alone survives, as a History revision
    // DW-213 records — which is why the confirm names the two halves apart.)
    if (readOnly) return;
    if (!current) return;
    // Behind the confirm's `disabled={busy}`. A second POST rewrites this
    // wiki's purpose.md, Schema and Workspace Purpose all over again.
    //
    // `latched` is the DW-515 half. A re-template whose outcome nobody knows
    // used to refresh underneath a confirm that stayed live: the dialog does
    // not close on that path, `busy` is back to false by the time the sentence
    // appears, and the reset effect keys on the active wiki — which a
    // re-template never moves — so the owner was left pressing `Overwrite`
    // again under a stale "the outcome is unknown" alert, over a card the
    // refresh may already have moved onto the new scenario. Idempotence is not
    // the answer: the second POST rewrites purpose.md and the Workspace Purpose
    // from the template a second time, discarding anything the first one may
    // have already replaced them with.
    if (busy || latched) return;
    setBusy(true);
    setTemplateError(null);
    try {
      const { wiki } = await send<{ wiki?: WikiRecord }>(
        `/api/wikis/${encodeURIComponent(current.id)}/template`,
        { method: "POST", body: JSON.stringify({ scenario: pendingScenario }) },
      );
      // A 2xx whose body is not the documented shape must not close the dialog:
      // the refresh below would then paint the OLD template as if the overwrite
      // had landed, with nothing on screen saying otherwise.
      if (!wiki?.id) throw new Error("Couldn’t apply the template.");
      setTemplateOpen(false);
      // The refreshed server render is what moves this card onto the new
      // template — there is no local copy of the record to replace.
      router.refresh();
    } catch (cause) {
      // Into the dialog, not the section: the overlay stays open on failure
      // and its backdrop covers everything this component renders behind it.
      const { message, unconfirmed } = writeFailure(cause, "apply the template");
      setTemplateError(message);
      // NOTHING CAME BACK — a fired deadline, a dropped connection or a gateway
      // that gave up, all of which reach here since DW-374 — so the overwrite
      // may have landed. This card would otherwise go on naming the OLD
      // template beside a message that does not claim it survived.
      //
      // And the latch goes up with the refresh (DW-515). It used to be argued
      // that a re-template needs none because the confirm is idempotent per
      // scenario; that is only true of the SCHEMA, which History keeps. A
      // repeat overwrite rewrites purpose.md and the Workspace Purpose from the
      // template with nothing kept, so a second press over an unresolved first
      // one can destroy the very bytes the first one may have already written.
      // The shared latch is what shuts `Overwrite` — and, because the sentence
      // rides with it, what lets the header's controls say why they went dim
      // too.
      if (unconfirmed) {
        raiseLatch(message);
        raisedLatchRef.current = true;
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wb-canvas-pad" aria-labelledby="wiki-workbench-heading">
      {/* h2, not h1: the Workbench shell's product title owns the page's h1. */}
      <h2
        ref={headingRef}
        id="wiki-workbench-heading"
        tabIndex={-1}
        className="text-lg font-semibold text-foreground outline-none"
      >
        Wiki
      </h2>

      {registryUnavailable ? (
        // NOT the empty state: `WIKI_EMPTY_COPY` would be a claim about the
        // registry that this render cannot make, and its Create Wiki button
        // would seed a duplicate wiki and move every prompt onto its template
        // on the strength of a read error.
        <div className="mt-4 rounded-xl border border-foreground/15 p-6">
          <p role="alert" className="text-sm text-foreground/60">
            {WIKI_UNAVAILABLE_COPY}
          </p>
        </div>
      ) : !current ? (
        <div className="mt-4 rounded-xl border border-foreground/15 p-6">
          <p className="text-sm text-foreground/60">{WIKI_EMPTY_COPY}</p>
          <button
            type="button"
            className={`btn primary mt-4${readOnly ? " opacity-60" : ""}`}
            // The window this card can seed a duplicate wiki in: a create has
            // gone out — landed, or with nobody able to say — the refresh has
            // not come back, and `WIKI_EMPTY_COPY` may already be false. See
            // `awaitingCreate` for both halves.
            //
            // `disabled`, not `aria-disabled`: this is a transient in-flight
            // state, like `switching` in the header, and it lifts on its own
            // when the server render lands. That is the whole reason — NOT that
            // it needs no explanation, which is what this comment used to
            // claim. It does need one (DW-430), and the note below gives it.
            //
            // Which is why that note is ordinary empty-state text and not just
            // a description: `disabled` takes the button out of the tab order,
            // so nothing ever moves focus here and a sentence reachable only
            // through `aria-describedby` would be a sentence nobody is read.
            // On screen it explains the dimming to everyone; the description
            // ties the two together for anyone who reaches the button by other
            // means.
            disabled={awaitingCreate || latched}
            // The deployment's standing refusal, which is the opposite case:
            // `POST /api/wikis` has answered 403 since before this card existed,
            // and `disabled` here would take the owner's only explanation of the
            // empty state out of the tab order along with the button. See
            // `WikiSwitcherProps.readOnly` for the convention.
            aria-disabled={readOnly || undefined}
            // Both sentences, joined — see `createDescribedBy`, and see
            // `disabled` above for why the latched one is also on screen in its
            // own right rather than living only in this attribute.
            aria-describedby={createDescribedBy}
            onClick={() => {
              // BEFORE the dialog opens, never after: a form the owner fills in
              // and submits before being refused is worse than a control that
              // says up front it will not run.
              if (readOnly) return;
              // `latched` included, so a write the HEADER left unconfirmed
              // refuses this opener too — the dialog it would open onto is
              // dead, and offering it is offering a form that cannot submit.
              if (awaitingCreate || latched) return;
              setCreateError(null);
              setCreateOpen(true);
            }}
          >
            Create Wiki
          </button>
          {readOnly && (
            <p
              id={createNoteId}
              className="mt-3 text-sm text-amber-700 dark:text-amber-400"
            >
              {WIKI_CREATE_READ_ONLY_COPY}
            </p>
          )}
          {/* Why the button above is dead, surviving the dismissal the sentence
              itself invites. NOT `role="alert"`: the dialog's own alert already
              owns that channel and is on screen at the same moment — a second
              one would announce the same sentence twice and break every
              `findByRole("alert")` that expects one. Muted, not amber: this is
              transient, unlike the deployment's standing refusal above. */}
          {createUnknownNote && (
            <p id={createUnknownNoteId} className="mt-3 text-sm text-foreground/60">
              {createUnknownNote}
            </p>
          )}
        </div>
      ) : (
        <div className="wb-canvas-receipt-grid mt-4 grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <div className="rounded-xl border border-foreground/15 p-4">
            {/* Which Wiki this card describes, and nothing to change it with:
                the switcher and New Wiki live in the left column header, which
                is the single owner of both (DW-33). */}
            <div>
              <p className="text-sm font-semibold text-foreground">{current.name}</p>
              <p className="mt-0.5 text-xs text-foreground/50">
                {SCENARIO_LABELS[current.scenario]}
              </p>
            </div>

            <ul className="mt-4 space-y-1 text-sm text-foreground/70">
              {WIKI_ARTIFACT_FILES.map((file) => (
                <li key={file} className="receipt text-xs text-foreground/60">
                  {file}
                </li>
              ))}
            </ul>

            <button
              type="button"
              className={`btn ghost mt-4 w-full justify-center${
                readOnly ? " opacity-60" : ""
              }`}
              // `POST /api/wikis/[id]/template` answers 403 on a read-only
              // deployment, and the dialog this opens is a DESTRUCTIVE confirm
              // naming an overwrite of purpose.md, the Schema and the Workspace
              // Purpose — irreversible for the first and the last, the Schema
              // recoverable from History. Refusing after the owner has confirmed
              // that is the confirm-then-403 shape; the refusal belongs here,
              // before the overlay. `aria-disabled` rather than `disabled` for
              // the reason `WikiSwitcherProps.readOnly` states in full.
              aria-disabled={readOnly || undefined}
              aria-describedby={readOnly ? templateNoteId : undefined}
              onClick={() => {
                if (readOnly) return;
                setPendingScenario(current.scenario);
                setTemplateError(null);
                setTemplateOpen(true);
              }}
            >
              Change template
            </button>
            {/* The only thing on screen that says why the button above refuses:
                an `aria-disabled` control with no description announces
                "dimmed" and nothing else. Not `role="alert"` — nothing failed. */}
            {readOnly && (
              <p
                id={templateNoteId}
                className="mt-3 text-sm text-amber-700 dark:text-amber-400"
              >
                {WIKI_TEMPLATE_READ_ONLY_COPY}
              </p>
            )}
          </div>

          {/* The undocked stand-in for the Preview column. `display: none` while
              the real column is docked, decided in CSS off the shell's
              `data-preview` (DW-39) — this card cannot see that state. */}
          <div className="wb-canvas-preview-note rounded-xl border border-foreground/15 p-6">
            <p className="text-sm text-foreground/50">{PREVIEW_UNSELECTED_COPY}</p>
          </div>
        </div>
      )}

      <CreateWikiDialog
        open={createOpen}
        busy={busy}
        // Cancel and Esc stay live behind it — see `awaitingCreate`.
        confirmDisabled={awaitingCreate || latched}
        // Falls back to the SHARED sentence while the latch is up, because the
        // latch may be the HEADER switcher's (DW-516) and this dialog's backdrop
        // covers everything that could otherwise explain the dead confirm. The
        // card's own `createError` still outranks it: this dialog's request is
        // the more specific answer.
        error={createError ?? (latched ? latchMessage : null)}
        fallbackFocusRef={headingRef}
        onCancel={() => setCreateOpen(false)}
        onCreate={(input) => void create(input)}
      />

      <ConfirmDialog
        // Gated on the RECORD, not just the flag, the same way the header gates
        // its Rename confirm: `applyTemplate` returns early without `current`,
        // so a dialog left open over a vanished wiki would answer its own
        // confirm with silence — a button that does nothing and says nothing.
        open={templateOpen && current !== null}
        title="Change Scenario Template"
        confirmLabel="Overwrite"
        cancelLabel="Cancel"
        busy={busy}
        // The dialog opens on the Wiki's current scenario, so the default path
        // through a destructive confirm would rewrite this wiki's purpose,
        // Schema and Workspace Purpose to identical template bytes — discarding
        // any hand-authored purpose — and bump updatedAt for nothing.
        // `latched` is the other half (DW-515): an unknown-outcome overwrite
        // leaves this dialog OPEN with `busy` already back to false, so without
        // it the owner meets a live `Overwrite` under the sentence saying
        // nobody knows what the last one did.
        confirmDisabled={pendingScenario === current?.scenario || latched}
        // Same fallback as the create dialog: the latch may have been raised on
        // the header, in which case `templateError` is null and this overlay
        // would otherwise present a dead `Overwrite` with nothing to explain it.
        error={templateError ?? (latched ? latchMessage : null)}
        fallbackFocusRef={headingRef}
        onCancel={() => setTemplateOpen(false)}
        onConfirm={() => void applyTemplate()}
        body={
          <>
            {/* The confirm NAMES its target (DW-284), on DW-148's premise: with
                "for this wiki" in the body, an overwrite aimed at the wrong wiki
                reads identically to the right one — and this is the confirm that
                rewrites purpose.md and the Workspace Purpose unrecoverably.
                `wikiOptionLabel` and not `current.name`: one disambiguated
                spelling, shared with the switcher options and the delete picker,
                because name alone is not unique.

                `open` is gated on `templateOpen && current !== null`, so no body
                without a target is ever SHOWN — but `body` is a prop, built on
                every render whether the dialog is open or not, so the call still
                has to survive a null `current`. */}
            <p>
              This overwrites purpose.md, Schema, and the Workspace Purpose for{" "}
              <strong>{current && wikiOptionLabel(current)}</strong> — a purpose you
              wrote in Settings will be replaced by the new template’s. The Schema
              it replaces is kept in the Preview’s History and can be restored;
              purpose.md and the Workspace Purpose are not kept and cannot be
              recovered. Other wikis, Pages and Sources are not changed.
            </p>
            <label
              htmlFor="wiki-workbench-template"
              className="mt-4 block text-xs font-medium text-foreground/60"
            >
              Scenario Template
            </label>
            <select
              id="wiki-workbench-template"
              value={pendingScenario}
              disabled={busy}
              onChange={(event) =>
                setPendingScenario(event.target.value as CreatableScenario)
              }
              className="mt-1 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-foreground/35"
            >
              {CREATABLE_SCENARIOS.map((value) => (
                <option key={value} value={value}>
                  {SCENARIO_LABELS[value]}
                </option>
              ))}
            </select>
            {pendingScenario === current?.scenario && (
              // Without this the owner meets a dead primary button and no
              // reason for it: the dialog opens on the current template, so
              // its default state is always the disabled one.
              <p className="mt-2 text-xs text-foreground/50">
                Pick a different template to overwrite this wiki.
              </p>
            )}
          </>
        }
      />
    </section>
  );
}
