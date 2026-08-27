---
title: 'Epic 8 follow-on: sidecar provider and Chat transport'
type: 'refactor'
created: '2026-08-26'
status: 'done'
review_loop_iteration: 0
baseline_commit: ad0f18ee51a54c30ce83274b59cabf5f9a898239
context:
  - _bmad-output/implementation-artifacts/epic-8-sidecar-runtime.md
  - _bmad-output/implementation-artifacts/epic-8-context.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Provider resolution and Chat HTTP/SSE still live inside the 1,341-line HTTP shell, so a Chat-door change cannot be reviewed without the routing table, CORS, proxy, and `main`.

**Approach:** Move local provider resolution/dispatch and Chat turn handling into sibling sidecar modules. `server.mjs` stays the Node ESM HTTP shell and re-exports today's public names. [assumption: two new files, `sidecar/chat-provider.mjs` and `sidecar/chat-transport.mjs`.] ChatCanvas and Settings extracts stay deferred.

## Boundaries & Constraints

**Always:** Sidecar remains Node ESM on `127.0.0.1:19828` and never imports `src/lib`. SSE events stay exactly `meta`, `agent`, `done`, `cancelled`, `error`. `generateChat` ignores caller `provider` / `apiKey` / `baseUrl`. Chat receives the live wiki-registry poller, not a flattened snapshot. Create the turn session only after synchronous refusals. Chat JSON body stays 1 MiB. Capability `take` matches `conversationId` + `wikiId`. A `/current` tool or resume turn is `503 current_wiki_unavailable` while identity is unresolved.

**Ask First:** Changing the `sidecar/server.mjs` export path tests already import; changing the Chat body or SSE contract; unifying `readBody` with the proxy `readRawBody`.

**Never:** Extract ChatCanvas or Settings in this spec. Rust sidecar. Sixth SSE event. Request-body `apiKey`. Edit `llm-wiki.md`, `.github/`, `.yoyo/`, frozen identifiers, or intent contracts. Close `epic-8-retro-architecture-follow-on` (ChatCanvas and Settings remain).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Caller supplies provider/key | Chat body sets `provider`, `apiKey`, `baseUrl` | Local env/config still choose provider, secret, and endpoint | Missing local key (except ollama) throws Settings copy |
| Coverage miss, tools off | `coverage: false` or empty context | Immediate `done` with the existing no-coverage sentence | No provider call |
| Forged resume | Caller-built `resume.pending` + `approved: true` | No spawn | `400 invalid_resume` |
| Unresolved current, tools on | `/projects/current/chat` with `tools: true` and poller `currentId` null | No session, no capability | `503 current_wiki_unavailable` |
| Disallowed Origin | `Origin: https://evil.example` | Handler never runs | `403 origin_not_allowed` |
| Import path | Existing tests import from `sidecar/server.mjs` | Same exported names resolve | N/A |

</frozen-after-approval>

## Code Map

- `sidecar/chat-provider.mjs` -- `generateChat`, local resolver/vendor calls, `PROVIDER_TIMEOUT_MS`, `MAX_PROVIDER_RESPONSE_CHARS`.
- `sidecar/chat-transport.mjs` -- `handleChat`, `runToolTurn`, turn session, SSE, Chat `readBody`, `chatPath`, `sanitizeCitedAnswer`. Exported for the HTTP shell; not re-exported from `server.mjs` except the names tests already import (`createChatTurnSession`, `formatSse`, `sanitizeCitedAnswer`).
- `sidecar/server.mjs` -- bind, CORS, health, skills, workspace preview, kernel proxy, `createSidecarServer`, `main`. POST Chat is a one-line `handleChat` dispatch with the live `wikiRegistry` poller. Re-exports today's public provider/Chat names so `workbench-epic3.test.ts`, `epic8-remediation.test.ts`, and `workbench-epic8.test.ts` keep importing `../../../sidecar/server.mjs`.
- `sidecar/agent.mjs` -- keep `generate` injected; do not move the agent loop.
- `sidecar/loopback.mjs`, `sidecar/capabilities.mjs` -- unchanged contracts (`V1_MAX_BODY_BYTES`, `canonicalLoopbackWikiId`, `take`).
- `src/lib/sidecar.ts` -- browser SSE name list only; do not import it from the sidecar.

## Tasks & Acceptance

**Execution:**
- [x] `sidecar/chat-provider.mjs` -- hold `generateChat` and the local resolver/vendor calls -- isolate provider transport.
- [x] `sidecar/chat-transport.mjs` -- hold `handleChat`, `runToolTurn`, session, SSE, and Chat `readBody` -- isolate Chat transport. [assumption: `handleChat` may stay unexported if HTTP tests still cover it.]
- [x] `sidecar/server.mjs` -- keep bind, CORS, health, skills, workspace preview, kernel proxy, `main`; import and re-export today's public Chat/provider names.
- [x] `src/lib/__tests__/workbench-epic3.test.ts`, `src/lib/__tests__/epic8-remediation.test.ts`, `src/lib/__tests__/workbench-epic8.test.ts` -- keep `server.mjs` imports; add a source pin that `generateChat` lives in `chat-provider.mjs` and that `server.mjs` / the new modules do not import `src/lib`.
- [x] Confirm `ChatCanvas.tsx`, `SettingsCanvas.tsx`, and `workbench-settings.ts` are untouched.

**Acceptance Criteria:**
- Given the existing sidecar Chat/HTTP suite, when it imports from `sidecar/server.mjs`, then every current assertion still holds, including forged resume, origin refusal, unresolved-current tool turns, and live `wikiRegistry` wiring.
- Given a Chat body that names a provider, key, or endpoint, when `generateChat` runs, then only local env/config choose those legs.
- Given the sidecar tree after the extract, when it is scanned for `src/lib` imports, then none exist.
- Given this spec's diff, when ChatCanvas and the Settings pair are compared to `ad0f18ee`, then they are unchanged.

## Spec Change Log

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/workbench-epic3.test.ts src/lib/__tests__/epic8-remediation.test.ts src/lib/__tests__/workbench-epic8.test.ts` -- expected: all pass.
- `pnpm exec tsc --noEmit` -- expected: exit 0.
- `git diff --name-only ad0f18ee -- src/components/workbench/ChatCanvas.tsx src/components/workbench/SettingsCanvas.tsx src/lib/workbench-settings.ts` -- expected: empty.

## Suggested Review Order

**HTTP shell dispatch**

- POST Chat is one-line `handleChat` with the live wiki-registry poller.
  [`server.mjs:403`](../../sidecar/server.mjs#L403)

- `main` still passes the poller into `createSidecarServer`, never a snapshot.
  [`server.mjs:462`](../../sidecar/server.mjs#L462)

**Provider extract**

- Caller `provider` / `apiKey` / `baseUrl` are ignored; local env/config win.
  [`chat-provider.mjs:186`](../../sidecar/chat-provider.mjs#L186)

**Chat transport**

- Turn handler lives here; `/current` tools refuse while identity is unresolved.
  [`chat-transport.mjs:438`](../../sidecar/chat-transport.mjs#L438)

- Session attaches only after forged-resume and unresolved-current refusals.
  [`chat-transport.mjs:509`](../../sidecar/chat-transport.mjs#L509)

**Public import path**

- Tests keep importing today's names from the HTTP shell.
  [`server.mjs:66`](../../sidecar/server.mjs#L66)

**Pins and remaining follow-on**

- Source pin: `generateChat` lives in the provider module; sidecar stays off `src/lib`.
  [`workbench-epic3.test.ts:386`](../../src/lib/__tests__/workbench-epic3.test.ts#L386)

- Runtime note: Chat extract is done; ChatCanvas and Settings remain follow-on.
  [`epic-8-sidecar-runtime.md:23`](./epic-8-sidecar-runtime.md#L23)
