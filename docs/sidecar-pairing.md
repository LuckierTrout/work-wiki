# App and sidecar pairing

The browser still uses the single sidecar on `127.0.0.1:19828`. It now verifies
that this process belongs to the app it is viewing before sending a token,
Chat turn, shell approval, Skills scan, or workspace read.

## Run a local pair

1. In the intended checkout, set `WORKWIKI_URL` to the app URL, for example
   `http://localhost:3001`. Configure the existing owner service credentials and
   use the same `DATA_DIR` for the app and sidecar.
2. Start the app there: `pnpm dev -- --port 3001` (or
   `pnpm exec next dev --turbopack --port 3001`).
3. Stop the previous sidecar, then run `pnpm sidecar` in that checkout. Its log
   identifies the kernel origin and whether pairing was verified. Never kill a
   process merely because it owns the port; identify it first.
4. Reload the app. Restart both processes after changing checkout, revision or
   data-directory configuration. Reload tabs after restarting the dev app.

Shell environment variables take precedence, then `.env.local`, then `.env`.
An existing sidecar is never stopped or replaced automatically. A second one
still exits with `port_conflict`.

## What the checks mean

- A fresh dev session or production build receives an opaque instance ID. The
  browser bundle and authenticated kernel settings response carry the same ID.
  It is a public identifier, not an authentication secret.
- Protocol version 1 is required. Older sidecars and missing or malformed
  handshake responses fail closed; upgrade the app and sidecar together.
- Local kernels must also match a startup fingerprint of the canonical checkout,
  Git revision, and data directory. Paths and credentials are never returned in
  health responses. Uncommitted source changes are not a revision fingerprint;
  restart both processes after changing their shared contracts.
- Every browser data request carries the instance ID. The sidecar freshly checks
  the configured kernel and compares the browser origin before dispatching it.
  Loopback hostname aliases are equivalent; different ports are not.
- Health preflight carries no credentials. The browser reads the current door
  token only after pairing succeeds. Authentication remains required unless
  explicitly disabled in Settings; pairing never substitutes for authentication.
- A failed attestation cannot reuse a last-good pairing or a disk fallback.
  Background extraction verifies the pair before each batch too. Requests or
  extraction already underway are not cancelled when another process restarts.
- A remote kernel uses the instance, protocol and origin checks without comparing
  its deployment filesystem to the laptop. Use its exact configured origin in
  `WORKWIKI_URL` and the existing allowed-origins setting. Local production builds
  must be built with the intended checkout and data-directory configuration.

Mismatch messages appear in Chat, Skills, workspace Preview, the status dot and
Settings → API + MCP. They direct the owner to restore the pair and reload. The
public sidecar health response includes `kernelOrigin`, `pairingReady`, and the
opaque pairing metadata, but never a token.

## Validation boundary

Automated HTTP tests drive the real browser request helper through a listening
sidecar into a kernel fixture. They cover successful proxy writes, token
rotation, mismatched/missing IDs, another checkout or origin, obsolete protocols,
and unavailable attestation. Mounted tests cover the user-visible refusal.
These are local checks, not evidence that a running installation has upgraded.

## Local verification — 2026-09-12

- Full Vitest run: 419 suites passed; 10,286 tests passed and 1 skipped.
- TypeScript (`tsc --noEmit --incremental false`) and ESLint on changed modules passed.
- Actual Next.js dev server on temporary port 4187: authenticated settings returned
  matching startup identity; matched sidecar Skills returned 200; another browser
  origin returned 409. The existing app on 3001 and sidecar on 19828 were untouched.
- Chromium against that app: the existing unpaired sidecar displayed the recovery
  message and no Chat Send button. Routing the browser's sidecar requests to a
  temporary, correctly paired sidecar showed the running status and loaded Skills
  with 200 and a valid list. These used the repository's local E2E owner identity.
- Includes the prerequisite middleware and cold-settings fixes previously present
  only as uncommitted work in the running `dw-422` checkout, with their 42 tests.

This branch has not been merged or deployed. Activate it by integrating the
change, restarting the intended app and sidecar together, and reloading open tabs.
