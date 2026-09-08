---
title: 'DW-445: extract the API + MCP category out of the generic Settings pair'
type: 'refactor'
created: '2026-08-30'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: 'f342c9a816f97067e11ee70ae0796710c522b49e'
context: []
warnings: [oversized]
deferred:
  - summary: >-
      The `starting` loopback health status renders the pane's "The sidecar is
      running" sentence, because the health ternary only special-cases
      port_conflict, unreachable and error.
    evidence: |-
      `LOOPBACK_STATUSES` in `src/lib/v1-contract.ts` is
      ["starting","running","port_conflict","error"], and
      `classifyLoopbackHealth` returns "starting" verbatim. The pane's ternary
      falls through everything that is not port_conflict/unreachable/error to
      SETTINGS_API_HEALTH_RUNNING_COPY, so a starting sidecar is described as
      running. There is no SETTINGS_API_HEALTH_STARTING_COPY to render instead.
      Pre-existing: moved verbatim out of SettingsCanvas by DW-445, not
      introduced by it, and outside that refactor's byte-identical mandate.
    location: >-
      src/components/workbench/SettingsApiMcpPane.tsx (the apiLive health ternary)
    severity: medium
  - summary: >-
      The API token row's hint span carries an id that no control references, so
      the env-pinned and "copy it now" sentences are announced by nothing.
    evidence: |-
      The span is `id={field("apiToken-hint")}`, but Generate, Show/Hide and Copy
      all point their `aria-describedby` at `field("apiToken-label")`. The
      workbench-settings.ts source scan only asserts every `wb-set-hint` span HAS
      an id, never that a control references it, so this reads as covered while
      the sentence is unannounced. Pre-existing: moved verbatim by DW-445.
    location: >-
      src/components/workbench/SettingsApiMcpPane.tsx (the API token row)
    severity: medium
  - summary: >-
      SETTINGS_API_TOKEN_ABSENT_COPY can render twice on screen at once — as the
      token row's hint and again as the wb-set-warn status note.
    evidence: |-
      With the door open, unauth off and no token anywhere, the hint's final
      fallback branch selects SETTINGS_API_TOKEN_ABSENT_COPY and
      `draftApiTokenMissing` renders the same sentence again as a role="status"
      note. The new dom suite has to work around the duplicate with
      `getAllByRole("status").find(...)` rather than `getByText`. One of the two
      should say something different. Pre-existing: moved verbatim by DW-445.
    location: >-
      src/components/workbench/SettingsApiMcpPane.tsx (token hint + missing-token note)
    severity: low
---

<intent-contract>

## Intent

**Problem:** API + MCP is still one row of the generic list with its rules spread through a
3,582-line `workbench-settings.ts` and its 230-line JSX subtree inline in a 1,705-line
`SettingsCanvas.tsx` (`case "api-mcp":` at `:1377`). No API/MCP component or copy module exists,
and no mounted suite has ever rendered the pane — the only end-to-end guard is one Playwright test
(`e2e/workbench-owner.spec.ts:156`), so the door's two switches, the Generate/Show/Copy buttons and
the health line have zero DOM-level coverage.

**Approach:** Give the category its own pair — `src/lib/workbench-api-mcp-settings.ts` for its copy,
its MCP/Skill snippet builders and its four draft rules, and
`src/components/workbench/SettingsApiMcpPane.tsx` for its JSX and its own liveness probe — each
with its own suite, and re-point the existing mounted and node suites at them so the refactor is
pinned rather than assumed. The dependency is ONE-WAY: the new lib module imports from
`workbench-settings.ts`, never the reverse.

## Boundaries & Constraints

**Always:** Every owner-visible sentence, control, label, id suffix and class stays byte-identical,
and the pane renders at exactly the point `case "api-mcp":` sits today inside `SettingsCanvas`'s
`detail()`. The pane receives `field` and `describedBy` from the canvas so its control ids stay in
the canvas's one `useId` namespace and the read-only sentence still appends. `apply` stays the only
edit gesture (it is what clears `status` and `saveError`). Moved symbols keep their exact names and
signatures. The new lib module stays client-safe (no `node:`, no `fs`/`path`/`os`, no `./storage`,
no `./config`) and the new component stays router-free, storage-free, `fetch`-free and carries no
`"/api/` literal — the same scans `workbench-settings.ts` and `SettingsCanvas.tsx` already answer.

**Block If:** the extraction cannot keep `e2e/workbench-owner.spec.ts:156`'s assertions meaning the
same thing, or an existing assertion in `workbench-epic8.test.ts` / `epic8-remediation.test.ts`
would have to change meaning (a re-pointed import specifier is not a meaning change).

**Never:** Touch `sidecar/`, `ChatCanvas.tsx`, `src/lib/chat-*`, `globals.css`, the wire or the
payload shape, or the deferred-work ledger. Move `SettingsCategoryId`, the `SETTINGS_CATEGORIES`
row, `WorkbenchSettingsPayload`, `WorkbenchSettingsValues`, `WorkbenchSettingsPatch`,
`SettingsDraft`, `settingsDraftFromPayload`, `settingsSaveBody`, `validateWorkbenchSettingsPatch`
or its API-patch copy constants (`SETTINGS_INVALID_API_FLAG_COPY`,
`SETTINGS_INVALID_SKILL_MAP_COPY`, `MIN_LOOPBACK_TOKEN_LENGTH`, `SETTINGS_WEAK_API_TOKEN_COPY`) —
those belong to the generic patch validator and moving them would create the cycle this split
exists to avoid. Re-export moved symbols from `workbench-settings.ts` for compatibility (importers
are re-pointed instead).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Pane opens | Category is `api-mcp` | The pane mounts and probes once; the health line is absent until the probe lands, then reads the classified sentence plus `N Skills on disk.` (`1 Skill on disk.` when exactly one) | Probe rejects ⇒ `SETTINGS_API_HEALTH_UNREACHABLE_COPY`, `0 Skills on disk.` |
| Leave and return | Reveal a generated token, switch to Embeddings, switch back | The draft token is still there; it renders MASKED again and the probe re-runs | No error expected |
| Door shut | `apiEnabled: false` | No unauth switch, no token row, no token-absent note. The standing note, Base URL row, health line, enable switch AND both `<h3>`/`<pre>` MCP and Skill blocks all still render — they sit OUTSIDE the `values.apiEnabled &&` guard, which is what `e2e/workbench-owner.spec.ts:156` asserts on a fresh (door-shut) wiki | No error expected |
| Enable, then disable | Tick enable, tick unauthenticated, untick enable | `settingsDraftAfterApiEnabled` clears `allowUnauthenticated` too; the warning goes with it | No error expected |
| Unauthenticated ticked | `apiEnabled && allowUnauthenticated` | The hint span flips to `wb-set-hint wb-set-warn` and carries `SETTINGS_API_UNAUTH_WARNING_COPY`; otherwise `SETTINGS_API_UNAUTH_OFF_COPY` | No error expected |
| Generate | Press Generate on a writable, non-env deployment | `settingsDraftAfterTokenGenerated` puts a fresh `newLoopbackApiToken()` in the draft; Show/Hide and Copy appear; the hint reads `SETTINGS_API_TOKEN_NEW_COPY` | No error expected |
| Token from env | `loopbackTokenSource: "env"` | No Generate button; hint reads `SETTINGS_API_TOKEN_ENV_COPY` | No error expected |
| Read-only deployment | `readOnly: true` | Both switches carry `aria-disabled` and refuse the change; no Generate button; neither control uses `disabled` | No error expected |
| Door open with no way in | `apiEnabled`, unauth off, no env token, no stored token, no draft token | `draftApiTokenMissing` is true ⇒ `SETTINGS_API_TOKEN_ABSENT_COPY` in a `role="status"` note; Save is NOT blocked | No error expected |
| Copy MCP config | Press Copy MCP config | `loopbackMcpConfig(draftToken, stored.loopbackMcpEntry)` reaches the clipboard; the shared `copied` note reads `SETTINGS_API_COPIED_COPY` | Clipboard absent or refused ⇒ `copied` stays false, snippet stays on screen |
| MCP snippet, no token | `loopbackMcpConfig(null)` | Names `yopedia`, `command: "node"`, one arg ending `sidecar/mcp.mjs`, and `PASTE_YOUR_TOKEN` under `env.LLM_WIKI_API_TOKEN` — never a `token=` query | No error expected |
| Masking | `maskToken` over a 48-char token | Last 4 characters survive; the rest is masked | `maskToken` of a ≤4-char token is all bullets |

</intent-contract>

## Code Map

- `src/lib/workbench-settings.ts` (3,582 lines) -- the lib source. Move the banner region
  `:903-1066` (the `// API + MCP` banner, 25 `SETTINGS_API_*` constants, `maskToken`,
  `LOOPBACK_MCP_SERVER_NAME`, `LOOPBACK_MCP_ENTRY`, `WORK_WIKI_SKILL_DIR`,
  `resolveLoopbackMcpEntry`, `loopbackMcpConfig`, `brandedSkillInstallCommand`) and the four draft
  rules `settingsDraftAfterTokenGenerated` (`:2757`), `settingsDraftAfterApiEnabled` (`:2775`),
  `draftApiUnauthenticated` (`:2790`), `draftApiTokenMissing` (`:2802`). `:1068`
  (`SETTINGS_LANGUAGE_*`) is NOT API/MCP and stays. Three consequences for what stays:
  `secretPatchValue` (`:3137`, currently private) gains `export` because `draftApiTokenMissing`
  needs it; `LOOPBACK_BASE_URL` and `LOOPBACK_TOKEN_ENV` become unused and leave the `./v1-contract`
  import at `:34-38` (only `type LoopbackTokenSource` survives there); and the `{@link
  SETTINGS_API_TOKEN_NEW_COPY}` at `:2702` (inside the `SettingsDraft` doc) is reworded to prose.
  Nothing else in the file consumes a moved symbol.
- `src/components/workbench/SettingsCanvas.tsx` (1,705 lines) -- the component source. Delete
  `revealToken` (`:209-216`), `apiLive` (`:217-220`), the probe effect (`:245-254`), the
  `case "api-mcp":` body (`:1378-1605`), and the now-unused imports: the 32 API specifiers inside
  the `@/lib/workbench-settings` block (`:20-51`), the whole `@/lib/v1-contract` block (`:131-135`),
  the whole `@/lib/workbench-loopback-health` block (`:136-142`), and `SkillSummary` (`:143`).
  `case "api-mcp":` returns `<SettingsApiMcpPane … />`. KEEP `copied`/`setCopied` (`:208`) and
  `copyToClipboard` (`:300`) — Intake shares them (`:1168`, `:1178`).
- `src/components/workbench/SettingsNav.tsx` -- the extraction pattern to copy: `"use client"`, a
  file-header block saying why the component exists, a named exported `…Props` interface directly
  above a named exported function, destructured props, no default export.
- `src/lib/workbench-loopback-health.ts:26-56` -- `probeLoopbackApiPane`, the three
  `SETTINGS_API_HEALTH_*` sentences, `ClassifiedLoopbackHealth`. Reused AS-IS by the pane; do not
  move or duplicate. `probeLoopbackApiPane` swallows every error itself and always resolves.
- `src/lib/v1-contract.ts:26,27,37,67` -- `LOOPBACK_BASE_URL`, `LOOPBACK_HEALTH_URL`,
  `LOOPBACK_TOKEN_ENV`, `newLoopbackApiToken`. The new lib module needs the base URL and the env
  name; the pane needs the health URL and the minter.
- `src/lib/config.ts:13,27,2180` -- imports `LOOPBACK_MCP_ENTRY` from `./workbench-settings`;
  re-point to the new module. It is the ONLY non-test production importer of a moved symbol.
- `e2e/workbench-owner.spec.ts:5-9,156-195` -- READ-ONLY EVIDENCE apart from the import line:
  re-point `SETTINGS_API_ENABLE_LABEL`, `SETTINGS_API_MCP_COPY`, `SETTINGS_API_MCP_HEADING` at the
  new module; every assertion stays as it is. It runs on a FRESH wiki (door shut) and asserts the
  MCP heading, the MCP sentence and `pre.wb-set-pre` are visible — the pin behind the "Door shut"
  matrix row.
- `src/lib/__tests__/workbench-epic8.test.ts:56-67` -- ten specifiers to re-point
  (`brandedSkillInstallCommand`, `draftApiTokenMissing`, `draftApiUnauthenticated`,
  `LOOPBACK_MCP_SERVER_NAME`, `loopbackMcpConfig`, `SETTINGS_API_UNAUTH_OFF_COPY`,
  `SETTINGS_API_UNAUTH_WARNING_COPY`, `settingsDraftAfterApiEnabled`,
  `settingsDraftAfterTokenGenerated`, `WORK_WIKI_SKILL_DIR`). Change no assertion.
- `src/lib/__tests__/epic8-remediation.test.ts:65` -- re-point `loopbackMcpConfig`; the spawn test
  at `:868-880` (which runs the wrap from `cwd: "/tmp"`) is the behavioural pin on
  `resolveLoopbackMcpEntry` and must keep passing untouched.
- `src/lib/__tests__/workbench-settings.test.ts` -- the source scans that must follow the code.
  `readComponent(file)` (`:157`) reads from `src/components/workbench`. `:5148` `describedBy` count
  11 (2 are the pane's: `apiEnabled-hint` at canvas `:1429`, `allowUnauthenticated-hint` at
  `:1456`); `:5192` `aria-disabled={stored.readOnly || undefined}` count 6 (2 are the pane's, canvas
  `:1418`, `:1451`); `:5152-5155` every `wb-set-hint` span carries an `id` (a ratio, holds per
  file); `:5053-5058` no `fetch(` / no `"/api/`; `:5380` the `["SettingsCanvas.tsx",
  "SettingsNav.tsx"]` router/storage loop; `:5520-5524` the `wb-set-*` CSS-coverage join;
  `:5482-5490` the client-safety scan, scoped by filename to `workbench-settings.ts`.
- `src/components/workbench/__tests__/settings-harness.tsx` -- `settingsPayload` (`:37`),
  `installSettingsFetchMock` (`:136`, once per file at module top level), `announcedFor` (`:174`),
  `mountSettings` (`:196`). `mountSettings` calls `fetchMock.mockResolvedValue`, which cannot serve
  the two probe URLs, so the new dom suite renders `<SettingsCanvas category="api-mcp"
  headingId="wb-set-heading" />` directly behind a URL-routing `mockImplementation` — the same
  direct-render shape `settings-read-only.test.tsx:378` already uses.
- `src/lib/loopback-client.ts:13-29` -- `loopbackFetch` goes through global `fetch` and
  `readLoopbackDoorToken` caches module-wide, so the new dom suite must call
  `clearLoopbackDoorToken()` per test. The probe hits `/api/v1/loopback-settings`,
  `LOOPBACK_HEALTH_URL` and `SKILL_SCAN_URL` (`chat-agent.ts:380`).
- `src/components/__tests__/email-ingest-read-only.test.tsx:72-73` -- the clipboard stub pattern
  (`vi.stubGlobal("navigator", { clipboard: { writeText } })`); the harness's
  `vi.unstubAllGlobals()` tears it down.
- `AGENTS.md` "Test environments" -- `*.test.ts` ⇒ `node`, `*.test.tsx` ⇒ `dom`, suites under
  `__tests__`.

## Tasks & Acceptance

**Execution:**
- `src/lib/workbench-api-mcp-settings.ts` -- new client-safe module holding the moved `:903-1066`
  region verbatim plus the four draft rules, importing `LOOPBACK_BASE_URL`/`LOOPBACK_TOKEN_ENV`
  from `./v1-contract`, `secretPatchValue` from `./workbench-settings`, and `SettingsDraft` /
  `WorkbenchSettingsValues` as `import type` -- so the category's rules are one file with one suite.
  Reword the four `{@link}`s that would now cross the boundary
  (`MINERU_CLOUD_WARNING_COPY`, `settingsEnvOverrideCopy`, `settingsDraftAfterMinerUEnabled`,
  `draftMinerULeavesMachine`) to prose naming the generic settings module.
- `src/lib/workbench-settings.ts` -- delete the moved symbols, `export` `secretPatchValue`, drop
  the two now-unused `./v1-contract` value imports, and reword `:2702`'s dangling link to prose
  naming the API + MCP CATEGORY (not the filename, so the one-way grep below stays clean). Import
  nothing from the new module.
- `src/components/workbench/SettingsApiMcpPane.tsx` -- new client component owning the moved JSX,
  `revealToken`, `apiLive` and the mount-time probe, with
  `SettingsApiMcpPaneProps { values, stored, field, describedBy, apply, copied, onCopy }`.
- `src/components/workbench/SettingsCanvas.tsx` -- delete the pane's state, effect, JSX and now-dead
  imports; render `<SettingsApiMcpPane … />` from `case "api-mcp":`.
- `src/lib/__tests__/workbench-api-mcp-settings.test.ts` -- new node suite covering every lib row of
  the I/O matrix (masking incl. the ≤4-char case, both snippet builders, all four draft rules) plus
  a client-safety source scan on the new module mirroring `workbench-settings.test.ts:5484-5490`.
- `src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx` -- new dom suite: the first
  mounted coverage the pane has ever had, covering every pane row of the I/O matrix over a
  URL-routing fetch mock and a stubbed clipboard, with `clearLoopbackDoorToken()` per test.
- `src/lib/__tests__/workbench-settings.test.ts` -- move the two counted scans' shares onto the new
  file (`describedBy` 11 ⇒ 9 + 2, `aria-disabled` 6 ⇒ 4 + 2, comments updated to say where the
  pane's two went), and add `SettingsApiMcpPane.tsx` to the router/storage loop, the CSS-coverage
  join, the hint-span-id rule and the no-`fetch`/no-`"/api/` rule.
- `src/lib/config.ts`, `e2e/workbench-owner.spec.ts`, `src/lib/__tests__/workbench-epic8.test.ts`,
  `src/lib/__tests__/epic8-remediation.test.ts` -- re-point import specifiers at the new module;
  change no assertion.

**Acceptance Criteria:**
- Given the repo after the change, when `src/lib/workbench-settings.ts` is grepped, then it holds no
  `SETTINGS_API_*` constant, no `maskToken`, no MCP or Skill snippet builder and no
  `draftApi*`/`settingsDraftAfterApi*` rule, and no reference to `workbench-api-mcp-settings`.
- Given `SettingsCanvas.tsx` after the change, when it is read, then it names no `SETTINGS_API_*`
  constant, no `probeLoopbackApiPane`, no `revealToken` and no `apiLive`, and it is materially
  shorter than 1,705 lines.
- Given the suites at `f342c9a8`, when they run against the extracted pair, then every assertion in
  `workbench-epic8.test.ts`, `epic8-remediation.test.ts` and the existing mounted Settings suites
  still holds with no edit beyond an import specifier or a moved scan count.
- Given the new dom suite, when it runs, then every pane row of the I/O matrix is asserted against
  the rendered DOM rather than against source text.

## Spec Change Log

## Review Triage Log

### 2026-08-30 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 10: (high 1, medium 3, low 6)
- defer: 3: (high 0, medium 2, low 1)
- reject: 13: (high 0, medium 0, low 13)
- addressed_findings:
  - `[high]` `[patch]` The new dom suite's "shows nothing until the probe lands"
    case was FLAKY — 3 of 5 isolated runs failed with the health note already
    rendered, because `mountPane` awaited the settings read and the probe's three
    fetches often flushed in the same tick. The `/health` response is now held
    behind a promise the test releases, so absence-then-presence are two ordered
    facts rather than a race. Confirmed green over 6 consecutive isolated runs.
  - `[medium]` `[patch]` The token Copy button — the only moment the loopback
    token is ever obtainable — was clicked by no test; mutating its handler to
    copy `maskToken(...)` left every suite green. A case now asserts `writeText`
    receives the plaintext token and neither the masked form nor `""`.
  - `[medium]` `[patch]` The read-only case asserted `aria-disabled` but never
    `announcedFor`, so dropping `describedBy` from either switch reddened only a
    source-text count. Both switches now assert their announcement contains
    `SETTINGS_READ_ONLY_COPY`.
  - `[medium]` `[patch]` The read-only loop's enable-switch half was vacuous: it
    mounted with `apiEnabled: true` and asserted the box stayed checked, which
    held whether or not the refusal guard fired. Split out and mounted door-shut.
  - `[low]` `[patch]` `new RegExp(SETTINGS_API_HEALTH_RUNNING_COPY)` built a
    regex out of prose containing `127.0.0.1:19828.`; the copy is matched as a
    string now.
  - `[low]` `[patch]` `describe("the pane probes once…")` never asserted "once";
    the probe count is now pinned across a re-render and three draft moves, and
    five dependency-array mutations were confirmed to fail it.
  - `[low]` `[patch]` The token hint's fourth branch,
    `SETTINGS_API_TOKEN_STORED_COPY`, had no coverage; a `hasLoopbackApiToken`
    case was added.
  - `[low]` `[patch]` `revealToken`'s doc comment moved verbatim and was left
    false — it claimed the reveal and the draft token are discarded together,
    which the pane's own new test disproves. Corrected.
  - `[low]` `[patch]` The new lib module's header stated the dependency direction
    backwards. Reworded.
  - `[low]` `[patch]` The lib side pinned that no `SETTINGS_API_*` constant
    survives in `workbench-settings.ts`, but nothing executed the matching claim
    about `SettingsCanvas.tsx` (acceptance criterion 2). A component-side scan
    was added.

## Design Notes

The split line is "the category's own rules and pixels" vs "the surface every category shares".
Anything describing the whole settings document — the category vocabulary, the payload and patch
types, the draft shape, the patch validator, the save body — stays in the generic pair even where it
mentions the API door, because those are single functions over a single object and cutting them per
category is what would create the import cycle. That is why the four API patch-validation constants
do NOT move: `validateWorkbenchSettingsPatch` uses them alongside `SETTINGS_INVALID_SECRET_COPY`, so
moving them would force `workbench-settings.ts` to import back from the new module while the new
module already imports `secretPatchValue` from it.

Two state lifetimes change as a consequence of the pane becoming a component, both named in the I/O
matrix and both in the safer direction. `apiLive` is no longer retained after the owner leaves the
pane, so a second visit shows nothing until the fresh probe lands instead of flashing the previous
visit's verdict. `revealToken` resets to masked on re-entry, which is what
`SETTINGS_API_TOKEN_NEW_COPY`'s "shown once" already promises; the draft token itself is untouched,
so Show brings it straight back.

`set` is not passed down: it is literally `apply((c) => ({ ...c, [key]: value }))`, so the pane's one
`set("allowUnauthenticated", …)` call becomes that `apply` and the props stay non-generic.

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
- `pnpm exec vitest run --project dom src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx src/components/workbench/__tests__/settings-read-only.test.tsx src/components/workbench/__tests__/settings-canvas-persistence.test.tsx src/components/workbench/__tests__/settings-embedding-provider-switch.test.tsx src/components/workbench/__tests__/settings-research-provider.test.tsx src/components/workbench/__tests__/settings-vector-namespace.test.tsx src/components/workbench/__tests__/settings-shortcut.test.tsx src/components/workbench/__tests__/settings-env-supplied-keys.test.tsx` -- expected: all pass.
- `pnpm exec tsc --noEmit` -- expected: exit 0.
- `pnpm test` -- expected: no new failure against the `f342c9a8` baseline.
- `grep -n "workbench-api-mcp-settings" src/lib/workbench-settings.ts` -- expected: no match (the one-way dependency).
- `wc -l src/components/workbench/SettingsCanvas.tsx src/lib/workbench-settings.ts` -- expected: materially below 1,705 and 3,582.
- `git diff --stat f342c9a8 -- sidecar src/components/workbench/ChatCanvas.tsx src/app/globals.css` -- expected: empty.

## Auto Run Result

Status: done

### Summary

DW-445 is resolved. The API + MCP category now has its own copy module
(`src/lib/workbench-api-mcp-settings.ts`) and its own client component
(`src/components/workbench/SettingsApiMcpPane.tsx`), matching the extraction
shape `SettingsNav.tsx` established. `SettingsCanvas` dropped from 1,705 to
1,422 lines and `workbench-settings.ts` from 3,582 to 3,346. The rendered
markup, ids and announcements are unchanged: the pane still receives `field`
and `describedBy` from the canvas, so its control ids stay in the canvas's one
`useId` namespace and the read-only sentence still appends. The dependency is
one-way — the new module imports `secretPatchValue` (newly exported) from
`workbench-settings.ts`, which imports nothing back.

The pane had never been rendered by any mounted suite; the only guard was one
Playwright case. It now has 20 dom tests and the moved rules have 14 node tests.

### Files changed

- `src/lib/workbench-api-mcp-settings.ts` (new) -- the moved banner region (25
  `SETTINGS_API_*` constants, `maskToken`, the MCP/Skill identifiers and snippet
  builders) plus the four draft rules.
- `src/components/workbench/SettingsApiMcpPane.tsx` (new) -- the pane's JSX,
  `revealToken`, `apiLive` and its own mount-time probe.
- `src/lib/__tests__/workbench-api-mcp-settings.test.ts` (new) -- node suite over
  every lib row of the I/O matrix, plus client-safety and one-way-dependency scans.
- `src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx` (new) --
  the pane's first mounted coverage, over a URL-routing fetch mock with a held
  `/health` response and a stubbed clipboard.
- `src/lib/workbench-settings.ts` -- moved symbols deleted, `secretPatchValue`
  exported, `./v1-contract` import narrowed to the surviving type, one dangling
  doc link reworded.
- `src/components/workbench/SettingsCanvas.tsx` -- pane state, probe effect, JSX
  and dead imports removed; `case "api-mcp":` is a single delegation.
- `src/lib/__tests__/workbench-settings.test.ts` -- counted scans split across the
  two files (`describedBy` 11 to 9+2, `aria-disabled` 6 to 4+2); the pane added to
  the router/storage loop, the CSS-coverage join, the hint-span-id rule and the
  no-`fetch` rule; a new component-side extraction scan.
- `src/lib/config.ts`, `e2e/workbench-owner.spec.ts`,
  `src/lib/__tests__/workbench-epic8.test.ts`,
  `src/lib/__tests__/epic8-remediation.test.ts` -- import specifiers re-pointed
  only; no assertion changed.

### Review findings

- Patches applied: 10 (1 high, 3 medium, 6 low) -- see the Review Triage Log.
- Items deferred: 3 (2 medium, 1 low) -- all pre-existing behaviour moved
  verbatim, recorded in frontmatter `deferred`.
- Items rejected: 13 -- mostly reviewer disagreement with decisions the spec had
  already settled (passing `set` down, rewording cross-module `{@link}`s,
  leaving `workbench-epic8.test.ts` assertions untouched), plus unreachable edge
  cases (a whitespace-only draft token cannot occur: the field is only ever set
  from `newLoopbackApiToken()`).
- Follow-up review recommended: **true**. Patched counts: high 1, medium 3, low
  6; a high-severity patch alone sets this, and the score 3x3 + 1x6 = 15 is over
  the threshold of 5.

### Verification

- `pnpm exec tsc --noEmit` -- exit 0.
- Node suites (new + `workbench-epic8` + `workbench-settings` +
  `epic8-remediation`) -- 4 files, 398 passed.
- Dom settings suites (new + 7 existing) -- 8 files, 158 passed.
- `pnpm test` -- 353 files, 8,225 passed, 1 skipped. Baseline `f342c9a8` was 351
  files / 8,190 passed / 1 skipped: +2 files, +35 tests, zero new failures.
- The new dom suite run 6 consecutive times in isolation -- 20 passed every run
  (it failed 3 of 5 before the P1 patch).
- `grep -n "workbench-api-mcp-settings" src/lib/workbench-settings.ts` -- no
  match; the dependency is one-way.
- `git diff --stat f342c9a8 -- sidecar src/components/workbench/ChatCanvas.tsx
  src/app/globals.css` -- empty.

### Residual risks

- **Two state lifetimes changed, by design.** Making the pane a component moves
  `apiLive` and `revealToken` from canvas lifetime to pane lifetime, so a return
  visit shows no health verdict until the fresh probe lands (rather than
  flashing the previous visit's) and re-masks a revealed token (the draft token
  itself survives). Both are named in the I/O matrix and the Design Notes, both
  are pinned by the new dom suite, and both move in the safer direction -- but on
  the return-visit path the announcements are NOT byte-identical with the
  pre-change canvas. This is the one place the refactor is not pure parity.
- **`e2e/workbench-owner.spec.ts:156` was not executed** (Playwright needs a
  running app). Only its import line changed; every assertion is byte-identical.
  Its door-shut claim -- that both snippet blocks render with `apiEnabled: false`
  -- is now additionally pinned at DOM level by the new dom suite.
- **The bundle intent's premises were false.** It states the other categories
  have already been extracted and that existing mounted suites should be
  re-pointed. Neither holds: no other category has been extracted (this change
  defines the shape), and no mounted suite had ever rendered this pane. The
  existing NODE and e2e suites were re-pointed as written, and the missing
  mounted coverage was authored rather than reported. If the intended scope was
  narrower -- a mechanical move with no new tests -- this delivered more.
- **`src/lib/config.ts`, a server module, now imports `LOOPBACK_MCP_ENTRY` from
  a per-category client module.** Correct and client-safe, but it is a new
  server-to-category-module edge worth knowing about.
