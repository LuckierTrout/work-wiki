---
name: review-versions
type: document-review
status: complete
reviewed: ARCHITECTURE-SPINE.md
lens: version-and-registry-verification
against:
  - npm registry (2026-08-12)
  - crates.io (2026-08-12)
  - Context7 /opennextjs/opennextjs-cloudflare and /vercel/next.js
  - package.json + pnpm-lock.yaml
  - wrangler.jsonc
created: 2026-08-12
reviewer: bmm-document-reviewer
verdict: not-ready-to-finalize
completeness: 78
---

# Architecture versions review — work-wiki

**Spine reviewed:** `_bmad-output/planning-artifacts/architecture/architecture-work-wiki-2026-08-12/ARCHITECTURE-SPINE.md` (`status: draft`, Stack + AD-14 / AD-15 / AD-16)

**This review does not edit the spine.** Patches belong in a later architecture pass.

**Check date:** 2026-08-12. Sources: npm registry, crates.io, Context7 (`/opennextjs/opennextjs-cloudflare`, `/vercel/next.js`), GitHub `opennextjs-cloudflare` `packages/cloudflare/package.json` (main = 1.20.2), `package.json`, `pnpm-lock.yaml`, `wrangler.jsonc`, Node.js Release schedule.

---

## 1. Executive summary

The **named version pins are real**. None of the AD-14 / AD-15 / AD-16 numbers look invented. Graph npm latest, sidecar crate latest, OpenNext 1.20.2, and the Next `>=15.5.21 <16` peer floor all match live registries today. Repo-today rows (`next` 15.5.18, `@opennextjs/cloudflare` ^1.19.10 / lock 1.19.10) match `package.json` and the lockfile.

The Stack header’s claim that the seed was “verified 2026-08-12 from `package.json`, npm registry, crates.io, and Context7” is **true for those pins** and **false for two attributed facts** that Context7 / training-adjacent docs contaminated:

1. **Node.js `(Next 15 engines) >=20.9.0` is not what Next 15.5.x publishes.** `next@15.5.18` and `next@15.5.21` both declare `"node": "^18.18.0 || ^19.8.0 || >= 20.0.0"`. `>=20.9.0` is the Next 16 / canary engines field Context7 returned.
2. **AD-16 says Turndown is already in the app.** It is not. Kernel HTML path is `@mozilla/readability` + `linkedom` + a local `htmlToMarkdown` in `src/lib/html-parse.ts`. No `turndown` dependency.

A third live-registry gap was not flagged when copying `package.json`: **Clerk 7.4.2 peers `react`/`react-dom` `~19.1.4`**, but the stack (and repo) pin **19.1.0**.

**Readiness:** **Not ready to Finalize** on this lens until the Node engines row, the Turndown claim, and the Clerk/React peer are corrected. Do **not** reopen AD-14 package choice or the AD-15 OpenNext 1.20.2 / Next 15.5.x floor — those are registry-correct.

**Completeness (version verification):** **78%.** Numeric pins exist and match. Runtime-floor attribution, “already in the app,” Clerk peer, Node 20 EOL, and companion bump packages are the deficit.

---

## 2. Spot-check results (do not reopen if green)

Checked 2026-08-12. “Latest” means npm `dist-tags.latest` or crates.io `max_stable_version`.

| Spine claim | Live check | Verdict |
| --- | --- | --- |
| next (repo today) 15.5.18 | `package.json` exact; lock `next@15.5.18`; npm publishes 15.5.18 | **Pass** |
| next required `>=15.5.21 <16` | 15.5.21 exists (published 2026-07-21). OpenNext 1.20.2 npm peer: `>=15.5.21 <16 \|\| >=16.2.11`. Context7 autodocs same. | **Pass** (floor). Current 15.x **backport** is **15.5.23** (2026-08-06); `latest` Next is **16.3.0**. |
| @opennextjs/cloudflare repo ^1.19.10 | `package.json` + lock **1.19.10** (caret did not float to 1.19.11, which exists) | **Pass** |
| @opennextjs/cloudflare required **1.20.2** | npm `latest` **1.20.2**; no 1.20.3. GitHub package.json version 1.20.2, same Next peer. | **Pass** |
| Stay off Next 16 in v1 | OpenNext also peers `>=16.2.11`. `npm create cloudflare -- --framework=next` would follow **Next latest (16.3.0)**. Spine correctly does **not** copy the starter. | **Pass** |
| react / react-dom 19.1.0 | Repo exact; npm publishes 19.1.0. Latest React **19.2.8**. Next 15.5.x peers `^19.0.0` — 19.1.0 is legal for Next. | **Pass as repo seed**; **fail vs Clerk** (H3) |
| @clerk/nextjs ^7.4.2 | 7.4.2 exists; lock 7.4.2; latest **7.7.4**. Same Next/React peer shape on 7.4.2 and 7.7.4. | **Pass existence** |
| ai ^6.0.146 + @ai-sdk/* 3.0.x | All four versions exist. `latest` AI SDK is **7.x**; `ai-v6` tag is **6.0.253**. Caret stays on 6.x. | **Pass** (repo seed, not chasing 7) |
| wrangler ^4.92.0 | 4.92.0 exists; lock 4.92.0; latest **4.122.0**. OpenNext 1.20.2 peers `wrangler ^4.86.0` — 4.92.0 satisfies. | **Pass** as repo seed |
| typescript ^5, vitest ^3, tailwindcss ^4, zod ^4.4.2, MCP SDK ^1.29.0, readability ^0.6.0 | All exist. Latest: TS **7.0.2**, vitest **4.1.10**, tailwind **4.3.3**, zod **4.4.3**, MCP SDK **1.30.0**, readability **0.6.0** (current). | **Pass** as caret seeds |
| sigma 3.0.3 | npm latest **3.0.3** (alpha 4.x exists; they correctly took stable) | **Pass** |
| graphology 0.26.0 | npm latest **0.26.0** | **Pass** |
| graphology-layout-forceatlas2 0.10.1 | npm latest **0.10.1** (rc `0.11.0-rc1` exists; they correctly skipped RC) | **Pass** |
| graphology-communities-louvain 2.0.2 | npm latest **2.0.2** | **Pass** |
| pdf-extract 0.12.0 | crates.io newest/max_stable **0.12.0** (2026-06-25). Description: extract content from PDFs. | **Pass** + fits |
| docx-rs 0.4.22 | crates.io newest/max_stable **0.4.22** (2026-07-21). | **Pass existence**; **fitness caveat** (M2) |
| calamine 0.36.1 | crates.io newest/max_stable **0.36.1** (2026-07-27). Spreadsheet reader; keywords xls/xlsx/xlsb/ods. | **Pass** + fits |
| CF resource names / compatibility_date 2025-01-01 | Matches both `wrangler.jsonc` files | **Pass as repo seed** |
| OpenNext 1.20.2 peer sentence under Stack | Matches npm + Context7 | **Pass** |

**Invented versions:** none found.

---

## 3. Issue list

### CRITICAL

None. No fabricated package names or version numbers. AD-14/15/16 technology choices still exist on npm/crates.io.

### HIGH

#### H1 — Node engines row is Next 16, mislabeled as Next 15

**Where:** Stack table, “Node.js (Next 15 engines) \| >=20.9.0” (ARCHITECTURE-SPINE.md ~line 245). Memlog: “Node engines for Next 15: >=20.9.0.”

**Evidence (npm, 2026-08-12):**

```json
// next@15.5.18 and next@15.5.21 engines
{ "node": "^18.18.0 || ^19.8.0 || >= 20.0.0" }
```

Context7 `/vercel/next.js` returned `>=20.9.0` from **canary `packages/next/package.json`** and the **version-16 upgrade guide**. That is not Next 15.5.x.

**Also unverified against the 2026 runtime calendar:** Node 20 (Iron) **EOL 2026-04-30**. On 2026-08-12 the supported lines are Node **24 Active LTS**, **22 Maintenance LTS**, **26 Current**. A floor of 20.9.0 (even if it were correct) would put local `next dev` / sidecar Node on an EOL line. Repo has no `engines` field; `@types/node` is `^20`.

**Fix:** Split the row:

- Next 15.5.x published engines: `^18.18.0 \|\| ^19.8.0 \|\| >=20.0.0` (do not cite 20.9.0 as Next 15).
- work-wiki **policy** (new): local Node **>=22** (prefer **24** Active LTS). Do not document Node 20 as the supported floor in August 2026.

Do not copy Context7 canary engines into a 15.5.x stack again.

#### H2 — AD-16 “Turndown, already in the app” is false

**Where:** AD-16 rule (~line 131); Stack lists `@mozilla/readability ^0.6.0` only.

**Evidence:** `package.json` has `@mozilla/readability` and `linkedom`. Grep finds **zero** `turndown` imports. `src/lib/html-parse.ts` documents a **dependency-free** `htmlToMarkdown`. npm `turndown` latest is 7.2.4 — the package exists; it is simply **not a repo dependency**.

**Fix:** Replace “Readability + Turndown, already in the app” with “`@mozilla/readability` + `linkedom` + existing `htmlToMarkdown` in `src/lib/html-parse.ts`.” If v1 intends to add Turndown, say so as a **new** dependency with a version, not as current state.

#### H3 — Clerk peer vs React 19.1.0 never checked

**Where:** Stack react 19.1.0 + `@clerk/nextjs ^7.4.2` (~lines 223–225). Copied from `package.json` without npm peer check.

**Evidence:** `@clerk/nextjs@7.4.2` and `@clerk/nextjs@7.7.4` both peer:

```text
react:     ^18.0.0 || ~19.0.3 || ~19.1.4 || ~19.2.3 || ~19.3.0-0
react-dom: (same)
next:      ^15.2.8 || ^15.3.8 || ^15.4.10 || ^15.5.9 || ...
```

`react@19.1.0` does **not** satisfy `~19.1.4` (`>=19.1.4 <19.2.0`). Next 15.5.21 **does** satisfy `^15.5.9`. Latest 19.1.x is **19.1.9**; latest 19.2.x is **19.2.8**.

**Fix:** Fold into AD-15 (same change-set as Next/OpenNext): bump `react` / `react-dom` to **>=19.1.4** (recommend **19.1.9** or **19.2.8**). Optionally bump `@clerk/nextjs` to **7.7.4** in that same PR. Do not leave 19.1.0 as an unannotated seed.

#### H4 — AD-15 names the peer floor, not the current 15.5 patch to install

**Where:** AD-15 (~line 125); Stack “next (required) \| >=15.5.21 <16”.

**Evidence:** Floor 15.5.21 is the **correct OpenNext 1.20.2 peer minimum**. npm `backport` tag is **15.5.23**. 15.5.22 also exists. Installing exactly 15.5.21 would skip two published 15.5 security/patch releases.

**Fix:** Keep the range `>=15.5.21 <16`. Add a concrete install target: **`next@15.5.23` and `eslint-config-next@15.5.23`** (repo today pins eslint-config-next **15.5.18**, omitted from the Stack table). Re-check the backport tag at bump time.

### MEDIUM

#### M1 — `compatibility_date` 2025-01-01 is repo-true, not starter-current

**Where:** Stack (~line 246); both wrangler configs.

**Evidence:** Cloudflare docs (2026-08-12) tell new Workers to use **today’s date**. Wrangler **4.122.0** notes that as of **2026-08-04**, `nodejs_compat` is **default-on**; listing the flag with a new date can fail locally. `create-cloudflare` / `wrangler setup` write **today’s** date. Spine copied 2025-01-01 from the fork without saying “do not bump this date in the AD-15 deploy without testing `nodejs_compat`.”

**Fix:** Label the row “repo today (do not treat as current Wrangler default).” If AD-15 also bumps wrangler toward 4.122, add: bump `compatibility_date` only with a Worker smoke test; after 2026-08-04 a newer date may make explicit `nodejs_compat` redundant/conflicting.

#### M2 — docx-rs 0.4.22 exists; crate purpose is writer-first

**Where:** AD-16 (~line 131); Stack (~line 242).

**Evidence:** crates.io description and README: **“A .docx file writer with Rust/WebAssembly.”** Version 0.4.22 is current and unyanked. The crate exposes `read_docx`, so extract is possible, but this was not fitness-checked against extract-oriented crates. PPTX “via ZIP+XML” has no crate pin (acceptable as a method).

**Fix:** One sentence: “docx-rs is writer-primary; v1 uses `read_docx` for extract. Revisit only if read coverage is insufficient.” Do not swap the crate in Finalize without a spike.

#### M3 — calamine 0.36.1 requires rustc 1.88; toolchain unstated

**Where:** AD-16 / Stack calamine 0.36.1.

**Evidence:** crates.io `calamine@0.36.1` `rust_version`: **1.88**. pdf-extract 0.12.0 and docx-rs 0.4.22 publish no rust-version. Sidecar has no `Cargo.toml` in-repo yet.

**Fix:** Add a Stack row: sidecar **rustc >= 1.88** (driven by calamine 0.36.1). Confirm at first `sidecar/` scaffold.

#### M4 — OpenNext 1.20.2 optional peer `rclone.js` omitted

**Where:** AD-15; Stack OpenNext 1.20.2.

**Evidence:** npm `@opennextjs/cloudflare@1.20.2` peers `rclone.js ^0.6.6` (optional) in addition to next + wrangler. 1.19.10 did not list rclone.js.

**Fix:** Note optional peer; do not add rclone.js unless the OpenNext build path needs it. Prevents a surprise `peer missing` on the AD-15 bump.

#### M5 — Stack mixes “repo today” carets with “install these exact latests” without a legend

**Where:** Stack table (~lines 219–250).

Repo-today carets (`wrangler ^4.92.0`, `ai ^6.0.146`, `vitest ^3`, `typescript ^5`) sit next to **exact** graph/crate pins that **are** current latest. Latest wrangler is 4.122.0, AI SDK 7.0.64, vitest 4.1.10, TypeScript 7.0.2. That is fine **if** labeled snapshot-vs-target. Unlabeled, an implementer may “update the stack” to Next 16 / AI 7 / vitest 4 / TS 7 and break AD-15.

**Fix:** Two columns or a tag: `seed (package.json)` vs `v1 target`. AD-15 remains the only required bump before next prod deploy.

#### M6 — sigma 3.0.3 depends on `graphology-utils`; not listed

**Where:** AD-14 / Stack graph rows.

**Evidence:** `sigma@3.0.3` dependencies: `events ^3.3.0`, `graphology-utils ^2.5.2` (utils latest **2.5.2**). graphology-layout-forceatlas2 / louvain peer `graphology-types >=0.19.0` (types latest **0.24.8**). pnpm will pull these; pinning only the four named packages is enough if the spine says “plus their published deps.”

**Fix:** Either add `graphology-utils 2.5.2` or one line “install sigma/graphology family; let the lockfile take `graphology-utils` / `graphology-types`.”

### LOW

#### L1 — eslint-config-next 15.5.18 missing from Stack / AD-15

Must move in lockstep with `next`. 15.5.21 and 15.5.23 both exist on npm.

#### L2 — wrangler latest 4.122.0 vs seed 4.92.0

Not a contradiction (OpenNext peer `^4.86.0`). Optional: allow wrangler to float inside `^4.86.0` when doing AD-15; do not treat 4.92.0 as a ceiling.

#### L3 — AI SDK 6 vs 7, TypeScript 5 vs 7, vitest 3 vs 4

Correct to keep repo major. Add “do not take `latest`” so Finalize does not “modernize” them.

#### L4 — unpdf ^1.6.2 still in package.json (latest 1.8.0)

AD-16 correctly forbids unpdf as the **v1 extract path**. Leave the dep until sidecar extract ships; no version pin needed in the spine.

#### L5 — OpenNext marketing docs vs npm peer

opennext.js.org/cloudflare still says “latest minors of Next 14 and 15” and “all Next 16.” npm/Context7 peer is the precise contract. Spine used the precise one. Keep it; do not widen to Next 14.

#### L6 — Graph / crate pins will rot

They are latest **today**. Header already says “Code owns versions once they move.” Sufficient.

---

## 4. Completeness score

**78%** — version-verification completeness (not general architecture quality).

| Required check | Weight | Score | Notes |
| --- | --- | --- | --- |
| Named packages exist on npm/crates.io | 12 | 12 | All found |
| Pinned versions exist (not invented) | 15 | 15 | All found, none yanked |
| Repo-today rows match package.json / lock | 10 | 10 | next 15.5.18, ON 1.19.10, react 19.1.0, wrangler 4.92.0 |
| OpenNext 1.20.2 + Next peer from live docs/npm | 12 | 12 | Context7 + npm + GitHub package.json agree |
| Graph npm pins = current latest | 8 | 8 | 3.0.3 / 0.26.0 / 0.10.1 / 2.0.2 |
| Crate pins = current max_stable | 8 | 8 | 0.12.0 / 0.4.22 / 0.36.1 |
| “Already in the app” matches package.json | 10 | 2 | Readability yes; Turndown no |
| Engines / Node floor from **that** package version | 10 | 2 | 20.9.0 is Next 16; Node 20 EOL unstated |
| Peer compatibility of the listed combo | 8 | 3 | Next/OpenNext yes; Clerk/React no |
| Starter / Wrangler live defaults | 4 | 2 | Did not copy Next 16 (good); compat date unlabeled |
| Companion packages for the required bump | 3 | 1 | eslint-config-next, rclone.js, rustc 1.88 missing |
| **Total** | **100** | **78** | |

---

## 5. Risk assessment

| Risk | If unpatched | Severity |
| --- | --- | --- |
| Implementer installs Node 20.9 because the spine said “Next 15 engines” | Local toolchain on **EOL** Node 20; or false confidence that 20.9 is required | High |
| Epic adds `turndown` “because architecture said it’s already there” **or** assumes Turndown APIs | Extra dep or broken web-clip path; ignores existing `htmlToMarkdown` | High |
| AD-15 bumps Next/OpenNext but leaves React 19.1.0 | Clerk peer warnings / install failures; flaky CI | High |
| AD-15 installs exactly 15.5.21 | Misses 15.5.22/15.5.23 backports | Medium |
| calamine 0.36.1 on rustc &lt; 1.88 | Sidecar extract crate set fails to compile | Medium |
| Wrangler 4.122 + new compat date + leftover `nodejs_compat` | Local Worker fail: flag is default as of 2026-08-04 | Medium |
| “Refresh the stack to latest” (Next 16, AI 7, vitest 4, TS 7) | Violates AD-15; unplanned major upgrades | Medium |
| docx-rs read coverage too thin for real DOCX | Extract quality hole; late crate swap | Low–Med |

**Implementation concern:** Treat AD-14/15/16 **version numbers** as verified. Treat Stack **prose attributions** (engines, “already in the app”) as unverified. The failure mode here is Context7/canary bleed and incomplete `package.json` cross-check, not hallucinated semver.

---

## 6. Recommended spine patch list (versions only)

1. **Stack Node row:** replace `>=20.9.0` / “Next 15 engines” with published 15.5.x engines **and** a work-wiki policy of Node **>=22** (prefer 24 LTS).
2. **AD-16:** drop Turndown; cite `@mozilla/readability` + `linkedom` + `htmlToMarkdown`.
3. **AD-15:** add `react`/`react-dom` **>=19.1.4**, `eslint-config-next` same patch as `next`, concrete `next@15.5.23` (or current `backport` at bump time). Mention optional `rclone.js` peer.
4. **Stack legend:** `seed (package.json)` vs `v1 target`. Do not imply wrangler/ai/vitest/typescript carets are “install latest.”
5. **calamine:** rustc **>=1.88**. **docx-rs:** one-line writer-primary caveat.
6. **compatibility_date:** label as repo-today; do not silently advance with wrangler 4.122.

Do not Finalize until **H1–H3** are patched. H4 should land in the same AD-15 sentence. Graph and crate **numbers** can stay.
