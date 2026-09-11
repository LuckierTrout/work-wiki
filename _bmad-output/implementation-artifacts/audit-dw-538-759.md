# Audit: DW-538 and DW-759

Date: 2026-09-11
Target: `/private/tmp/work-wiki-dw-422`, HEAD `239f43dda395f5ba318812b177b413fcd330558a` plus the existing uncommitted DW-422 changes. No implementation or ledger changes made by this audit.

## DW-538 — current defect claim unsupported

The entry correctly observes that `src/app/globals.css:2720` has no dedicated `.wb-canvas-pad[hidden]` rule. Its conclusion that the eight mode panes rely only on the user-agent default is false for the built application.

`src/app/globals.css:1` imports Tailwind. The installed `tailwindcss/preflight.css:391-393` supplies `[hidden]:where(:not([hidden='until-found'])) { display: none !important; }`. That rule is present in `.next/static/css/b630f51128170ac5.css`. ModeCanvas uses boolean `hidden`, so the rule covers these panes.

Chromium 151.0.7922.34, using the built application CSS in a DOM fixture, verified at 1440px and 600px:
- Baseline hidden `.wb-canvas-pad`: computed display none, height zero.
- Appended normal author `.wb-canvas-pad { display: flex }`: still none and zero.
- Removing ONLY the compiled Preflight hidden rule inside the browser probe: the same competitor produces flex and a 50.84375px box. The sibling `.wb-canvas-mode` remains hidden through its dedicated rule.

This removal control establishes that the actual application has the protection the ledger says is absent. The source-level cascade suite explicitly strips the Tailwind import and therefore does not model the complete built stylesheet.

Disposition recommendation: have the next orchestrator triage dismiss or reconcile DW-538 against this evidence. Do not implement a redundant rule merely to satisfy the ledger wording. This audit does not identify when the protection first entered the application.

## DW-759 — confirmed current medium defect

`src/components/workbench/Workbench.tsx:996-999` samples focus only inside `#wb-canvas` before changing the surface. SettingsNav is outside that canvas and is unmounted when Settings closes.

A scratch mounted test exercising the real Workbench and real jsdom history reproduced:
1. Open Settings, focus and select the Embeddings navigation row.
2. Back restores the default Settings pane; the navigation row retains focus.
3. Back closes Settings; the row disconnects and `document.activeElement` becomes `document.body`, rather than the new canvas.

Five focused tests passed: the explicit undesirable-behavior reproduction plus existing traversal controls. These preserve the distinction between focus on a persistent rail control, focus inside the swapped canvas, and category-only traversal. Passing the reproduction means the bug was observed, not fixed.

Recommended fix scope: sample whether focus is inside a region the Settings transition will withdraw, before applying the transition. Include SettingsNav on close, and validate the tree/ActivityDock/Preview cases on open. Preserve focus on persistent rail controls and on category-only navigation. The earlier DW-512/513 spec explicitly restricted focus sampling to the canvas; capture the expanded behavior in a separate repair contract rather than editing that completed frozen intent.

Evidence limit: this focus reproduction uses mounted React/jsdom, not the running Next application or assistive technology. A fix should add the missing regression and verify the actual browser Back/Forward focus behavior. The additional opening-Settings surfaces were inspected, not independently reproduced in this audit.

## Evidence and preservation

Scratch evidence: `/private/tmp/dw538-759-audit/focus.test.tsx`, `focus.log`, `vitest.config.mjs`, `cascade.cjs`, and `cascade.json`.

All 1052 source/config files in the prior DW-422 verification manifest were checked and unchanged. Ledger SHA-256 remains `0d89fe29ff6138cd66060f768a9b7c6cc532a8918491b61d694941e0f4113b9a`. No ledger status was changed. No fixes, commits, pushes, or deployments were performed.
