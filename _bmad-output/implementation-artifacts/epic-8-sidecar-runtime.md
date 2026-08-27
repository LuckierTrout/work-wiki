---
title: Epic 8 sidecar runtime
status: decided
date: 2026-08-26
---

# Epic 8 sidecar runtime

**Decision.** The v1 loopback Agent (Chat, extract, MCP wrap, Skills, shell,
`agent-workspace/`) stays the existing Node ESM process at
`sidecar/server.mjs`, bound to `127.0.0.1:19828`. It is not a Rust rewrite
and it is not Cloudflare Sandbox.

**Why.** Epic 8's implementable spec assumed this process (AD-6: the sidecar
never imports `src/lib`). A Rust sidecar would be a new product boundary, not
a remediation of the 2026-08-25 retrospective.

**Decomposition applied with the remediations.**

- Pause tickets live in `sidecar/capabilities.mjs`.
- Browser callers share `src/lib/loopback-client.ts`.
- Live `/health` classification lives in `src/lib/workbench-loopback-health.ts`.
- Provider/Chat transport lives in `sidecar/chat-provider.mjs` and
  `sidecar/chat-transport.mjs`; `server.mjs` remains the HTTP shell.
  Pending-turn/session transport in `ChatCanvas.tsx` and the API/MCP
  category on the Settings pair remain follow-on, not acceptance blockers.

The architecture spine's Rust seed is historical. v1 Agents at the door are
Node ESM.
