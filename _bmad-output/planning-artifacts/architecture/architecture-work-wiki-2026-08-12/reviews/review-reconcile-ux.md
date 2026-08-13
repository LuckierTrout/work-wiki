---
name: review-reconcile-ux
type: document-review
status: complete
reviewed: ARCHITECTURE-SPINE.md
against:
  - ux-work-wiki-2026-08-12/DESIGN.md (status: final)
  - ux-work-wiki-2026-08-12/EXPERIENCE.md (status: final)
created: 2026-08-12
reviewer: bmm-document-reviewer
verdict: not-ready-to-finalize
completeness: 74
---

# Architecture ↔ UX reconciliation — work-wiki

**Spine reviewed:** `_bmad-output/planning-artifacts/architecture/architecture-work-wiki-2026-08-12/ARCHITECTURE-SPINE.md` (`status: draft`, `updated: 2026-08-12`)

**UX locked:** `_bmad-output/planning-artifacts/ux-designs/ux-work-wiki-2026-08-12/DESIGN.md` and `EXPERIENCE.md` (both `status: final`)

**This review does not edit the spine.** Patches belong in a later architecture pass. UX locks stay closed.

---

## 1. Executive summary

The spine is a solid **runtime** substrate (two hexagons, kernel write path, sidecar Chat/extract, loopback `:19828`, `yopedia` identifiers). It is **not yet a faithful bind** to the final UX.

Three UX locks are at risk of being re-opened or under-specified:

1. **Chat is a rail icon** (EXPERIENCE IA; screenshots win over PRD FR-5 / glossary “center column — not an icon”). The spine still says **“Workbench Chat column”** (AD-5) and maps the shell as **rail + tree + Preview** with Chat only as a sidecar capability.
2. **Intake is store-then-auto-queue** across upload / folder / email / Plaud / API / Capture. Extract is sidecar-only and cannot be reached from the Worker. The spine never sequences **kernel Source bytes + sidecar parse + serial compile**, especially for **email / Plaud OAuth / cloud API** arrivals that do not originate in the same-machine browser.
3. **Preview is view-first**; markdown edit is confirm-gated; not WYSIWYG. The spine is silent (good if it **defers**; bad because it sources `DESIGN.md` only and never cites `EXPERIENCE.md`).

**Readiness:** **Not ready to Finalize.** Runtime ADs can stand. Patch IA language, Intake/extract sequence, EXPERIENCE as a source, and AD-17 vs stacked-desktop Chat **without** re-litigating UX.

**Completeness (UX reconciliation):** **74%.** Runtime, auth, graph, ingest compile, Todos, API bind, and visual-token deferral are aligned. IA topology, Intake extract, Preview citation, and device-vs-viewport are the deficit.

---

## 2. What already aligns (do not reopen)

| Topic | UX lock | Spine | Status |
| --- | --- | --- | --- |
| Workbench is web, not Tauri | EXPERIENCE Foundation | AD-1 | Aligned |
| Local sidecar: Agent, `:19828`, MCP, shell, extractors | EXPERIENCE Foundation, Platform | AD-1, AD-5, AD-6, Structural Seed | Aligned |
| Chat streams from sidecar; fail closed if down | EXPERIENCE composer, Sidecar down | AD-5, AD-6 (`503 sidecar_required`) | Aligned |
| Loopback `127.0.0.1:19828` only; no `0.0.0.0` / LAN | DESIGN Don'ts; EXPERIENCE API + MCP | AD-6 | Aligned |
| Kernel is system of record; no second vault | EXPERIENCE Intake → Sources | AD-2, AD-3 | Aligned |
| Two-step Analysis → Generation; Activity steps | EXPERIENCE activity-row, Flow 1/3 | AD-4, AD-9 | Aligned |
| Auto-queue on arrival; no OS folder-watch | EXPERIENCE Intake assumption | AD-4/AD-5 Intake; capability map | Aligned in intent |
| Serial Ingest LLM per Wiki; Chat may overlap | EXPERIENCE Ingest running | AD-9 | Aligned |
| Graph: sigma + graphology; cohesion 0.15; 12 community colors | DESIGN tokens; EXPERIENCE graph-canvas | AD-14 | Aligned; defers palette to DESIGN.md |
| Embeddings off by default; tagged model | EXPERIENCE Embeddings | AD-12 | Aligned |
| MinerU off; Local API if on | UX left OPEN; spine closed | AD-19 | Architecture fill of UX OPEN — OK |
| Deep Research default Tavily | UX left OPEN; spine closed | AD-18 | Architecture fill of UX OPEN — OK |
| Todos persist until owner delete; no auto-approve | EXPERIENCE todo-card | AD-20 | Aligned |
| Meeting Todos: Plaud-origin or Mark as meeting | EXPERIENCE Mark as meeting | erDiagram `meeting-only` | Aligned |
| Private v1; commons 404 | EXPERIENCE Foundation | AD-8, AD-21 | Aligned |
| English-only chrome/LLM | DESIGN Don'ts | Consistency Conventions | Aligned |
| Display work-wiki / runtime yopedia | DESIGN Brand | AD-7 | Aligned |
| dataVersion refresh; Graph position cache | EXPERIENCE dataVersion | AD-11, AD-14 | Aligned |
| Web clips in kernel (Readability + Turndown) | Capture / URL Intake | AD-16 | Compatible with Capture → kernel |
| Visual tokens, type pairing, density | DESIGN.md | Capability map → UX DESIGN.md | Correctly deferred |

**Closed UX OPENs (do not treat as conflicts):** EXPERIENCE Settings still tags Deep Research default and MinerU default as `[OPEN]`. AD-18 / AD-19 already adopted Tavily and MinerU-off. Implementers should follow the spine for those defaults; optionally sync the UX OPEN tags later. Do not re-open the choices.

---

## 3. Issue list

### CRITICAL

None that make the runtime paradigm infeasible. The items below are **HIGH** because they will fork IA or Intake if left as-is.

### HIGH

#### H1 — Chat-as-rail-icon vs “Chat column” topology

**Where**

- Spine AD-5 (lines 61–65): binds **“Workbench Chat column”**; rule is browser → sidecar SSE.
- Spine Capability map (line 305): **“Workbench shell (rail, tree, Preview)”** — Chat is not a Workbench mode.
- Spine Capability map (line 308): **“Chat Agent | sidecar; browser → loopback”** — runtime only.
- Spine topology mermaid (lines 273–276): correct *runtime* split (HTTPS tree/Preview/search vs loopback Chat), silent on *IA*.
- UX EXPERIENCE Information Architecture (lines 32–36, 42): rail **switches modes**; **not** always-on Tree \| Chat \| Preview; **Chat is a rail icon**; empty Chat has no Preview; first-run lands on **Wiki**.
- UX EXPERIENCE Inspiration (line 208): **Rejected — Chat as a hidden non-icon column (PRD §10). Screenshots win.**
- UX DESIGN Layout (line 237): next column is **tree, conversation list, or Settings nav** (one mode panel, not three stacked job columns).
- PRD FR-5 / glossary still say center Chat column / “not an icon.” **UX already resolved that conflict. Architecture must not re-open it.**

**Why it matters**

AD-5’s runtime rule (browser talks to loopback; Worker cannot) is correct. Calling Chat a **column** and omitting it from the shell map invites epics to restore PRD FR-5’s always-on three-column Workbench and to treat Chat as a permanent center pane rather than a rail mode.

**Fix (spine only; do not change UX)**

- Replace “Workbench Chat column” with **“Workbench Chat mode (rail icon)”**.
- Add one invariant or capability-map row: **IA is rail-switched modes per EXPERIENCE.md. Chat is a rail icon. Preview docks when a tree selection or citation is active. Runtime topology (browser → `:19828`) is independent of IA.**
- List Chat (and Skills) under Workbench shell *and* sidecar, not sidecar-only.
- Do not “fix” UX back to FR-5. Do not add an always-on Chat column in architecture diagrams.

#### H2 — Intake vs sidecar extract: missing sequence, especially non-browser arrivals

**Where**

- UX EXPERIENCE Intake (lines 62, 210–214): arrival paths = upload, recursive folder, inbound email, Plaud/direct connect, API/MCP, Capture. Auto-queue **always on**. **Concurrent parsers** may run ahead of **serial Ingest LLM**. Optional `raw/parsed`.
- UX EXPERIENCE Flow 3 (lines 254–259): drag/import → **store under `raw/sources/`** → auto-queue two-step Ingest.
- UX EXPERIENCE Foundation (line 23): extractors run on the **local sidecar**.
- Spine AD-2: canonical Source bytes in kernel store.
- Spine AD-4 (line 59): sidecar extracts binaries to text and **POSTs into kernel ingest**; compile stays in kernel.
- Spine AD-5 (lines 63–65): **Chat and extract attach at the browser**; binary extract on sidecar; text/markdown/URL **may go kernel-direct**.
- Spine AD-16: crate set in Rust sidecar; web clips in kernel.
- Spine AD-17: binary extract requires sidecar on the **same machine as the browser**.
- Spine capability map (line 306): Intake = Workbench + kernel store + sidecar extract — no sequence.

**Why it matters**

Two stories collide:

1. **UX / FR-41:** Source **arrives** → stored under `raw/sources/` → queued. Email, Plaud OAuth (P1), and cloud `/api/v1` writes can land on the **Worker**, not the desktop browser.
2. **AD-5 / AD-16 / AD-17:** The Worker **must not** parse office/PDF and **cannot** call `127.0.0.1`. Extract attaches at the **browser**.

Unspecified:

- Who uploads **immutable Source bytes** to the kernel vs who runs **pdf-extract / docx-rs / calamine**?
- How **email / Plaud pull / MCP write** of a PDF ever gets extracted if no same-machine browser is in the loop?
- How UX **concurrent parsers** relate to AD-9 **serial compile** (compatible, but unstated).
- Whether “plain text/markdown/URL kernel-direct” skips sidecar entirely (OK) while office always needs a **pending-extract** pull from the sidecar.

If epics follow AD-5 literally, cloud Intake either silently fails extract or someone puts parsers back in the Worker (violates AD-16). If they follow Flow 3 literally, they may assume the Worker extracts after store.

**Fix (spine only)**

Adopt a single sequence; do not change UX arrival paths:

1. **All Intake paths store Source bytes in the kernel first** (`raw/sources/`, AD-2).
2. **Office/PDF parse runs only on the sidecar** (AD-16). Sidecar **pulls or is handed** bytes (browser upload of a copy, or sidecar watches kernel “pending extract” via owner-auth HTTP). Extracted text POSTs into kernel ingest (AD-4).
3. **Parsers may run concurrently** on the sidecar; **Analysis/Generation stay serial per Wiki** (AD-9). That is the UX concurrent-parsers lock.
4. **Cloud-originated binaries** (inbound email, Plaud OAuth, cloud API/MCP): kernel stores + marks **extract-pending**; compile does not start until sidecar extract completes (or fails visibly). Do not have the Worker parse. Do not require the Worker to call localhost.
5. **Same-machine browser upload** may stream the file to sidecar and kernel in one operator action; still one Source in the kernel.
6. **Text / markdown / URL / Capture web clip** may skip sidecar extract (AD-5, AD-16 web clips) and still auto-queue compile.

Name Capture (bookmarklet/share) as an Intake path in the capability map. It is in final UX and PRD glossary; it is absent from the spine.

#### H3 — Preview view-first is a UX lock; spine neither cites nor defers it

**Where**

- UX DESIGN preview component (line 267) and Don'ts (line 290): **view-first GFM; no WYSIWYG toolbar.**
- UX EXPERIENCE preview (line 99): view-first; confirm-gated markdown escape hatch; next Ingest may overwrite; not WYSIWYG; Georgia for Page body only.
- UX EXPERIENCE Banned (line 167): WYSIWYG as default Preview.
- Spine frontmatter `sources` (lines 14–21): lists `DESIGN.md`, **not** `EXPERIENCE.md`.
- Spine Capability map (line 305): Workbench shell governed by **AD-1, UX DESIGN.md** — behavioral contract is in EXPERIENCE.
- Spine body: no Preview view-first / escape-hatch / anti-WYSIWYG statement.
- Architecture `.memlog.md` already constrains “Preview view-first + markdown escape hatch” — **not promoted into the spine.**

**Why it matters**

Silence plus “Chat column” language plus DESIGN-only sourcing lets a later epic treat Preview as an editor surface (Milkdown, default-edit, WYSIWYG) “because architecture didn’t say.” That **re-opens a closed UX lock**. Architecture should not specify chrome; it **must** point at the lock.

**Fix (spine only)**

- Add `EXPERIENCE.md` to `sources` and to the Workbench shell “Governed by” cell.
- One deferral line, e.g. **“Preview is view-first per UX EXPERIENCE.md; markdown edit is confirm-gated; architecture does not choose an editor or WYSIWYG.”**
- Do not add editor libraries, default-edit routes, or a second Preview renderer in the stack table.

#### H4 — AD-17 “phone is browse-only” vs UX stacked Chat + Todos

**Where**

- Spine AD-17 (lines 133–137): any Clerk browser may use tree, Preview, search; Chat/extract/shell/Skills need sidecar on **same machine**; **“Phone is browse-only in v1.”**
- UX DESIGN (line 241): **Mobile: Chat + Todos usable;** Graph is not the job surface; stack rail into a sheet below ~900px.
- UX EXPERIENCE Responsive (lines 187–192): `< ~900px` **Chat + Todos usable**; rail becomes a sheet; Preview stacks under Chat. Assumption: **no dedicated phone IA**; tablet is a stacked Workbench; **desktop browser is the contract.**

**Why it matters**

Two axes got collapsed into “phone”:

| Axis | Owner | Lock |
| --- | --- | --- |
| Viewport &lt; ~900px | UX | Stacked Workbench; **Chat + Todos remain usable** |
| Browser **without** a same-machine sidecar | Architecture | Chat/extract/Skills fail closed; tree/Preview/search still work |

“Phone is browse-only” will be read as “do not implement DESIGN’s mobile Chat+Todos layout.” That re-opens the UX responsive lock. A resized desktop window with sidecar must still Chat. A phone hitting only Cloudflare correctly cannot Chat (AD-5/AD-6) — that is fail-closed, not a different IA.

**Fix (spine only)**

- Split AD-17: **sidecar-absent clients** (including a phone browser) are browse-only for Chat/extract/Skills. **Viewport stacking** is UX EXPERIENCE Responsive — architecture does not override it.
- Do not add a “mobile Chat” product or a dedicated phone IA (UX already refused that).

#### H5 — EXPERIENCE.md is not a spine source

**Where:** Spine YAML `binds` includes `ux-work-wiki-2026-08-12` but `sources` lists only `DESIGN.md` (line 17).

**Why it matters:** Chat-as-icon, Intake replacing watch, view-first behavior, rail order (incl. Skills + Todos), Capture, Create Wiki, concurrent parsers, and banned WYSIWYG live in EXPERIENCE, not DESIGN tokens.

**Fix:** Add EXPERIENCE.md to `sources`. Point IA/Preview/Intake deferrals at it. Do not copy UX prose into ADs beyond one-line binds.

---

### MEDIUM

#### M1 — Create Wiki / Scenario Templates missing from capability map

UX Flow 7 and DESIGN mock `create-wiki.html`: five templates; writes `purpose.md` + Schema via kernel; first-run lands on Wiki. Spine has no Create Wiki / template row. Risk: a second writer that skips `lifecycle.ts` (AD-3).

**Fix:** Capability row: Create Wiki / template apply → kernel `lifecycle.ts` (AD-3). Confirm-gated template switch overwrites purpose/Schema only (UX). No new store.

#### M2 — Deep Research vs serial Ingest queue

UX research-panel (line 109) and PRD: Deep Research is **independent of the serial Ingest queue** (up to 3 concurrent DR tasks). AD-9 only says Chat may overlap ingest.

**Fix:** One clause: Deep Research synthesis/fetch does not take the Ingest compile slot; auto-Ingest of a finished research Page **does** enter the serial queue (UX success path).

#### M3 — Skills is a Workbench rail mode, not only a sidecar folder

UX rail order includes **Skills**; scan/enable is a surface. Spine maps Skills only to sidecar (line 317). Browser Skills UI must call loopback (same as Chat), fail closed if sidecar down.

**Fix:** Capability map: Skills UI in `src/app`; scan/workspace on sidecar; AD-5/AD-17.

#### M4 — UX Settings still OPEN on defaults the spine closed

EXPERIENCE lines 220–222: Deep Research default OPEN; MinerU default OPEN. AD-18/AD-19 adopted. Drift for anyone reading UX Settings first.

**Fix:** Out of band (UX or a one-line spine note “closes EXPERIENCE OPENs”). Do not revert AD-18/AD-19.

#### M5 — EPUB/MOBI vs AD-16 crate set

PRD FR-71 and UX Intake file-type grid imply more than PDF/DOCX/XLSX/PPTX. AD-16 names pdf-extract, docx-rs, calamine, PPTX ZIP+XML only. Unsupported types must **fail visibly** (UX Ingest failed).

**Fix:** Either add EPUB/MOBI to the sidecar extract set or explicitly **defer** them as visible-fail until a later crate. Do not parse them in the Worker.

#### M6 — Activity dock and rail order are UX, not architecture — keep them that way

UX: Activity under the left column; rail order Wiki · Chat · Sources · … Spine is silent. Correct, as long as no architecture diagram draws a fourth full-height queue column or drops Chat from the rail.

---

### LOW

#### L1 — “Chat column” / “Preview column” in DESIGN typography

DESIGN line 229 says “Preview column” as a layout slot. That is the **docked Preview pane**, not PRD’s always-on three-column. Spine should use **docked Preview**, not “third column always.”

#### L2 — shadcn rejection

EXPERIENCE Foundation: not shadcn; custom Tailwind 4 chrome. Spine stack lists `tailwindcss ^4` and does not mention shadcn. Fine. Optional: “no shadcn defaults” under Consistency Conventions.

#### L3 — Clip-server port 19827

UX rejects Clip-server. Spine never mentions 19827. Fine. Do not add it.

#### L4 — Graph color tokens

AD-14 correctly defers to DESIGN.md. Do not duplicate hex in architecture.

#### L5 — Typos / style

Spine is terse and consistent. No blocking copy issues.

---

## 4. Completeness score

**74%** — UX-reconciliation completeness (not general architecture quality).

| Required bind | Weight | Score | Notes |
| --- | --- | --- | --- |
| Cite final UX (DESIGN + EXPERIENCE) | 8 | 4 | DESIGN only |
| Chat IA = rail icon; Preview docks | 12 | 3 | “Chat column”; shell omits Chat |
| Runtime Chat = browser → sidecar | 10 | 10 | AD-5/AD-6 solid |
| Intake store + auto-queue | 8 | 6 | Intent yes; sequence no |
| Extract sidecar vs cloud Intake | 12 | 4 | Browser-attach only; email/Plaud hole |
| Concurrent parsers vs serial compile | 6 | 2 | UX lock unstated |
| Preview view-first deferral | 10 | 3 | Memlog only |
| AD-17 vs &lt;900px Chat+Todos | 8 | 4 | “Phone browse-only” over-claims |
| Graph / tokens / cohesion | 6 | 6 | |
| Auth, loopback, no 0.0.0.0 | 6 | 6 | |
| Two-step ingest, dataVersion, Todos | 8 | 8 | |
| Capture / Create Wiki | 6 | 2 | Missing |
| Visual identity not re-specified | 4 | 4 | Correctly deferred |
| **Total** | **100** | **74** | |

Runtime architecture alone would score higher (~88%). The deficit is **UX bind**, not hexagonal design.

---

## 5. Risk assessment

| Risk | If unpatched | Severity |
| --- | --- | --- |
| Epic restores always-on Tree \| Chat \| Preview (PRD FR-5) | Conflicts with final UX; Chat empty state and first-run Wiki land break | High |
| Worker office parsers “to make email Intake work” | Violates AD-16; isolate CPU/memory; two extract stacks | High |
| Email/Plaud PDFs stored but never extracted | UJ-1/UJ-3 fail for P1 paths; silent or stuck queue | High |
| Preview ships as default markdown editor / WYSIWYG | Re-opens DESIGN/EXPERIENCE lock; density/type pairing break | High |
| “Phone browse-only” skips stacked Chat+Todos | Re-opens DESIGN responsive lock on desktop-narrow | Medium |
| Create Wiki writes purpose/Schema outside lifecycle | Index/log drift (`.yoyo/learnings.md`) | Medium |
| Deep Research serialized behind Ingest | UX/PRD “does not block Ingest” missed | Medium |

**Implementation concern:** Do not let architecture “clarify” by changing UX. Chat stays a rail icon. Intake stays auto-queue on arrival. Preview stays view-first. Architecture only states **where bytes and processes live** so those locks can be built.

---

## 6. Recommended spine patch list (no UX edits)

1. **Sources:** add `EXPERIENCE.md`.
2. **AD-5 bind language:** “Workbench Chat **mode** (rail icon),” not “Chat column.”
3. **New one-liner (IA):** Rail-switched modes per EXPERIENCE; Chat is a rail icon; Preview docks; do not implement PRD FR-5 as always-on three columns.
4. **New one-liner (Preview):** View-first + confirm-gated markdown per EXPERIENCE; no editor/WYSIWYG decision in architecture.
5. **Intake sequence AD** (or extend AD-5/AD-16): kernel-store first; sidecar extract; pending-extract for cloud arrivals; concurrent parse / serial compile; Capture named.
6. **AD-17:** sidecar-absent = Chat/extract/Skills fail closed; viewport stacking stays UX.
7. **Capability map:** Chat + Skills as Workbench modes; Create Wiki → lifecycle; Intake includes email/Plaud/Capture + extract-pending.
8. **AD-9:** Deep Research does not consume the Ingest compile slot.

Do not Finalize until H1–H5 are addressed in the spine. UX documents stay `status: final`.
