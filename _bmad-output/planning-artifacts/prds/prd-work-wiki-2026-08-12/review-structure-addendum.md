# Structure review — addendum.md

This document exists to help architecture readers use rejected alternatives, mechanism, and desktop→web mapping without treating them as PRD requirements.

| Field | Value |
|-------|--------|
| Audience | humans (architecture) |
| Reader type | humans |
| Structure model | Explanation (Conceptual), closest; intro claims three Strategic buckets |
| Current length | 1,227 words (word_metrics.py) |

Cap: 5. Content sacrosanct. No requirement moves into or out of the PRD except true duplicates noted below.

## Recommendations

1. **[MOVE]** §Chat Agent runtime (208 words) — full section — **before** §Desktop → web parity mapping (275 words). Hosting lock (Rust sidecar vs Workers isolate) is the architecture lead; it currently sits after ~419 words of Rejected + parity FR index. Word impact: 0.

2. **[MERGE]** Six peer H2s labeled mechanism (stack 61 + Chat Agent 208 + Retrieval 73 + Document extraction 120 + Deep Research 44 + Graph 61 = 567 words) into one `## Mechanism` with `###` children. Intro promises three buckets; twelve same-level H2s fight that shape and force linear scan. Word impact: 0.

3. **[CONDENSE]** §Chat Agent runtime — External Agent Skill paragraph (~110 words) to a pointer at PRD FR-79. True duplicate: install command, token headers, `{id}` resolution, 501 vs FR-77, trigger phrases. Keep only the architecture increment (sidecar owns `:19828` / MCP / shell / Skills scan; cloud is façade). Do not copy into the PRD. Saves ~110 words.

4. **[CONDENSE]** §Document extraction (120 words) to crate names + “sidecar, not isolate.” True duplicate of PRD FR-71/FR-72 behavior table. Keep pdf-extract / docx-rs / calamine / Readability+Turndown and the Workers-isolate exclusion. Do not copy crates into the PRD. Saves ~70 words.

5. **[CUT]** §Plaud (48 words) and §Aesthetic note (50 words). True duplicates of PRD FR-30/31 + §14 P0/P1 Plaud, and §1 Voice. Do not copy into the PRD. **[PRESERVE]** §Existing app vs this PRD (53 words) — unique fork delta. Saves ~98 words.

## Summary

5 recommendations. Estimated reduction if all accepted: ~278 words (~23% of 1,227). No length target was set. MOVE/MERGE only reorder; CUT/CONDENSE drop PRD restatement, not architecture-only increment. Comprehension trade-off: architecture readers lose in-addendum Plaud/voice recap and must open the PRD for those contracts.
