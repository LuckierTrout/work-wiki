"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CreateWikiDialog } from "@/components/CreateWikiDialog";
import { useWorkbenchData } from "@/components/workbench/WorkbenchData";
import {
  CREATABLE_SCENARIOS,
  SCENARIO_LABELS,
  WIKI_ARTIFACT_FILES,
  type CreatableScenario,
} from "@/lib/wiki-scenarios";
import { PREVIEW_UNSELECTED_COPY } from "@/lib/workbench-preview";
import { send, writeFailure } from "@/lib/workbench-request";
import {
  WIKI_CREATE_READ_ONLY_COPY,
  WIKI_TEMPLATE_READ_ONLY_COPY,
} from "@/lib/workbench-tree";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The Wiki surface on the owner's landing page — the Wiki-mode canvas.
 *
 * It owns the artifact receipt (`purpose.md`, `schema.md`), the wiki's name and
 * scenario heading, `Change template`, and the `No wiki yet.` empty state whose
 * `Create Wiki` action lands the owner somewhere real. It does NOT own
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
   * Ids for the two standing refusal sentences below (DW-189, DW-282).
   *
   * Two, not one: `Change template` and this card's create action sit in
   * MUTUALLY EXCLUSIVE branches, so a single shared node would be unmounted for
   * whichever branch is not on screen and the surviving control's
   * `aria-describedby` would resolve to nothing at all.
   */
  const templateNoteId = useId();
  const createNoteId = useId();
  const [createOpen, setCreateOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [pendingScenario, setPendingScenario] = useState<CreatableScenario>("business");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  /**
   * A create whose server render has not arrived yet — one that SUCCEEDED, or
   * one whose OUTCOME IS UNKNOWN (DW-407).
   *
   * The card is not optimistic, so on success the dialog closes and the empty
   * state — `No wiki yet.` and an enabled `Create Wiki` — is still on screen
   * for the length of `router.refresh()`. On the unconfirmed path the dialog
   * deliberately stays OPEN — the sentence explaining what happened is inside
   * it — and `busy` is already back to false, so the confirm button and the
   * Enter path behind it are two more live routes to a second POST. Nothing
   * enforces unique wiki names, so a press down any of them seeds a SECOND
   * wiki and makes it active, moving every prompt onto its template.
   *
   * The latch rides `confirmDisabled` and NEVER `busy`: `busy` also kills
   * Cancel, Esc and the outside-click dismiss, and the sentence the owner has
   * just read tells them to go and look at the screen. A modal they cannot
   * dismiss is not a screen they can look at.
   *
   * The door stays shut until a new server render lands (the effect below),
   * which is the only thing that can say what is actually there.
   */
  const [awaitingCreate, setAwaitingCreate] = useState(false);
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
   * The create door reopens when a server render lands — whatever it says.
   *
   * `wikis` is a fresh array on every server render (`page.tsx` reads the
   * registry each time), so its identity is the arrival signal. Deliberately
   * NOT "when the new wiki appears": a refresh that answers without it must
   * still give the owner their button back rather than leaving a control dead
   * with no explanation.
   */
  useEffect(() => {
    setAwaitingCreate(false);
  }, [wikis, currentWikiId]);

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
    // second wiki. `awaitingCreate` rides ALONGSIDE `busy` because the two shut
    // the same door for different lengths of time: `busy` for the length of the
    // request, the latch until a server render lands after one whose outcome
    // nobody knows — and the dialog is still open then, with `busy` back to
    // false.
    if (busy || awaitingCreate) return;
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
      setAwaitingCreate(true);
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
        // this dialog still says `No wiki yet.` and still offers a Create Wiki
        // button — pressing it now would seed a second wiki and move every
        // prompt onto its template — so the door is held shut exactly as a
        // succeeding create holds it, until a server render says what is
        // actually there. And the refresh is what fetches that render: without
        // it the owner is told the outcome is unknown in front of a screen that
        // will never resolve it.
        setAwaitingCreate(true);
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
    // owner has agreed to an irreversible rewrite.
    if (readOnly) return;
    if (!current) return;
    // Behind the confirm's `disabled={busy}`. A second POST rewrites this
    // wiki's purpose.md, Schema and Workspace Purpose all over again.
    if (busy) return;
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
      // template beside a message that does not claim it survived. No
      // `awaitingCreate` equivalent here: the confirm is idempotent per
      // scenario and re-running it rewrites the same bytes.
      if (unconfirmed) router.refresh();
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
        // NOT the empty state: "No wiki yet." would be a claim about the
        // registry that this render cannot make, and its Create Wiki button
        // would seed a duplicate wiki and move every prompt onto its template
        // on the strength of a read error.
        <div className="mt-4 rounded-xl border border-foreground/15 p-6">
          <p role="alert" className="text-sm text-foreground/60">
            Your wikis couldn’t be loaded. Reload to try again.
          </p>
        </div>
      ) : !current ? (
        <div className="mt-4 rounded-xl border border-foreground/15 p-6">
          <p className="text-sm text-foreground/60">No wiki yet.</p>
          <button
            type="button"
            className={`btn primary mt-4${readOnly ? " opacity-60" : ""}`}
            // The window this card can seed a duplicate wiki in: a create has
            // gone out — landed, or with nobody able to say — the refresh has
            // not come back, and `No wiki yet.` may already be false. See
            // `awaitingCreate` for both halves. `disabled`, not `aria-disabled`:
            // this is transient, like `switching` in the header, not a standing
            // refusal a screen-reader user needs a sentence for.
            disabled={awaitingCreate}
            // The deployment's standing refusal, which is the opposite case:
            // `POST /api/wikis` has answered 403 since before this card existed,
            // and `disabled` here would take the owner's only explanation of the
            // empty state out of the tab order along with the button. See
            // `WikiSwitcherProps.readOnly` for the convention.
            aria-disabled={readOnly || undefined}
            aria-describedby={readOnly ? createNoteId : undefined}
            onClick={() => {
              // BEFORE the dialog opens, never after: a form the owner fills in
              // and submits before being refused is worse than a control that
              // says up front it will not run.
              if (readOnly) return;
              if (awaitingCreate) return;
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
        </div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
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
              // naming an irreversible overwrite of purpose.md, the Schema and
              // the Workspace Purpose. Refusing after the owner has confirmed
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
        confirmDisabled={awaitingCreate}
        error={createError}
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
        confirmDisabled={pendingScenario === current?.scenario}
        error={templateError}
        fallbackFocusRef={headingRef}
        onCancel={() => setTemplateOpen(false)}
        onConfirm={() => void applyTemplate()}
        body={
          <>
            <p>
              This overwrites purpose.md, Schema, and the Workspace Purpose for this
              wiki — a purpose you wrote in Settings will be replaced by the new
              template’s. Other wikis, Pages and Sources are not changed.
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
