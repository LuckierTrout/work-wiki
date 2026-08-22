# Design: Trigger/Notification System for Wiki Change Events

Research evaluation for [#148](https://github.com/yologdev/yopedia/issues/148).
No implementation — evaluation and design only.

---

## 1. Market Survey

Three projects in the Karpathy LLM Wiki ecosystem implement change
notifications, each with a different architecture. A fourth signal comes from
the MCP specification itself, which has an active working group on triggers
and events.

### 1.1 onyx-dot-app/agent-wiki — LLM-evaluated NL triggers

The strongest implementation. Triggers are user-created with:

| Field | Purpose |
|-------|---------|
| `scope_path` | File or directory to watch (`auth/passwords.md`, `projects/`) |
| `nl_description` | Plain-English firing condition |
| `message` | Instruction for rendering the notification body |
| `destination` | Where to deliver (currently `event_log` only) |
| `kind` | `"delta"` (change-driven) or `"schedule"` (cron-based) |

**How it works:** Post-commit, a fan-out enqueues every matching trigger for
LLM evaluation. A two-phase LLM pipeline first checks whether the change
matches the NL condition (`{matches: bool, reason: str}`), then — only on
match — renders a concrete notification grounded in the diff. Token budgets
cap evaluation cost (16K per doc, 200K total wiki snapshot, 8K change body).

**Strengths:**
- Natural-language conditions are maximally flexible — no schema to learn
- Two-phase LLM (match → render) ensures relevance before message composition
- Scope hierarchy (file/directory) is intuitive
- Schedule + delta kinds cover reactive and periodic use cases
- ACL enforcement at fire-time prevents content leaks

**Weaknesses:**
- LLM evaluation adds latency and cost per trigger × per commit
- Outbound dispatch (webhooks, external APIs) is stubbed, not shipped
- Conservative matching may miss legitimate triggers
- Push notifications not implemented (polling only via event log)

### 1.2 rohitg00/agentmemory — Fixed event hooks

A persistent memory server for coding agents (★16K+). Not a wiki-trigger
system, but has a relevant event-driven architecture:

- **12 built-in hooks** (session-start, session-end, post-tool-use, etc.)
  capture agent activity automatically
- **Durable pub/sub** with topic-based routing (`agentmemory.observation`,
  `agentmemory.session.started`, etc.)
- **State triggers** react to KV mutations (e.g., observation count changes)
- **Signals** enable structured inter-agent messaging with threading and expiry
- **Filesystem watcher** watches file changes, sends observations via REST

**Strengths:** Rich hook ecosystem, durable pub/sub, state-change triggers.
**Weaknesses:** No user-definable conditions, no NL trigger specification,
tightly coupled to iii-sdk runtime.

### 1.3 gastownhall/beads — Audit trail only

A distributed graph issue tracker for AI agents. No trigger/subscription
mechanism:

- Events are SQL rows (issue lifecycle: comments, status changes, claims)
- `GetAllEventsSince(ctx, since)` enables temporal polling
- `bd prime` is a pull-based context injection pattern (no push)
- Mail delegation via external command (`BEADS_MAIL_DELEGATE`)

**Strengths:** Dolt provides cell-level merge, branching, built-in sync.
**Weaknesses:** Entirely pull-based; no user-definable triggers; no push.

### 1.4 MCP Specification — Evolving toward push

Three relevant areas:

**Subscriptions (`subscriptions/listen` — draft):** Client sends a filter
(`toolsListChanged`, `resourceSubscriptions: string[]`), server pushes
`notifications/resources/updated` etc. over SSE or stdio. Good for
resource-level change notification but no arbitrary conditions.

**Tasks Extension (experimental):** Long-running operations return a
`CreateTaskResult` instead of blocking. Lifecycle: `working` →
`input_required` → `completed`/`failed`/`cancelled`. Client polls or opts
into push notifications via subscriptions.

**Triggers & Events Working Group (active, chartered March 2026):**
Led by Clare Liguori (AWS) and Peter Alexander (Anthropic). Mission: define
how MCP servers proactively notify clients of state changes beyond
polling/SSE. Status: "Ideating" — RFC targeted for end of April. No concrete
schema yet.

**Summary:** MCP is heading toward trigger/notification support at the
protocol level, but it's pre-specification. Designing for compatibility is
wise; blocking on the spec would stall indefinitely.

---

## 2. Approach Evaluation

Three approaches, evaluated against work-wiki's existing architecture.

### 2.1 LLM-evaluated triggers (agent-wiki style)

**How it would work in work-wiki:** User creates a trigger with an NL condition
("notify me when any page about climate science drops below confidence 0.5").
On every page write/delete, the lifecycle pipeline (`runPageLifecycleOp`)
evaluates all matching triggers via LLM.

| Dimension | Assessment |
|-----------|-----------|
| **Flexibility** | Maximum — any expressible condition works |
| **Cost** | High — one LLM call per trigger × per page lifecycle event |
| **Latency** | Adds 1–5s per trigger evaluation to every write path |
| **Reliability** | LLM matching is probabilistic; false negatives are possible |
| **Complexity** | High — requires trigger storage, evaluation queue, fan-out |
| **Fit with work-wiki** | work-wiki already has lint checks that detect the most valuable conditions deterministically; LLM evaluation adds cost without proportional value |

**Verdict:** Interesting for open-ended use cases, but over-engineered for
work-wiki's current stage. The conditions users actually want ("confidence
dropped", "page went stale", "contradiction found") are already detected by
lint checks — deterministically, for free.

### 2.2 Structured rules (lint-based triggers)

**How it would work in work-wiki:** Triggers are structured rules that map to
existing lint check types and frontmatter fields. Instead of evaluating an NL
condition via LLM, the system checks whether a page lifecycle event produces
a lint issue that matches a trigger's rule.

| Dimension | Assessment |
|-----------|-----------|
| **Flexibility** | Limited to expressible conditions (lint types, field thresholds) |
| **Cost** | Zero marginal LLM cost — reuses existing lint infrastructure |
| **Latency** | Negligible — lint checks are fast (except contradiction/missing-concept, which use LLM but are already budgeted) |
| **Reliability** | Deterministic — same input always produces same result |
| **Complexity** | Low — trigger is a filter over lint results + page events |
| **Fit with work-wiki** | Direct — work-wiki has 15 lint check types, frontmatter fields, revision history, and talk pages. These already detect the conditions users care about. |

**Verdict:** The right first step. Covers 80% of use cases at near-zero
marginal cost by leveraging infrastructure that already exists.

### 2.3 Hybrid (structured rules + optional NL override)

**How it would work:** Structured rules handle the common cases (lint-based
conditions, field thresholds, page events). An optional `nl_condition` field
enables LLM evaluation for triggers that can't be expressed structurally.

| Dimension | Assessment |
|-----------|-----------|
| **Flexibility** | Maximum — structured for common cases, NL for edge cases |
| **Cost** | Low baseline (structured); high only for NL triggers |
| **Latency** | Negligible for structured; 1–5s for NL triggers |
| **Reliability** | Deterministic for structured; probabilistic for NL |
| **Complexity** | Medium — two evaluation paths, but NL path is optional |
| **Fit with work-wiki** | Good eventual target, but NL evaluation should be deferred |

**Verdict:** The right long-term architecture. Start with structured rules;
add the NL path when a concrete use case demands it.

---

## 3. Proposed Minimal Trigger Schema

### 3.1 Trigger definition

```typescript
interface WikiTrigger {
  /** Unique trigger ID (UUID or timestamp-based) */
  id: string;

  /** Human-readable name for this trigger */
  name: string;

  /** Who created this trigger (user handle or agent ID) */
  owner: string;

  /** Whether the trigger is active */
  enabled: boolean;

  /** ISO date of creation */
  created: string;

  // ---- Condition ----

  /** What kind of event fires the trigger */
  on: "page-write" | "page-delete" | "lint-found" | "discussion-opened"
    | "discussion-resolved";

  /** Optional: limit to specific page slugs (glob patterns allowed) */
  scope?: string[];

  /** For lint-found triggers: which lint issue types to match */
  lintTypes?: LintIssue["type"][];

  /** For lint-found triggers: minimum severity to match */
  minSeverity?: "error" | "warning" | "info";

  /** Optional: field-threshold condition (e.g., confidence < 0.5) */
  fieldCondition?: {
    field: "confidence" | "expiry";
    op: "lt" | "gt" | "eq" | "expired";
    value?: number | string;
  };

  // ---- Action ----

  /** Where to deliver the notification */
  destination: "log" | "webhook" | "event-store";

  /** For webhook destinations: the URL to POST to */
  webhookUrl?: string;

  /** Optional: message template with {{slug}}, {{type}}, {{message}} placeholders */
  messageTemplate?: string;
}
```

### 3.2 Trigger event (what gets recorded when a trigger fires)

```typescript
interface TriggerEvent {
  /** Unique event ID */
  id: string;

  /** Which trigger fired */
  triggerId: string;

  /** ISO date of firing */
  firedAt: string;

  /** The page slug that caused the trigger to fire */
  slug: string;

  /** What happened */
  eventType: WikiTrigger["on"];

  /** The lint issue or lifecycle event that matched */
  detail: string;

  /** Rendered notification message */
  message: string;

  /** Whether delivery succeeded */
  delivered: boolean;
}
```

### 3.3 Storage

Triggers and events should be stored as JSON files on the filesystem,
consistent with work-wiki's storage model:

| Artifact | Location | Format |
|----------|----------|--------|
| Trigger definitions | `wiki/.triggers/` | One JSON file per trigger: `<id>.json` |
| Trigger events | `wiki/.trigger-events/` | Append-only JSONL files, rotated daily: `<YYYY-MM-DD>.jsonl` |

This keeps triggers alongside the wiki content they watch, makes them
visible to the storage provider abstraction (filesystem or R2), and avoids
introducing a database dependency.

### 3.4 Integration points

**Where triggers evaluate:**

The natural hook point is `runPageLifecycleOp` in `src/lib/lifecycle.ts`.
This function already orchestrates every page write and delete. Adding a
trigger evaluation step after the existing 5-step pipeline (validate → mutate
→ index → cross-ref → log) would be the 6th step:

```
1. Validate slug
2. Write/delete page file
3. Update index.md
4. Cross-reference related pages
5. Append to log.md
6. [NEW] Evaluate matching triggers → fire events
```

For `lint-found` triggers, evaluation happens after `lint()` completes —
the lint result is compared against registered triggers.

**MCP exposure:**

Two new MCP tools:

| Tool | Purpose |
|------|---------|
| `create_trigger` | Register a new trigger subscription |
| `list_triggers` | List active triggers for an owner |

Plus, when MCP's Triggers & Events WG ships a specification, trigger events
could be exposed as MCP notifications via `notifications/resources/updated`
on the existing subscriptions mechanism.

### 3.5 Schema section for SCHEMA.md (proposed)

```markdown
### Triggers (proposed — not yet implemented)

Triggers turn work-wiki from a pull-only knowledge base into an active signal
source. A trigger is a structured rule that fires when wiki content changes
in a way that matches the rule's condition.

**Trigger types:**

| `on` value | Fires when | Example use case |
|------------|-----------|-----------------|
| `page-write` | A page is created or updated | "Notify me when any page I authored is edited" |
| `page-delete` | A page is deleted | "Alert when a page in the security/ scope is removed" |
| `lint-found` | A lint check finds a matching issue | "Notify me when lint finds a contradiction" |
| `discussion-opened` | A new talk thread is created | "Alert when someone opens a discussion on my pages" |
| `discussion-resolved` | A talk thread is resolved | "Notify me when a dispute I'm involved in resolves" |

**Scope:** Triggers can be scoped to specific page slugs or glob patterns
(e.g., `["security-*", "auth-*"]`). Unscoped triggers match all pages.

**Field conditions:** For `page-write` triggers, an optional field condition
checks frontmatter values (e.g., `confidence < 0.5`, `expiry == expired`).

**Destinations:** `log` (append to trigger event log), `webhook` (POST to a
URL), or `event-store` (queryable event storage).

**Storage:** Trigger definitions in `wiki/.triggers/<id>.json`. Trigger
events in `wiki/.trigger-events/<YYYY-MM-DD>.jsonl`.
```

---

## 4. MCP Integration Assessment

### 4.1 Current MCP capabilities

work-wiki's MCP server (`src/mcp.ts`) exposes 40 tools over stdio transport.
The `@modelcontextprotocol/sdk` package supports:

- **Tool registration** (fully used)
- **Resource registration** (not used — wiki pages could be exposed as
  MCP resources, enabling subscriptions)
- **Notifications** (server → client push over the transport)

### 4.2 MCP notifications (current spec)

MCP notifications are fire-and-forget JSON-RPC messages from server to
client. The current spec defines a small set:

- `notifications/resources/updated` — a resource changed
- `notifications/tools/list_changed` — tool list changed
- `notifications/prompts/list_changed` — prompt list changed

If work-wiki exposed wiki pages as MCP resources (`wiki://<slug>`), it could
send `notifications/resources/updated` when a page changes. This is the
**simplest possible MCP integration** and requires no spec extensions.

### 4.3 MCP Tasks Extension

The Tasks Extension handles long-running operations (ingest, lint) by
returning a task handle instead of blocking. This is orthogonal to triggers
— it solves "how do I wait for a slow operation?" not "how do I get notified
when something interesting happens." Not directly relevant.

### 4.4 MCP Triggers & Events Working Group

The WG is chartered but pre-specification (status: "Ideating"). When it
ships, it will likely define:

- A standard trigger registration mechanism
- Event delivery semantics (at-least-once, ordering guarantees)
- Subscription lifecycle management

**Recommendation:** Design work-wiki's trigger system with a clean internal
interface so it can be adapted to the MCP Triggers & Events spec when it
materializes. Don't block on the WG; don't build a proprietary protocol
that conflicts with where MCP is heading.

### 4.5 Recommended MCP integration path

1. **Now:** Expose wiki pages as MCP resources. Send
   `notifications/resources/updated` on page writes — this works with the
   current spec and gives MCP clients basic change awareness.
2. **When triggers ship internally:** Add `create_trigger` and
   `list_triggers` as MCP tools. Agents can subscribe programmatically.
3. **When MCP Triggers & Events WG ships:** Adapt the internal trigger
   system to use the standard protocol. The clean internal interface makes
   this a mechanical translation.

---

## 5. Recommendation

**Watch — with a small preparatory step.**

### Rationale

1. **The building blocks already exist.** work-wiki has 15 lint check types
   that detect the most valuable change conditions (stale, low-confidence,
   disputed, contradictions, broken links, etc.), a revision system that
   tracks who changed what, talk pages for discussions, and a unified
   lifecycle pipeline (`runPageLifecycleOp`) that every write flows through.
   The infrastructure for *detecting* interesting changes is mature.

2. **The missing piece is small.** What's missing is the *subscription* layer
   — letting users/agents say "tell me when X happens" and delivering that
   notification. The proposed schema above is ~200 lines of implementation
   (trigger storage + lifecycle hook + event recording).

3. **No demand signal yet.** No user or agent has asked for push
   notifications. The use cases in the issue are plausible but speculative.
   Building a trigger system before anyone subscribes to anything risks
   over-engineering.

4. **MCP is heading here.** The Triggers & Events WG will likely standardize
   this pattern. Building a proprietary system now means migrating it later.
   Better to wait for the spec and build once.

5. **The preparatory step is free.** Exposing wiki pages as MCP resources
   and sending `notifications/resources/updated` on writes costs ~30 lines
   and gives MCP clients basic change awareness immediately. This is worth
   doing regardless of whether a full trigger system ships.

### Action items

| Priority | Action | Size | When |
|----------|--------|------|------|
| **Do now** | Expose wiki pages as MCP resources; send `notifications/resources/updated` on writes | Small (~30 lines) | Next build cycle |
| **Watch** | Monitor MCP Triggers & Events WG for draft specification | Zero | Ongoing |
| **Watch** | Track whether users/agents request push notifications | Zero | Ongoing |
| **Build later** | Implement structured trigger schema (§3) when either demand or MCP spec materializes | Medium (~200 lines) | When triggered by demand or spec |
| **Defer** | LLM-evaluated NL triggers (agent-wiki style) | Large | Only if structured rules prove insufficient |

---

## 6. Comparative Summary

| Dimension | agent-wiki | agentmemory | beads | work-wiki (proposed) |
|-----------|-----------|-------------|-------|-------------------|
| **Trigger definition** | NL + scope path | Fixed SDK hooks | None | Structured rules + scope |
| **LLM evaluation** | Yes (two-phase) | No | No | No (defer) |
| **Event detection** | Git commit diffing | Agent lifecycle hooks | SQL event rows | Lint checks + lifecycle hooks |
| **Delivery** | Event log (polling) | Pub/sub + streams | Polling only | MCP notifications + event log |
| **Cost per trigger** | 1 LLM call | Zero | Zero | Zero |
| **MCP integration** | None | None | None | Native (resources + notifications) |
| **User-definable** | Yes | No | No | Yes (structured conditions) |

work-wiki's advantage: lint checks already detect 14 condition types
deterministically. A trigger system built on top of lint is cheaper, more
reliable, and more predictable than LLM-evaluated NL triggers — while
covering the conditions that actually matter for a knowledge base (staleness,
confidence decay, contradictions, broken links, disputes).

---

*Research conducted for work-wiki issue #148. Evaluation only — no code changes.*
