---
title: 'DW-443 — per-runtime DNS-rebinding SSRF boundary'
type: 'bugfix'
created: '2026-08-29'
status: 'in-review'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
baseline_revision: 'e86dce76f1162502e35e70ce4496a18d53dd8d56'
---

<intent-contract>

## Intent

**Problem:** `validateUrlSafety` (`src/lib/url-safety.ts`) rejects only *literal* private hosts; a hostname that resolves to a private address — or re-resolves to one between the check and the fetch — passes, so every guarded fetch path is open to DNS-rebinding SSRF.

**Approach:** Per-runtime guard (human decision, 2026-08-28). Make `validateUrlSafety` async and dispatch the post-literal half to a runtime target: a **Node** target that resolves DNS, rejects private answers, and pins the resolved address through to connect time; a **Workers** target that has no DNS control and therefore relies on an operator egress allowlist (or a deployment-level egress proxy). Add a `safeFetch` door so the pinned address is what the socket actually connects to, update every caller, and state in the module doc which protection each target actually has.

## Boundaries & Constraints

**Always:**
- The literal checks (scheme, blocked hostnames/suffixes, private IPv4/IPv6 literals, IPv4-mapped IPv6) keep their current behaviour and current error text (`URL blocked: …`), and run *before* any runtime dispatch.
- Runtime detection mirrors the existing precedent in `src/lib/storage/index.ts` (`globalThis.caches.default` ⇒ Workers, else Node).
- The Node target's connect-time pin is what makes it a boundary: the socket connects to an address the guard validated, not to whatever DNS returns at connect time.
- Node-only modules (`node:dns`, `node:http`, `node:https`) are reached through a dynamic `import()` inside the Node target only, never at Workers module-eval time.
- Existing suites that stub `globalThis.fetch` must keep working: `vitest.setup.ts` installs a deterministic test target.

**Block If:**
- The Workers runtime turns out to need a wire header or new brand identifier (frozen-identifier surface — see AGENTS.md) to carry egress config.

**Never:**
- Do not add a runtime dependency (no `undici`) — the Workers bundle is production, and a Node HTTP client must not be bundled into it.
- Do not invent a proxy wire protocol. The Workers *code* control is the allowlist; an egress proxy is deployment configuration, documented only.
- Do not weaken or delete any existing blocked-host rule.
- Do not perform real DNS or real network I/O in the unit suites.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Literal private host | `http://10.0.0.1/` | rejects, before any DNS | `URL blocked: hostname resolves to a private/reserved address` |
| Node, host resolves public | `https://example.com`, lookup ⇒ `93.184.216.34` | resolves; pin = that address | none |
| Node, host resolves private | `https://rebind.example`, lookup ⇒ `169.254.169.254` | rejects | `URL blocked: hostname resolves to a private/reserved address` |
| Node, mixed answers | lookup ⇒ `[8.8.8.8, 127.0.0.1]` | rejects — *any* private answer fails the host | same message |
| Node, lookup fails | lookup throws `ENOTFOUND` | rejects | `URL blocked: DNS resolution failed` |
| Node, empty answer | lookup ⇒ `[]` | rejects | `URL blocked: DNS resolution failed` |
| Node, connect-time pin | `safeFetch` with pin `A` while DNS would now answer `B` | socket connects to `A` | none |
| Workers, allowlist set, host on it | allowlist `example.com`, host `docs.example.com` | allowed | none |
| Workers, allowlist set, host off it | allowlist `example.com`, host `evil.test` | rejects | `URL blocked: host is not on the egress allowlist` |
| Workers, no allowlist | no env configured | allowed — literal-only protection, logged once as a warning | none |

</intent-contract>

## Code Map

- `src/lib/url-safety.ts:95` — `validateUrlSafety` today: sync, literal-only. Becomes the public async door + target registry. Keep `isPrivateIPv4`/`isPrivateIPv6` and the `BLOCKED_HOST*` lists; export a shared `isPrivateAddress(ip)` for the targets.
- `src/lib/storage/index.ts:38-58` — `detectProvider()`: the runtime-detection idiom to mirror (`caches.default` heuristic + env override + singleton).
- `src/lib/fetch.ts:26,35` — imports and re-exports `validateUrlSafety` (the re-export is load-bearing; `ingest.test.ts`/`mcp.test.ts` import it from `./fetch`).
- `src/lib/fetch.ts:167,176` — `fetchFollowingRedirects`: guard + per-hop `fetch` (line 195 re-validates each redirect target).
- `src/lib/fetch.ts:497` — `downloadImages`: fetches image URLs harvested from remote HTML with **no** guard at all today. Degrades gracefully (`try`/`continue`).
- `src/lib/fetch.ts:579,584` — `fetchImageBytes`: guard errors are wrapped in `ClientInputError` (→ 4xx); preserve that wrapping.
- `src/lib/source-monitors.ts:228` (`createSourceMonitor`) and `:344,350` (`defaultFetchSource`, HEAD + GET) — both already inside `async` functions.
- `src/lib/integration-outbox.ts:126` (`saveIntegrationSettings`) and `:305,307` (webhook delivery, `dependencies.fetch ?? fetch`, `redirect: "error"`).
- `src/lib/__tests__/url-safety.test.ts` and `src/lib/__tests__/ingest.test.ts:3037-3145` — every case is `expect(() => validateUrlSafety(x)).toThrow(...)`; all must become `await expect(...).rejects.toThrow(...)`.
- `vitest.setup.ts` (11 lines) — shared setup for both projects; where the deterministic test target is installed.
- `AGENTS.md` "Frozen identifiers" — `YOPEDIA_*` all-caps env names are waived as a *shape*, so `YOPEDIA_EGRESS_ALLOWLIST` needs no allowlist edit. A new `X-Yopedia-*` header would (do not add one).
- `.env.example:100` — where `YOPEDIA_*` operator env is documented.

## Tasks & Acceptance

**Execution:**
- `src/lib/url-safety.ts` — split into literal core + async door. Keep the literal checks in `assertLiteralUrlSafety(url)` (returns the parsed URL and bracket-stripped hostname); export `isPrivateAddress(ip)`. Add the `UrlSafetyTarget` interface (`protection` label, `guard(hostname) => Promise<PinnedAddress[]>`, `fetch(url, init, pin)`), lazy `detectUrlSafetyTarget()` (Workers heuristic ⇒ `./url-safety-workers`, else `./url-safety-node`, via dynamic `import()`), a `setUrlSafetyTarget(target | null)` seam, `async validateUrlSafety(url): Promise<void>`, and `async safeFetch(url, init?): Promise<Response>` (literal check → guard → target fetch with the pin). Lead the file with a **Protection by target** doc block naming, per target, exactly what it does and does not stop.
- `src/lib/url-safety-node.ts` — new. `resolvePinnedAddresses(hostname, lookup?)`: IP literal ⇒ itself; else `dns/promises` `lookup(host, { all: true, verbatim: true })`, reject empty/failed lookups and any private answer. `nodeSafeFetch(url, init, pin)`: `node:http`/`node:https` `request` with a `lookup` option that hands back only pinned addresses (re-checked), so SNI/`Host` stay the original hostname; support GET/HEAD/POST, string bodies, `AbortSignal`, `redirect: "manual"` (default) and `"error"` (throw on 3xx), and return a real `Response` built from the stream. `createNodeTarget()` wires the two.
- `src/lib/url-safety-workers.ts` — new. `createWorkersTarget()`: read `YOPEDIA_EGRESS_ALLOWLIST` (comma-separated hosts; a host matches an entry exactly or as its subdomain) from `getCloudflareContext().env` (try/catch) falling back to `process.env`; enforce it in `guard`, warn once when unset; `fetch` is the platform `fetch` (no pin is possible). Document why resolving DNS here would be theatre.
- `src/lib/fetch.ts` — `await` the three guard calls; route the fetches at 176, 497, 584 through `safeFetch`; keep the `ClientInputError` wrapping in `fetchImageBytes`; re-export `safeFetch` alongside `validateUrlSafety`.
- `src/lib/source-monitors.ts` — `await` both guard calls; `defaultFetchSource` uses `safeFetch` for its HEAD and GET.
- `src/lib/integration-outbox.ts` — `await` both guard calls; webhook delivery defaults to `safeFetch` (`dependencies.fetch ?? safeFetch`).
- `vitest.setup.ts` — install a deterministic test target (guard ⇒ one fixed public address, fetch ⇒ `globalThis.fetch(url, init)`) so suites that stub global fetch keep working and no test does real DNS.
- `src/lib/__tests__/url-safety.test.ts` — convert every case to `rejects.toThrow`; add cases for the target seam.
- `src/lib/__tests__/ingest.test.ts` — convert the `validateUrlSafety` block (3037-3145) to `rejects.toThrow`.
- `src/lib/__tests__/url-safety-runtime.test.ts` — new. Cover the whole I/O matrix: injected `lookup` for every Node resolution case; a real loopback `node:http` server plus a pin to prove connect-time pinning (URL host is a public-looking name, pin is the loopback server, request lands on the server); Workers allowlist accept/reject/unset; `detectUrlSafetyTarget()` picking each target.
- `.env.example` — document `YOPEDIA_EGRESS_ALLOWLIST` next to the other `YOPEDIA_*` operator entries.

**Acceptance Criteria:**
- Given a caller on the Node target, when it guards a hostname whose DNS answer includes a private address, then the call rejects and no request is made.
- Given a validated pin, when `safeFetch` runs on the Node target, then the connection is made to that pinned address even if DNS would now answer differently.
- Given the Workers target with no allowlist configured, when a public hostname is guarded, then the call proceeds and the module doc states plainly that this target has literal-only protection.
- Given the full suite, when `pnpm test` runs, then it passes with no network access and no test performs real DNS.

## Spec Change Log

## Design Notes

The transport has to change hands for pinning to mean anything: Node's global `fetch` gives no hook between "resolve" and "connect", and adding `undici` to get one would drag a Node HTTP client into the Workers bundle. So the Node target owns its own `node:https` request and passes a `lookup` that can only answer with pinned addresses:

```ts
const pinnedLookup: LookupFunction = (_host, opts, cb) => {
  const usable = pin.filter((a) => !opts.family || a.family === opts.family);
  if (!usable.length) return cb(new Error("URL blocked: no pinned address"), "", 4);
  if (isPrivateAddress(usable[0].address)) return cb(new Error("URL blocked: …"), "", 4);
  cb(null, usable[0].address, usable[0].family);
};
```

`request(url, { lookup })` keeps the URL's hostname for SNI and the `Host` header, so TLS still validates against the real certificate — which is why this beats rewriting the URL to the IP literal.

Workers cannot do the same: `workerd` exposes no DNS API, and even a DoH lookup would not bind the answer to the socket the platform's `fetch` opens. Saying so in the file is half the deliverable.

## Verification

**Commands:**
- `pnpm exec vitest run src/lib/__tests__/url-safety.test.ts src/lib/__tests__/url-safety-runtime.test.ts` -- expected: all pass, including the pinning and DNS-rejection cases.
- `pnpm test` -- expected: full suite green (both projects), no new failures.
- `pnpm lint` -- expected: clean.
- `pnpm exec tsc --noEmit` -- expected: no type errors (every `validateUrlSafety` call site awaited).
