---
title: 'Landmark and navigation a11y: studio region, aria-current, modal shortcuts help'
type: 'bugfix'
created: '2026-08-28'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
baseline_revision: '804570ec3a777308184bb49d0b65b59149fcef4d'
deferred: []
---

<intent-contract>

## Intent

**Problem:** Three landmark/navigation gaps. (DW-152) `KnowledgeStudio`'s content column is a plain `<div className="studio-main">` sitting between two labelled `<aside>` rails, so a screen-reader user can jump to both rails but not to the substance between them. (DW-260) `NavHeader` signals the active route only through inline `fontWeight`/colour, with no `aria-current`, so the current page is announced not at all — and the mounted suite has to assert on styling because that is the only observable signal. (DW-424) `ShortcutsHelp` renders `role="dialog"` with no `aria-modal`, so `isInModalDialog` skips it and a global `g <key>` typed over the open help overlay navigates out from under it.

**Approach:** Name the studio region with a `<section aria-labelledby>` mirroring the shape `VaultExplorer` already uses; add `aria-current="page"` wherever `NavHeader` already computes an active link; make the shortcuts overlay a real modal by adopting the shared `useDialogA11y` hook (focus, Tab trap, Esc, scroll lock) and adding `aria-modal="true"`, while handling `?` locally so the key that opens the sheet still closes it from inside.

## Boundaries & Constraints

**Always:**
- Keep exactly one `main` landmark in the document. The new studio region is a `<section>`/`region`, never a `main`, and `single-main-landmark-scan.test.ts` must still pass.
- Keep `.studio-main` on the wrapper — `globals.css:739` keys the surface's layout on it.
- Keep `isInModalDialog`'s selector as `[role="dialog"][aria-modal="true"]`. This change makes `ShortcutsHelp` satisfy the selector; it does not loosen the selector.
- `?` must still toggle the help sheet closed from inside the open overlay, and Esc must still close it.
- Record in this spec's Design Notes that `spec-single-main-landmark-sweep.md`'s frozen "do not add ARIA roles, headings or landmarks to compensate" clause was deliberately renegotiated for this one wrapper (DW-152's recorded decision).

**Block If:**
- Making the overlay modal cannot be done without breaking `?`-from-inside or Esc.

**Never:**
- Do not touch `VaultExplorer`'s content column — DW-152's decision scopes the fix to `KnowledgeStudio`; `VaultExplorer.tsx:454` is already the pattern.
- Do not restyle any surface: no CSS changes, no class renames, no new visual affordance.
- Do not change which routes `getActiveHref` matches, or the shortcut key table.
- Do not add a landmark to any other demoted wrapper from the sweep.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Studio region named | `KnowledgeStudio` mounted, "Compile" section active | A `region` landmark exists whose accessible name is the active section's label ("Compile"), between the two rails | No error expected |
| Studio region follows section | Owner opens "Research desk" | The same region's accessible name follows the heading to "Research desk" | No error expected |
| Active primary link announced | `pathname = "/ingest/history"` | The "Ingest" link carries `aria-current="page"`; "Chat" carries none | No error expected |
| No primary link active | `pathname = "/studio"` | No primary link carries `aria-current` | No error expected |
| Global shortcut suppressed | Help overlay open, focus inside it, `g` then `i` typed | No navigation; `router.push` not called | No error expected |
| `?` from inside | Help overlay open, focus inside it, `?` typed | Overlay closes exactly once | No error expected |
| Esc from inside | Help overlay open, `Escape` typed | Overlay closes | No error expected |
| Tab trapped | Help overlay open, Tab from the last focusable | Focus wraps to the first focusable inside the overlay | No error expected |

</intent-contract>

## Code Map

- `src/components/KnowledgeStudio.tsx:213` -- `<div className="studio-main">`, the unlandmarked content column; its `<header className="studio-main-header">` at :214 already holds the `<h2 className="display">` (:216-ish) that names the active section — that heading is the label to point `aria-labelledby` at.
- `src/components/VaultExplorer.tsx:454` -- the pattern to mirror verbatim: `<section className="vault-explorer-register" aria-labelledby="document-register-heading">` with a matching `id` on the `<h2>` inside. Read-only.
- `src/app/globals.css:739,744,1334` -- `.studio-main` / `.studio-main-header` rules. Class-keyed, not tag-keyed, so the tag swap is style-neutral. Read-only.
- `src/components/NavHeader.tsx:37-44` -- `getActiveHref`. `:103` and `:262` compute `isActive` for the desktop `<ul>` link (:106-121) and the mobile panel link (:264-279); `:290` computes it for the workspace links (:292-306); `:318`/`:334` for the owner Settings and Wiki Health links. Every one already has an active boolean and emits colour/background only.
- `src/components/ShortcutsHelp.tsx:33-41` -- the overlay div carrying `role="dialog"` + `aria-label="Keyboard shortcuts"`; `:19-29` is its local Escape effect (superseded by the hook); `:36-38` its backdrop-click dismissal (keep).
- `src/hooks/useDialogA11y.ts:102-260` -- the reuse point. Returns `{ dialogRef }`; supplies initial focus on the container, capture-phase Tab trap, Esc (`preventDefault` + `stopPropagation`, skipped for `<select>`), body scroll lock, and focus restore to the opener. `useSurfaceVisible()` answers `true` outside a surface provider, so it is safe at `ClientProviders` level.
- `src/components/VaultExplorer.tsx:196` -- in-repo precedent for the whole overlay (backdrop included) being the `role="dialog" aria-modal="true"` element; `useKeyboardShortcuts.ts:41-44` names it as one of the modal renderers.
- `src/hooks/useKeyboardShortcuts.ts:46-51` -- doc comment asserting `ShortcutsHelp` is deliberately OUTSIDE `isInModalDialog`; `:263` is the guard. The rationale text is now wrong and must be rewritten.
- `src/lib/__tests__/keyboard-shortcuts.test.ts:122-129` -- "returns false for a role=dialog that is NOT aria-modal" cites `ShortcutsHelp` as the live example. The assertion stays correct; only the comment's example must change.
- `src/lib/__tests__/single-main-landmark-scan.test.ts:355-386` -- "leaves the demoted content columns carrying their original classes" builds `new RegExp(`<div\\s+className="${className}"`)` from a `[relative, className]` tuple list; the `KnowledgeStudio.tsx` / `studio-main` entry at :370 will fail once the tag changes. `LANDMARK_PATTERNS` (:253-263) match `<main\b`, `role="main"` etc. — `<section className="studio-main"` is not matched, so the sweep stays green.
- `src/app/__tests__/app-shell.test.tsx:424-446` -- the two tests keyed on `link.style.fontWeight === "600"`; `mountNav()` at :330, `PRIMARY` at :352, `openMobileMenu()` at :346.
- `src/components/__tests__/owner-scoped-anchors.test.tsx:100-130,402-413` -- the working `KnowledgeStudio` mount harness (route-table `fetch` stub, `next/navigation` + Clerk mocks, `renderStudio()`). Copy its shape for the new mounted region test. Read-only.
- `AGENTS.md` "Test environments" -- mounted suites MUST be `*.test.tsx` under a `__tests__` dir (dom project); `*.test.ts` is the node project with no DOM.

## Tasks & Acceptance

**Execution:**
- `src/components/KnowledgeStudio.tsx` -- change the `.studio-main` wrapper from `<div>` to `<section aria-labelledby="studio-main-heading">` and put `id="studio-main-heading"` on the existing `<h2 className="display">` in `.studio-main-header`; keep `className="studio-main"` and the closing tag consistent -- restores a named region between the two labelled rails without a second `main`.
- `src/components/NavHeader.tsx` -- add `aria-current={isActive ? "page" : undefined}` to every link that already computes an active state: the desktop primary link, the mobile primary link, the mobile workspace links, and the mobile Settings / Wiki Health links -- the active route becomes an announced fact rather than a font weight.
- `src/components/ShortcutsHelp.tsx` -- adopt `useDialogA11y({ open: showHelp, onDismiss: close })`; put `ref={dialogRef}`, `aria-modal="true"` and `tabIndex={-1}` on the existing overlay div beside its `role="dialog"`/`aria-label`; delete the now-superseded local Escape effect; add a local `keydown` effect that closes on `?` when the event target is inside `dialogRef.current` -- makes the overlay a real modal that `isInModalDialog` covers, while keeping `?` and Esc working from inside.
- `src/hooks/useKeyboardShortcuts.ts` -- rewrite the `isInModalDialog` doc comment (:46-51) so it names `ShortcutsHelp` as a modal the guard now covers and records that `?` is handled by the overlay itself; leave the selector and the `:263` guard unchanged -- the comment is the only thing this change falsifies.
- `src/lib/__tests__/single-main-landmark-scan.test.ts` -- widen the demoted-columns tuple to carry an element tag (defaulting to `div`) and set `KnowledgeStudio.tsx` to `section`, keeping the `studio-main` class assertion -- the guard still pins the class, and now pins the deliberate tag too.
- `src/components/__tests__/studio-content-region.test.tsx` -- new mounted suite: render `KnowledgeStudio` with the `owner-scoped-anchors` fetch harness and assert the named region exists and its name follows the active section -- the scan above is source-level; this is the rendered accessibility tree.
- `src/app/__tests__/app-shell.test.tsx` -- rewrite the two `fontWeight === "600"` tests (:424-446) to assert `aria-current`, and extend the active-link case to the hamburger panel copy -- decouples the suite from styling, which was DW-260's stated cost.
- `src/components/__tests__/shortcuts-help-modality.test.tsx` -- new mounted suite covering the modal matrix rows: `g i` typed inside the open overlay does not navigate, `?` from inside closes it exactly once, Esc closes it, Tab wraps inside -- these are the four behaviours the modality change is for.
- `src/lib/__tests__/keyboard-shortcuts.test.ts` -- update the comment at :122-129 to cite a different non-modal example (or state that no shipped surface renders one) without changing the assertion -- a stale comment pointing at a now-modal component would mislead the next reader.

**Acceptance Criteria:**
- Given a screen-reader user on `/studio`, when they enumerate landmarks, then a `region` named for the active section sits between the "Knowledge Studio sections" and "Evidence and actions" asides, and the document still reports exactly one `main`.
- Given the studio surface, when the tag swap lands, then `.studio-main`'s rendered classes, padding and layout are unchanged (no CSS edits in the diff).
- Given the help overlay is open and focus is inside it, when any global shortcut sequence is typed, then no route change and no in-page shortcut action occurs.
- Given the help overlay is open, when the user presses `?`, then it closes once — not twice-toggled by both the global handler and the overlay's own.
- Given `pnpm test`, when the suite runs, then every previously-passing landmark, shortcut and app-shell assertion still passes with no test deleted to accommodate the change.

## Spec Change Log

## Review Triage Log

## Design Notes

**Renegotiated clause (DW-152).** `spec-single-main-landmark-sweep.md`'s frozen intent-contract said "Do not add ARIA roles, headings or landmarks to compensate", and DW-11 authorised `<div>` OR `<section>` without choosing per site. That clause is deliberately renegotiated here, for this one wrapper only, on DW-152's recorded 2026-08-19 decision. The sweep's actual invariant — one `main` per document — is untouched: a `<section aria-labelledby>` is a `region`, not a `main`.

**Why `aria-labelledby`, not `aria-label`.** `.studio-main-header` already renders the active section's label as an `<h2>`, so pointing at it makes the region's name follow the section the owner opened, with no second source of truth to drift. Exactly what `VaultExplorer` does:

```tsx
<section className="studio-main" aria-labelledby="studio-main-heading">
  <header className="studio-main-header">
    <h2 id="studio-main-heading" className="display">{label}</h2>
```

**Why the whole overlay is the dialog.** `ConfirmDialog` puts `role="dialog"` on the inner panel; the Vault lightbox puts it on the full-bleed overlay. `ShortcutsHelp` already has it on the overlay, and keeping it there means every keydown originating anywhere in the overlay — backdrop included — is inside the `isInModalDialog` selector, which is precisely DW-424's complaint. Moving it inward would leave the backdrop outside the guard for no gain.

**Why `?` must be handled locally.** Once the overlay is `aria-modal="true"`, `KeyboardShortcutsProvider`'s handler returns at `useKeyboardShortcuts.ts:263` for targets inside it — including `?`, which the provider owns at `:308`. `useDialogA11y` focuses the container on open, so that is the common case. The local handler must be scoped to targets inside `dialogRef.current`: with focus on `<body>` the global handler still fires, and an unscoped local handler would toggle a second time and reopen the sheet.

## Verification

**Commands:**
- `pnpm exec vitest run --project dom src/components/__tests__/studio-content-region.test.tsx src/components/__tests__/shortcuts-help-modality.test.tsx src/app/__tests__/app-shell.test.tsx src/components/__tests__/single-main-landmark-mounted.test.tsx` -- expected: all pass, new suites included.
- `pnpm exec vitest run --project node src/lib/__tests__/single-main-landmark-scan.test.ts src/lib/__tests__/keyboard-shortcuts.test.ts` -- expected: all pass.
- `pnpm test` -- expected: full suite green, no regressions elsewhere.
- `pnpm lint` -- expected: clean.
- `git diff --stat -- src/app/globals.css` -- expected: empty; the tag swap must not touch styling.
