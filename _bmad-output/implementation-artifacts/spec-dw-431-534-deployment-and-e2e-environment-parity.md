---
title: 'Deployment and E2E environment parity (DW-431, DW-534)'
type: 'bugfix'
created: '2026-09-05'
status: 'done'
baseline_revision: '4318ac59a0b873fe18e1b71c7a6d638bc41b6d66'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      `docker build .` cannot produce an image at all: the build stage's `pnpm build`
      fails with a webpack error pulling `node:timers/promises` into a client bundle.
    evidence: |-
      Verifying DW-431 with a real build surfaced this. `docker build .` fails at
      `Dockerfile:20` (`RUN pnpm build`) with "Build failed because of webpack errors"
      and the import trace `node:timers/promises` -> src/lib/storage/filesystem.ts ->
      src/lib/storage/index.ts -> src/lib/backups.ts -> src/components/SystemHealthDesk.tsx.
      Pre-existing, not caused by this change: a control build from a Dockerfile whose
      deps stage still reads `COPY package.json pnpm-lock.yaml ./` fails identically at
      the same step. `docker build --target deps .` succeeds either way, so only the
      image's build stage is dead. Nothing in `.github/workflows/` runs `docker build`,
      so CI cannot see it; `Dockerfile` and `docker-compose.yml` are the only record
      that the container path is meant to work.
    location: >-
      Dockerfile:20
    severity: low
---

<intent-contract>

## Intent

**Problem:** Two environment configurations disagree with what the rest of the app assumes. (DW-431) `Dockerfile:5` copies only `package.json pnpm-lock.yaml` before `pnpm install --frozen-lockfile`, while `Dockerfile:13`'s `COPY . .` brings the root `pnpm-workspace.yaml` (which `.dockerignore` does not exclude) into the build stage — so the two stages disagree about whether `/app` is a pnpm workspace root, and no `docker build` has ever verified either. (DW-534) Under the armed E2E cookie identity `src/app/layout.tsx:88` renders the shell WITHOUT `<ClerkProvider>`, so `useViewerHandle` (`src/lib/viewer-handle.ts:49`, which reads Clerk's `useUser`) answers signed-out for the very owner `middleware.ts` admits — every client identity gate (Delete, Re-ingest, Graphify, and now Revert) fails closed for the E2E owner.

**Approach:** Copy `pnpm-workspace.yaml` alongside `package.json`/`pnpm-lock.yaml` in the deps stage and verify with a real `docker build`. Give `useViewerHandle` an E2E-armed branch: the root layout resolves the owner handle from the `yopedia_e2e` cookie on the SERVER (the same `principalFromCookieValue` middleware and `getPrincipal` share) and injects it through a client context the hook prefers over Clerk; without that injection the hook keeps reading Clerk exactly as today.

## Boundaries & Constraints

**Always:**
- The client gate may be NARROWER than the server's answer, never WIDER. The E2E branch must resolve the actual cookie identity — an armed server with no (or an invalid) `yopedia_e2e` cookie must answer signed-out, exactly as the server does.
- `src/lib/viewer-handle.ts` stays inside the browser bundle's boundary: no `@/lib/commons`, `@/lib/authz` or `@/lib/wiki` import, directly or transitively, and it remains the ONE copy of the handle-resolution rule (`article-actions-gate.test.ts` scans it).
- The hook's Clerk read must never execute on the armed E2E path — there is no `<ClerkProvider>` there and `useUser()` throws outside one.
- `RootLayout` and `AppProviders` in `src/app/layout.tsx` stay SYNCHRONOUS; `src/app/__tests__/app-shell.test.tsx` mounts `RootLayout({children})` by calling it directly and its docblock pins that.
- The E2E harness stays out of production render paths: nothing new may load `next/headers` or read cookies on the non-armed branch.
- E2E arming stays out of wrangler vars/Cloudflare secrets and out of any `NEXT_PUBLIC_*` variable (`e2e-identity.test.ts` pins the wrangler half).

**Block If:**
- `docker build` cannot run at all in this environment (no daemon) AND no equivalent evidence of the deps stage installing can be produced.
- Copying `pnpm-workspace.yaml` into the deps stage changes what `pnpm install --frozen-lockfile` resolves (e.g. `ERR_PNPM_OUTDATED_LOCKFILE`) — that would mean the root workspace file and the root lockfile disagree, which is a repo-wide question, not a Dockerfile one.

**Never:**
- Do not edit `_bmad-output/implementation-artifacts/deferred-work.md` — the orchestrator records resolution.
- Do not mount `<ClerkProvider>` on the armed E2E path, and do not add a `NEXT_PUBLIC_*` variable to carry the E2E identity to the browser.
- Do not add a new HTTP route or client fetch to discover the E2E viewer.
- Do not change what any gate DECIDES (`canDelete`, `canReingest`, `canCurate`, `canRevert` expressions stay byte-identical); only who the viewer is under E2E changes.
- Do not enrol the e2e lane in CI, add Playwright specs for article affordances, or change `playwright.config.ts` — DW-431/DW-534 are the prerequisite, not that work.
- Do not restructure the Dockerfile beyond the deps-stage `COPY` (no standalone output, no stage merging).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Docker deps stage | `docker build --target deps .` | Succeeds; `/app/pnpm-workspace.yaml` present and `pnpm install --frozen-lockfile` resolves the single `.` importer | Non-zero exit fails the story |
| Docker stage parity | Dockerfile text | The stage that runs `pnpm install` copies every root file the build stage's `COPY . .` supplies for workspace resolution (`pnpm-workspace.yaml` included), and `.dockerignore` does not exclude it | Test fails naming the divergent stage |
| E2E owner, cookie present | `isE2eIdentityArmed()`, valid `yopedia_e2e` cookie for `YOPEDIA_OWNER_USER_ID` | `useViewerHandle()` → `{isLoaded:true, isSignedIn:true, handle:"<owner>"}` (lowercased); Clerk's `useUser` never called | n/a |
| E2E, no/invalid cookie | armed, cookie absent or HMAC/user-id mismatch | `useViewerHandle()` → `{isLoaded:true, isSignedIn:false, handle:null}`; Clerk's `useUser` never called | Cookie store unavailable → same signed-out answer, never an owner |
| Not armed (production, unit tests) | no E2E identity injected | `useViewerHandle()` reads Clerk exactly as today | Unchanged |

</intent-contract>

## Code Map

- `Dockerfile:5` -- deps stage `COPY package.json pnpm-lock.yaml ./` then `:6` `pnpm install --frozen-lockfile`; `:13` `COPY . .` in the build stage is the other half of the divergence.
- `.dockerignore` -- excludes `*.md` (except `SCHEMA.md`), `node_modules/`, `.next/`, `.git/`, data dirs. Does NOT exclude `pnpm-workspace.yaml`, which is why the build stage gets it.
- `pnpm-workspace.yaml` -- `packages: ["."]`, exists only to stop pnpm's upward walk; comments explain why `workers/sandbox-runner` is excluded.
- `src/lib/__tests__/pnpm-workspace-root.test.ts` -- DW-411's suite; `readRepoFile` helper, `ROOT_WORKSPACE`/`ROOT_LOCKFILE` constants, and it already names "the Dockerfile build" in two failure messages. The Dockerfile parity pin belongs here.
- `src/lib/viewer-handle.ts:29,48-61` -- `"use client"`; imports only `@clerk/nextjs`; exports `ViewerHandle` and `useViewerHandle()`. Add the context + the armed branch here.
- `src/app/layout.tsx:77-96` -- sync `AppProviders`; `const e2e = isE2eIdentityArmed()` at `:78`; `:88` returns the bare shell under E2E, `<ClerkProvider>` otherwise. The injection point.
- `src/lib/e2e-identity.ts:19,113-128` -- `E2E_COOKIE_NAME`, `principalFromCookieValue()` (verifies HMAC, requires `userId === ownerId`, returns `{id, handle}` with `e2eOwnerHandle()`). Already imported by layout for `isE2eIdentityArmed`.
- `src/lib/auth.ts:74-82` -- `getE2ePrincipal()` shows the server-side shape: `await cookies()`, `jar.get(E2E_COOKIE_NAME)?.value`, fail closed on a missing cookie store.
- `src/components/ArticleActions.tsx:116` / `src/components/RevisionHistory.tsx:120` -- the two consumers; their gate expressions must not change.
- `src/lib/__tests__/article-actions-gate.test.ts:104,266-283,288-313` -- `CLIENT_LIB = "viewer-handle.ts"` source scan: asserts the file is `"use client"`, imports `@clerk/nextjs`, exports `useViewerHandle()`, keeps the twitter-fallback regex and `isSignedIn: boolean;`, and that neither island restates `useUser`/`externalAccounts`. Keep all of it true.
- `src/app/__tests__/app-shell.test.tsx:96-140,186-199` -- mocks `@clerk/nextjs` so `useUser` THROWS outside `<ClerkProvider>`, and mounts `RootLayout({children})` synchronously. Not armed, so it must keep exercising the Clerk branch untouched.
- `src/components/__tests__/article-actions-delete-gate.test.tsx:56`, `page-write-read-only.test.tsx:69` -- mount the islands with `@clerk/nextjs.useUser` mocked and NO provider; the fallback path must stay their path.
- `vitest.config.ts` -- two projects: `node` over `src/**/__tests__/**/*.test.ts`, `jsdom` over `src/**/__tests__/**/*.test.tsx`.
- `playwright.config.ts:34-59` / `e2e/fixtures/owner.ts` -- how the harness is armed and how the cookie is installed (`unsignedTest` = no cookie).

## Tasks & Acceptance

**Execution:**
- `Dockerfile` -- add `pnpm-workspace.yaml` to the deps-stage `COPY` at `:5`, with a short comment saying why (the build stage's `COPY . .` supplies it, so without this the two stages disagree about the workspace root) -- closes DW-431.
- `src/lib/__tests__/pnpm-workspace-root.test.ts` -- add a test that DERIVES the deps stage from the Dockerfile (the stage whose `RUN` invokes `pnpm install`), asserts its `COPY` sources include `pnpm-workspace.yaml`, and asserts `.dockerignore` does not exclude that file -- so the divergence cannot silently return.
- `src/lib/viewer-handle.ts` -- add an exported React context carrying a server-resolved `ViewerHandle` (default `null`) and make `useViewerHandle()` return the injected value when present, falling through to the existing Clerk read otherwise; document why the branch cannot flip between renders and why Clerk must not be read on the armed path -- closes DW-534's hook half.
- `src/components/E2eViewerIdentityProvider.tsx` -- new `"use client"` component: takes the cookie-resolved handle (`string | null`) and publishes `{isLoaded:true, isSignedIn: handle !== null, handle: lowercased}` on the context -- the client half of the seam.
- `src/components/E2eViewerIdentity.tsx` -- new async SERVER component: resolves the `yopedia_e2e` cookie through `principalFromCookieValue`, renders the provider around `children`. Load `next/headers` lazily so the non-armed graph never gains it; a missing cookie store fails closed to `null`.
- `src/app/layout.tsx` -- on the armed branch only, wrap `shell` in `<E2eViewerIdentity>`; `AppProviders` stays sync and the Clerk branch is untouched -- the injection point.
- `src/lib/__tests__/viewer-handle-e2e.test.tsx` -- new mounted suite covering the matrix's three hook rows: injected owner, injected signed-out, and no injection (Clerk fallback), with `useUser` mocked to THROW so "never reads Clerk when armed" is observable rather than assumed.
- `src/components/__tests__/e2e-viewer-identity.test.tsx` -- new suite for the server component: valid cookie → provider gets the owner handle; absent/invalid cookie → `null`; cookie store unavailable → `null`. Plus a source scan pinning that `src/app/layout.tsx` wraps ONLY the armed branch and still renders `<ClerkProvider>` on the other.

**Acceptance Criteria:**
- Given a clean checkout, when `docker build --target deps .` runs, then it succeeds and the resulting stage contains `/app/pnpm-workspace.yaml` next to the installed `node_modules`.
- Given the Dockerfile, when the deps stage's `COPY` list is compared against the workspace files the build stage's `COPY . .` supplies, then `pnpm-workspace.yaml` appears in both and the new test fails if it is dropped from either.
- Given the E2E harness is armed and the owner cookie is installed, when a client island calls `useViewerHandle()`, then it reports the owner as signed in with the lowercased owner handle without Clerk being consulted.
- Given the E2E harness is armed and no valid cookie is present, when a client island calls `useViewerHandle()`, then it reports signed-out with a `null` handle — never the owner.
- Given the harness is not armed, when `RootLayout` is mounted, then the tree still passes through `<ClerkProvider>` and `useViewerHandle()` answers from Clerk exactly as before.
- Given the whole suite, when `pnpm test`, `pnpm lint` and `pnpm exec tsc --noEmit` run, then all pass with no new warnings.

## Spec Change Log

## Review Triage Log

### 2026-09-05 - Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 1: (high 0, medium 0, low 1)
- reject: 11: (high 0, medium 0, low 11)
- addressed_findings:
  - `[low]` `[patch]` `dockerignoreExcludes` never matched a root-anchored `.dockerignore` pattern (a leading `/`), so a real exclusion of `pnpm-workspace.yaml` would have read as "not excluded" - the silent-pass direction the guard exists to prevent. Leading `/` is now stripped after the `!` prefix, with a unit row covering both directions.
  - `[low]` `[patch]` The Dockerfile parity test asserted only the stage that runs `pnpm install`, so narrowing the build stage's `COPY . .` to explicit paths would have re-opened the DW-431 divergence with the suite green. Added the complementary half: the derived app-build stage must receive every install input from the build context, anti-vacuity included.
  - `[low]` `[patch]` `E2eViewerIdentity`'s `catch` was documented as narrow but was total, so a real defect - or Next's dynamic-rendering bailout - would have become an unlogged signed-out answer indistinguishable from the DW-534 symptom. Now mirrors `src/lib/auth.ts`: `unstable_rethrow` first, then a logged fail-closed, with a test row that throws a real control-flow error.
  - `[low]` `[patch]` Two doc claims in `src/lib/viewer-handle.ts` were left stale by the change ("imports `@clerk/nextjs` and nothing else"; `isLoaded` described only as the Clerk session resolving). Both reconciled with the injected path.

## Design Notes

The hook's branch is a CONDITIONAL hook call by shape (`injected ?? useClerkViewerHandle()`), which needs a targeted `eslint-disable-next-line react-hooks/rules-of-hooks` plus the reason: the provider is mounted (or not) by the root layout from a server env read, so for any given page load it is present for the whole lifetime of the tree — the call order can never change between renders of the same component. The alternative shapes are worse: always calling `useUser()` throws on the armed path (no `<ClerkProvider>`), and moving the Clerk read into a provider would strand every mounted island suite that mocks `useUser` and renders the island bare.

Injection carries a full `ViewerHandle` (not just a handle string) so "armed" is distinguishable from "armed but signed out" — a `handle: null` context value must still short-circuit Clerk.

```tsx
// src/app/layout.tsx — armed branch only
return e2e ? (
  <E2eViewerIdentity>{shell}</E2eViewerIdentity>
) : (
  <ClerkProvider signInFallbackRedirectUrl="/" signInForceRedirectUrl="/">{shell}</ClerkProvider>
);
```

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/pnpm-workspace-root.test.ts src/lib/__tests__/article-actions-gate.test.ts` -- expected: pass
- `pnpm exec vitest run --project dom` -- expected: pass, including the new mounted suites and `app-shell.test.tsx`
- `pnpm test` -- expected: full suite green
- `pnpm lint` -- expected: no errors, no new warnings
- `pnpm exec tsc --noEmit` -- expected: clean
- `docker build --target deps -t work-wiki-deps .` -- expected: exit 0; then `docker run --rm work-wiki-deps ls /app/pnpm-workspace.yaml /app/node_modules` lists both

## Auto Run Result

Status: done
Blocking condition: none

**Summary.** Both halves of the bundle landed. DW-431: the Dockerfile's deps stage now copies `pnpm-workspace.yaml` alongside the manifest and lockfile, so it and the build stage agree that `/app` is the pnpm workspace root, and the divergence is pinned by a test that derives both stages from the Dockerfile rather than restating it. DW-534: under the armed E2E harness the root layout now resolves the `yopedia_e2e` cookie on the server - through the same `principalFromCookieValue` middleware and `getPrincipal` share - and injects the resulting `ViewerHandle` into a client context that `useViewerHandle()` prefers over Clerk, so the E2E owner the server admits is the viewer the client gates see. Nothing changes for a normal request: with no provider mounted the context is `null` and the Clerk read is the whole hook.

**Files changed.**
- `../../Dockerfile` - deps stage copies `pnpm-workspace.yaml`, with the two-stage divergence explained in place.
- `../../src/lib/__tests__/pnpm-workspace-root.test.ts` - Dockerfile instruction/stage reader and `.dockerignore` matcher, plus the two-direction parity assertion (install stage copies the workspace inputs; the app-build stage receives them) and unit rows for both helpers.
- `../../src/lib/viewer-handle.ts` - `E2eViewerHandleContext`, the Clerk read extracted to `useClerkViewerHandle()`, and the injected-first branch in `useViewerHandle()`; docs reconciled.
- `../../src/components/E2eViewerIdentity.tsx` (new) - async server component resolving the cookie, `next/headers` loaded lazily, fails closed and re-throws Next control-flow errors.
- `../../src/components/E2eViewerIdentityProvider.tsx` (new) - client provider publishing the server-resolved handle, lowercased.
- `../../src/app/layout.tsx` - wraps the armed branch only; `AppProviders` and `RootLayout` stay synchronous.
- `../../src/lib/__tests__/viewer-handle-e2e.test.tsx` (new), `../../src/components/__tests__/e2e-viewer-identity.test.tsx` (new) - the hook's three matrix rows and the server component's cookie matrix, with `useUser` mocked to throw so "never reads Clerk when armed" is observed rather than assumed.

**Review findings.** 4 patches applied (all low severity - see the Review Triage Log). 1 deferred: `docker build .` fails at `pnpm build` for a pre-existing webpack reason, confirmed against a control build of the unmodified deps stage. 11 rejected, chiefly Dockerfile-parser edge cases whose failure direction is loud rather than silent, and the absence of a Playwright spec touching an article affordance - which the intent itself names as out of scope ("harmless today ... the prerequisite for enrolling the e2e lane in CI").

**Follow-up review recommendation.** false. Patched findings by severity: high 0, medium 0, low 4. Score: no high-severity patch, so no further pass is warranted.

**Verification.**
- `docker build --target deps -t work-wiki-deps .` - exit 0; `docker run --rm work-wiki-deps` shows `/app/pnpm-workspace.yaml` present next to a populated `node_modules`, and a re-run of `pnpm install --frozen-lockfile` inside the image reports "Already up to date" - no `ERR_PNPM_OUTDATED_LOCKFILE`. Image removed afterwards.
- `docker build .` (full image) - fails at `RUN pnpm build`; a control build from a Dockerfile with the ORIGINAL deps-stage `COPY` fails identically, establishing the failure as pre-existing and unrelated (recorded in frontmatter `deferred`).
- `pnpm test` - 396 files, 9905 passed / 1 skipped.
- `pnpm exec vitest run --project dom` - 87 files, 1298 passed.
- `pnpm exec vitest run src/lib/__tests__/pnpm-workspace-root.test.ts src/lib/__tests__/article-actions-gate.test.ts` - 39 passed.
- `pnpm lint` - clean (3 pre-existing `jsx-ast-utils` notices, count unchanged against a stashed tree).
- `pnpm exec tsc --noEmit` - clean.
- Mutation checks on the new Dockerfile assertions: dropping `pnpm-workspace.yaml` from the deps `COPY`, narrowing the build stage's `COPY . .`, adding `/pnpm-workspace.yaml` to `.dockerignore`, and removing the leading-slash strip each fail with the intended message; all restored.
- Real-runtime evidence for DW-534: a throwaway client probe route driven by the armed Playwright lane with the owner cookie reported signed-in with the owner handle (deleted afterwards, along with its generated `.next` artifacts).

**Residual risks.**
- The conditional Clerk call in `useViewerHandle()` carries a targeted `react-hooks/rules-of-hooks` disable. It is safe because the provider is mounted or not by the root layout from a server env read, so the branch cannot flip within a tree's lifetime - but a future refactor that made arming dynamic would break that premise, and only the docblock records it.
- The layout's armed branch is pinned as a source scan, not a render: `app-shell.test.tsx` calls `RootLayout({children})` directly and cannot mount an async server component. The real-runtime check above covered it once, but that evidence is not durable.
- Other client islands (`SaveCapture`, `IngestVaultPicker`, the graph and query pages) still call `useUser()` directly and would fail under the armed shell. Pre-existing and the same shape as the gates this story fixed; not filed, since the E2E lane never leaves `/` today.
- Docker's local build cache on this machine hit "no space left on device" during the full-image verification. The images this run created were removed; the shared build cache (30GB, mostly pre-existing) was left alone.
