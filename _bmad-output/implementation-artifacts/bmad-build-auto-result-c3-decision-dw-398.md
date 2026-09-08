---
status: done
---

# BMad Build Auto Result

Status: done
Blocking condition: none — the bundle's intent is already true in the tree; no source, test, or spec file needed to change.

## Bundle

- Bundle: `c3-decision-dw-398` (run `20260820-220331-0f16`)
- Intent: `.bmad-loop/runs/20260820-220331-0f16/bundles/c3-decision-dw-398/intent.md`
- Ledger entry: DW-398
- Baseline revision: `793e0a9c287d90c426accd41a2203bb49f67f797`
- Files touched by this session: none (this result file only).

## Why no change was made

The bundle asks to "disable the embedding-provider select in `SettingsCanvas.tsx` whenever
`EMBEDDING_PROVIDER` is set, with the env-override hint copy, so the newly reachable
consequence disappears without touching the frozen clear rule." That pin already shipped,
and the ledger already records it.

**The ledger entry is closed.** `_bmad-output/implementation-artifacts/deferred-work.md:2919`
carries DW-398 as `status: done 2026-08-27`, `archived: 2026-08-29`, and the entry is
mirrored in `deferred-work-archive.md:3394`.

**The pin is in the tree.** `src/components/workbench/SettingsCanvas.tsx`:

- `:894-899` — the comment naming DW-398 and the reason for the pin (the move is not inert:
  `settingsDraftAfterEmbeddingProvider` blanks the endpoint and key, and the save deletes both).
- `:916` — `const envPinned = stored.envEmbeddingProvider !== null;`
- `:956` — `aria-disabled={stored.readOnly || envPinned || undefined}` — the house convention
  (`providerRow`/`researchProviderRow`): announced unavailable, still keyboard-reachable.
- `:958` — `onChange` early-returns under `stored.readOnly || envPinned`, so the draft never
  moves and `settingsDraftAfterEmbeddingProvider` is never reached under a pin.
- `:1005-1009` — the hint names which provider the environment forces
  (`settingsEnvProviderPinCopy`). This is a *dedicated pinned sentence* rather than the generic
  `settingsEnvOverrideCopy` the bundle names: `settingsEnvOverrideCopy` promises "what you save
  here applies once that variable is unset", which is false for a select the pin now refuses.
  That copy substitution is DW-507's recorded resolution
  (`spec-dw-507-508-509-510-embedding-provider-env-pin.md`), and the archived note at
  `deferred-work-archive.md:4037` records the handoff explicitly.

**The frozen clear rule is untouched.** `settingsDraftAfterEmbeddingProvider` still owns the
blank/restore decision; the component only declines to call it under a pin.

**Follow-on work also landed.** DW-508 (a junk `EMBEDDING_PROVIDER` is described, deliberately
*not* pinned — `SettingsCanvas.tsx:901-915, 936-939`) and DW-510 (the browser-only pin extended
to the route — `src/app/api/settings/route.ts:383, 414, 436`) are both in the tree.

## Verification

```
npx vitest run src/components/workbench/__tests__/settings-vector-namespace.test.tsx \
               src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx

 ✓ src/components/workbench/__tests__/settings-vector-namespace.test.tsx (31 tests)
 ✓ src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx (13 tests)
 Test Files  2 passed (2)
      Tests  44 passed (44)
```

The pin's behaviour is asserted directly in `settings-vector-namespace.test.tsx:675-730`:
with `envEmbeddingProvider: "google"` and a stored OpenAI endpoint + key, the select reports
`aria-disabled="true"` while `disabled === false`, still renders the stored value, announces
`settingsEnvProviderPinCopy("google")`, and a `fireEvent.change` to `workers-ai` leaves the
draft, the endpoint and the stored-key affordance all intact with no save attempted — which
is exactly the consequence DW-398 asked to remove.

## Note for the orchestrator

DW-398 was already `done` and `archived` before this dispatch. Nothing about the re-dispatch
changed the tree; recording it resolved is accurate. No new deferred work was found.
