---
title: 'DW-445: extract the API + MCP category out of the generic Settings pair'
type: 'refactor'
created: '2026-08-29'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'a34c4fee0fbae07ea363ffdf4d3cedc742d6781a'
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** API + MCP is still one row in the generic list (`src/lib/workbench-settings.ts:97`)
with its rules spread through a 3,255-line module and its 229-line JSX subtree inline in a
1,589-line `SettingsCanvas.tsx` (`case "api-mcp":` at `:1261`). No API/MCP component or module
exists, and no mounted test ever renders the pane — the only end-to-end guard is one Playwright
test, so the door's switches, the Generate/Show/Copy buttons and the health line have zero
DOM-level coverage.

**Approach:** Give the category its own pair — `src/lib/workbench-api-mcp-settings.ts` for its
copy, its MCP/Skill snippet builders and its four draft rules, and
`src/components/workbench/SettingsApiMcpPane.tsx` for its JSX and its own liveness probe — each
with its own suite. The generic pair keeps everything else and re-points nothing back: the new lib
module imports from `workbench-settings.ts`, never the reverse, so no import cycle is created.

## Boundaries & Constraints

**Always:** Every owner-visible sentence, control, label, id suffix and class stays byte-identical;
the pane keeps rendering into `SettingsCanvas`'s `detail()` at exactly the point `case "api-mcp":`
sits today. The pane receives `field` and `describedBy` from the canvas so its control ids stay in
the canvas's one `useId` namespace and the read-only sentence still appends. `apply` stays the only
edit gesture (it is what clears `status` and `saveError`). The moved lib symbols keep their exact
names and signatures. The new lib module stays client-safe (no `node:`, no `fs`/`path`/`os`, no
`./storage`, no `./config`) and the new component stays router-free, storage-free, `fetch`-free and
carries no `"/api/` literal — the same four scans `workbench-settings.ts` and `SettingsCanvas.tsx`
already answer to. Direction of dependency is one-way: `workbench-api-mcp-settings.ts` may import
from `workbench-settings.ts`; `workbench-settings.ts` must import nothing from it.

**Block If:** the extraction cannot keep `e2e/workbench-owner.spec.ts:156`'s assertions meaning the
same thing, or an existing assertion in `workbench-epic8.test.ts` / `epic8-remediation.test.ts`
would have to change meaning (a re-pointed import specifier is not a meaning change).

**Never:** Touch `sidecar/`, `ChatCanvas.tsx`, `src/lib/chat-*`, or the deferred-work ledger. Move
the `SettingsCategoryId` union, the `SETTINGS_CATEGORIES` row, `WorkbenchSettingsPayload`,
`WorkbenchSettingsPatch`, `SettingsDraft`, `isWorkbenchSettingsPayload`,
`settingsDraftFromPayload`, `settingsSaveBody`, `validateWorkbenchSettingsPatch` or any of its
four API-patch copy constants (`SETTINGS_INVALID_API_FLAG_COPY`, `SETTINGS_INVALID_SKILL_MAP_COPY`,
`MIN_LOOPBACK_TOKEN_LENGTH`, `SETTINGS_WEAK_API_TOKEN_COPY`) — those live in the generic patch
validator and moving them would create the cycle this split exists to avoid. Re-export the moved
symbols from `workbench-settings.ts` for compatibility. Change the wire, the payload shape, or
`globals.css`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Pane opens | Category switches to `api-mcp` | The pane mounts and probes once; the health line is absent until the probe lands, then reads the classified sentence plus `N Skills on disk.` | Probe rejects ⇒ `SETTINGS_API_HEALTH_UNREACHABLE_COPY`, `0 Skills on disk.` |
| Leave and return | Reveal a generated token, switch to Embeddings, switch back | The draft token is still there; it renders MASKED again and the probe re-runs | No error expected |
| Door shut | `apiEnabled: false` | Only the standing note, the Base URL row, the health line and the enable switch render; no unauth switch, no token row, no MCP/Skill blocks | No error expected |
| Enable, then disable | Tick enable, tick unauthenticated, untick enable | `settingsDraftAfterApiEnabled` clears `allowUnauthenticated` too; the warning goes with it | No error expected |
| Unauthenticated ticked | `apiEnabled && allowUnauthenticated` | The hint span flips to `wb-set-hint wb-set-warn` and carries `SETTINGS_API_UNAUTH_WARNING_COPY`; otherwise `SETTINGS_API_UNAUTH_OFF_COPY` | No error expected |
| Generate | Press Generate on a writable, non-env deployment | `settingsDraftAfterTokenGenerated` puts a fresh `newLoopbackApiToken()` in the draft; Show/Hide and Copy appear; the hint reads `SETTINGS_API_TOKEN_NEW_COPY` | No error expected |
| Token from env | `loopbackTokenSource: "env"` | No Generate button; hint reads `SETTINGS_API_TOKEN_ENV_COPY` | No error expected |
| Read-only deployment | `readOnly: true` | Both switches carry `aria-disabled` and refuse the change; no Generate button; neither control uses `disabled` | No error expected |
| Door open with no way in | `apiEnabled`, unauth off, no env token, no stored token, no draft token | `draftApiTokenMissing` is true ⇒ `SETTINGS_API_TOKEN_ABSENT_COPY` in a `role="status"` note; Save is NOT blocked | No error expected |
| Copy MCP config | Press Copy MCP config | `loopbackMcpConfig(draftToken, stored.loopbackMcpEntry)` reaches the clipboard; the shared `copied` note reads `SETTINGS_API_COPIED_COPY` | Clipboard absent or refused ⇒ `copied` stays false, snippet stays on screen |
| MCP snippet, no token | `loopbackMcpConfig(null)` | Names `yopedia`, `command: "node"`, one absolute arg ending `sidecar/mcp.mjs`, and `PASTE_YOUR_TOKEN` under `env.LLM_WIKI_API_TOKEN` — never a `token=` query | No error expected |
| Masking | `maskToken` over a 48-char token | Last 4 characters survive; the rest is masked | No error expected |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts` -- the lib source. Move the whole banner region `:807-968`
  (25 `SETTINGS_API_*` constants, `maskToken`, `LOOPBACK_MCP_SERVER_NAME`, `LOOPBACK_MCP_ENTRY`,
  `WORK_WIKI_SKILL_DIR`, `resolveLoopbackMcpEntry`, `loopbackMcpConfig`,
  `brandedSkillInstallCommand`) and the four draft rules `settingsDraftAfterTokenGenerated`
  (`:2565`), `settingsDraftAfterApiEnabled` (`:2583`), `draftApiUnauthenticated` (`:2602`),
  `draftApiTokenMissing` (`:2613`). Line `:970` (`SETTINGS_LANGUAGE_*`) is NOT API/MCP and stays.
  Nothing left in the file consumes any moved symbol, so no in-file caller breaks. Two changes to
  what stays: `secretPatchValue` (`:2914`, private) gains `export` because `draftApiTokenMissing`
  needs it, and the four dangling `{@link}`s the move creates (`:834`, `:883`, and the two
  MinerU cross-references in the moved doc blocks, plus `:2521`'s link to
  `SETTINGS_API_TOKEN_NEW_COPY`) are reworded to prose naming the other module.
- `src/components/workbench/SettingsCanvas.tsx` -- the component source. Delete `revealToken`
  (`:212`), `apiLive` (`:213-216`), the probe effect (`:241-250`), the `case "api-mcp":` body
  (`:1263-1488`), and the now-unused imports: the 32 specifiers at `:20-51`, the whole
  `@/lib/v1-contract` block (`:127-131`), the whole `@/lib/workbench-loopback-health` block
  (`:132-138`), and `SkillSummary` (`:139`). `case "api-mcp":` returns `<SettingsApiMcpPane … />`.
  Keep `copied`/`copyToClipboard` (`:204`, `:296`) — Intake shares them (`:1059`, `:1069`).
- `src/components/workbench/SettingsNav.tsx` -- the extraction pattern to copy: `"use client"`,
  a file-header block saying why the component exists, a named exported `…Props` interface directly
  above a named exported function, destructured props, no default export.
- `src/lib/workbench-loopback-health.ts:26-56` -- `probeLoopbackApiPane`, the three
  `SETTINGS_API_HEALTH_*` sentences, `ClassifiedLoopbackHealth`. Reused as-is by the pane; do not
  move or duplicate. `probeLoopbackApiPane` swallows every error itself.
- `src/lib/v1-contract.ts:26,27,37,67` -- `LOOPBACK_BASE_URL`, `LOOPBACK_HEALTH_URL`,
  `LOOPBACK_TOKEN_ENV`, `newLoopbackApiToken`. The new lib module needs the base URL and the env
  name; the pane needs the health URL and the minter.
- `src/lib/config.ts:12,1832` -- imports `LOOPBACK_MCP_ENTRY` from `./workbench-settings`;
  re-point to the new module. It is the only non-test production importer of a moved symbol.
- `e2e/workbench-owner.spec.ts:5-9,156-194` -- READ-ONLY EVIDENCE apart from the import line:
  re-point `SETTINGS_API_ENABLE_LABEL`, `SETTINGS_API_MCP_COPY`, `SETTINGS_API_MCP_HEADING` at the
  new module; every assertion stays as it is.
- `src/lib/__tests__/workbench-epic8.test.ts:55-66,648-777` -- the existing node coverage of the
  moved rules and snippets. Re-point the ten specifiers at `:55-66`; change no assertion.
- `src/lib/__tests__/epic8-remediation.test.ts:65` -- re-point `loopbackMcpConfig`; the spawn test
  at `:868` (which runs the wrap from `cwd: "/tmp"`) is the behavioural pin on
  `resolveLoopbackMcpEntry` and must keep passing untouched.
- `src/lib/__tests__/workbench-settings.test.ts` -- the source scans that must follow the code.
  `:4736` `describedBy` count 11 (2 are the pane's); `:4762` `aria-disabled={stored.readOnly ||
  undefined}` count 6 (2 are the pane's); `:4739-4741` every `wb-set-hint` span carries an `id`;
  `:4658-4671` no `fetch(`/`"/api/`; `:4754-4757` exactly one `disabled={`; `:4967-4981` the
  `["SettingsCanvas.tsx","SettingsNav.tsx"]` loop; `:5108-5121` the `wb-set-*` CSS coverage join;
  `:5070-5079` the client-safety scan, scoped by filename to `workbench-settings.ts`.
- `src/components/workbench/__tests__/settings-harness.tsx` -- `settingsPayload` (`:37`),
  `installSettingsFetchMock` (`:132`, once per file at module top level), `announcedFor` (`:167`),
  `mountSettings` (`:191`). `mountSettings` calls `fetchMock.mockResolvedValue`, which cannot serve
  the two probe URLs, so the new dom suite renders `<SettingsCanvas category="api-mcp" …>` directly
  behind a URL-routing `mockImplementation` — the same direct-render shape
  `settings-read-only.test.tsx:376` already uses. `loopbackFetch` goes through global `fetch`, and
  `readLoopbackDoorToken` caches module-wide, so call `clearLoopbackDoorToken()` per test.
- `src/components/__tests__/email-ingest-read-only.test.tsx:72-73` -- the clipboard stub pattern
  (`vi.stubGlobal("navigator", { clipboard: { writeText } })`); the harness's
  `vi.unstubAllGlobals()` tears it down.
- `AGENTS.md` "Test environments" -- `*.test.ts` ⇒ `node`, `*.test.tsx` ⇒ `dom`, suites under
  `__tests__`.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-api-mcp-settings.ts` -- new client-safe module holding the moved `:807-968`
  region verbatim plus the four draft rules, importing `LOOPBACK_BASE_URL`/`LOOPBACK_TOKEN_ENV`
  from `./v1-contract`, `secretPatchValue` from `./workbench-settings`, and `SettingsDraft` /
  `WorkbenchSettingsValues` as `import type` -- so the category's rules are one file with one
  suite.
- `src/lib/workbench-settings.ts` -- delete the moved symbols, `export` `secretPatchValue`, and
  reword the doc links the move would leave dangling; import nothing from the new module.
- `src/components/workbench/SettingsApiMcpPane.tsx` -- new client component owning the moved JSX,
  `revealToken`, `apiLive` and the mount-time probe, with
  `SettingsApiMcpPaneProps { values, stored, field, describedBy, apply, copied, onCopy }` -- the
  ids and the read-only append come from the canvas, the edit gesture stays `apply`, and `copied`
  stays shared with Intake.
- `src/components/workbench/SettingsCanvas.tsx` -- delete the pane's state, effect, JSX and
  imports; render `<SettingsApiMcpPane … />` from `case "api-mcp":`.
- `src/lib/__tests__/workbench-api-mcp-settings.test.ts` -- new node suite covering every lib row
  of the I/O matrix (masking, both snippet builders, all four draft rules) plus a client-safety
  source scan on the new module mirroring `workbench-settings.test.ts:5070-5079`.
- `src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx` -- new dom suite: the first
  mounted coverage the pane has ever had, covering every pane row of the I/O matrix over a
  URL-routing fetch mock and a stubbed clipboard.
- `src/lib/__tests__/workbench-settings.test.ts` -- move the two counted scans' shares onto the new
  file (`describedBy` 11 ⇒ 9 + 2, `aria-disabled` 6 ⇒ 4 + 2, with the comments updated to say where
  the pane's two went), and add `SettingsApiMcpPane.tsx` to the router/storage loop (`:4967`), the
  CSS-coverage join (`:5108`), the hint-span-id rule and the no-`fetch`/no-`"/api/` rule.
- `src/lib/config.ts`, `e2e/workbench-owner.spec.ts`,
  `src/lib/__tests__/workbench-epic8.test.ts`, `src/lib/__tests__/epic8-remediation.test.ts` --
  re-point import specifiers at the new module; change no assertion.

**Acceptance Criteria:**
- Given the repo after the change, when `src/lib/workbench-settings.ts` is grepped, then it holds
  no `SETTINGS_API_*` constant, no `maskToken`, no MCP or Skill snippet builder and no
  `draftApi*`/`settingsDraftAfterApi*` rule, and no import from `workbench-api-mcp-settings`.
- Given `SettingsCanvas.tsx` after the change, when it is read, then it names no
  `SETTINGS_API_*` constant, no `probeLoopbackApiPane`, no `revealToken` and no `apiLive`, and it
  is materially shorter than 1,589 lines.
- Given the suites at `a34c4fee`, when they run against the extracted pair, then every assertion in
  `workbench-epic8.test.ts`, `epic8-remediation.test.ts` and the four existing mounted Settings
  suites still holds with no edit beyond an import specifier.
- Given the new dom suite, when it runs, then every pane row of the I/O matrix is asserted against
  the rendered DOM rather than against source text.

## Spec Change Log

- 2026-08-29 -- implementation note on the "Door shut" matrix row. The row says the
  MCP and Skill blocks do not render while `apiEnabled` is false. That is WRONG about
  the code at `a34c4fee`: only the unauthenticated switch, the token row and the
  token-absent sentence sit inside the `values.apiEnabled &&` guard
  (`SettingsCanvas.tsx:1324-1446`); both `<h3>`/`<pre>` snippet blocks are outside it
  and always render. Two things in the contract outrank the row and both point the
  same way -- the "Always" invariant that every owner-visible control stays
  byte-identical, and the "Block If" that `e2e/workbench-owner.spec.ts:156` must keep
  meaning what it means, since that test opens the pane on a FRESH wiki (door shut)
  and asserts the MCP heading, the MCP sentence and the `pre.wb-set-pre` config are
  visible. The blocks therefore stay unconditional, and
  `settings-api-mcp-pane.test.tsx` pins that explicitly with the e2e line named as
  the reason. Gating them would be a behaviour change, not this refactor.
- 2026-08-29 -- implementation note on the Code Map's "reworded to prose naming the
  other module". The Verification block requires
  `grep "workbench-api-mcp-settings" src/lib/workbench-settings.ts` to return
  nothing, which is the machine-checkable half of the one-way-dependency rule. The
  surviving doc references in `workbench-settings.ts` therefore name the CATEGORY
  ("the API + MCP category's own module") rather than the filename.

## Review Triage Log

## Design Notes

The split line is "the category's own rules and pixels" vs "the surface every category shares".
Anything that describes the whole settings document — the category vocabulary, the payload and
patch types, the draft shape, the patch validator, the save body — stays in the generic pair even
where it mentions the API door, because those are single functions over a single object and cutting
them per category is what would create the import cycle. That is why the four API patch-validation
constants at `workbench-settings.ts:1906-1921` do NOT move: `validateWorkbenchSettingsPatch` uses
them alongside `SETTINGS_INVALID_SECRET_COPY`, so moving them would force
`workbench-settings.ts` to import back from the new module while the new module already imports
`secretPatchValue` from it.

Two state lifetimes change as a consequence of the pane becoming a component, both named in the
I/O matrix and both in the safer direction. `apiLive` is no longer retained after the owner leaves
the pane, so a second visit shows nothing until the fresh probe lands instead of flashing the
previous visit's verdict. `revealToken` resets to masked on re-entry, which is what
`SETTINGS_API_TOKEN_NEW_COPY`'s "shown once" already promises; the draft token itself is untouched,
so Show brings it straight back.

`set` is not passed down: it is literally `apply((c) => ({ ...c, [key]: value }))`, so the pane's
one `set("allowUnauthenticated", …)` call becomes that `apply` and the props stay non-generic.

```tsx
case "api-mcp":
  return (
    <SettingsApiMcpPane
      values={values}
      stored={stored}
      field={field}
      describedBy={describedBy}
      apply={apply}
      copied={copied}
      onCopy={copyToClipboard}
    />
  );
```

## Verification

**Commands:**
- `pnpm exec vitest run --project node src/lib/__tests__/workbench-api-mcp-settings.test.ts src/lib/__tests__/workbench-epic8.test.ts src/lib/__tests__/workbench-settings.test.ts src/lib/__tests__/epic8-remediation.test.ts` -- expected: all pass.
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx src/components/workbench/__tests__/settings-read-only.test.tsx src/components/workbench/__tests__/settings-canvas-persistence.test.tsx src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx src/components/workbench/__tests__/settings-research-provider.test.tsx src/components/workbench/__tests__/settings-vector-namespace.test.tsx src/components/workbench/__tests__/settings-shortcut.test.tsx` -- expected: all pass.
- `pnpm exec tsc --noEmit` -- expected: exit 0.
- `pnpm test` -- expected: no new failure against the `a34c4fee` baseline.
- `grep -n "workbench-api-mcp-settings" src/lib/workbench-settings.ts` -- expected: no match (the one-way dependency).
- `wc -l src/components/workbench/SettingsCanvas.tsx src/lib/workbench-settings.ts` -- expected: materially below 1,589 and 3,255.
- `git diff --stat a34c4fee -- sidecar src/components/workbench/ChatCanvas.tsx src/app/globals.css` -- expected: empty.
