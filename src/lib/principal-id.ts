/**
 * Principal id shapes — one definition of "this id is synthesized, not a Clerk id".
 *
 * A `Principal.id` is normally the caller's stable Clerk user id (`user_2ab…`).
 * Several surfaces mint principals with NO Clerk session behind them, and each
 * one synthesizes an id in the same `<kind>:<value>` shape:
 *
 *   - `service:<handle>`      — the bearer service credential (`src/lib/auth.ts`)
 *   - `service:mcp`           — the MCP tool layer's system caller (`src/mcp.ts`)
 *   - `agent:<agentId>`       — a per-agent MCP token (`src/app/api/mcp/route.ts`)
 *   - `agent-owner:<handle>`  — an agent run acting for its human
 *                               (`src/lib/agent-runtime.ts`)
 *   - `knowledge-compiler:<tenant>`, `eval:<owner>` — internal pipeline callers
 *
 * WHY THE `:` RULE IS THE RIGHT TEST, AND WHY IT IS SAFE. A Clerk user id is
 * `user_` followed by a base58-ish instance id — it never contains a colon, and
 * Clerk does not let a user choose it. So "contains a `:`" cannot produce a
 * false positive on a real Clerk id, which is the only direction that could
 * hurt: a false positive would push the REAL owner off the stable-id path and
 * back onto the drifting handle, reintroducing DW-486. A false NEGATIVE (some
 * future synthesized id with no colon) would merely deny that principal the
 * owner grant — the fail-closed direction. Testing the shape rather than
 * enumerating prefixes also means a new `<kind>:` minted anywhere in the repo is
 * covered the day it is written, instead of the day someone remembers to add it
 * to a list.
 *
 * Two modules have to agree about this — `auth.ts` mints (server only) and
 * `owner.ts` reads (bundled into client components) — so it lives here, in a
 * module with NO imports. That keeps `owner.ts` client-safe: asking "is this a
 * real Clerk id?" must not drag Clerk, or anything server-only, into the
 * browser bundle.
 */

/** Prefix marking a synthesized bearer service principal id. */
export const SERVICE_PRINCIPAL_ID_PREFIX = "service:";

/**
 * Mint a synthesized SERVICE principal id for `handle`.
 *
 * The one construction site, paired with {@link isServicePrincipalId}: the
 * module that WRITES the shape and the module that READS it now share a single
 * definition of the prefix, so neither can drift from the other by an edit that
 * only touched one of them. Callers are `getServicePrincipal` (the bearer
 * service credential, `src/lib/auth.ts`) and the stdio MCP door's system caller
 * (`src/mcp.ts`).
 */
export function servicePrincipalId(handle: string): string {
  return `${SERVICE_PRINCIPAL_ID_PREFIX}${handle}`;
}

/**
 * Whether `id` belongs to a bearer SERVICE principal specifically.
 *
 * Narrower than {@link isSynthesizedPrincipalId} on purpose: this is the
 * "deployment-trusted automated caller" test that `canWritePage` spends to let
 * agents and cron write anything. An `agent:` principal is deliberately NOT
 * one — it sits on the ordinary human side of the realm gate.
 */
export function isServicePrincipalId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(SERVICE_PRINCIPAL_ID_PREFIX);
}

/**
 * Whether `id` was synthesized by this app rather than issued by Clerk.
 *
 * Such an id can never equal a configured `YOPEDIA_OWNER_USER_ID`, so any gate
 * that decides owner-ness by the stable id must exclude it and fall back to the
 * handle — otherwise the sidecar token, the MCP agent tokens and every agent run
 * silently lose the owner grant they act with.
 */
export function isSynthesizedPrincipalId(id: string | null | undefined): boolean {
  return !!id && id.includes(":");
}
