---
status: blocked
---

# BMad Build Auto Result

Status: blocked

Bundle: `c2-retire-legacy-settings-route` (DW-61, DW-62)
Baseline revision: 37825f7f388de4072f943ce51565c0c8f6af3dbe
Halt point: step-01 instruction 2 (resolve intent) — no spec was generated, no files changed.

Blocking condition: the recorded decision's premise is false against the codebase.
DW-61's decision retires the legacy `/settings` page "now that the Workbench
Settings surface covers models, embeddings and keys". It does not. The legacy
page's `ProviderForm` is the ONLY editor anywhere for the PRIMARY provider/model
pair (`AppConfig.provider` / `AppConfig.model`), and that pair is what every
non-workload LLM call resolves through. Deleting the route as instructed removes
the only way to configure it, with no replacement.

## Evidence

- `src/lib/config.ts:779-783` — `getResolvedCredentials()` reads `cfg.provider`
  first, env second. `src/lib/llm.ts:241` (`getModel()`) is built from it, and
  `llm.ts:426,447,481,537` route every `callLLM` / `callLLMStream` through
  `getModel()`.
- `src/lib/config.ts:428-464` (`workloadModelSettings`) — chat, ingest and
  structured-knowledge each fall back to `getEffectiveProvider()`, i.e. the same
  primary pair, whenever their own provider is unset (`usesPrimary`).
  `src/lib/llm.ts:359-370` makes the fallback explicit: an unset workload
  provider deliberately falls through to `getModel()`.
- `src/components/workbench/SettingsCanvas.tsx:414-429` — the `llm-models`
  category offers `chatProvider`, `chatModel`, `ingestProvider`, `ingestModel`,
  `customBaseUrl`, `customApiKey` and `llmTimeoutSeconds`. No primary
  provider/model.
- `src/lib/workbench-settings.ts:246-344` — neither `SettingsDraft` nor
  `WorkbenchSettingsPatch` carries a top-level `provider` / `model` key, so the
  surface's ONE save cannot write the pair even in principle.
- `src/app/settings/page.tsx:120-132` → `src/components/ProviderForm.tsx` is the
  sole UI that writes it, via `useSettings` (`src/hooks/useSettings.ts`).

## Secondary gap (same halt, not the cause)

The legacy route is also the only host for five other sections that the
Workbench surface does not cover, and that would become unreachable:
`StructuredKnowledgeSettings`, `EmbeddingSettings` (the legacy rebuild-embeddings
control), `NamesTermsSettings`, `EmailIngestSettings` and `VaultExportButton`
(`src/app/settings/page.tsx:134-218`). Two live links point into them and would
land on a surface that has neither: `src/components/ActionInbox.tsx:343`
(`/settings#names-terms-heading`) and `src/components/KnowledgeStudio.tsx:942`
("Email settings" → `/settings`). `epics.md:170` (UX-DR18) and the settings-nav
`pending` copy show purpose-built replacements are planned for later epics
(Intake, Maintenance, FR-37 ZIP export), so these are supersedable — but they are
not superseded today.

## What is needed to unblock

An explicit decision on the primary pair, one of:

1. **Extend the Workbench surface first** — add primary provider/model to the
   `llm-models` category (new `SettingsDraft` + `WorkbenchSettingsPatch` fields,
   route validation, tests), then retire the legacy page. This changes the
   settings contract `spec-1-9` froze, so it is story-sized and not something an
   unattended run should decide.
2. **Retire the primary pair instead** — make chat/ingest (and structured
   knowledge) the only providers, drop the `usesPrimary` fallback in
   `config.ts` / `llm.ts`, then retire the page. Larger, and it touches every
   `callLLM` caller.
3. **Narrow DW-61** — keep the legacy route as the primary-pair editor and fix
   only the reported defect (give `ProviderForm` the base-URL and key fields for
   `custom`, or drop `custom` from its dropdown). This closes DW-61 as written
   in its `reason` ("either to give that form the two fields or to retire the
   page") without the false premise.

DW-62 (retarget `g s` to the in-shell Settings surface) is independently
implementable and was NOT attempted, because its recorded decision is written as
part of the same move ("Consistent with retiring the legacy page under DW-61")
and a partial landing would leave the bundle half-applied for the re-drive.
