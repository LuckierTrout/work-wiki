### DW-1: The CLI still exposes a publish-to-commons command after the REST route and the MCP tool were retired.

status: done 2026-08-16
origin: spec-deferred 592955d7b1dc
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-2: slugPath() addresses every slug-only link through the default tenant, so the URL names the wrong handle until the owner route redirects it.

status: done 2026-08-16
origin: spec-deferred fe2df3ceb0dd
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-3: Alias forwarding for merged or renamed slugs disappeared with the retired commons URL and was never rebuilt on the owner-scoped URL.

status: done 2026-08-16
origin: spec-deferred 162f1930cc8c
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-4: The zh-CN translation catalog has stale keys and still spells the old brand.

status: done 2026-08-16
origin: spec-deferred ee84aaa25ba2
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-5: Reconcile-from-talk plumbing and the discussion lint checks outlive the talk surface they point at.

status: done 2026-08-16
origin: spec-deferred af264a332ec0
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-6: ArticleActions still branches on the commons realm.

status: done 2026-08-16
origin: spec-deferred 5bb7128d058f
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-7: canWritePage's commons-realm rule lost its escape hatch when talk was retired.

status: done 2026-08-16
origin: spec-deferred 51476f69db15
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-8: The contributor capability is retired at every page and REST surface but still ships as two MCP tools.

status: done 2026-08-16
origin: spec-deferred b763192224b5
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-9: Middleware still exempts the retired publish route as an in-route-auth path.

status: done 2026-08-16
origin: spec-deferred 049dafc8e212
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-10: Maintainer-facing files still carry the old brand after the display rename.

status: done 2026-08-16
origin: spec-deferred 4087d7d02acb
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-11: Every owner-only page renders a second `<main>` landmark inside the one `SiteChrome` already provides.

status: done 2026-08-17
origin: spec-deferred 87a650148e71
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-12: The email-ingest worker's attachment-forwarding path has no test, so its byte-copy could silently forward empty files.

status: done 2026-08-16
origin: spec-deferred 02eeaa536555
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-13: Follow-up review still recommended for 1-1-sign-in-privately-and-retire-commons after the damping cap was spent

status: done 2026-08-26
origin: review-budget-followup
source_spec: `spec-1-1-sign-in-privately-and-retire-commons.md`
archived: 2026-08-29

### DW-14: Creating or re-templating a Wiki overwrites the tenant-global workspace profile, including one the owner hand-authored in Settings.

status: done 2026-08-17
origin: spec-deferred 60cce7b0cff4
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
archived: 2026-08-29

### DW-15: The repository has no DOM test environment, so the confirm gate and "Cancel writes nothing" are pinned only by scans of component source text.

status: done 2026-08-16
origin: spec-deferred 2b4928bd0582
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
archived: 2026-08-29

### DW-16: `purpose.md` is written at create time but no runtime path reads it.

status: done 2026-08-16
origin: spec-deferred 0335bb4045db
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
archived: 2026-08-29

### DW-17: Wiki artifacts sit at `tenants/<t>/wikis/<id>/`, not at the project root beside `wiki/` and `raw/sources/` as FR-76's file contract describes.

status: done 2026-08-26
origin: spec-deferred b01b1e432d01
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
archived: 2026-08-29

### DW-18: A Wiki can be created and re-templated but never deleted or renamed, and artifact directories are never cleaned up.

status: done 2026-08-17
origin: spec-deferred 5fa916c79323
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
archived: 2026-08-29

### DW-19: `loadPageConventions()` resolves the active Wiki deployment-globally from `NEXT_PUBLIC_OWNER_HANDLE`, while the guidance beside it at the same prompt sites resolves per-caller.

status: done 2026-08-17
origin: spec-deferred 54c8fcb81384
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
archived: 2026-08-29

### DW-20: Create and re-template are not atomic across the two artifact writes, the profile write, and the registry write.

status: done 2026-08-17
origin: spec-deferred 1f1c9143305b
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
archived: 2026-08-29

### DW-21: Switching the active Wiki rewrites the tenant-global workspace profile with no confirm at all, unlike the template overwrite it is equivalent to.

status: done 2026-08-17
origin: spec-deferred 3671da5ea756
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
archived: 2026-08-29

### DW-22: The `wikis:<tenant>` lock does not serialize against the `workspace-profile:<tenant>` lock it writes through.

status: done 2026-08-17
origin: spec-deferred 7d6ef98a9b38
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
archived: 2026-08-29

### DW-23: Follow-up review still recommended for 1-2-create-a-wiki-from-a-scenario-template after the damping cap was spent

status: done 2026-08-26
origin: review-budget-followup
source_spec: `spec-1-2-create-a-wiki-from-a-scenario-template.md`
archived: 2026-08-29

### DW-24: The whole interactive shell is verified only by reading its own source text; nothing renders, mounts, or measures it.

status: done 2026-08-16
origin: spec-deferred fd8367b6c9be
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
archived: 2026-08-29

### DW-25: Nothing states the cross-origin contract an HTTPS page must satisfy to reach `http://127.0.0.1:19828`, so the probe can fail closed forever for reasons the copy cannot explain.

status: done 2026-08-29
resolution: resolved by sweep bundle dw2-sidecar-cross-origin-contract
resolution-undo: b49ba3f56af2150ffab199698c6a889efc8567811b6262de8984f8363c5207b7 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 344c510011f1
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
archived: 2026-08-29

### DW-26: Switching away from Wiki unmounts `WikiWorkbench`, discarding an open Create Wiki dialog, a typed wiki name, and any error already shown.

status: done 2026-08-21
origin: spec-deferred eb1d417b7c7d
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
archived: 2026-08-29

### DW-27: The active mode has no URL representation, so a mode cannot be linked or bookmarked and Back leaves the app entirely.

status: done 2026-08-17
origin: spec-deferred 8ebf6433668a
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
archived: 2026-08-29

### DW-28: `HomeDashboard` is no longer mounted by any route, and the test that pinned it as the landing page's `<h1>` owner now guards a component that does not ship.

status: done 2026-08-16
origin: spec-deferred 8594e9c2456b
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
archived: 2026-08-29

### DW-29: Follow-up review still recommended for 1-3-nashsu-icon-rail-and-workbench-chrome after the damping cap was spent

status: done 2026-08-26
origin: review-budget-followup
source_spec: `spec-1-3-nashsu-icon-rail-and-workbench-chrome.md`
archived: 2026-08-29

### DW-30: Switching Wikis changes only `purpose.md` and `schema.md` in the trees; `wiki/` and `raw/` are tenant-flat, so the Knowledge tab shows the same pages under every Wiki.

status: done 2026-08-17
origin: spec-deferred 166e4d5b97ae
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
archived: 2026-08-29

### DW-31: The Files tab shows `purpose.md` and `schema.md` at the tree root, so the path the Preview strip prints for them is not the path that addresses their bytes.

status: done 2026-08-16
origin: spec-deferred 5bb2e2fd9c76
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
archived: 2026-08-29

### DW-32: The read gate covers `wiki/` leaves only; `raw/` filenames are listed unfiltered, and they are derived from page slugs.

status: done 2026-08-27
origin: spec-deferred 5a6b330e4ac8
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
archived: 2026-08-29

### DW-33: Wiki mode now shows two Wiki switchers and two create controls at once — the new header pair and Story 1.2's canvas card.

status: done 2026-08-17
origin: spec-deferred 6403cc2df74f
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
archived: 2026-08-29

### DW-34: Docking and undocking the Preview is a silent layout change, and below 900px the column arrives off screen below the canvas.

status: done 2026-08-17
origin: spec-deferred 884c300a0a3f
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
archived: 2026-08-29

### DW-35: Follow-up review still recommended for 1-4-knowledge-tree-and-file-tree after the damping cap was spent

status: done 2026-08-26
origin: review-budget-followup
source_spec: `spec-1-4-knowledge-tree-and-file-tree.md`
archived: 2026-08-29

### DW-36: Changing the tree selection while the confirm-gated editor is open discards the owner's unsaved markdown with no warning.

status: done 2026-08-18
origin: spec-deferred 3c0e066248f5
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
archived: 2026-08-29

### DW-37: `PUT /api/wiki/[slug]` has no `isReadOnly()` gate, and this story's `Edit` affordance is the first surface to offer it to a human.

status: done 2026-08-17
origin: spec-deferred 28559db804f6
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
archived: 2026-08-29

### DW-38: The page write path has no lost-update guard, so a save can silently overwrite a page rewritten since the Preview read it.

status: done 2026-08-17
origin: spec-deferred 0f0288cf1313
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
archived: 2026-08-29

### DW-39: Story 1.2's canvas card keeps saying `Select a file to preview.` while a Preview column is docked beside it showing exactly that file.

status: done 2026-08-17
origin: spec-deferred 6624dcbc2fe7
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
archived: 2026-08-29

### DW-40: A read under `raw/` inherits `resolveRoot`'s fallback to the SHARED flat root, so an owner whose raw silo is empty reads the legacy tree's bytes.

status: done 2026-08-22
origin: spec-deferred 8926f334b742
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
archived: 2026-08-29

### DW-41: The Files tab lists `wiki/` leaves that are not pages, and the Preview now answers every one of them with `This file couldn’t be loaded.`

status: done 2026-08-17
origin: spec-deferred 8ab03831be26
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
archived: 2026-08-29

### DW-42: `editable` is every page the READ gate admits, but the write ACL is narrower, so a readable-but-unwritable page offers `Edit` and fails at Save.

status: done 2026-08-27
origin: spec-deferred e4b29f3d45f4
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
archived: 2026-08-29

### DW-43: Follow-up review still recommended for 1-5-view-first-preview-with-gfm-and-wikilinks after the damping cap was spent

status: done 2026-08-26
origin: review-budget-followup
source_spec: `spec-1-5-view-first-preview-with-gfm-and-wikilinks.md`
archived: 2026-08-29

### DW-44: The divider's 9px grab strip is under WCAG 2.2 AA's 24px target-size minimum, and its outer half overlaps the tree's own scrollbar.

status: done 2026-08-18
origin: spec-deferred 223f18c1acac
source_spec: `spec-1-6-drag-resize-and-durable-layout.md`
archived: 2026-08-29

### DW-45: The separators carry no `aria-controls`, and the keyboard surface has no coarse step (PageUp/PageDown).

status: done 2026-08-18
origin: spec-deferred e99921b6f2d1
source_spec: `spec-1-6-drag-resize-and-durable-layout.md`
archived: 2026-08-29

### DW-46: The restore validates a stored row against the two trees and the Wiki id, but never against the tree TAB it restores alongside it.

status: done 2026-08-18
origin: spec-deferred ce30a7341cbf
source_spec: `spec-1-6-drag-resize-and-durable-layout.md`
archived: 2026-08-29

### DW-47: The tree's scroll effects re-run on tab and collapse only, so crossing the 899px force-show boundary by RESIZING is missed.

status: done 2026-08-18
origin: spec-deferred 960bd3db4d29
source_spec: `spec-1-6-drag-resize-and-durable-layout.md`
archived: 2026-08-29

### DW-48: A refresh whose server re-render still reads the OLD version strands that version: `refreshedFor` has already advanced, so it is never retried.

status: done 2026-08-21
origin: spec-deferred 50d952f5c317
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
archived: 2026-08-29

### DW-49: Writes that bypass `runPageLifecycleOp` — template seeding of `purpose.md` and `schema.md`, raw source files — never move the signal.

status: done 2026-08-18
origin: spec-deferred 53e5882c5f58
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
archived: 2026-08-29

### DW-50: A silent same-row refresh swaps the Preview's body with no announcement, so a screen-reader user reading it is not told the content changed.

status: done 2026-08-17
origin: spec-deferred 6d3ef6e9607b
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
archived: 2026-08-29

### DW-51: `PUT /api/wiki/[slug]` carries no `If-Match` precondition, so the Preview editor silently clobbers a write another actor made while it was open.

status: done 2026-08-17
origin: spec-deferred d5ca34c088fa
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
archived: 2026-08-29

### DW-52: The watcher's effect lifecycle — poll cadence, visibility gating, abort, teardown — is verified only by matching strings in its own source.

status: done 2026-08-16
origin: spec-deferred 90233d0f0577
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
archived: 2026-08-29

### DW-53: A page another actor deletes now disappears from the trees mid-session while the docked selection survives, leaving no row marked current.

status: done 2026-08-17
origin: spec-deferred a8eec345e2bd
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
archived: 2026-08-29

### DW-54: A silent refresh cannot tell "another actor deleted this page" from "the network blipped", so a transient failure replaces the page the owner is reading with the failure copy and does not heal itself.

status: done 2026-08-17
origin: spec-deferred de2abf5767d2
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
archived: 2026-08-29

### DW-55: Follow-up review still recommended for 1-7-dataversion-workbench-refresh after the damping cap was spent

status: done 2026-08-26
origin: review-budget-followup
source_spec: `spec-1-7-dataversion-workbench-refresh.md`
archived: 2026-08-29

### DW-56: The Schema write has no lost-update protection, so an editor left open across another actor's save silently clobbers it.

status: done 2026-08-17
origin: spec-deferred 078a87eb5dc9
source_spec: `spec-1-8-edit-schema.md`
archived: 2026-08-29

### DW-57: A Preview left open on `schema.md` across a Scenario Template re-apply shows pre-template bytes, and saving them silently reverts the re-apply.

status: done 2026-08-18
origin: spec-deferred a5eae62be08b
source_spec: `spec-1-8-edit-schema.md`
archived: 2026-08-29

### DW-58: FR-34's other half is still unbuilt — `purpose.md` is editable from no surface, and the narrow allowlist now pins that shut.
origin: spec-deferred d9e12a049e09
location: src/lib/wiki-scenarios.ts (EDITABLE_ARTIFACT_FILES)
source_spec: `spec-1-8-edit-schema.md`
severity: medium
reason: PRD FR-34 reads "Christian can view/edit purpose and Schema from Settings or Wiki tree", and the UX run names both files. This story's acceptance covers Schema alone, so the exclusion is correct here — but it is now an asserted invariant (`expect(EDITABLE_ARTIFACT_FILES).not.toContain( "purpose.md")`), so a later story must edit a test to open it. Opening it also needs an answer to what `purpose.md` must contain to be valid (the Schema's `hasPageConventions` has no analogue) and to how it reconciles with the tenant-global workspace profile (DW-14, DW-21), which is why it was not simply widened here.
status: done 2026-09-02
resolution: already resolved: src/lib/wiki-scenarios.ts:77 — EDITABLE_ARTIFACT_FILES now lists purpose.md, and src/lib/__tests__/wiki-schema-edit.test.ts:180 asserts toEqual(["purpose.md","schema.md"]); the inverted invariant the entry describes is gone.
decision: 2026-08-16 Wait for DW-14

### DW-59: An overwritten Schema has no recovery path — the artifact write takes no revision snapshot, while the page write it is modelled on does.

status: done 2026-08-18
origin: spec-deferred 3d268db29649
source_spec: `spec-1-8-edit-schema.md`
archived: 2026-08-29

### DW-60: Follow-up review still recommended for 1-8-edit-schema after the damping cap was spent

status: done 2026-08-26
origin: review-budget-followup
source_spec: `spec-1-8-edit-schema.md`
archived: 2026-08-29

### DW-61: The legacy `/settings` page now offers `Custom` in its provider picker but has no base-URL or key field for it, so selecting it there stores a provider no LLM call can construct.

status: done 2026-08-20
origin: spec-deferred 172fbd06f98e
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
archived: 2026-08-29

### DW-62: The `g s` keyboard shortcut still routes out of the shell to the legacy Settings page, doing exactly the route change the rail control stopped doing.

status: done 2026-08-21
origin: spec-deferred cbeb1a3bf4ed
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
archived: 2026-08-29

### DW-63: Two live Settings surfaces now write one config file with no lost-update protection between them.

status: done 2026-08-17
origin: spec-deferred b1364ed893f7
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
archived: 2026-08-29

### DW-64: The configured deadline bounds a whole STREAM on `callLLMStream`, and a deadline that fires surfaces raw transport vocabulary.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-stream-deadline-owner-copy
resolution-undo: 59fc6b9ad5d6f1a9b7ee48383f3c5cc98105b84ea1db1fef393b81e8186ae09c 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 0d779aa5cece
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
archived: 2026-08-29

### DW-65: On a read-only deployment the Settings selects and checkbox are `disabled`, which takes them out of the tab order, so a keyboard user cannot even read the stored provider.

status: done 2026-08-17
origin: spec-deferred e6bf2b886405
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
archived: 2026-08-29

### DW-66: `hasCustomApiKey` / `hasFirecrawlApiKey` conflate an env-supplied key with a stored one, so `Remove` is offered for keys it cannot remove.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-env-locked-credential-affordances
resolution-undo: a2bc3f517016d00b840c4497974d90581053315b9d7eac5a37d8febc1b69824d 2026-08-29 7374617475733a206f70656e
origin: spec-deferred a152dc3b5b3f
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
archived: 2026-08-31

### DW-67: Edits typed while a save is in flight are discarded when the response re-seeds the draft.
origin: spec-deferred 7fd1f35ba122
location: src/components/workbench/SettingsCanvas.tsx (save)
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: low
reason: `save` re-seeds the whole draft from the stored values the route answers with, which is what clears `dirty` — but the fields stay editable during the request, so anything typed in that window is replaced without a word. The alternatives (freeze the form while saving, or merge only untouched fields) are both behavioural choices this story's acceptance does not settle.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-settings-save-in-flight-freshness
resolution-undo: da15ea5de83fe8fdcb5e911d0c2d65e67d416f176617fa044ae72da0891d817d 2026-09-01 7374617475733a206f70656e
decision: 2026-08-28 Freeze the form while saving — Disable the Settings form's inputs for the duration of the save request so nothing can be typed into the window whose contents would be discarded, with a test pinning that the fields are inert while the PUT is in flight.

### DW-68: Storing an embedding key through the new surface flips `hasEmbeddingSupport()` on for the existing ingest caller even with vector search switched off.
origin: spec-deferred 050a745f1202
location: src/lib/embeddings.ts:139 (embeddingApiKeyFor), src/lib/ingest.ts:989
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: medium
reason: `embeddingApiKeyFor` now falls back to `loadConfigSync().embeddingApiKey` (which the spec's Execution list requires, or the three stored vector values would have no reader at all). `hasEmbeddingSupport()` → `getEmbeddingModelName()` → `resolveEmbeddingProvider()` → `embeddingApiKeyFor()`, so an owner who pastes a key into Settings → Embeddings and leaves the switch off — the story's headline default — turns `ingest.ts:989` from off to on. Nothing fails: `embeddings.test.ts` drives that path from env vars, which are unchanged. The epic assigns "embed after ingest only when vector is on" to Story 2.9 and the spec's Never list forbids gating the callers here, so closing it is that story's work.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-embedding-config-plumbing
resolution-undo: 8a0382f4070a51c2a5a7aaf7da5b7aa65dd5bd80790f4a492e096d44cb987daf 2026-09-01 7374617475733a206f70656e
decision: 2026-08-29 Gate the ingest caller, leave the predicate alone — Gate src/lib/ingest.ts:1011 on `getVectorSearchSettings().enabled` rather than on `hasEmbeddingSupport()`, keeping `hasEmbeddingSupport`'s contract and `embeddings.test.ts` untouched. Fall through to the existing corpus-stats path when the switch is off, which is the same branch an unconfigured deployment already takes. Pin that a stored embedding key with the switch off takes the non-vector branch.
decision: 2026-08-29 Gate the ingest caller, leave the predicate alone — Gate src/lib/ingest.ts:1011 on `getVectorSearchSettings().enabled` rather than on `hasEmbeddingSupport()`, keeping `hasEmbeddingSupport`'s contract and `embeddings.test.ts` untouched. Fall through to the existing corpus-stats path when the switch is off, which is the same branch an unconfigured deployment already takes. Pin that a stored embedding key with the switch off takes the non-vector branch.

### DW-69: One `embeddingApiKey` is shared by both keyed embedding vendors, so switching provider silently reuses the other vendor's key.

status: done 2026-08-21
origin: spec-deferred bddb90da84c0
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
archived: 2026-08-29

### DW-70: The Embeddings category offers an endpoint field that is never read for `ollama` or `workers-ai`.
origin: spec-deferred 9c4aafe22ebe
location: src/lib/embeddings.ts:228-247, src/components/workbench/SettingsCanvas.tsx
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
severity: low
reason: `_createEmbeddingModel` applies `config.embeddingBaseUrl` for `openai` and `google` only; `ollama` reaches its server through `getOllamaBaseUrl()` and `workers-ai` through the Cloudflare binding. The vector gate agrees (both are in `SELF_TRANSPORTING_EMBEDDING_PROVIDERS` and are not asked for an endpoint), so nothing is broken — but the field still accepts a value that goes nowhere. Hiding it per provider, or routing `ollama`'s embedding endpoint through it, both change what `ollamaBaseUrl` means and want one decision rather than a fix inside this surface.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-embedding-config-plumbing
resolution-undo: 8a0382f4070a51c2a5a7aaf7da5b7aa65dd5bd80790f4a492e096d44cb987daf 2026-09-01 7374617475733a206f70656e
decision: 2026-08-28 Route ollama through it — Make _createEmbeddingModel read embeddingBaseUrl for ollama, redefining ollamaBaseUrl as the chat endpoint only, and document and pin the split so the two settings stop overlapping.

### DW-71: `LLM_CUSTOM_BASE_URL` wins at runtime but is invisible on the surface, so the Custom endpoint box can be typed into and saved with no effect.

status: done 2026-08-20
origin: spec-deferred 982384b4e50e
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
archived: 2026-08-29

### DW-72: One stored `embeddingBaseUrl` is handed to whichever embedding provider is active, so an endpoint entered for OpenAI is sent to Google after a switch.

status: done 2026-08-21
origin: spec-deferred 1ed1cc09bf7d
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
archived: 2026-08-29

### DW-73: A `workers-ai` embedding model outside the `@cf/` namespace satisfies the vector gate and is then silently discarded at resolution time.

status: done 2026-08-18
origin: spec-deferred e96831d64aed
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
archived: 2026-08-29

### DW-74: Follow-up review still recommended for 1-9-settings-for-models-and-embeddings after the damping cap was spent

status: done 2026-08-26
origin: review-budget-followup
source_spec: `spec-1-9-settings-for-models-and-embeddings.md`
archived: 2026-08-29

### DW-75: LintFilterControls.tsx keeps a hand-copied ALL_CHECK_TYPES with only 11 entries while the lib const in lint-checks.ts has 14, so the lint UI cannot toggle uncited-claims, supersedes-dangling, or incom

status: done 2026-08-19
origin: spec-deferred e4d2cbfe1b61
source_spec: `spec-retire-dead-machinery.md`
archived: 2026-08-29

### DW-76: The disputed frontmatter flag is now one-way — ingest still sets disputed: true on contradicting merges and ArticleView still renders the disputed banner, but with reconcile-from-talk and the disputed

status: done 2026-08-19
origin: spec-deferred 78f255fc65a4
source_spec: `spec-retire-dead-machinery.md`
archived: 2026-08-29

### DW-77: authz.ts still carries the commons-realm delete-deny branch with no commons behind it; after this change the client delete gate no longer mirrors it for a hypothetical non-admin owner of a public page

status: done 2026-08-16
origin: spec-deferred a067ea608790
source_spec: `spec-retire-dead-machinery.md`
archived: 2026-08-29

### DW-78: HomeGraph.tsx had zero references already at the baseline revision — a pre-existing dead component, not orphaned by this story (unlike HomeAsk.tsx, which this story deleted).

status: done 2026-08-16
origin: spec-deferred 05b39e1a7083
source_spec: `spec-retire-dead-machinery.md`
archived: 2026-08-29

### DW-79: The orchestrator's ledger sweep truncates entry headings at a fixed width mid-word — DW-75's heading in deferred-work.md ends "or incom" and DW-76's ends "and the disputed", and DW-75's useLint-length

status: done 2026-08-16
origin: spec-deferred 5e93c57512b0
source_spec: `spec-retire-dead-machinery.md`
archived: 2026-08-29

### DW-80: workers/task-consumer docs still describe reconcile as live work — its README walks through "reconcile a page from a discussion thread" and index.ts's header says the actual work is "(reconcile / inge

status: done 2026-08-16
origin: spec-deferred 72b5e66c4034
source_spec: `spec-retire-dead-machinery.md`
archived: 2026-08-29

### DW-81: talk.ts getDiscussionStats is newly orphaned by this story — its last production callers were the deleted discussion lint checks — and reports green under talk.test.ts with no reachable caller; the ba

status: done 2026-08-16
origin: spec-deferred 327d8597cfc7
source_spec: `spec-retire-dead-machinery.md`
archived: 2026-08-29

### DW-82: Follow-up review still recommended for dw-retire-dead-machinery after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-retire-dead-machinery.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-122748-68ea; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-83: MarkdownRenderer call sites outside the intent's component list still emit DEFAULT_TENANT wikilinks for in-content [x](slug.md) targets, taking the wrong-handle 308 hop the named components were just

status: done 2026-08-19
origin: spec-deferred 9c6585bd571d
source_spec: `spec-owner-scoped-linking.md`
archived: 2026-08-29

### DW-84: The edit and raw owner-scoped routes do not alias-forward merged-away slugs, so an old /u/<handle>/<slug>/edit bookmark 404s where the page-view URL now forwards.

status: done 2026-08-19
origin: spec-deferred 7e750d1a36d0
source_spec: `spec-owner-scoped-linking.md`
archived: 2026-08-29

### DW-85: The owner route's "Page not found" UI is rendered as a normal HTTP 200 response instead of signalling notFound(), so dead slugs (including alias candidates that fail the forwarding guard) are indexabl

status: done 2026-08-19
origin: spec-deferred 7952daea88ca
source_spec: `spec-owner-scoped-linking.md`
archived: 2026-08-29

### DW-86: Converted components' rendered anchors have no executable coverage: reverting any one call site to slugPath (or dropping a slugTenants renderer prop) passes the whole suite, so the story's component-s

status: done 2026-08-19
origin: spec-deferred 7eeab2ede4b6
source_spec: `spec-owner-scoped-linking.md`
archived: 2026-08-29

### DW-87: loadSlugTenants caches a non-OK response's empty map for the whole session (no retry) while a rejected fetch is retried, so one transient 401/429/500 from /api/wiki/routes pins DEFAULT_TENANT fallback

status: done 2026-08-19
origin: spec-deferred e1b670ffa4b7
source_spec: `spec-owner-scoped-linking.md`
archived: 2026-08-29

### DW-88: getAliasIndex caches only successful builds, so while any page file has malformed frontmatter every missing-slug request re-runs the full wiki scan behind aliasRedirectForMissing before failing closed

status: done 2026-08-19
origin: spec-deferred 30b195a5eb4f
source_spec: `spec-owner-scoped-linking.md`
archived: 2026-08-29

### DW-89: SlugTenantMap lookups use plain inherited-prototype indexing, so a slug naming an Object.prototype member (a page titled "Constructor" slugifies to "constructor") resolves to the inherited function an

status: done 2026-08-19
origin: spec-deferred 8c3a40745345
source_spec: `spec-owner-scoped-linking.md`
archived: 2026-08-29

### DW-90: Follow-up review still recommended for dw-owner-scoped-linking after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-owner-scoped-linking.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 1) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-122748-68ea; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-91: tools/WORKWIKI_SYNC.md filename still carries the old WORKWIKI brand after the sweep.

status: done 2026-08-19
origin: spec-deferred 2182a48bb95c
source_spec: `spec-maintainer-brand-sweep.md`
archived: 2026-08-29

### DW-92: workers/sandbox-runner/README.md H1 still reads "Yopedia sandbox runner" — stale display prose invisible to both brand scans.

status: done 2026-08-19
origin: spec-deferred 25a5969a3d48
source_spec: `spec-maintainer-brand-sweep.md`
archived: 2026-08-29

### DW-93: AGENTS.md's frozen-identifier list omits the WORKWIKI_* operator family.

status: done 2026-08-19
origin: spec-deferred 082aa1c5ca08
source_spec: `spec-maintainer-brand-sweep.md`
archived: 2026-08-29

### DW-94: public/ served static copy (e.g. public/agent-api.md) is outside both brand scans.

status: done 2026-08-19
origin: spec-deferred b6515946b4ea
source_spec: `spec-maintainer-brand-sweep.md`
archived: 2026-08-29

### DW-95: DW-91's recorded premise ("nothing references the doc's path") is now stale — the sweep's vacuity-guard test pins tools/WORKWIKI_SYNC.md by literal path.

status: done 2026-08-19
origin: spec-deferred 153d65f75801
source_spec: `spec-maintainer-brand-sweep.md`
archived: 2026-08-29

### DW-96: Maintainer-facing surfaces outside the four scan roots remain unscanned: scripts/, journal-site/, and .opencode/commands/*.md.

status: done 2026-08-19
origin: spec-deferred 7d14595dc7b0
source_spec: `spec-maintainer-brand-sweep.md`
archived: 2026-08-29

### DW-97: A stray empty ~/pnpm-workspace.yaml (outside the repo) breaks every `pnpm <cmd>` on this dev machine, including all of this spec's documented verification commands.

status: done 2026-08-16
origin: spec-deferred 6a474b2bad10
source_spec: `spec-maintainer-brand-sweep.md`
archived: 2026-08-29

### DW-98: The email-ingest route's own byte handoff to `stageBytes` is unverified, so the empty-attachment harm DW-12 names is still reachable one hop past the worker.

status: done 2026-08-19
origin: spec-deferred 84b8769da573
source_spec: `spec-email-ingest-attachment-test.md`
archived: 2026-08-29

### DW-99: The worker's supported-attachment allowlist has drifted from the app's document extractor, so formats the app can read are rejected at the email door.

status: done 2026-08-19
origin: spec-deferred e07612517bf9
source_spec: `spec-email-ingest-attachment-test.md`
archived: 2026-08-29

### DW-100: The `attachmentName` FormData fields the worker sends are unobserved, so names of unsupported attachments can vanish from ingest job metadata undetected.

status: done 2026-08-19
origin: spec-deferred 92d4586ec775
source_spec: `spec-email-ingest-attachment-test.md`
archived: 2026-08-29

### DW-101: Only the ArrayBuffer branch of the worker's attachment-content normalization is exercised — including, ironically, not the branch the defensive copy exists for.

status: done 2026-08-19
origin: spec-deferred 0da5a9e0e5df
source_spec: `spec-email-ingest-attachment-test.md`
archived: 2026-08-29

### DW-102: Multi-attachment behaviour is unobserved — the 10-attachment cap, per-index filename/bytes pairing, and both fallbacks are untested.

status: done 2026-08-19
origin: spec-deferred 376e7071da0f
source_spec: `spec-email-ingest-attachment-test.md`
archived: 2026-08-29

### DW-103: The acknowledgement copy a sender receives about their attachments is unpinned.

status: done 2026-08-19
origin: spec-deferred 929e58770d4a
source_spec: `spec-email-ingest-attachment-test.md`
archived: 2026-08-29

### DW-104: Base64 expansion makes the route's 10 MB per-document limit unreachable via email, and neither cap is tested against the other.

status: done 2026-08-20
origin: spec-deferred 4fa3442f8443
source_spec: `spec-email-ingest-attachment-test.md`
archived: 2026-08-29

### DW-105: The shared dialog hook `useDialogA11y` — the richest DOM-only behaviour in reach — still has no mounted coverage.

status: done 2026-08-19
origin: spec-deferred 1fd2c04cc42e
source_spec: `spec-dom-test-environment.md`
archived: 2026-08-29

### DW-106: WikiWorkbench's other write paths have no mounted coverage — switchWiki's rollback and re-entry guard, the degraded `unavailable` render, and create()'s failure branch.

status: done 2026-08-19
origin: spec-deferred 684689c6d8cd
source_spec: `spec-dom-test-environment.md`
archived: 2026-08-29

### DW-107: Nothing pins the `busy` gate on either dialog, so a double-submit would issue two destructive writes with the suite green.

status: done 2026-08-19
origin: spec-deferred d8fb9fb38bc8
source_spec: `spec-dom-test-environment.md`
archived: 2026-08-29

### DW-108: Seventeen source files still tell the reader this repository has no DOM test environment, and several use that as the stated justification for their design.

status: done 2026-08-27
origin: spec-deferred bca5238bf2c5
source_spec: `spec-dom-test-environment.md`
archived: 2026-08-29

### DW-109: Most of DW-24's own verbatim list is still scan-only — the collapse toggle, badge rendering at 0 vs > 0, the sidecar dot's three states, and the live-region announcement.

status: done 2026-08-19
origin: spec-deferred e63cd3a386e5
source_spec: `spec-dom-test-environment.md`
archived: 2026-08-29

### DW-110: The two polling suites have no mounted case for a rejecting fetch, a malformed body, or a wedged (never-settling) probe.

status: done 2026-08-19
origin: spec-deferred 71d48dcc2b92
source_spec: `spec-dom-test-environment.md`
archived: 2026-08-29

### DW-111: The new `*.test.tsx` ⇒ jsdom / `*.test.ts` ⇒ node convention is documented only in a `vitest.config.ts` comment.

status: done 2026-08-27
origin: spec-deferred 781ee7265273
source_spec: `spec-dom-test-environment.md`
archived: 2026-08-29

### DW-112: The DOM suites import their shim helpers through a relative ladder out of `src` (`../../../../vitest.setup.dom`), hardcoding each file's directory depth.

status: done 2026-08-27
origin: spec-deferred 60cbf8e54eb5
source_spec: `spec-dom-test-environment.md`
archived: 2026-08-29

### DW-113: No mounted test can reach the shell's width-derived decisions, because a mounted `Workbench` measures `shellWidth === 0`.

status: done 2026-08-27
origin: spec-deferred d7b2d8e349f5
source_spec: `spec-dom-test-environment.md`
archived: 2026-08-29

### DW-114: Follow-up review still recommended for dw-dom-test-environment after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dom-test-environment.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-122748-68ea; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-115: `pnpm` cannot run any script in this repo, so the documented verification commands (`pnpm test`, `pnpm lint`) are unusable.

status: done 2026-08-19
origin: spec-deferred becf08fd7220
source_spec: `spec-retire-zh-cn-locale.md`
archived: 2026-08-29

### DW-116: `<html lang>` is now unconditionally `"en"` while the wiki deliberately stores CJK and other non-English source content, so assistive technology announces those pages as English.
origin: spec-deferred 98df4f306e4c
source_spec: `spec-retire-zh-cn-locale.md`
location: src/app/layout.tsx:70
severity: low
reason: `src/lib/slugify.ts`, `src/lib/bm25.ts` and `src/lib/ingest.ts` all preserve CJK by design, and nothing sets `lang` on the article or Preview subtree. Pre-existing rather than caused by this change — the old value tracked the UI locale, not the content language, so it was equally wrong — but the retirement removes the last place where a per-content `lang` could have been derived.
status: open
decision: 2026-08-28 Detect and set on the body — Detect the dominant script of a page body at render time and set lang on the article/Preview subtree only, leaving <html lang="en"> for the chrome; no schema change.
decision: 2026-08-26 Detect and set on the body — Detect the dominant script of a page body at render time and set lang on the article/Preview subtree only, leaving <html lang="en"> for the chrome; no schema change.

### DW-117: The `walk()` test helper is now copy-pasted across five suites with inconsistent directory exclusions, so the scans silently cover different file sets.

status: done 2026-08-27
origin: spec-deferred 5ee27cb93f34
source_spec: `spec-retire-zh-cn-locale.md`
archived: 2026-08-29

### DW-118: No test renders the root layout or the nav, so the app shell's provider tree is guarded only by source-text reads.

status: done 2026-08-19
origin: spec-deferred 3681ca6a1583
source_spec: `spec-retire-zh-cn-locale.md`
archived: 2026-08-29

### DW-119: Follow-up review still recommended for dw-retire-zh-cn-locale after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-retire-zh-cn-locale.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-215057-fc61; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-120: The client delete gate still shows "Delete page" to a non-admin owner of a public knowledge page, whose DELETE the same realm gate then refuses with a generic message.

status: done 2026-08-19
origin: spec-deferred 7cd7a18f81ec
source_spec: `spec-authz-commons-realm-cleanup.md`
archived: 2026-08-29

### DW-121: The edit page gates the whole editor — including the seven metadata fields — on writeKind "body", withholding metadata patches that canWritePage still permits.

status: done 2026-08-21
origin: spec-deferred fbcd3507e87a
source_spec: `spec-authz-commons-realm-cleanup.md`
archived: 2026-08-29

### DW-122: Seven other call sites of the same realm deny still emit a generic permission message with no realm explanation.

status: done 2026-08-19
origin: spec-deferred 8ef6b4ff69c9
source_spec: `spec-authz-commons-realm-cleanup.md`
archived: 2026-08-29

### DW-123: The edit page's write denial returns before the canonical-tenant redirect, so a non-canonical edit URL renders the refusal instead of its 308.

status: done 2026-08-19
origin: spec-deferred 20dcb006b261
source_spec: `spec-authz-commons-realm-cleanup.md`
archived: 2026-08-29

### DW-124: Follow-up review still recommended for dw-authz-commons-realm-cleanup after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-authz-commons-realm-cleanup.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-215057-fc61; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-125: `listContributors` and `buildContributorProfile` in `src/lib/contributors.ts` now have test-only callers — retiring the two contributor MCP tools removed their last production consumers.
origin: spec-deferred 4ca2c6cb527d
source_spec: `spec-retire-dead-machinery-round-2.md`
location: src/lib/contributors.ts:278
severity: low
reason: `src/lib/contributors.ts` exports `buildContributorProfile` (:278) and `listContributors` (:331). Their only remaining callers are `src/lib/__tests__/contributors.test.ts` and `src/lib/__tests__/contributor-index.test.ts:13`; the production call sites in `src/mcp.ts` (`handleListContributors` / `handleGetContributor`) were deleted in this pass. The sibling `buildContributorProfiles` (:313) is in the same test-only state, which predates this pass. The module itself must stay: `src/lib/contributor-index.ts:37-43` imports `computeScanData` and `computeTrustScore` from it, and `lifecycle.ts:33`, `talk.ts:46`, `maintenance.ts:231` keep the index live. The spec's Code Map called this residue explicitly out of scope ("record as deferred, do not delete") because deleting the scan functions would mean deciding whether the trust-score surface returns, which is a product call rather than a cleanup.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-contributor-and-discuss-index-residue
resolution-undo: 2baf9665322cad66955e33280ea2f14cc21bb9001001db28e5c48764a5941ea4 2026-09-02 7374617475733a206f70656e
decision: 2026-08-19 Retire the scan functions — Delete buildContributorProfile, buildContributorProfiles and listContributors along with their now-orphaned tests, keeping computeScanData and computeTrustScore for contributor-index.ts. Resolve DW-126 the same way by dropping the contributors step from rebuildDerivedIndexes.

### DW-126: The daily maintenance scan still rebuilds the contributor index, but after this pass no production code reads what it builds.
origin: spec-deferred 38e4600a3ab5
source_spec: `spec-retire-dead-machinery-round-2.md`
location: src/lib/maintenance.ts:231
severity: low
reason: `src/lib/maintenance.ts:231` registers `["contributors", () => rebuildContributorIndex()]`, and `lifecycle.ts:33` / `talk.ts:46` still write into the index. The read side (`profilesFromIndex`, `contributorProfileFromIndex`) is reached only through `src/lib/contributors.ts`'s fast paths, whose own callers are now test-only. So the cron pays for a full-wiki scan whose output nothing consumes. Removing it is not a cleanup decision: it depends on whether the contributor trust surface returns, the same product call recorded in the entry above.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-contributor-and-discuss-index-residue
resolution-undo: 2baf9665322cad66955e33280ea2f14cc21bb9001001db28e5c48764a5941ea4 2026-09-02 7374617475733a206f70656e
decision: 2026-08-19 Drop the contributors step — Remove the ["contributors", rebuildContributorIndex] entry from rebuildDerivedIndexes and the now-dead index writes from lifecycle.ts:33 and talk.ts:46, together with the DW-125 scan functions, and pin that the daily scan no longer walks the wiki for contributor data.

### DW-127: `src/lib/maintenance.ts`'s module header documents only three deterministic `fix` lint types while the scan emits eight.

status: done 2026-08-20
origin: spec-deferred 3045ad1557a2
source_spec: `spec-retire-dead-machinery-round-2.md`
archived: 2026-08-29

### DW-128: `.yoyo/status.md` still advertises `list_contributors` and `get_contributor` and an MCP tool count of 31.

status: done 2026-08-27
origin: spec-deferred d19fab62b40d
source_spec: `spec-retire-dead-machinery-round-2.md`
archived: 2026-08-29

### DW-129: `SCHEMA.md` still documents the contributor REST routes, wiki pages, and `ContributorBadge` component as live surfaces.

status: done 2026-08-20
origin: spec-deferred 08cb76da0f99
source_spec: `spec-retire-dead-machinery-round-2.md`
archived: 2026-08-29

### DW-130: `DESIGN-triggers.md` states the MCP server exposes 21 tools; the real count is 40.

status: done 2026-08-20
origin: spec-deferred b88666035d3d
source_spec: `spec-retire-dead-machinery-round-2.md`
archived: 2026-08-29

### DW-131: The graph page's canvas accessibility fallback points readers at `/wiki`, which is a retired 404.

status: done 2026-08-27
origin: spec-deferred 0160c928098e
source_spec: `spec-retire-dead-machinery-round-2.md`
archived: 2026-08-29

### DW-132: Two more hand-maintained tool/task inventories have no test pinning them against their source of truth.

status: done 2026-08-20
origin: spec-deferred b45716b28e31
source_spec: `spec-retire-dead-machinery-round-2.md`
archived: 2026-08-29

### DW-133: No test exercises a `wontfix` thread through the KV-index fast path of `getDiscussionStatsForSlugs`.
origin: spec-deferred ead2056e1663
source_spec: `spec-retire-dead-machinery-round-2.md`
location: src/lib/__tests__/discuss-stats-index.test.ts:133
severity: low
reason: `getDiscussionStatsForSlugs` fast-paths through the discuss-stats index when one exists and falls back to a directory scan otherwise. The mixed-status case added in this pass (`src/lib/__tests__/talk.test.ts`, "counts a wontfix thread toward total but not open") seeds no index, so it covers only the scan path, and the fast-path parity test at `src/lib/__tests__/discuss-stats-index.test.ts:133-162` uses only `open` and `resolved` threads. So `wontfix` never reaches `statsFromThreads()`. Pre-existing: the deleted `getDiscussionStats` never touched the index path either, so this pass neither created nor widened the gap.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-talk-surface-truth
resolution-undo: 6aa52e284f23545e6b9c56b7d5165ef2332d8c9cd738d7063d87f10bdf8ba617 2026-09-02 7374617475733a206f70656e

### DW-134: `/api/tasks/scan?dry=1` is documented as pure inspection but still rebuilds derived indexes and purges stale jobs.
origin: spec-deferred 7049e961715f
source_spec: `spec-retire-dead-machinery-round-2.md`
location: src/app/api/tasks/scan/route.ts:57
severity: low
reason: `src/app/api/tasks/scan/route.ts:57` calls `rebuildDerivedIndexes()` and `:60` calls `purgeStaleJobs()` before the `dry` branch is consulted — both write. `workers/task-consumer/README.md` defines dry-run as "logs/returns what it *would* enqueue and enqueues nothing" without noting them, which matters for the "inspect what it would do" step it recommends. Pre-existing route behavior; documenting it accurately means first deciding whether those two calls should move behind the flag, which is beyond a doc correction.
status: open
decision: 2026-08-19 Make dry actually dry — Move `rebuildDerivedIndexes()` and `purgeStaleJobs()` behind the `!dry` branch so a dry run performs no writes at all, and add a test asserting no storage write occurs when `dry=1`.

### DW-135: Follow-up review still recommended for dw-retire-dead-machinery-round-2 after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-retire-dead-machinery-round-2.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-215057-fc61; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-136: The Workspace Purpose form never refetches after the active Wiki changes, so it can keep naming and editing a Wiki that is no longer current.

status: done 2026-08-20
origin: spec-deferred eeecef5703cc
source_spec: `spec-per-wiki-workspace-profiles.md`
archived: 2026-08-29

### DW-137: The legacy tenant-global profile is read through by every pre-change Wiki in a tenant, so one purpose appears under all of them until each is individually saved.

status: done 2026-08-20
origin: spec-deferred 425c83c35758
source_spec: `spec-per-wiki-workspace-profiles.md`
archived: 2026-08-29

### DW-138: `docs/llm-wiki-functional-parity-roadmap.md` still describes the Workspace Purpose editor as owner-scoped rather than per-Wiki.

status: done 2026-08-20
origin: spec-deferred c3c9cc846535
source_spec: `spec-per-wiki-workspace-profiles.md`
archived: 2026-08-29

### DW-139: `putWorkspaceProfile` is an exported unlocked writer whose only guard is a docblock.

status: done 2026-08-20
origin: spec-deferred 5cc8cc30ccaa
source_spec: `spec-per-wiki-workspace-profiles.md`
archived: 2026-08-29

### DW-140: `PUT /api/workspace-profile` has no explicit invalid-JSON branch, so a malformed body surfaces a raw parser message as the 400.

status: done 2026-08-20
origin: spec-deferred f65e39667a15
source_spec: `spec-per-wiki-workspace-profiles.md`
archived: 2026-08-29

### DW-141: `buildWorkspaceGuidance` now performs two storage reads per call, uncached, at seven call sites including three in `ingest.ts`.

status: done 2026-08-20
origin: spec-deferred 4b7d37651866
source_spec: `spec-per-wiki-workspace-profiles.md`
archived: 2026-08-29

### DW-142: The Settings no-Wiki and load-failed states offer no CTA, no retry, and no aria-live announcement, and `loadFailed` is never reset.

status: done 2026-08-20
origin: spec-deferred f1b70803bbe7
source_spec: `spec-per-wiki-workspace-profiles.md`
archived: 2026-08-29

### DW-143: A failure of the profile write in `seedWikiArtifacts` leaves `schema.md` on the new template and the profile on the old one.

status: done 2026-08-17
origin: spec-deferred 51c4bb218e74
source_spec: `spec-per-wiki-workspace-profiles.md`
archived: 2026-08-29

### DW-144: A corrupt per-Wiki `workspace-profile.json` blocks the re-template that would have overwritten it.

status: done 2026-08-20
origin: spec-deferred 6e541a1b637d
source_spec: `spec-per-wiki-workspace-profiles.md`
archived: 2026-08-29

### DW-145: Two tabs editing the SAME Wiki's Workspace Purpose still last-write-wins with no warning.

status: done 2026-08-20
origin: spec-deferred 47d53b63986a
source_spec: `spec-per-wiki-workspace-profiles.md`
archived: 2026-08-29

### DW-146: Follow-up review still recommended for dw-per-wiki-workspace-profiles after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-per-wiki-workspace-profiles.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-215057-fc61; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-147: The orphan-directory sweep has no trigger other than a successful delete, so a tenant that never deletes never reclaims a directory orphaned by a normalizeRegistry drop.

status: done 2026-08-19
origin: spec-deferred 68436c804582
source_spec: `spec-wiki-rename-and-delete.md`
archived: 2026-08-29

### DW-148: Wiki names are not unique and both the switcher and the new delete picker render the name alone, so two Wikis with the same name are indistinguishable at the moment of an irreversible delete.

status: done 2026-08-19
origin: spec-deferred b04ccd5558d3
source_spec: `spec-wiki-rename-and-delete.md`
archived: 2026-08-29

### DW-149: WikiSwitcher offers its write controls with no client-side read-only signal, so on a read-only deployment the 403 arrives only after the owner has confirmed.

status: done 2026-08-17
origin: spec-deferred 8a87b42369f8
source_spec: `spec-wiki-rename-and-delete.md`
archived: 2026-08-29

### DW-150: `withFileLock` is in-process only, so on a multi-isolate deployment the orphan sweep can delete the directory of a Wiki whose registry entry has not landed yet.

status: done 2026-08-19
origin: spec-deferred 11deb3958f5b
source_spec: `spec-wiki-rename-and-delete.md`
archived: 2026-08-29

### DW-151: Follow-up review still recommended for dw-wiki-rename-and-delete after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-wiki-rename-and-delete.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260816-215057-fc61; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-152: Demoting KnowledgeStudio's and VaultExplorer's content columns to plain `<div>` leaves each grid with labelled `<aside>` landmarks on both sides and no landmark on the content between them.

status: done 2026-08-28
origin: spec-deferred e6cd199706ac
source_spec: `spec-single-main-landmark-sweep.md`
archived: 2026-08-29

### DW-153: The DW-152 entry in the deferred-work ledger is truncated mid-sentence, losing the clause that scopes it away from PrivateWorkspaceNotice.

status: done 2026-08-26
origin: spec-deferred b0e8da54231b
source_spec: `spec-single-main-landmark-sweep.md`
archived: 2026-08-29

### DW-154: Follow-up review still recommended for dw-single-main-landmark-sweep after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-single-main-landmark-sweep.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-155: `readActiveWikiSchema()`'s catch branch — warn and fall back to the root Schema on an unreadable or unparseable registry — has no test.

status: done 2026-08-27
origin: spec-deferred e7c53a0d9578
source_spec: `spec-dw-19-single-owner-resolution-invariant.md`
archived: 2026-08-29

### DW-156: Owner-handle case normalization is load-bearing for the single-owner invariant but untested at the Schema path.

status: done 2026-08-27
origin: spec-deferred d5cca58d2f5d
source_spec: `spec-dw-19-single-owner-resolution-invariant.md`
archived: 2026-08-29

### DW-157: The backup scheduler re-implements `getOwnerHandle()` inline, so the owner env var has two readers and a `getOwnerHandle` grep misses one.

status: done 2026-08-27
origin: spec-deferred 194d538ba460
source_spec: `spec-dw-19-single-owner-resolution-invariant.md`
archived: 2026-08-29

### DW-158: Neither `lint-checks.ts` detector has any test that it resolves the ACTIVE Wiki's Schema — a mutation pinning both to the repo-root file passes the entire suite.

status: done 2026-08-27
origin: spec-deferred 517d89b179e4
source_spec: `spec-dw-19-single-owner-resolution-invariant.md`
archived: 2026-08-29

### DW-159: `POST /api/wikis` is gated on sign-in but not ownership, so a non-owner can create a Wiki that every downstream surface then treats as inert.

status: done 2026-08-27
origin: spec-deferred 0cea96b84531
source_spec: `spec-dw-19-single-owner-resolution-invariant.md`
archived: 2026-08-29

### DW-160: Follow-up review still recommended for dw-single-owner-resolution-invariant after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-19-single-owner-resolution-invariant.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-161: `FilesystemStorageProvider.writeFile` is a bare `fs.writeFile`, not the write-to-tmp + rename that `StorageProvider`'s documented contract claims.

status: done 2026-08-20
origin: spec-deferred 0d5c376c507a
source_spec: `spec-dw-20-wiki-create-and-template-atomicity.md`
archived: 2026-08-29

### DW-162: A half-created FIRST Wiki's directory is unreclaimable, because the orphan sweep bails on an empty registry and has no scheduled caller.

status: done 2026-08-19
origin: spec-deferred b2027da91fa3
source_spec: `spec-dw-20-wiki-create-and-template-atomicity.md`
archived: 2026-08-29

### DW-163: Crash durability is still open — compensating cleanup only covers a rejected write, not process death between two writes.

status: done 2026-08-19
origin: spec-deferred 75712627a6a0
source_spec: `spec-dw-20-wiki-create-and-template-atomicity.md`
archived: 2026-08-29

### DW-164: `research-projects.ts` still carries the same untransacted registry property DW-20 names, and was not given a compensation.

status: done 2026-08-20
origin: spec-deferred b087c7736364
source_spec: `spec-dw-20-wiki-create-and-template-atomicity.md`
archived: 2026-08-29

### DW-165: Follow-up review still recommended for dw-wiki-create-and-template-atomicity after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-20-wiki-create-and-template-atomicity.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-166: The repo now carries two independent conventions for reading a query param on the client, and neither references the other.
origin: spec-deferred 77952b63c537
source_spec: `spec-dw-27-workbench-mode-url-sync.md`
location: src/app/wiki/graph/page.tsx:35-42
severity: low
reason: `src/app/wiki/graph/page.tsx:41` already does `new URLSearchParams(window.location.search).get("scope")`, with a comment at `:35` giving the same "avoid the useSearchParams bailout" rationale that `src/lib/workbench-url.ts` was introduced under. Pre-existing — DW-27 did not create it — but `workbench-url.ts` is now presented as the home for URL rules, so the divergence is easier to inherit than it was.
status: open

### DW-167: With Settings open the URL still names the underlying mode, so a link copied there reopens the mode canvas and Back on the first entry leaves the app with the unsaved Settings draft.

status: done 2026-08-28
origin: spec-deferred 1361b6b2b5e9
source_spec: `spec-dw-27-workbench-mode-url-sync.md`
archived: 2026-08-29

### DW-168: A deep link followed by a signed-out browser loses its `?mode=` at the sign-in redirect, which is the case a shared or bookmarked link is most likely to be in.

status: done 2026-08-20
origin: spec-deferred e025aeb56769
source_spec: `spec-dw-27-workbench-mode-url-sync.md`
archived: 2026-08-29

### DW-169: Follow-up review still recommended for dw-workbench-mode-url-sync after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-27-workbench-mode-url-sync.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-170: DW-17's stated reopening trigger, and three frozen story records, still quote the Story 1.4 AC phrase this change removed.

status: done 2026-08-28
origin: spec-deferred 96e0e22d612c
source_spec: `spec-dw-30-wiki-lens-copy-and-invariant.md`
archived: 2026-08-29

### DW-171: The PRD still glosses the File Tree as a browse of "the Wiki's files", the same per-Wiki reading this story removed from the epic.

status: done 2026-08-20
origin: spec-deferred 5ba851433aa5
source_spec: `spec-dw-30-wiki-lens-copy-and-invariant.md`
archived: 2026-08-29

### DW-172: The AC edit shifted `epics.md` by two lines, so four line-addressed citations in three completed story records now point two lines short.
origin: spec-deferred 1f39f0c46915
source_spec: `spec-dw-30-wiki-lens-copy-and-invariant.md`
location: _bmad-output/implementation-artifacts/spec-1-6-drag-resize-and-durable-layout.md:246
severity: low
reason: Verified against the current file: `spec-1-6-drag-resize-and-durable-layout.md:246` cites `epics.md:440` (the 320px clause is now at :442), `spec-1-5-view-first-preview- with-gfm-and-wikilinks.md:383` cites `:423` (now :425), `:391` cites `:413` and `:414` (now :415 and :416), and `spec-1-4-knowledge-tree-and-file-tree.md:136` cites `:530` (now :532). The previous pass's triage entry claimed "every other `epics.md:<line>` citation in the repo sits above the edit" — that holds for shipped code under `src/` (the only other citations there are `epics.md:367`, above the edit, and `workbench-split.ts` was corrected) but not for the planning and implementation artifacts. The intent's Never clause puts the completed `spec-1-4` record off limits, and the same freeze applies to the other completed story records, so none of the four can be corrected from this story. Each lands within the same AC block, so a reader is misdirected by two lines rather than to unrelated text.
status: open
decision: 2026-08-28 Correct the citations — Bump the four line-addressed citations in spec-1-4, spec-1-5 and spec-1-6 to their current epics.md lines, recording that a citation correction is not an amendment of the approved content.
decision: 2026-08-26 Correct the citations — Bump the four line-addressed citations in spec-1-4, spec-1-5 and spec-1-6 to their current epics.md lines, recording that a citation correction is not an amendment of the approved content.

### DW-173: Follow-up review still recommended for dw-wiki-lens-copy-and-invariant after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-30-wiki-lens-copy-and-invariant.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-174: A header Rename leaves the Wiki canvas card naming the old wiki until a reload.

status: done 2026-08-19
origin: spec-deferred 3de0090154c7
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
archived: 2026-08-29

### DW-175: `WikiWorkbench.send()` has no request deadline, so a hung create or re-template leaves the dialog spinning for the session.

status: done 2026-08-19
origin: spec-deferred f456e0d80acd
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
archived: 2026-08-29

### DW-176: The zero-wiki viewport shows two byte-identical `No wiki yet.` sentences.
origin: spec-deferred 5b12d4aa3439
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
location: src/components/WikiWorkbench.tsx:160 with src/lib/workbench-tree.ts:71
severity: low
reason: The canvas empty state inlines the literal while the left column's tree renders `TREE_NO_WIKI_COPY` (`src/lib/workbench-tree.ts:71`) — the same string, on two surfaces, at the same moment. Same class of defect as DW-33, and the new mounted suite scopes its assertion to `.wb-canvas` to work around it. Deciding which surface owns the sentence is a UX call, not a mechanical de-duplication.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-workbench-card-copy-constants
resolution-undo: 2f567eade7e497cea873a21ba1f848f3fbce09a7059096095479ba5a852e5db6 2026-09-02 7374617475733a206f70656e
decision: 2026-08-19 Canvas owns the sentence — Keep the canvas empty state as the one place that says "No wiki yet." (rendering the shared TREE_NO_WIKI_COPY constant rather than an inline literal) and let the tree render a quieter row-level placeholder, then drop the .wb-canvas scoping workaround from the mounted suite.

### DW-177: `Select a file to preview.` is still an inline literal restated in three files while every sibling sentence is an exported constant.

status: done 2026-08-19
origin: spec-deferred 1099d47dbb87
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
archived: 2026-08-29

### DW-178: Collapsing the left column now leaves no Wiki switch, create, rename or delete control reachable.

status: done 2026-08-19
origin: spec-deferred e9c63e7fce1e
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
archived: 2026-08-29

### DW-179: The only Wiki switcher's label is `wb-sr-only`, so a sighted user now meets a bare combobox.
origin: spec-deferred 7677137abba0
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
location: src/components/workbench/WikiSwitcher.tsx:262-264
severity: low
reason: The retired card control carried a VISIBLE `Active wiki` label; the survivor's is clipped (`WikiSwitcher.tsx:262-264`), justified on the 280px column width. The accessibility floor is still met — the input is labelled beyond a placeholder — but that tradeoff was made while a visible label existed elsewhere on the same viewport, and it has not been re-examined now that it does not.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-wiki-switcher-label-and-copy
resolution-undo: b8fe045daf2a1db57da8fceb9ef2bb20469460eaecb647d3212237a42b64f1b4 2026-09-02 7374617475733a206f70656e
decision: 2026-08-19 Make the label visible — Render the `Active wiki` label visibly above the switcher within the 280px column (a small-caps field label in the existing left-column type scale), drop the `wb-sr-only` class, and update the chrome tests that pin the current markup.

### DW-180: Hiding the preview note leaves the canvas grid's second track empty, so a docked Preview strands the card at 320px beside blank space.
origin: spec-deferred 08dd131042c7
source_spec: `spec-dw-33-retire-duplicate-wiki-canvas-controls.md`
location: src/components/WikiWorkbench.tsx:172 with src/app/globals.css:2696
severity: low
reason: The card's wrapper is `grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]` (`WikiWorkbench.tsx:172`). `display: none` removes the second child from layout but not the track it sat in, so at the `lg:` breakpoint with `data-preview="true"` the receipt card stays pinned at 320px and the `1fr` column renders empty — space the sentence used to fill. The intent authorized a visibility change only ("Only its visibility while a Preview is docked changes"), so the diff is spec-compliant; whether the card should reflow to the full canvas width when the Preview docks is a UX call, not a mechanical fix. Adding a `grid-template-columns` override to the DW-39 rule would be cascade-safe (`workbench-split.test.ts:1247` keys on `lastIndexOf`, and this rule sits far ahead of the docked grid variants), so the blocker is the design decision, not the mechanism.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-canvas-reflow-and-revision-cap
resolution-undo: 358fdc0eb187500bae67cda8a18d4ee078bc352b79ea908756f8f1ba3bfeb602 2026-09-02 7374617475733a206f70656e
decision: 2026-08-19 Reflow to full width — Extend the DW-39 docked-preview rule with a `grid-template-columns` override so the canvas card takes the full canvas width when a Preview is docked, verifying it sits ahead of the docked grid variants the way `workbench-split.test.ts:1247`'s `lastIndexOf` check expects.

### DW-181: The `Edit` control stays live over a body a 404 has replaced, so the confirm dialog and then a `PUT` can be reached for a page the route says is not there.

status: done 2026-08-19
origin: spec-deferred 42b15c1d03b0
source_spec: `spec-dw-34-workbench-preview-announcements.md`
archived: 2026-08-29

### DW-182: A live region rewritten with the identical string is not re-announced, so two consecutive silent refreshes that both change the body report as one.

status: done 2026-08-19
origin: spec-deferred df75dfff157b
source_spec: `spec-dw-34-workbench-preview-announcements.md`
archived: 2026-08-29

### DW-183: An unreachable refresh is the one refresh outcome that is never announced — the stale strip is a purely visual affordance.

status: done 2026-08-19
origin: spec-deferred 0fba34343eca
source_spec: `spec-dw-34-workbench-preview-announcements.md`
archived: 2026-08-29

### DW-184: Pressing `Retry` produces no in-flight feedback, so a slow retry is indistinguishable from a broken button.

status: done 2026-08-19
origin: spec-deferred 8a133c7a6465
source_spec: `spec-dw-34-workbench-preview-announcements.md`
archived: 2026-08-29

### DW-185: No CSS layout rule in this repo is verified by anything that lays out a page — every breakpoint claim is a text scan of `globals.css`.
origin: spec-deferred 8bd6d98814e7
source_spec: `spec-dw-34-workbench-preview-announcements.md`
location: vitest.config.ts (no browser project); src/lib/__tests__/workbench-left-column.test.ts (the CSS scans)
severity: low
reason: `vitest.config.ts` has exactly two projects, `node` and `dom` (jsdom), and jsdom has no layout engine; there is no Playwright config, no `e2e/` directory and no browser project anywhere. So DW-34's user-visible payoff — "a docked column below 900px is reachable" — is pinned by `workbench-left-column.test.ts` asserting that declaration strings appear inside a slice of the stylesheet. That scan cannot show the new rule wins the cascade, that the released clamp actually makes the row reachable, or that the `[data-sheet-open]` counter-rule outranks the docked selectors. The mounted suite observes only that the shell ASKS the platform to scroll. Pre-existing and repo-wide: every earlier Workbench story verified its stylesheet half the same way. Closing it means adding a browser test project, which is a project-level decision rather than a fix to this change.
status: open
decision: 2026-08-19 Add a browser project — Add a real browser test project (Playwright, or Vitest browser mode) covering the layout claims the stylesheet scans currently stand in for — the 900px docked-column reachability, the split-handle geometry, and the sheet counter-rule — and mark the corresponding scan assertions as structural rather than behavioural once a real check exists.

### DW-186: Follow-up review still recommended for dw-workbench-preview-announcements after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-34-workbench-preview-announcements.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-187: A read-only deployment still accepts page CREATION, revision revert, and bulk ingest deletion — three page-write doors that never consulted isReadOnly().

status: done 2026-08-19
origin: spec-deferred 7a425c0e8357
source_spec: `spec-dw-37-read-only-deployment-consistency.md`
archived: 2026-08-29

### DW-188: The stdio MCP server writes pages through the library directly, so no HTTP route gate can reach the agent callers DW-37's reason claims it covers.

status: done 2026-08-19
origin: spec-deferred a6adca8dbb43
source_spec: `spec-dw-37-read-only-deployment-consistency.md`
archived: 2026-08-29

### DW-189: WikiWorkbench's Change template control opens a confirm dialog onto a route that already answers 403 on a read-only deployment.

status: done 2026-08-20
origin: spec-deferred ed548e677477
source_spec: `spec-dw-37-read-only-deployment-consistency.md`
archived: 2026-08-29

### DW-190: `POST /api/ingest/reingest` rewrites an entire page body with no isReadOnly() gate, and its control sits on the same article action bar as the Delete button this bundle just gated.

status: done 2026-08-19
origin: spec-deferred 948ef5e14a2f
source_spec: `spec-dw-37-read-only-deployment-consistency.md`
archived: 2026-08-29

### DW-191: WorkspacePurposeSettings wraps its whole form in a `disabled` fieldset on a read-only deployment, so the stored purpose text becomes unreachable by keyboard — the DW-65 defect at full form scale.

status: done 2026-08-20
origin: spec-deferred af274abf11df
source_spec: `spec-dw-37-read-only-deployment-consistency.md`
archived: 2026-08-29

### DW-192: `loadConfig()` answers `{}` for an UNREADABLE config as well as an absent one, so the settings route can merge a patch into an empty object and `saveConfig` writes away every stored field.

status: done 2026-08-19
origin: spec-deferred 4b41f7d77923
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
archived: 2026-08-29

### DW-193: The artifact route reads current bytes OUTSIDE the very per-owner lock its own writer takes, so the one route that already holds a lock still leaves the concurrent-save window open.

status: done 2026-08-21
origin: spec-deferred f94acd1bd4a8
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
archived: 2026-08-29

### DW-194: Requiring `If-Match` is an undocumented wire-contract change for the service-token REST path, which `middleware.ts` still describes as an unconditional write.

status: done 2026-08-21
origin: spec-deferred 40d3b352a7ca
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
archived: 2026-08-29

### DW-195: `readWikiPage`'s in-process `pageCache` can serve the Preview a stale body and now a stale VERSION, producing a 412 against a write the reader was never shown.

status: done 2026-08-21
origin: spec-deferred e8332ca1afef
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
archived: 2026-08-29

### DW-196: The kernel page writer stays unguarded, so the ~18 non-HTTP callers of `writeWikiPageWithSideEffects` — including the ingest and agent writers DW-38 names as the reason the guard is needed — still clo

status: done 2026-08-28
origin: spec-deferred cd37d8d20782
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
archived: 2026-08-29

### DW-197: `stableSerialize` collapses every non-plain object to `{}` and has no cycle or depth bound, so `objectVersion` can report "no change" between two genuinely different values.

status: done 2026-08-19
origin: spec-deferred 2984302c303e
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
archived: 2026-08-29

### DW-198: The Settings write precondition is a hash of the STORED SECRETS, and it is served to the browser beside the comment asserting no secret material crosses that boundary.

status: done 2026-08-19
origin: spec-deferred d87cea3adf09
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
archived: 2026-08-29

### DW-199: `isWorkbenchSettingsPayload` making `version` required turns a save that LANDED into a reported failure, and one absent field into a whole-canvas load failure.

status: done 2026-08-19
origin: spec-deferred 7dbd4c8d1bf2
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
archived: 2026-08-29

### DW-200: A Schema draft held across an active-Wiki switch can still land on the OTHER Wiki's `schema.md` when both hold the identical seeded bytes.

status: done 2026-08-21
origin: spec-deferred 18037df81052
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
archived: 2026-08-29

### DW-201: Follow-up review still recommended for dw-write-preconditions-and-conflict-surface after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-38-write-preconditions-and-conflict-surface.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-202: On a case-sensitive store, `wiki/cased.md` and `wiki/cased.MD` now both list as rows for the one slug `cased`, and an edit from either row writes `<slug>.md`.

status: done 2026-08-27
origin: spec-deferred 9fb5f09a4780
source_spec: `spec-dw-41-workbench-file-listing-gate.md`
archived: 2026-08-29

### DW-203: On a case-sensitive store, `wiki/cased.md` and `wiki/cased.MD` both list as rows for the one slug `cased`, and an edit from either row writes `<slug>.md`.

status: done 2026-08-27
origin: spec-deferred 83c76aec8291
source_spec: `spec-dw-41-workbench-file-listing-gate.md`
archived: 2026-08-29

### DW-204: "A direct child of the wiki root" is now spelled three independent times, and only a test binds them together.

status: done 2026-08-27
origin: spec-deferred 0c82c718ee92
source_spec: `spec-dw-41-workbench-file-listing-gate.md`
archived: 2026-08-29

### DW-205: The widened 24px grab strip now overlays the leftmost 24px of the canvas and of the docked Preview, so a click, text selection or touch-pan that starts there hits the divider instead of the content.
origin: spec-deferred 2f67eae2f508
source_spec: `spec-dw-44-split-divider-target-and-responsiveness.md`
location: src/app/globals.css (.wb-split-handle--tree, .wb-split-handle--preview)
severity: low
reason: `.wb-split-handle` is `z-index: 2`, `cursor: col-resize`, `touch-action: none` and full height, and both modifiers now start AT their boundary and extend 24px right. `.wb-canvas-pad` and `.wb-preview-body` are both `padding: ... var(--wb-space-4)` = 16px, so the strip covers the whole gutter plus ~8px of real content in each pane: the first characters of a line, and a wikilink sitting at the left margin, are unclickable and unselectable, and on a touchscreen at 1200px+ that band cannot be panned. DW-44's ledger named "eat 12px of the canvas edge" as the known cost of widening and its decision took the trade anyway, so this is authorised rather than accidental - but the decision reasoned about scrollbars, never about what the strip would cover, and 24px offset to one side eats twice what the entry quantified. Choosing between a narrower strip that misses SC 2.5.8, matching left padding on both panes, and a documented exception is the same chrome decision DW-44 was, one boundary further
status: done 2026-09-02
resolution: resolved by sweep bundle dw-split-handle-hit-and-focus
resolution-undo: 7891c9e2fdcd52e0c8b34591cc14412aced7486278c43dc6ba5fc7402c95b914 2026-09-02 7374617475733a206f70656e
decision: 2026-08-19 Widen the content padding to match — Raise .wb-canvas-pad and .wb-preview-body left padding to at least the hit-strip width so the strip covers only gutter, never text, keeping the 24px target that satisfies SC 2.5.8; pin the relationship between the padding and --wb-split-hit so they cannot drift.

### DW-206: One stored tree scroll offset per tab is shared across the 900px breakpoint, where `.wb-tree-body` is capped at 40vh - so crossing into the narrow layout restores a desktop offset the browser clamps,

status: done 2026-08-28
origin: spec-deferred d620d0a1c5f8
source_spec: `spec-dw-44-split-divider-target-and-responsiveness.md`
archived: 2026-08-29

### DW-207: A divider's hover and focus-visible states paint an identical 1px `var(--wb-border)` line, so keyboard focus is visually indistinguishable from hover, and a border-token hairline is unlikely to clear
origin: spec-deferred 7afb956d7e51
source_spec: `spec-dw-44-split-divider-target-and-responsiveness.md`
location: src/app/globals.css (.wb-split-handle:hover::before, .wb-split-handle:focus-visible::before)
severity: low
reason: `globals.css` declares one rule for both states: `.wb-split-handle:hover::before, .wb-split-handle:focus-visible::before { background: var(--wb-border); }`. Two separate problems sit on it. First, SC 1.4.11 wants a focus indicator at 3:1 against adjacent colours, and `--wb-border` is chosen to be a quiet separator colour against exactly the panel surfaces it now has to stand out from - the last pass's `--wb-split-hit--preview::before { left: 1px }` patch made the indicator VISIBLE (WCAG 2.4.7) without touching whether it is visible ENOUGH. Second, the two states are pixel-identical, so a keyboard user cannot tell focus from a stray pointer, and DW-44's widening enlarges the hover region that produces the focus appearance from 9px to 24px. This is pre-existing from Story 1.6 in kind - neither the colour nor the shared rule changed here - but the widened strip is what makes the ambiguity routine. Fixing it means choosing an indicator token (an outline, a second colour, a wider rule) agai
status: done 2026-09-02
resolution: resolved by sweep bundle dw-split-handle-hit-and-focus
resolution-undo: 7891c9e2fdcd52e0c8b34591cc14412aced7486278c43dc6ba5fc7402c95b914 2026-09-02 7374617475733a206f70656e

### DW-208: TreePanel's persist effect cancels a pending requestAnimationFrame write in its cleanup without flushing it, so a scroll in the last frame before a tab switch, a collapse, or now a breakpoint crossing

status: done 2026-08-28
origin: spec-deferred 246ae7a17f3f
source_spec: `spec-dw-44-split-divider-target-and-responsiveness.md`
archived: 2026-08-29

### DW-209: `renameWiki` rewrites `purpose.md` under the tenant lock without moving `dataVersion`, so a Preview open on that artifact keeps the old heading.

status: done 2026-08-21
origin: spec-deferred 4e2733a570b3
source_spec: `spec-dw-49-artifact-seed-data-version-bump.md`
archived: 2026-08-29

### DW-210: A re-apply whose `restoreSeededFiles` compensation itself fails leaves changed bytes on disk with no `dataVersion` bump at all.

status: done 2026-08-27
origin: spec-deferred 6526deb5b008
source_spec: `spec-dw-49-artifact-seed-data-version-bump.md`
archived: 2026-08-29

### DW-211: DW-49's raw-source half is untouched — no writer under `tenants/<t>/raw/` exists yet, so it needs re-checking when Epic 2 Ingest lands one.

status: done 2026-08-26
origin: spec-deferred 376f1759e471
source_spec: `spec-dw-49-artifact-seed-data-version-bump.md`
archived: 2026-08-29

### DW-212: `dataVersion` is one global key with no tenant segment, so the two new bumps force a `router.refresh()` in every open Workbench of every other tenant too.

status: done 2026-08-20
origin: spec-deferred 1e08fbc6dc92
source_spec: `spec-dw-49-artifact-seed-data-version-bump.md`
archived: 2026-08-29

### DW-213: A successful re-template overwrites an owner-edited `schema.md` with template bytes and takes no revision snapshot, so DW-59's recovery path does not cover the other operation that destroys the same f

status: done 2026-08-21
origin: spec-deferred 0847f138003a
source_spec: `spec-dw-59-per-wiki-artifact-revisions.md`
archived: 2026-08-29

### DW-214: The artifact history API has no client — no Workbench surface lists or reverts artifact revisions, so the recovery path is unreachable from the running app.

status: done 2026-08-21
origin: spec-deferred d5925f928e90
source_spec: `spec-dw-59-per-wiki-artifact-revisions.md`
archived: 2026-08-29

### DW-215: Artifact revisions accumulate with no cap or pruning and are walked by the backup scan, which throws rather than degrades at its safety limits.

status: done 2026-08-28
resolution: resolved by sweep bundle dw-artifact-revision-retention
resolution-undo: 84bfd98071839dd86be731ef630afcbc9934935a3bfa9f85476f39a9417a8835 2026-08-28 7374617475733a206f70656e
origin: spec-deferred 5d7e90742d9d
source_spec: `spec-dw-59-per-wiki-artifact-revisions.md`
archived: 2026-08-29

### DW-216: Follow-up review still recommended for dw2-per-wiki-artifact-revisions after the damping cap was spent
origin: review-budget-followup
source_spec: `spec-dw-59-per-wiki-artifact-revisions.md`
location: n/a
severity: low
reason: The follow-up-review damping cap (limits.max_followup_reviews = 0) was spent with the story finalized (status: done, verify green) while the review pass still recommended an independent follow-up. The work was committed by bmad-loop run 20260817-125533-fe6b; this entry preserves the lingering recommendation for a deliberate later review.
status: open

### DW-217: The legacy flat `PUT /api/settings` branch writes `embeddingModel` without running the vector gate, so a flat-only save can now silently switch effective vector search off.

status: done 2026-08-20
origin: spec-deferred be65cc16b535
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
archived: 2026-08-29

### DW-218: An `EMBEDDING_MODEL` env override in the wrong namespace refuses vector search with a sentence the owner cannot act on from the Settings box.

status: done 2026-08-19
origin: spec-deferred 9cfdb86b9ca5
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
archived: 2026-08-29

### DW-219: A deployment already storing a namespace mismatch with vector search on now gets a 400 on EVERY Workbench settings save, including edits to unrelated fields.

status: done 2026-08-19
origin: spec-deferred 1eee0ecfc70f
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
archived: 2026-08-29

### DW-220: The gate checks the namespace but not that the id is a usable Workers AI EMBEDDING model, so a bare `@cf/` or a vision id passes.

status: done 2026-08-19
origin: spec-deferred 90d558e058af
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
archived: 2026-08-29

### DW-221: The gate reads a trimmed model while `resolveEmbeddingModelName` reads the raw stored string, so a stored id with leading whitespace passes the gate and is still dropped at resolution.

status: done 2026-08-19
origin: spec-deferred a3c81a10def4
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
archived: 2026-08-29

### DW-222: The refusal calls the provider "Workers AI" while the picker two rows above calls the same selection "Cloudflare Workers AI".

status: done 2026-08-20
origin: spec-deferred 1b9ba6bd81b9
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
archived: 2026-08-29

### DW-223: The namespace complaint is announced on the vector checkbox, not on the embedding-model field that actually holds the wrong value.

status: done 2026-08-19
origin: spec-deferred abe456693455
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
archived: 2026-08-29

### DW-224: The path that actually embeds is untaught about the namespace rule, so the owner's model choice is still replaced without a word wherever the gate is not consulted.

status: done 2026-08-19
origin: spec-deferred 29b372e0cc6c
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
archived: 2026-08-29

### DW-225: The vector gate has no Cloudflare-binding leg, so `workers-ai` with a matching `@cf/` id passes on a deployment where nothing can ever embed.

status: done 2026-08-19
origin: spec-deferred cd8a690ae5d7
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
archived: 2026-08-29

### DW-226: `resolveEmbeddingModelName` drops a mismatched override with no log, while its sibling misconfiguration warns.

status: done 2026-08-19
origin: spec-deferred 75c0edb48a0f
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
archived: 2026-08-29

### DW-227: A whitespace-only `EMBEDDING_MODEL` is handed to the provider verbatim as the embedding model name, while the vector gate reads the same value as absent.

status: done 2026-08-19
origin: spec-deferred bebc4469f137
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
archived: 2026-08-29

### DW-228: The new mounted settings test duplicates about sixty lines of an existing workbench test's harness verbatim.

status: done 2026-08-27
origin: spec-deferred 29c84000c317
source_spec: `spec-dw-73-workers-ai-embedding-namespace.md`
archived: 2026-08-29

### DW-229: LintIssueCard's hand-copied `fixableTypes` set omits `supersedes-dangling`, so one of the ten auto-fixable lint checks renders with no Fix button.

status: done 2026-08-20
origin: spec-deferred f19a42b24e75
source_spec: `spec-dw-75-76-lint-check-parity-and-disputed-surface.md`
archived: 2026-08-29

### DW-230: Disputed transitions still write talk reconciliation threads that no surface can read, since talk's HTTP routes are retired.

status: done 2026-08-21
origin: spec-deferred 7895126181f4
source_spec: `spec-dw-75-76-lint-check-parity-and-disputed-surface.md`
archived: 2026-08-29

### DW-231: The edit route answers a dead slug with a rendered "Page not found — nothing to edit" body at HTTP 200, the same defect DW-85 fixed on the page view, and this story's tests now pin that 200 in place.

status: done 2026-08-28
origin: spec-deferred 08fb49a7fb70
source_spec: `spec-dw-83-89-owner-scoped-link-and-notfound-hardening.md`
archived: 2026-08-29

### DW-232: tenantForSlug still resolves a slug through inherited-prototype indexing, the exact defect DW-89 fixed in resolveSlugPath, one file over.
origin: spec-deferred 2a3579814c9e
source_spec: `spec-dw-83-89-owner-scoped-link-and-notfound-hardening.md`
location: src/lib/wiki.ts:126
severity: low
reason: src/lib/wiki.ts:130 does `pageIdx[slug]` and :136 does `map[slug] ?? tenantForOwner(undefined)`, both over plain object literals — so a page titled "Constructor" would short-circuit the fast path on Object.prototype.constructor, or return that function as a tenant. Currently inert: the function's only callers are in tenant-paths.test.ts, no production path. The structural fix is to build these maps with a null prototype at their construction sites (buildSlugTenantMap, /api/wiki/routes, the log page's literal) rather than guarding each lookup. Byte-identical to the pre-story idiom; this story hardened only the link path.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-inherited-prototype-indexing
resolution-undo: e1b250c9774399a4fd7170de3d0862fe2b5f07daf4488461685aefe4992c8165 2026-09-02 7374617475733a206f70656e

### DW-233: The machine surfaces GET /api/wiki/[slug] and /api/raw/[slug] still hard-404 a merged-away slug, so agents and MCP clients now get a different answer than the UI for the same bookmark.
origin: spec-deferred f09cb6af046e
source_spec: `spec-dw-83-89-owner-scoped-link-and-notfound-hardening.md`
location: src/app/api/wiki/[slug]/route.ts
severity: low
reason: This story wired aliasTargetForMissing into all three /u/ routes, so the page, edit and raw views forward. The JSON routes were never in scope — the intent names only the edit and raw owner-scoped routes — and were already hard-404 before it. The asymmetry is new even though neither side changed: forwarding the HTML surfaces is what made the API's behavior a divergence rather than the uniform rule. Either forward there too, or return the canonical slug in the 404 envelope so a client can follow it.
status: open
decision: 2026-08-28 Canonical slug in the 404 — Keep the 404 status and add the canonical slug to the error envelope on both routes, so a client can follow deliberately; document the field in SCHEMA.md.
decision: 2026-08-26 Canonical slug in the 404 — Keep the 404 status and add the canonical slug to the error envelope on both routes, so a client can follow deliberately; document the field in SCHEMA.md.

### DW-234: A component mounted while /api/wiki/routes was failing keeps DEFAULT_TENANT hrefs for its whole lifetime, because useSlugTenants has no refresh path after its mount effect.
origin: spec-deferred 9d5e0be11183
source_spec: `spec-dw-83-89-owner-scoped-link-and-notfound-hardening.md`
location: src/hooks/useSlugTenants.ts:56
severity: low
reason: src/hooks/useSlugTenants.ts's effect has an empty dependency array, so it loads once per mount. DW-87's fix makes the SESSION recover — the next cold caller re-fetches and caches a good map — but a component already mounted during the outage never re-reads it. Links still work through the 308 fallback, so the consequence is a stale wrong-handle hop on one component until it remounts, not breakage. The empty-dep mount effect pre-dates this story; DW-87 only changed what the cache holds.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-slug-tenant-map-lifecycle
resolution-undo: 4e90e1d24f934455fa9aa9826734cb64350c2896842017832859f3bd9cc22315 2026-09-02 7374617475733a206f70656e

### DW-235: scripts/setup-cloudflare.sh:113 prints the stale display brand "yopedia — Cloudflare Infrastructure Setup" to the operator's terminal.

status: done 2026-08-20
origin: spec-deferred 0ccea9511710
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
archived: 2026-08-29

### DW-236: DW-92's fix has no regression guard — "Yopedia" display prose can return to any maintainer surface with CI green.

status: done 2026-08-20
origin: spec-deferred 28803e5d8656
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
archived: 2026-08-29

### DW-237: workers/email-ingest/README.md still says "Yopedia", so the two Worker READMEs in workers/ now disagree on the product name.

status: done 2026-08-20
origin: spec-deferred bd43323d6e3a
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
archived: 2026-08-29

### DW-238: The stronger stray-workwiki rule guards only maintainer docs; the shipped app tree still uses the case-sensitive literal check.

status: done 2026-08-20
origin: spec-deferred f5f2a244a9e7
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
archived: 2026-08-29

### DW-239: This spec's stated reason for keeping the four new roots out of scannedSources() is wrong for three of them.

status: done 2026-08-20
origin: spec-deferred ff31b1fa5979
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
archived: 2026-08-29

### DW-240: skills/work-wiki-mcp/SKILL.md is hand-authored, brand-named, and read by no scan.

status: done 2026-08-20
origin: spec-deferred 970d96b7a1a8
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
archived: 2026-08-29

### DW-241: AGENTS.md's frozen list still omits four live WORKWIKI_* family members.

status: done 2026-08-20
origin: spec-deferred 4cafc2bd11e4
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
archived: 2026-08-29

### DW-242: The DW-93 freeze fact lives inside a managed block whose own header says inside-block edits are replaced on refresh.

status: done 2026-08-20
origin: spec-deferred bc5d931b1066
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
archived: 2026-08-29

### DW-243: wrangler.jsonc files and root non-markdown are unscanned though AGENTS.md freezes their resource names.

status: done 2026-08-20
origin: spec-deferred 49b6ba9ef745
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
archived: 2026-08-29

### DW-244: Three overlapping extension filters with no shared definition; each omits types the others cover.

status: done 2026-08-20
origin: spec-deferred cdc2c1304d4b
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
archived: 2026-08-29

### DW-245: tools/work-wiki-sync.md is reachable from nothing but the test's pin list.

status: done 2026-08-20
origin: spec-deferred 18ccb7a475e4
source_spec: `spec-dw-91-96-brand-scan-coverage-and-residue.md`
archived: 2026-08-29

### DW-246: A third hand-copy of the document allowlist lives in `src/lib/bulk-document-import.ts` and still rejects seven formats the app extractor accepts.

status: done 2026-08-20
origin: spec-deferred 2da88f7dbb6c
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
archived: 2026-08-29

### DW-247: The acknowledgement tells a sender that a cap-truncated *supported* attachment was "unsupported", and understates the skipped count past 20 attachments.

status: done 2026-08-20
origin: spec-deferred 21bb2bd1fe8b
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
archived: 2026-08-29

### DW-248: Three more forced cross-module duplicate constants in the Worker remain unpinned after this run pinned only the 10-attachment cap.

status: done 2026-08-20
origin: spec-deferred 5210d48fc471
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
archived: 2026-08-29

### DW-249: Four hand-written prose lists of supported formats exist and no test asserts any of them against the allowlist they describe.

status: done 2026-08-20
origin: spec-deferred 1bb1a8484942
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
archived: 2026-08-29

### DW-250: The route's own `MAX_EMAIL_DOCUMENTS` rejection branch is never exercised.

status: done 2026-08-20
origin: spec-deferred 7fe00efe551e
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
archived: 2026-08-29

### DW-251: The Worker's `|| "application/octet-stream"` MIME fallback cannot be observed at the Request boundary, so the assertion pinning it is not discriminating.

status: done 2026-08-20
origin: spec-deferred b0bbefc71f31
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
archived: 2026-08-29

### DW-252: The forwarded request's `Authorization` header and target URL are asserted nowhere, in a Worker suite that otherwise reads the body closely.

status: done 2026-08-20
origin: spec-deferred 309fb683efb4
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
archived: 2026-08-29

### DW-253: Two attachment-related behaviours have neither a test nor deliberate handling.

status: done 2026-08-27
origin: spec-deferred fc3cbd828749
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
archived: 2026-08-29

### DW-254: The prototype-chain fix applied to `mediaTypeFor` during review is unpinned by any test.

status: done 2026-08-20
origin: spec-deferred 7ef023996ec5
source_spec: `spec-dw-98-103-email-ingest-attachment-coverage.md`
archived: 2026-08-29

### DW-255: `ConfirmDialog`'s `busy` gate is pinned at one consumer only — `WikiSwitcher`'s Rename and Delete confirms reach the same gate with nothing asserting it.

status: done 2026-08-19
origin: spec-deferred 304df609e829
source_spec: `spec-dw-105-109-dom-tests-dialogs-and-rail.md`
archived: 2026-08-29

### DW-256: Only `create()`'s `!wiki?.id` malformed-2xx guard is tested; the identical guards in `applyTemplate`, `rename` and `remove` are not.

status: done 2026-08-19
origin: spec-deferred 63ffcaa5467c
source_spec: `spec-dw-105-109-dom-tests-dialogs-and-rail.md`
archived: 2026-08-29

### DW-257: `IconRail`'s "exactly one `aria-current` control" rule and its mode-select callbacks have no mounted pin.
origin: spec-deferred 336890cf909d
source_spec: `spec-dw-105-109-dom-tests-dialogs-and-rail.md`
location: src/components/workbench/IconRail.tsx:101
severity: low
reason: `icon-rail.test.tsx` mounts the rail with `settingsActive: false` throughout and passes inert stubs for `onSelect`/`onToggleSettings`, so a rail that marked both a mode and Settings current (the case the component's own comment forbids: "two current controls would describe two surfaces the owner cannot both be looking at"), or wired every mode button to the same id, passes. Rail ORDER is likewise unasserted, though UX-DR3 fixes the ten modes top to bottom.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-mounted-rail-tree-split-coverage
resolution-undo: 799de0dacb06db7787a2e0686669e6e5f90cd096c1a99f801dff5da0a487db3b 2026-09-02 7374617475733a206f70656e

### DW-258: `Workbench`'s `aria-live="polite"` mode announcement — the OTHER live region — is still pinned only by source scan.

status: done 2026-08-19
origin: spec-deferred 39bb6b0f1e10
source_spec: `spec-dw-105-109-dom-tests-dialogs-and-rail.md`
archived: 2026-08-29

### DW-259: Three of the six converted client components -- RecentIngests, ActionInbox and BulkDocumentImport -- still have no rendered-anchor coverage, so reverting any of their hrefForSlug call sites to slugPat

status: done 2026-08-29
resolution: resolved by sweep bundle dw-component-anchor-and-flake-coverage
resolution-undo: 261fa7215a7e4dd35377c63e571ad76627ca6311fcd9a185accfc2e771e3504d 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 8332b2aa4a3f
source_spec: `spec-dw-86-110-118-dom-tests-polling-and-shell.md`
archived: 2026-08-29

### DW-260: NavHeader conveys the active route only through inline fontWeight, with no aria-current, so the current page is announced to assistive tech not at all.

status: done 2026-08-28
origin: spec-deferred 22cbe3585ae4
source_spec: `spec-dw-86-110-118-dom-tests-polling-and-shell.md`
archived: 2026-08-29

### DW-261: layout.tsx's metadata export and its inline theme script are still guarded only by source scans, even though the file now has a mounted suite.
origin: spec-deferred 8326245b9bba
source_spec: `spec-dw-86-110-118-dom-tests-polling-and-shell.md`
location: src/app/layout.tsx:58
severity: low
reason: `src/app/layout.tsx:37-56` (title template, metadataBase, OG/Twitter) and the `themeScript` at :58-70 (which applies the `light`/`dark` class before paint) live only in this file. `app-shell.test.tsx` mounts the layout but asserts neither; the metadata half is pure data and needs no mount at all. Deleting the theme script leaves the whole suite green.
status: open

### DW-262: loadSlugTenants has no exported reset, so no mounted suite can express "map still loading" or "/api/wiki/routes failed" -- the DEFAULT_TENANT fallback every converted component is built to survive is
origin: spec-deferred 91b84f773caf
source_spec: `spec-dw-86-110-118-dom-tests-polling-and-shell.md`
location: src/hooks/useSlugTenants.ts
severity: low
reason: The map is cached in a module-level singleton in `src/hooks/useSlugTenants.ts`, warmed once per file by `await loadSlugTenants()` in `beforeEach`. Once warmed it cannot be un-warmed, so `owner-scoped-anchors.test.tsx` can only ever assert the resolved-map branch. `renderer-slug-tenant-adoption.test.tsx` covers the unknown-slug fallback via a slug absent from the map, but the degraded-map path (session fetch failed) has no component witness.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-slug-tenant-map-lifecycle
resolution-undo: 4e90e1d24f934455fa9aa9826734cb64350c2896842017832859f3bd9cc22315 2026-09-02 7374617475733a206f70656e

### DW-263: ChatWorkspace's save-failure and slug-less-response banner paths are untested; only the happy path and the url-absent fallback are pinned.
origin: spec-deferred 3149502ae75b
source_spec: `spec-dw-86-110-118-dom-tests-polling-and-shell.md`
location: src/components/ChatWorkspace.tsx:232
severity: low
reason: `saveAnswer` (src/components/ChatWorkspace.tsx:219-238) keeps the banner hidden when the response carries no slug and surfaces an error alert when the request fails. The new suite always answers `/api/query/save` with an ok body carrying a slug, so a regression rendering "Saved as undefined" -- the exact state the comment at :232 says the guard exists to avoid -- would pass.
status: open

### DW-264: `/wiki/new` still lets the owner compose an entire page before `POST /api/wiki` refuses it, now that the route answers 403.

status: done 2026-08-21
origin: spec-deferred ee147ee7465e
source_spec: `spec-dw-187-188-190-read-only-write-doors.md`
archived: 2026-08-29

### DW-265: The `/ingest` page's bulk-delete control confirms an irreversible delete in front of a `DELETE /api/ingest/history` that now answers 403.

status: done 2026-08-21
origin: spec-deferred 2f18f66dd0d3
source_spec: `spec-dw-187-188-190-read-only-write-doors.md`
archived: 2026-08-29

### DW-266: `putWikiArtifact` writes `schema.md` and `purpose.md` without the gate `writeWikiArtifact` now carries, so wiki seeding still writes.

status: done 2026-08-20
origin: spec-deferred 41aab9652a70
source_spec: `spec-dw-187-188-190-read-only-write-doors.md`
archived: 2026-08-29

### DW-267: `POST /api/tasks/run` answering 403 changes Cloudflare Queue semantics from retry-then-DLQ to ack-and-drop, and the trade-off deserves a human call.

status: done 2026-08-20
origin: spec-deferred d73cd0e4de4b
source_spec: `spec-dw-187-188-190-read-only-write-doors.md`
archived: 2026-08-29

### DW-268: `YOPEDIA_READONLY` has no operator-facing documentation, and this change materially redefines what it refuses.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-read-only-operator-docs
resolution-undo: 3b09c8630704cd1ee6b9a953f6709b99d99347084c194b69f40f07e555f82e49 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 726f9f7ae0c5
source_spec: `spec-dw-187-188-190-read-only-write-doors.md`
archived: 2026-08-31

### DW-269: The Re-ingest and Revert client affordances are still offered where the same commons-realm gate refuses them — the exact shape DW-120 fixed for Delete.

status: done 2026-08-21
origin: spec-deferred 58361bfa045c
source_spec: `spec-dw-120-122-123-authz-realm-parity-and-copy.md`
archived: 2026-08-29

### DW-270: The `jobIds` path of `DELETE /api/ingest/history` reaches the delete ACL holding a page the caller was never read-gated on.

status: done 2026-08-21
origin: spec-deferred b1232cb9f27f
source_spec: `spec-dw-120-122-123-authz-realm-parity-and-copy.md`
archived: 2026-08-29

### DW-271: `src/lib/commons.ts` imports two client-safe predicates through `./wiki`, so every route test that mocks `@/lib/wiki` must stub them or get a 500 where it means 403.
origin: spec-deferred 431f1d62b7a4
source_spec: `spec-dw-120-122-123-authz-realm-parity-and-copy.md`
location: src/lib/commons.ts:17
severity: low
reason: `commons.ts` imports `isAgentScopedType`/`isArtifactType` from `./wiki`, which merely re-exports them from the client-safe `./page-types`. Because `belongsInCommons` is now on the 403 path, two suites (`ingest-history-delete-route.test.ts`, `ingest-routes.test.ts`) had to widen their `vi.mock("@/lib/wiki")` factories to keep the predicate from calling `undefined`. Importing from `./page-types` directly would remove the trap for every future route suite at no behavioural cost. The import is pre-existing and unchanged by this pass.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-module-graph-fragility
resolution-undo: 3b6de595a5695a7cd945cc07198a564a1a29c8e59dbd7d8d94fb6846c2032adb 2026-09-02 7374617475733a206f70656e

### DW-272: The two-file token scheme has no coverage on the Cloudflare R2 backend, where the read-your-writes guarantee the design leans on does not hold across two separate objects.

status: done 2026-08-20
origin: spec-deferred 8497b4ae1815
source_spec: `spec-dw-192-197-198-199-settings-write-precondition.md`
archived: 2026-08-29

### DW-273: Both embedding-resolution warnings fire per resolution rather than once per distinct misconfiguration, so a rebuild or a large ingest emits the same sentence hundreds of times.

status: done 2026-08-20
origin: spec-deferred 7167de6cd16e
source_spec: `spec-dw-220-221-224-226-227-embedding-resolution.md`
archived: 2026-08-29

### DW-274: `getEffectiveSettings` reports a provider-mismatched embedding model as the effective one, so the Settings surface names a model nothing embeds with.

status: done 2026-08-20
origin: spec-deferred 9bd380a9167d
source_spec: `spec-dw-220-221-224-226-227-embedding-resolution.md`
archived: 2026-08-29

### DW-275: The legacy flat `PUT /api/settings` branch still stores `model` and `ollamaBaseUrl` untrimmed, the same gate/resolver split just closed for `embeddingModel`.

status: done 2026-08-20
origin: spec-deferred 1873c25f4f7d
source_spec: `spec-dw-220-221-224-226-227-embedding-resolution.md`
archived: 2026-08-29

### DW-276: A mismatched deployment still EMBEDS under the substituted default; this bundle ended the silence, not the substitution.

status: done 2026-08-26
origin: spec-deferred 5155e62ce7df
source_spec: `spec-dw-220-221-224-226-227-embedding-resolution.md`
archived: 2026-08-29

### DW-277: The new Cloudflare-binding refusal is announced only on the vector checkbox; the embedding-provider select that produces the state carries no complaint and no `aria-invalid`.

status: done 2026-08-20
origin: spec-deferred c1aba6d1ed22
source_spec: `spec-dw-218-219-223-225-vector-gate-surface.md`
archived: 2026-08-29

### DW-278: Every settings read and save now calls `getWorkersAiBinding()`, so a Workers deployment with `AI` unbound emits one WARN per settings request on a path that previously logged nothing.

status: done 2026-08-20
origin: spec-deferred cdd17a74d9ff
source_spec: `spec-dw-218-219-223-225-vector-gate-surface.md`
archived: 2026-08-29

### DW-279: There is no copy for the "stored on, effectively off" state the DW-219 scoping makes durable — the checkbox renders checked and unrefused beside a sentence saying vector search cannot be turned on.

status: done 2026-08-20
origin: spec-deferred d35e879954cf
source_spec: `spec-dw-218-219-223-225-vector-gate-surface.md`
archived: 2026-08-29

### DW-280: `textRow` never appends the read-only sentence through `describedBy()`, unlike every other refusable control on the surface.

status: done 2026-08-20
origin: spec-deferred eedddaf19e0d
source_spec: `spec-dw-218-219-223-225-vector-gate-surface.md`
archived: 2026-08-29

### DW-281: With `EMBEDDING_PROVIDER=workers-ai` the binding refusal advises choosing another embedding provider, which the env-locked select cannot do.

status: done 2026-08-20
origin: spec-deferred d621d1cdd313
source_spec: `spec-dw-218-219-223-225-vector-gate-surface.md`
archived: 2026-08-29

### DW-282: The Wiki canvas card reads `WorkbenchData` but ignores its `readOnly` flag, so on a read-only deployment `Create Wiki` and `Change template` still open and only meet a 403 after the destructive confir

status: done 2026-08-20
origin: spec-deferred bdeb7e2db60a
source_spec: `spec-dw-148-174-175-177-255-256-workbench-client-hardening.md`
archived: 2026-08-29

### DW-283: A write that aborts on the 15s deadline is reported as a flat failure even though the server may have applied it, and no refresh reconciles the screen.

status: done 2026-08-21
origin: spec-deferred 589216deb264
source_spec: `spec-dw-148-174-175-177-255-256-workbench-client-hardening.md`
archived: 2026-08-29

### DW-284: The Rename and Change-template confirms never name the wiki they act on, which is the same premise DW-148 fixed for the pickers.
origin: spec-deferred 18943a232416
source_spec: `spec-dw-148-174-175-177-255-256-workbench-client-hardening.md`
location: src/components/workbench/WikiSwitcher.tsx (Rename body) and WikiWorkbench.tsx (template body)
severity: low
reason: DW-148's premise is that a bare name does not identify a wiki. The Delete confirm leans entirely on its `<select>`, and the Rename and Change-template bodies say "this wiki" with no target named at all — so the two confirms that rewrite or rename an artifact set identify their target less precisely than the picker that chooses it.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-wiki-switcher-label-and-copy
resolution-undo: b8fe045daf2a1db57da8fceb9ef2bb20469460eaecb647d3212237a42b64f1b4 2026-09-02 7374617475733a206f70656e

### DW-285: `No wiki yet.` and `Your wikis couldn't be loaded. Reload to try again.` are still inline literals in the card while every other sentence it shows is an exported constant.
origin: spec-deferred f852398160ce
source_spec: `spec-dw-148-174-175-177-255-256-workbench-client-hardening.md`
location: src/components/WikiWorkbench.tsx:151,146
severity: low
reason: DW-177 named only the preview sentence, and extracting it leaves the card the one component that both imports a copy constant and restates two sentences of its own. `TREE_NO_WIKI_COPY` and `TREE_UNAVAILABLE_COPY` already exist in `workbench-tree.ts` for the left column's versions of the same two states, so the card is a second definition of both wordings.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-workbench-card-copy-constants
resolution-undo: 2f567eade7e497cea873a21ba1f848f3fbce09a7059096095479ba5a852e5db6 2026-09-02 7374617475733a206f70656e

### DW-286: A network-level `fetch` rejection reaches the owner verbatim as "Failed to fetch", the same class of defect `failureMessage`'s abort branch exists to prevent.

status: done 2026-08-26
origin: spec-deferred 7b64629d64ad
source_spec: `spec-dw-148-174-175-177-255-256-workbench-client-hardening.md`
archived: 2026-08-29

### DW-287: Nothing in either vitest project can verify that the live-region repeat mark is actually re-announced by assistive technology.
origin: spec-deferred 0a52fb9a4a49
source_spec: `spec-dw-181-184-preview-refresh-affordances.md`
location: src/lib/live-region.ts and src/components/workbench/__tests__/preview-announcements.test.tsx
severity: low
reason: DW-182's fix is an alternating U+200B appended to a repeated sentence. The node and jsdom suites prove only that the region's string CHANGED — which was never in doubt. Whether NVDA, JAWS or VoiceOver re-utters on that change, and whether any of them normalises the mark away before diffing, is asserted in prose only. The DW-182 ledger entry predicted this ("no test in a node or jsdom project can verify"), and the repo already records the equivalent gap for CSS. Without a browser/AT project the suite reads as if the mechanism is proven.
status: open
decision: 2026-08-28 Document a manual AT check — Record a short manual verification procedure (which AT, which surface, what to hear) beside live-region.ts and in the test-strategy docs, and close the gap as knowingly manual.
decision: 2026-08-26 Document a manual AT check — Record a short manual verification procedure (which AT, which surface, what to hear) beside live-region.ts and in the test-strategy docs, and close the gap as knowingly manual.

### DW-288: The scheduled sweep reclaims only the configured owner's tenant, so DW-147's condition still holds unchanged for every other tenant.

status: done 2026-08-27
origin: spec-deferred 13ff1f1e878f
source_spec: `spec-dw-147-150-162-orphan-wiki-sweep-hardening.md`
archived: 2026-08-29

### DW-289: The sweep has no per-pass cap, so one cron request can walk, stat and delete an unbounded number of candidates while holding the tenant lock.

status: done 2026-08-21
origin: spec-deferred a53600c92e2a
source_spec: `spec-dw-147-150-162-orphan-wiki-sweep-hardening.md`
archived: 2026-08-29

### DW-290: A future-dated mtime (clock skew, or a restored archive) makes an orphan permanently unsweepable, with no signal that it is leaking.

status: done 2026-08-27
origin: spec-deferred a38f8ad0290b
source_spec: `spec-dw-147-150-162-orphan-wiki-sweep-hardening.md`
archived: 2026-08-29

### DW-291: A `.discarded` tombstone is never cleared, so it can outlive the condition it records.

status: done 2026-08-27
origin: spec-deferred 83a44a70622c
source_spec: `spec-dw-147-150-162-orphan-wiki-sweep-hardening.md`
archived: 2026-08-29

### DW-292: A tmp file stranded by process death is hidden from every listing surface and nothing ever reclaims it.
origin: spec-deferred 470152434e7b
source_spec: `spec-dw-161-164-storage-write-integrity.md`
location: src/lib/storage/filesystem.ts
severity: low
reason: `atomicWrite`'s cleanup only covers a REJECTED write inside a live process. A SIGKILL between `fs.open(tmp)` and `fs.rename` leaves a `.tmp-<uuid>.tmp` on disk, and the new `listFiles` filter now hides it from all ~20 listing call sites, from `sweepOrphans` (which only considers directories matching `WIKI_ID_RE`) and from backups. Nothing sweeps them, so they accumulate silently. Closing it means a reaper — its own story, the way DW-162 was for the orphan-directory sweep.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-filesystem-publication-mechanics
resolution-undo: 3a20726c29e49a4647a7fdb4db75d437b0ae720271919e0b709895b24a73ac04 2026-09-01 7374617475733a206f70656e

### DW-293: Every whole-file write now costs a real fsync, and nothing bounds that on the production paths that write in a loop.
origin: spec-deferred 76acb44f9ed6
source_spec: `spec-dw-161-164-storage-write-integrity.md`
location: src/lib/storage/filesystem.ts
severity: medium
reason: Measured under the full parallel suite: contributors 27ms -> 5091ms, lint 35ms -> 4854ms, query-history 102ms -> 24204ms. The same per-write cost is paid by `portable-archive.ts` on import (one write per archive entry), `backups.ts` on restore (one per asset), `embeddings.ts` on rebuild (each `upsertEmbedding` rewrites AND fsyncs the whole `.indexes/embeddings.json`) and by ingest. The cost is the durability guarantee working as specified, not a defect — but no benchmark, batching, or bound exists for those paths.
status: done 2026-09-02
resolution: already resolved: src/lib/storage/filesystem.ts:985 withBatchedWrites with the per-directory barrier at :309-326; the loop paths are converted at src/lib/backups.ts:270,:445 and src/lib/portable-archive.ts:326, and the bounds are pinned by src/lib/__tests__/write-batching-bounds.test.ts.
decision: 2026-08-20 Batch the loop paths — Keep fsync as the default for single writes, and give the loop paths a batched form: a bulk-write door that fsyncs once per batch (or a directory sync at the end) for portable-archive import, backup restore and ingest, plus an accumulate-then-flush shape for `upsertEmbedding` so an embeddings rebuild stops rewriting and syncing the whole index per vector. Add a benchmark that fails if any of those paths regresses past a recorded bound.

### DW-294: `POST /api/research` has no `isReadOnly()` gate, unlike ~20 sibling write routes.

status: done 2026-08-21
origin: spec-deferred a0e0feee7f8f
source_spec: `spec-dw-161-164-storage-write-integrity.md`
archived: 2026-08-29

### DW-295: `POST /api/research` answers 500 for a malformed or non-object JSON body.

status: done 2026-08-26
origin: spec-deferred eb0c1ee445f5
source_spec: `spec-dw-161-164-storage-write-integrity.md`
archived: 2026-08-29

### DW-296: The `/required|invalid/i` message regex still routes genuine server faults to 400.

status: done 2026-08-27
origin: spec-deferred 912df682cec9
source_spec: `spec-dw-161-164-storage-write-integrity.md`
archived: 2026-08-29

### DW-297: `readProjects` degrades a non-array registry JSON to an empty list, so a corrupt registry passes the new cap check and is then overwritten.

status: done 2026-08-27
origin: spec-deferred 92cc58b8d547
source_spec: `spec-dw-161-164-storage-write-integrity.md`
archived: 2026-08-29

### DW-298: `writeProjects`' `slice(-MAX_PROJECTS)` can still silently evict for a legacy over-cap registry reached through update or delete.

status: done 2026-08-27
origin: spec-deferred c398ace2e4f5
source_spec: `spec-dw-161-164-storage-write-integrity.md`
archived: 2026-08-29

### DW-299: `/settings` still refuses read-only by disabling its whole form fieldset — the identical DW-191 defect, one section above the form this change fixed.

status: done 2026-08-21
origin: spec-deferred 32fcc7e0ed24
source_spec: `spec-dw-189-191-read-only-surface-affordances.md`
archived: 2026-08-29

### DW-300: `/api/names-terms` and `/api/email/settings` have no `isReadOnly()` gate, so those Settings forms silently SUCCEED on a read-only deployment.

status: done 2026-08-21
origin: spec-deferred 62ef6bcca620
source_spec: `spec-dw-189-191-read-only-surface-affordances.md`
archived: 2026-08-29

### DW-301: The `!wiki` leg of WorkspacePurposeSettings' fieldset carries the same tab-order harm DW-191 named, on bytes the route answers so they can be READ.

status: done 2026-08-20
origin: spec-deferred 4ca76f982d23
source_spec: `spec-dw-189-191-read-only-surface-affordances.md`
archived: 2026-08-29

### DW-302: `WIKI_READ_ONLY_COPY` is the one client refusal sentence with no case in `read-only-copy-parity.test.ts`, and it demonstrably differs from its route.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-read-only-kernel-writer-coverage
resolution-undo: 7babae5c1f979f9f9a279840f690171a0608302a7a14bc08597a783af1ca2015 2026-08-30 7374617475733a206f70656e
origin: spec-deferred c4e48f3e8686
source_spec: `spec-dw-189-191-read-only-surface-affordances.md`
archived: 2026-08-31

### DW-303: The flat branch can now be refused for vector legs no flat field can satisfy (endpoint, API key, Workers AI binding), and the legacy /settings page has no control for any of them.

status: done 2026-08-20
origin: spec-deferred fe4be61a5560
source_spec: `spec-dw-217-275-settings-flat-branch-validation.md`
archived: 2026-08-29

### DW-304: The flat `ollamaBaseUrl` is stored with no absolute-http validation, unlike every endpoint in the `workbench` patch.

status: done 2026-08-20
origin: spec-deferred 4592c0a3844b
source_spec: `spec-dw-217-275-settings-flat-branch-validation.md`
archived: 2026-08-29

### DW-305: `structuredKnowledgeModel` is the one flat text field still deciding its delete on the literal empty string rather than on the trimmed value.

status: done 2026-08-20
origin: spec-deferred 3bf4aaa1f56f
source_spec: `spec-dw-217-275-settings-flat-branch-validation.md`
archived: 2026-08-29

### DW-306: A body carrying BOTH a flat legacy field and a `workbench` key -- the only case `validateWorkbenchSettingsPatch`'s `baseline` parameter exists for -- has no test at any surface.

status: done 2026-08-20
origin: spec-deferred 68068f7435ec
source_spec: `spec-dw-217-275-settings-flat-branch-validation.md`
archived: 2026-08-29

### DW-307: `secretRow` never routes its description through `describedBy()`, so the three API-key rows are the last controls on the Settings surface that a read-only deployment refuses without saying why.

status: done 2026-08-20
origin: spec-deferred c188b4ff4f4e
source_spec: `spec-dw-277-279-280-281-vector-gate-surface-completeness.md`
archived: 2026-08-29

### DW-308: The route's 400 body still frames an already-on deployment as un-turn-on-able, so the two halves of the one rule now describe the same state with different sentences.

status: done 2026-08-20
origin: spec-deferred 1e2fbab9c662
source_spec: `spec-dw-277-279-280-281-vector-gate-surface-completeness.md`
archived: 2026-08-29

### DW-309: DEPLOY.md still says the legacy flat `/settings` branch never enters the vector gate, which DW-217 made false.

status: done 2026-08-20
origin: spec-deferred bc4653e2dd77
source_spec: `spec-dw-277-279-280-281-vector-gate-surface-completeness.md`
archived: 2026-08-29

### DW-310: `searchByVector`'s model-drift breadcrumb is the same standing-misconfiguration shape as the three warnings this story throttled, but fires once per search query and was left unguarded.

status: done 2026-08-20
origin: spec-deferred 23b8e4e79790
source_spec: `spec-dw-273-278-embedding-warning-throttle.md`
archived: 2026-08-29

### DW-311: The non-embedding-capable override warning hardcodes `EMBEDDING_PROVIDER="..."` even when the value came from stored config, and now says it only once.

status: done 2026-08-20
origin: spec-deferred eb0689dd76b5
source_spec: `spec-dw-273-278-embedding-warning-throttle.md`
archived: 2026-08-29

### DW-312: The Workbench Settings canvas has its own embedding-model control and still cannot say which model is actually embedding.

status: done 2026-08-20
origin: spec-deferred f2471935e58a
source_spec: `spec-dw-274-effective-settings-embedding-truth.md`
archived: 2026-08-29

### DW-313: `getEffectiveSettings` reads the config cache several times, so its "what is set" and "what is in effect" halves can in principle describe different snapshots.

status: done 2026-08-20
origin: spec-deferred 811577823483
source_spec: `spec-dw-274-effective-settings-embedding-truth.md`
archived: 2026-08-29

### DW-314: `deleteWiki`, `setCurrentWiki` and `sweepOrphanWikiDirectories` still write and delete bytes with no `assertWritable`, while their three sibling lifecycle doors now refuse.

status: done 2026-08-21
origin: spec-deferred 844e3a28f040
source_spec: `spec-dw-139-144-266-workspace-profile-store-hardening.md`
archived: 2026-08-29

### DW-315: `read-only-door-coverage.test.ts` still registers four kernel writers, so the newly refusing wiki-lifecycle exports are invisible to the scan that guards tomorrow's doors.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-read-only-kernel-writer-coverage
resolution-undo: 7babae5c1f979f9f9a279840f690171a0608302a7a14bc08597a783af1ca2015 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 451eef2b76ed
source_spec: `spec-dw-139-144-266-workspace-profile-store-hardening.md`
archived: 2026-08-31

### DW-316: The three wiki lifecycle routes classify a `ReadOnlyError` as 500 rather than mapping it to 403.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-read-only-lifecycle-route-status
resolution-undo: 8d0d9d1b39fad0e0145b43bf523a8c44a01125170236b0b6b41ab2d01975abaf 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 56ea98b9ffae
source_spec: `spec-dw-139-144-266-workspace-profile-store-hardening.md`
archived: 2026-08-31

### DW-317: The two putter backstop gates are unreachable through every current caller, so no test observes them firing.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-read-only-kernel-writer-coverage
resolution-undo: 7babae5c1f979f9f9a279840f690171a0608302a7a14bc08597a783af1ca2015 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 0b21a169fec9
source_spec: `spec-dw-139-144-266-workspace-profile-store-hardening.md`
archived: 2026-08-31

### DW-318: Two sibling wiki doors own inline read-only literals with no constant and no parity assertion, and `wikiRename` has no client counterpart.

status: done 2026-08-29
origin: spec-deferred ad2cf2a1e9d1
source_spec: `spec-dw-139-144-266-workspace-profile-store-hardening.md`
archived: 2026-08-31

### DW-319: A storage failure inside `saveWorkspaceProfile` is still answered 400 by `PUT /api/workspace-profile`, telling the owner their edit was rejected when the write merely could not reach storage.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-read-only-lifecycle-route-status
resolution-undo: 8d0d9d1b39fad0e0145b43bf523a8c44a01125170236b0b6b41ab2d01975abaf 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 926718bb8f18
source_spec: `spec-dw-140-145-workspace-profile-route-preconditions.md`
archived: 2026-08-31

### DW-320: `save()` has no unmount guard, so a PUT that resolves after the form unmounts still writes state.

status: done 2026-08-21
origin: spec-deferred df488f2bd6a3
source_spec: `spec-dw-136-142-301-workspace-purpose-settings-freshness.md`
archived: 2026-08-29

### DW-321: After a 412 write conflict this form still offers no in-page way to re-seed its version; the only recovery is a full reload.
origin: spec-deferred 8ca1e9659b2e
source_spec: `spec-dw-136-142-301-workspace-purpose-settings-freshness.md`
location: src/components/WorkspacePurposeSettings.tsx (save catch / feedback banner)
severity: low
reason: `WRITE_CONFLICT_COPY` tells the owner to copy their text and reload. `load("retry")` would now re-seed `version` from a fresh read, but the Try again control renders only under `loadFailed`, so the conflict banner has no affordance of its own. Out of scope for this bundle — the intent names the no-Wiki and load-failed states, not the conflict one.
status: done 2026-09-02
resolution: already resolved: commit 48412822 — src/components/WorkspacePurposeSettings.tsx is now a 33-line link-only callout that owns no draft and performs no write (:8), so there is no 412 conflict banner left to re-seed.

### DW-322: `buildNamesTermsGuidance` is still uncached in the exact same `Promise.all` pairs the DW-141 handle now covers, so one document still pays up to four dictionary reads while paying one profile read.

status: done 2026-08-21
origin: spec-deferred 8fd5a084ba2f
source_spec: `spec-dw-141-workspace-guidance-request-caching.md`
archived: 2026-08-29

### DW-323: A manual page merge gets neither Workspace Purpose nor Names & Terms guidance, while an ingest-time reconcile of the same two bodies gets both.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-merge-door-workspace-guidance
resolution-undo: 00ead2cfce08d8e022d14e56c8fc27d6b9f223b9ab0a41fcbd16162498402a7a 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 0fb017929a75
source_spec: `spec-dw-141-workspace-guidance-request-caching.md`
archived: 2026-08-29

### DW-324: One HTTP request can still resolve guidance N times when it ingests N documents in a loop; the handle is per-`ingest()`, not per-request.

status: done 2026-08-21
origin: spec-deferred 3caced74045d
source_spec: `spec-dw-141-workspace-guidance-request-caching.md`
archived: 2026-08-29

### DW-325: `workspace-purpose-settings.test.tsx` "adopts a recheck that answers no wiki at all" is flaky under full-suite load and can red an unrelated CI run.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-component-anchor-and-flake-coverage
resolution-undo: 261fa7215a7e4dd35377c63e571ad76627ca6311fcd9a185accfc2e771e3504d 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 09cd0fe96308
source_spec: `spec-dw-141-workspace-guidance-request-caching.md`
archived: 2026-08-29

### DW-326: DW-304's URL rule is write-time only: a value stored before this change, or one supplied through OLLAMA_BASE_URL, still reaches the provider SDK unvalidated.

status: done 2026-08-20
origin: spec-deferred b7a9d467256f
source_spec: `spec-dw-303-306-settings-flat-branch-uniformity.md`
archived: 2026-08-29

### DW-327: A flat save that the new scoping ALLOWS lands with no signal on /settings that the stored vector switch is on but inactive.

status: done 2026-08-20
origin: spec-deferred 66f5fc6223a9
source_spec: `spec-dw-303-306-settings-flat-branch-uniformity.md`
archived: 2026-08-29

### DW-328: All four flat text fields resolve a non-string to `""` before deciding the delete, so the belt-and-braces fallback points AT deletion rather than away from it.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-settings-route-write-semantics
resolution-undo: 4a50281ffc8d83c599d317b0d37a2175e3c5f2ea1ce9fc6453047ba752f9814f 2026-08-30 7374617475733a206f70656e
origin: spec-deferred f1908ff9cbf1
source_spec: `spec-dw-303-306-settings-flat-branch-uniformity.md`
archived: 2026-08-31

### DW-329: Every refusal the legacy flat `/settings` path can now produce ends "Turn it off, or supply what is missing." — naming a switch that page does not render.

status: done 2026-08-20
origin: spec-deferred d479ec58b9cf
source_spec: `spec-dw-307-308-vector-gate-copy-and-secret-row.md`
archived: 2026-08-29

### DW-330: The client picks the refusal's frame from the DRAFT checkbox and the route from the STORED flag, so one composition still shows both sentences on the same screen at the same moment.
origin: spec-deferred 5ca1c85bc38b
source_spec: `spec-dw-307-308-vector-gate-copy-and-secret-row.md`
location: src/components/workbench/SettingsCanvas.tsx (the checkbox hint selector) with src/lib/workbench-settings.ts:validateWorkbenchSettingsPatch
severity: low
reason: `SettingsCanvas` selects between `vectorSearchInactiveCopy` and `vectorSearchMissingCopy` on `values.vectorSearchEnabled` — the draft flag — while `validateWorkbenchSettingsPatch` selects on `baseline.vectorSearchEnabled`. Reachable: with the switch stored OFF and the legs met, the owner ticks the box (`vectorRefused` permits it), then moves a leg into an unmet state in the same draft. The checkbox hint reads "Vector search is switched on, but it needs …" while the 400 that lands in the save bar a few rows below reads "… before it can be turned on". The behaviour is unchanged by DW-308 — that composition answered the same way before — but it is the same two-sentences-for-one-state shape DW-279 and DW-308 exist to remove. DW-308's own intent excluded the literal "same frame the client picks" reading by also requiring both frames to be pinned at the route, so closing this needs a decision the intent does not contain: whether the route should read the REQUEST's flag for the frame while st
status: done 2026-09-02
resolution: resolved by sweep bundle dw-settings-save-verdict-contract
resolution-undo: 48ddddf59b44b2fa625d50086b3ffe9dfc1d4b907dd025ba89846c1f242105aa 2026-09-02 7374617475733a206f70656e
decision: 2026-08-28 Frame from the request — Have validateWorkbenchSettingsPatch select the refusal frame from the request's vectorSearchEnabled while still deciding refusal from the stored flag, so client and route agree; pin the previously contradictory composition.
decision: 2026-08-26 Align the client instead — Have SettingsCanvas select its checkbox hint from the STORED flag rather than the draft, matching the route exactly and leaving DW-308's boundary intact.

### DW-331: `workspace-purpose-settings.test.tsx` is flaky — one `getByRole("status")` assertion fails intermittently, roughly one run in three.
origin: spec-deferred 9e7a23de70bf
source_spec: `spec-dw-307-308-vector-gate-copy-and-secret-row.md`
location: src/components/__tests__/workspace-purpose-settings.test.tsx
severity: low
reason: Observed during this change's verification: a full `npm test` reported 1 failed / 5514 passed in that file, and two subsequent full runs reported 5515/5515. Run in isolation three times it failed once and passed twice. The file is untouched by this change and shares nothing with the settings or vector-gate surface — the failing assertion is on the active-wiki status line ("This workspace now has an active wiki, ...") — so this is pre-existing suite noise rather than a regression. It makes every future run's green a coin flip on that one file.
status: done 2026-09-02
resolution: already resolved: commit 48412822 — src/components/__tests__/workspace-purpose-settings.test.tsx is now a single synchronous 20-line case with no getByRole("status") and no fetch (:17); the intermittently failing assertion no longer exists.

### DW-332: The `drift:<active model>` key is never re-armed, so a corpus that is rebuilt and then drifts again under the same active model is silent for the rest of the process.

status: done 2026-08-21
origin: spec-deferred 694c7c190212
source_spec: `spec-dw-310-313-embedding-truth-and-warning-attribution.md`
archived: 2026-08-29

### DW-333: A whitespace-only `EMBEDDING_PROVIDER` is truthy, shadows a valid stored provider, and is now attributed to the environment while quoting a blank string.

status: done 2026-08-27
origin: spec-deferred 2dbdb2eb9569
source_spec: `spec-dw-310-313-embedding-truth-and-warning-attribution.md`
archived: 2026-08-29

### DW-334: `getEffectiveSettings` still re-enters the 5 s config cache on its non-embedding legs, so only the embedding half of its answer is snapshot-consistent.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-config-single-read-resolution
resolution-undo: 918c9d4112f6248cfdcfe721ad357c3745c069bc57d18c4196811f896d74d7a7 2026-08-29 7374617475733a206f70656e
origin: spec-deferred fbbe5abd3cc7
source_spec: `spec-dw-310-313-embedding-truth-and-warning-attribution.md`
archived: 2026-08-31

### DW-335: `settings-vector-namespace.test.tsx`'s default fixture encodes a config whose real payload would carry the substitution note, so several exact-equality announcements pin a state the wire cannot produc
origin: spec-deferred b09de8588471
source_spec: `spec-dw-310-313-embedding-truth-and-warning-attribution.md`
location: src/components/workbench/__tests__/settings-vector-namespace.test.tsx
severity: low
reason: The fixture is `embeddingProvider: "workers-ai"` with `embeddingModel: "text-embedding-3-small"` and `embeddingModelOverridden: false, embeddingModelInEffect: null`. For that config `embeddingModelAnswer` returns `overridden: true, inEffect: "@cf/baai/bge-m3"`, so the real GET body would carry a third sentence on the model row. The pre-existing cases assert the announced string with `toBe`, and they are about the vector gate rather than the substitution, so the simplification is deliberate and documented in the fixture comment — but it means those assertions describe a payload the server never serves. Making the fixture faithful would repin every one of them.
status: open

### DW-336: The substitution sentence exists as two hand-maintained twins — the flat page's JSX and the canvas's copy function — with nothing pinning that they keep saying the same thing.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-settings-substitution-copy-parity
resolution-undo: c833a8e8d47fb3752cd6e865237e548fd33822c4a7a78a59c80f20fa192a10a2 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 005b0025a4ed
source_spec: `spec-dw-310-313-embedding-truth-and-warning-attribution.md`
archived: 2026-08-31

### DW-337: The canvas substitution note is payload-derived while the two sentences beside it are draft-derived, so mid-edit the row can describe pre-edit server state.
origin: spec-deferred 30c4576690ec
source_spec: `spec-dw-310-313-embedding-truth-and-warning-attribution.md`
location: src/components/workbench/SettingsCanvas.tsx (modelSubstitution)
severity: low
reason: `modelSubstitution` reads `stored.embeddingModelOverridden` / `stored.embeddingModelInEffect`, while the env sentence and `vectorModelIssue` on the same row come from `values`. An owner who corrects the model in the box still reads "Not in effect. This deployment embeds with …" until a PUT lands. This is unavoidable without the server — the rule runs over the env and the store together — and it is documented in code and in DEPLOY.md ("re-reads it on save"), but the same row now mixes two freshness contracts and no test mounts the edit-then-read path. Whether the note should be suppressed while the model or provider field is dirty is a decision the intent does not contain.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-settings-save-in-flight-freshness
resolution-undo: da15ea5de83fe8fdcb5e911d0c2d65e67d416f176617fa044ae72da0891d817d 2026-09-01 7374617475733a206f70656e
decision: 2026-08-28 Suppress while dirty — Suppress the payload-derived substitution note while embeddingModel or embeddingProvider is dirty, so the row never describes pre-edit server state beside draft-derived sentences, and add a mounted edit-then-read case.

### DW-338: SCHEMA.md's Talk pages section still documents all five `/api/wiki/:slug/discuss...` routes as live surfaces.

status: done 2026-08-27
origin: spec-deferred d5560fb0b17e
source_spec: `spec-dw-127-309-doc-drift-corrections.md`
archived: 2026-08-29

### DW-339: SCHEMA.md's planned-evolution status still calls talk pages and contributor profiles complete, contradicting the new retired-surfaces block.

status: done 2026-08-27
origin: spec-deferred 493f9af093ca
source_spec: `spec-dw-127-309-doc-drift-corrections.md`
archived: 2026-08-29

### DW-340: DESIGN-triggers.md still designs triggers on `discussion-opened` / `discussion-resolved` and talk-thread events that retired with the commons.

status: done 2026-08-27
origin: spec-deferred 3b9db02a207e
source_spec: `spec-dw-127-309-doc-drift-corrections.md`
archived: 2026-08-29

### DW-341: The eight-member `fix` list is hand-copied in two documents with nothing pinning either to `MaintainFixType`.

status: done 2026-08-27
origin: spec-deferred 52bccbf1a637
source_spec: `spec-dw-127-309-doc-drift-corrections.md`
archived: 2026-08-29

### DW-342: A fifth supported-format sentence lives in the bulk importer and is already stale, and the private allowlist behind it is narrower than the app's.

status: done 2026-08-20
origin: spec-deferred fe13901b98f1
source_spec: `spec-dw-132-249-prose-inventory-parity.md`
archived: 2026-08-29

### DW-343: `MAINTAIN_FIX_TYPES` has no omission pin and the task-consumer README restates the same `lintType` list in unpinned prose.

status: done 2026-08-27
origin: spec-deferred 7dfb6b825471
source_spec: `spec-dw-132-249-prose-inventory-parity.md`
archived: 2026-08-29

### DW-344: The bulk-import file picker advertises formats the very next step refuses.

status: done 2026-08-26
origin: spec-deferred ec1d252f2b80
source_spec: `spec-dw-132-249-prose-inventory-parity.md`
archived: 2026-08-29

### DW-345: The bulk importer's only copy test restates the sentence as a literal, so it can never fail on drift.

status: done 2026-08-26
origin: spec-deferred 0f7b1eaec336
source_spec: `spec-dw-132-249-prose-inventory-parity.md`
archived: 2026-08-29

### DW-346: `POST /api/lint/fix`'s JSDoc is a sixth un-derived restatement of the fixable list and names only five of the ten types.

status: done 2026-08-27
origin: spec-deferred 4043386addcd
source_spec: `spec-dw-229-246-hand-copied-list-parity.md`
archived: 2026-08-29

### DW-347: Bulk import's `accept` advertises 21 MIME types its validator never consults, so a file the picker admits by content type alone is still refused client-side.

status: done 2026-08-27
origin: spec-deferred 4e813d060c28
source_spec: `spec-dw-229-246-hand-copied-list-parity.md`
archived: 2026-08-29

### DW-348: The two untrusted lint-fix doors accept an unvalidated `type` even though `AUTO_FIXABLE_CHECK_TYPES` now exists as a tuple to validate against.

status: done 2026-08-27
origin: spec-deferred ac2df2d3e945
source_spec: `spec-dw-229-246-hand-copied-list-parity.md`
archived: 2026-08-29

### DW-349: workers/email-ingest/README.md:20 documents a live app menu path with the retired brand ("the address entered under Yopedia **Settings -> Email ingestion**"), so the exemption freezes wrong operator d

status: done 2026-08-26
origin: spec-deferred 8edfd4178f50
source_spec: `spec-dw-236-244-brand-scan-coverage.md`
archived: 2026-08-29

### DW-350: .github/workflows/ carries brand strings and is read by no scan.
origin: spec-deferred c422dc958830
source_spec: `spec-dw-236-244-brand-scan-coverage.md`
location: .github/workflows/
severity: low
reason: Reviewer found hits at infra-setup.yml:52, deploy-cloudflare.yml:4,79,97,98 and seed-yoyo.yml:4-18,36,92-102. Neither source list reaches the tree. AGENTS.md marks .github/ protected, so folding it in is a decision the intent did not authorise; seed-yoyo.yml:93 also names a second workers.dev subdomain (yopedia.christianlee-flightwall.workers.dev) that the current single-host allowlist entry would not cover.
status: open
decision: 2026-08-28 Scan and allowlist — Add .github/ to the brand-copy scan's sources, add the second workers.dev deployment origin to IDENTIFIER_ALLOWLIST and to AGENTS.md's frozen list, and correct any remaining prose the scan then flags.
decision: 2026-08-26 Scan and allowlist — Add .github/ to the brand-copy scan's sources, add the second workers.dev deployment origin to IDENTIFIER_ALLOWLIST and to AGENTS.md's frozen list, and correct any remaining prose the scan then flags.

### DW-351: Root non-Markdown files beyond the four AGENTS.md freezes stay unread.

status: done 2026-08-27
origin: spec-deferred 78dc1d82c3b4
source_spec: `spec-dw-236-244-brand-scan-coverage.md`
archived: 2026-08-29

### DW-352: IDENTIFIER_ALLOWLIST's /yopedia-[a-z-]+/g swallows display prose, the way the workwiki family did before it was anchored.

status: done 2026-08-27
origin: spec-deferred 41f20a262d72
source_spec: `spec-dw-236-244-brand-scan-coverage.md`
archived: 2026-08-29

### DW-353: Named single files and newly walked roots surface as ENOENT rather than a pin failure when renamed or removed.

status: done 2026-08-27
origin: spec-deferred 7e47d62e4062
source_spec: `spec-dw-236-244-brand-scan-coverage.md`
archived: 2026-08-29

### DW-354: .agents/skills/ is tracked installer-generated markdown that no scan reads, while the comparable .opencode/commands/ was folded in.

status: done 2026-08-27
origin: spec-deferred 41e89080aefb
source_spec: `spec-dw-236-244-brand-scan-coverage.md`
archived: 2026-08-29

### DW-355: The browser clipper's shipped product name has no positive coverage: manifest.json's name, description and action.default_title, and popup.html's title and heading, are read only by the negative brand

status: done 2026-08-27
origin: spec-deferred fb9316c76117
source_spec: `spec-dw-235-237-241-242-brand-display-copy-residue.md`
archived: 2026-08-29

### DW-356: AGENTS.md's frozen list still omits three yopedia-side identifiers that IDENTIFIER_ALLOWLIST waives: the X-Yopedia-* wire headers and the two deployment origins.

status: done 2026-08-27
origin: spec-deferred b4f795fea992
source_spec: `spec-dw-235-237-241-242-brand-display-copy-residue.md`
archived: 2026-08-29

### DW-357: The duplicate-Message-ID early return omits skippedAttachmentCount entirely, so a resend of an already-seen message reports supportedAttachmentCount with no skipped figure at all.

status: done 2026-08-27
origin: spec-deferred 00f8b3678ac9
source_spec: `spec-dw-104-247-248-email-worker-caps-and-accounting.md`
archived: 2026-08-29

### DW-358: Quoted-printable transfer encoding is unaccounted for in the raw-size cap, which is derived from base64 expansion alone.

status: done 2026-08-26
origin: spec-deferred 18e6b2bf1947
source_spec: `spec-dw-104-247-248-email-worker-caps-and-accounting.md`
archived: 2026-08-29

### DW-359: Inline MIME parts (signature logos, embedded images) are counted as unsupported attachments and reported to the sender as skipped.

status: done 2026-08-26
origin: spec-deferred b0f13e11e949
source_spec: `spec-dw-104-247-248-email-worker-caps-and-accounting.md`
archived: 2026-08-29

### DW-360: Nothing bounds the aggregate size of the attachments the Worker copies into the forwarded FormData, and raising the raw cap raises that peak.

status: done 2026-08-26
origin: spec-deferred 9ad9274b13e0
source_spec: `spec-dw-104-247-248-email-worker-caps-and-accounting.md`
archived: 2026-08-29

### DW-361: A full-size document and a maximal email body cannot both fit under the derived raw cap, because the 64 KiB envelope allowance is far smaller than MAX_EMAIL_CONTENT_CHARS.

status: done 2026-08-26
origin: spec-deferred 29968aee1ee7
source_spec: `spec-dw-104-247-248-email-worker-caps-and-accounting.md`
archived: 2026-08-29

### DW-362: The raw cap bounds one full-size document, so several mid-size supported documents are refused wholesale even though every per-document and per-count limit is respected.

status: done 2026-08-26
origin: spec-deferred 95bfc309fad5
source_spec: `spec-dw-104-247-248-email-worker-caps-and-accounting.md`
archived: 2026-08-29

### DW-363: The second copy of the site-URL trim -- the one that builds the sender-visible acknowledgement links -- is pinned by nothing.

status: done 2026-08-27
origin: spec-deferred 5a52b035362e
source_spec: `spec-dw-250-251-252-254-email-ingest-test-coverage.md`
archived: 2026-08-29

### DW-364: The Worker's two misconfiguration early-returns -- missing service token and missing site URL -- produce sender-visible replies that no test observes.

status: done 2026-08-27
origin: spec-deferred def3eb49a02e
source_spec: `spec-dw-250-251-252-254-email-ingest-test-coverage.md`
archived: 2026-08-29

### DW-365: `assetFromArchive` still indexes the unzipped file map with a raw `files[target]`, one line above the `ownLookup` call added to close exactly that pattern.
origin: spec-deferred d5c3b8bba1b8
source_spec: `spec-dw-250-251-252-254-email-ingest-test-coverage.md`
location: src/lib/document-extract.ts:458
severity: low
reason: `src/lib/document-extract.ts:458` does `const bytes = files[target]`, where `target` is resolved from a relationship `Target` attribute inside an attacker-supplied archive. `resolveArchiveTarget` can produce a bare `constructor` (e.g. from `../constructor`), which would answer an inherited function. It is unreachable today only because `mediaTypeFor` rejects an extensionless name first and the `!bytes || !mediaType` guard short-circuits -- an accident of ordering, not a guard. Routing it through `ownLookup` would make it match its neighbour.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-snapshot-coverage-and-archive-lookup
resolution-undo: 07a4b5b8a44b8a65a0b1c538e87fae9d53c4b4f8686762b90f112510c146d6e3 2026-08-31 7374617475733a206f70656e

### DW-366: The route's `MAX_EMAIL_CONTENT_CHARS` 400 branch is unexercised -- the same defect class as DW-250, two gates above it.

status: done 2026-08-27
origin: spec-deferred a47249ac6557
source_spec: `spec-dw-250-251-252-254-email-ingest-test-coverage.md`
archived: 2026-08-29

### DW-367: The route's "no text body or supported document attachment" 400 asserts only its status, in the same file as a new block arguing at length that the copy must be pinned.

status: done 2026-08-27
origin: spec-deferred 96774befabcc
source_spec: `spec-dw-250-251-252-254-email-ingest-test-coverage.md`
archived: 2026-08-29

### DW-368: The Extraction provider picker on the same flat /settings page also offers Custom and renders no base-URL or API-key field, so it stores a provider the runtime refuses to construct with no on-page poi

status: done 2026-08-21
origin: spec-deferred ab8661d17322
source_spec: `spec-dw-61-327-329-legacy-settings-surface-parity.md`
archived: 2026-08-29

### DW-369: The five "Settings -> LLM Models" literals in llm.ts are hand-typed rather than derived from settingsCategory, so renaming that category leaves five runtime errors naming something the nav no longer s

status: done 2026-08-27
origin: spec-deferred b8ca25f1e6cd
source_spec: `spec-dw-61-327-329-legacy-settings-surface-parity.md`
archived: 2026-08-29

### DW-370: `detectEnvProvider()` and the embedding provider detection still select `ollama` from the mere presence of `OLLAMA_BASE_URL`, including a value `getOllamaBaseUrl` now refuses.

status: done 2026-08-21
origin: spec-deferred 9a66b32844ef
source_spec: `spec-dw-71-326-272-settings-config-resolution-hardening.md`
archived: 2026-08-29

### DW-371: The filesystem provider's compare-and-set is best-effort: its etag is `mtime-size` and its read pairs `readFile` with `stat`, so a losing compare-and-set can still win there.

status: done 2026-08-26
origin: spec-deferred 4c28f233b6f3
source_spec: `spec-dw-71-326-272-settings-config-resolution-hardening.md`
archived: 2026-08-29

### DW-372: A pre-DW-272 build reading the new single-object config carries `__settingsVersion` through as an ordinary key and writes it back, so the stamp stops rotating on a rollback.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-settings-route-write-semantics
resolution-undo: 4a50281ffc8d83c599d317b0d37a2175e3c5f2ea1ce9fc6453047ba752f9814f 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 9589cff245eb
source_spec: `spec-dw-71-326-272-settings-config-resolution-hardening.md`
archived: 2026-08-31

### DW-373: Opening the in-shell Settings surface still unmounts the whole mode canvas, so the Wiki subtree DW-26 keeps mounted across mode switches is destroyed — dialog, typed name and error — whenever Settings

status: done 2026-08-22
origin: spec-deferred 125b109b6d09
source_spec: `spec-dw-26-62-283-320-workbench-client-state-and-nav.md`
archived: 2026-08-29

### DW-374: Only `TimeoutError`/`AbortError` are treated as unconfirmed, so a dropped connection or a 502/504 is reported as a known failure — with transport vocabulary — and no refresh runs.

status: done 2026-08-21
origin: spec-deferred e6705ae0513e
source_spec: `spec-dw-26-62-283-320-workbench-client-state-and-nav.md`
archived: 2026-08-29

### DW-375: `WikiSwitcher`'s create, rename and delete confirms stay live after an unconfirmed write, so a retry can seed a duplicate wiki or paint a 404 over a delete that landed.

status: done 2026-08-21
origin: spec-deferred be4b261f912b
source_spec: `spec-dw-26-62-283-320-workbench-client-state-and-nav.md`
archived: 2026-08-29

### DW-376: `SettingsCanvas.save` and `PreviewColumn` carry their own deadlines and still report a blown one as a flat failure, which is the claim DW-283 says the client cannot make.

status: done 2026-08-21
origin: spec-deferred 5d49180cca3b
source_spec: `spec-dw-26-62-283-320-workbench-client-state-and-nav.md`
archived: 2026-08-29

### DW-377: Retry attempts are counted per qualifying poll rather than per settled re-render, so a nudge or visibility burst — or a merely slow refresh — can spend the whole budget before any new baseline has had

status: done 2026-08-21
origin: spec-deferred eb490a039820
source_spec: `spec-dw-48-data-version-refresh-retry.md`
archived: 2026-08-29

### DW-378: `readWikiPage` answers `null` for a page that is UNREADABLE as well as one that is absent, so a storage blip on the page write's merge-base read is reported as `404 page not found`.

status: done 2026-08-27
origin: spec-deferred e2c2f3bbd280
source_spec: `spec-dw-193-194-195-200-write-precondition-and-version-freshness.md`
archived: 2026-08-29

### DW-379: The other read-modify-write merge bases still read through `pageCache`, so the staleness DW-195 closed for the precondition-bearing reads is open on every path that merges into cached bytes and writes

status: done 2026-08-27
origin: spec-deferred 620dd58d504a
source_spec: `spec-dw-193-194-195-200-write-precondition-and-version-freshness.md`
archived: 2026-08-29

### DW-380: A fresh read still falls back from a FAILED silo read to the flat copy, so a version can describe bytes at a path the write will not target.

status: done 2026-08-26
origin: spec-deferred 60eded0bf0fa
source_spec: `spec-dw-193-194-195-200-write-precondition-and-version-freshness.md`
archived: 2026-08-29

### DW-381: The re-template confirm still presents the Schema overwrite as unrecoverable, which DW-213 has just made false.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-scenario-template-failure-truth
resolution-undo: 7d1542c4c2d4b1fa95833a726570cdeb403e73d0fc63131b28636e52d3b80b5d 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 612a8939a001
source_spec: `spec-dw-213-214-artifact-revision-recovery.md`
archived: 2026-08-31

### DW-382: `deleteWiki` removes a Wiki's `purpose.md` and `schema.md` outright and moves no `dataVersion`, so a Preview open on those artifacts in a second client keeps rendering bytes whose Wiki is gone.

status: done 2026-08-27
origin: spec-deferred e419c472892c
source_spec: `spec-dw-209-289-wiki-rename-refresh-and-sweep-cap.md`
archived: 2026-08-29

### DW-383: A sweep candidate whose age cannot be read is skipped but still consumes one of the per-pass cap slots on every pass, so enough of them could starve the tail of the list.

status: done 2026-08-27
origin: spec-deferred 5c402c238ab7
source_spec: `spec-dw-209-289-wiki-rename-refresh-and-sweep-cap.md`
archived: 2026-08-29

### DW-384: The sibling research routes (PATCH/DELETE `/api/research/[id]`, POST `/api/research/[id]/run`) still write and delete research-project records with no read-only gate.

status: done 2026-08-26
origin: spec-deferred 4a4bbd173b0f
source_spec: `spec-dw-264-265-294-299-300-314-read-only-doors-and-affordances.md`
archived: 2026-08-29

### DW-385: The research, Names & Terms and email-ingest stores carry no `assertWritable`, so a CLI, MCP or agent-runtime caller still writes them on a read-only deployment.

status: done 2026-08-28
resolution: resolved by sweep bundle dw-read-only-kernel-guards
resolution-undo: 228a442950964e6d36ebc8b9e564fa2523daaedbc7b5c0ed3d96be6ad65d5e59 2026-08-28 7374617475733a206f70656e
origin: spec-deferred 192b376cbc62
source_spec: `spec-dw-264-265-294-299-300-314-read-only-doors-and-affordances.md`
archived: 2026-08-29

### DW-386: Three surfaces now compose a write in front of a door this change taught to answer 403, with no read-only mirror — the DW-264/DW-265 shape, one bundle later.

status: done 2026-08-28
resolution: resolved by sweep bundle dw-read-only-client-parity
resolution-undo: 07f3607f3fe2d414f4c8b525cf7eac492435161ccb7877f7b0c7e12f2a571bc0 2026-08-28 7374617475733a206f70656e
origin: spec-deferred 56c9d9c9eb3d
source_spec: `spec-dw-264-265-294-299-300-314-read-only-doors-and-affordances.md`
archived: 2026-08-29

### DW-387: `/settings` now states three different sentences for one deployment state, none of them owned by `READ_ONLY_REFUSAL` and none pinned by the parity suite.

status: done 2026-08-28
resolution: resolved by sweep bundle dw-read-only-client-parity
resolution-undo: 07f3607f3fe2d414f4c8b525cf7eac492435161ccb7877f7b0c7e12f2a571bc0 2026-08-28 7374617475733a206f70656e
origin: spec-deferred cba66956e0ae
source_spec: `spec-dw-264-265-294-299-300-314-read-only-doors-and-affordances.md`
archived: 2026-08-29

### DW-388: Nothing outside code comments records that `POST /api/tasks/scan` now answers 403 on every cron pass of a read-only deployment.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-read-only-operator-docs
resolution-undo: 3b09c8630704cd1ee6b9a953f6709b99d99347084c194b69f40f07e555f82e49 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 49c9a3138d42
source_spec: `spec-dw-264-265-294-299-300-314-read-only-doors-and-affordances.md`
archived: 2026-08-31

### DW-389: The `disputed-page` lint guidance still tells the reader to clear the Disputed toggle with a PATCH that DW-121 now refuses for every non-admin.

status: done 2026-08-28
resolution: resolved by sweep bundle dw-authz-gate-and-copy-tails
resolution-undo: c0c5d313c4b41b5ea3bf4ff4e9578c846882c4d983ec1d048fc027665386a2a6 2026-08-28 7374617475733a206f70656e
origin: spec-deferred 63617f440c96
source_spec: `spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md`
archived: 2026-08-29

### DW-390: Deleting the reconciliation-thread writer took the last programmatic caller of the whole talk thread API with it.

status: done 2026-08-28
resolution: resolved by sweep bundle dw-retire-dead-talk-writers
resolution-undo: 380d8804c9b253bf823aa9f1e6238eec0464915b46b8ab7aa9eb9a35e287b7e2 2026-08-28 7374617475733a206f70656e
origin: spec-deferred 83dd95b177cf
source_spec: `spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md`
archived: 2026-08-29

### DW-391: A non-admin page owner can no longer take their own public knowledge page private — the realm became a one-way door for them.

status: done 2026-08-21
origin: spec-deferred d981f87caa54
source_spec: `spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md`
archived: 2026-08-29

### DW-392: Revert is still offered to signed-out viewers on every page the realm does not restrict.

status: done 2026-08-28
resolution: resolved by sweep bundle dw-authz-gate-and-copy-tails
resolution-undo: c0c5d313c4b41b5ea3bf4ff4e9578c846882c4d983ec1d048fc027665386a2a6 2026-08-28 7374617475733a206f70656e
origin: spec-deferred 5acd94afc307
source_spec: `spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md`
archived: 2026-08-29

### DW-393: An orphan page — on disk but absent from the page index — now makes its ingest-history row undeletable and fails the whole batch.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-decision-dw-393
resolution-undo: 113ce535213b06bbb9fb350653e1916208c6c4796dc71d6a018aa1fe5248dc1e 2026-08-29 7374617475733a206f70656e
origin: spec-deferred a01843f3f763
source_spec: `spec-dw-121-230-269-270-authz-realm-parity-and-read-gates.md`
archived: 2026-08-29

### DW-394: Both guidance memos are keyed by `owner`, but the files they memoize are addressed by TENANT, so two owner strings in one tenant key two entries over one file.

status: done 2026-08-27
origin: spec-deferred 1eea774dfd5c
source_spec: `spec-dw-322-324-dictionary-guidance-and-request-cache.md`
archived: 2026-08-29

### DW-395: `src/mcp.ts`'s batch ingest tool loops `ingestUrl` over up to MAX_BATCH_URLS URLs with no handle — the same one-action-N-documents shape DW-324 just closed for the HTTP batch route.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-mcp-rest-door-parity
resolution-undo: e61b6550811aed7194f363080d6b27679d0d79c5aa1900b253385cd30754f0d9 2026-08-29 7374617475733a206f70656e
origin: spec-deferred a07d00ea301f
source_spec: `spec-dw-322-324-dictionary-guidance-and-request-cache.md`
archived: 2026-08-29

### DW-396: `IngestOptions` now carries a live, non-serializable object guarded only by the convention that queue task payloads are hand-written literals.
origin: spec-deferred f8d8c4c6caab
source_spec: `spec-dw-322-324-dictionary-guidance-and-request-cache.md`
location: src/lib/ingest.ts:1328
severity: low
reason: `IngestOptions.guidanceCache` holds two `Map`s. The batch route keeps it out of the queue by building `enqueueTask`'s payload as a separate literal (src/app/api/ingest/batch/route.ts:143-150), and `tasks/run` and the agent ingest route do the same by hand. Nothing structural stops a future `enqueueTask({ kind: "ingest", ...ingestOptions })`: TypeScript does not excess-property-check spread properties, so it would compile and fail at structured-clone/JSON time. An `Omit<IngestOptions, "guidanceCache">` on the payload builders, or a handle passed as its own argument rather than a field on the data bag, would make it a compile error.
status: open
decision: 2026-08-28 Type the queue payload — Type enqueueTask's ingest payload as Omit<IngestOptions,"guidanceCache"> so the compiler refuses a serialized handle, leaving the call signature of ingestUrl unchanged.
decision: 2026-08-26 Type the queue payload — Type enqueueTask's ingest payload as Omit<IngestOptions,"guidanceCache"> so the compiler refuses a serialized handle, leaving the call signature of ingestUrl unchanged.

### DW-397: Under a handle the dictionary ENTRY OBJECTS are shared across every caller of the operation; only the top-level array is copied.

status: done 2026-08-27
origin: spec-deferred db45e54ae4f5
source_spec: `spec-dw-322-324-dictionary-guidance-and-request-cache.md`
archived: 2026-08-29

### DW-398: The EFFECTIVE embedding vendor can move without the stored `embeddingProvider` moving, so the clear never fires and a stored key or endpoint can still reach a vendor it was not entered for.

status: done 2026-08-27
origin: spec-deferred e1c07dfbeb93
source_spec: `spec-dw-69-72-embedding-provider-secret-isolation.md`
archived: 2026-08-29

### DW-399: `spec-dw-66-72-settings-credential-fidelity.md` still reads `status: 'in-progress'` for DW-69/DW-72 under the superseded per-provider keying approach.
origin: spec-deferred ce665a977ec1
source_spec: `spec-dw-69-72-embedding-provider-secret-isolation.md`
location: _bmad-output/implementation-artifacts/spec-dw-66-72-settings-credential-fidelity.md
severity: low
reason: That spec planned to key `embeddingApiKey`/`embeddingBaseUrl` per provider with a load-time migration. The recorded decisions rule that out, and nothing from it landed — the store is still flat. Its frontmatter is where anyone scanning for open work will look, and it currently claims work is under way on entries this spec resolves.
status: open

### DW-400: The custom-endpoint pointer is visually adjacent to the provider picker on both the primary and the extraction surface, but no `aria-describedby` associates it, so a screen-reader owner selecting Cust

status: done 2026-08-22
origin: spec-deferred 870c311fd59f
source_spec: `spec-dw-368-370-provider-selection-truthfulness.md`
archived: 2026-08-29

### DW-401: DW-370's harm class survives on the EXPLICIT ollama selections: an `EMBEDDING_PROVIDER=ollama` override and a stored `cfg.provider === "ollama"` still select ollama regardless of endpoint usability, t

status: done 2026-08-27
origin: spec-deferred 68e862a9281d
source_spec: `spec-dw-368-370-provider-selection-truthfulness.md`
archived: 2026-08-29

### DW-402: A refused `OLLAMA_BASE_URL` is now described only in a server log; every owner-facing surface still advertises the variable as the remedy and reports no reason it was ignored.

status: done 2026-08-22
origin: spec-deferred 3f538ea33f5f
source_spec: `spec-dw-368-370-provider-selection-truthfulness.md`
archived: 2026-08-29

### DW-403: The extraction section's "Credential ready" badge can be green for `custom` while extraction still throws, because `providerIsConfigured("custom")` checks base URL and API key but not the model name C

status: done 2026-08-22
origin: spec-deferred a7d97b2655cd
source_spec: `spec-dw-368-370-provider-selection-truthfulness.md`
archived: 2026-08-29

### DW-404: The re-arm gate `kept.length > 0` is a property of the per-query top-K window, not of the corpus, so a partially-rebuilt (mixed-model) corpus can oscillate warn -> re-arm -> warn and revert DW-310's o

status: done 2026-08-29
resolution: resolved by sweep bundle dw-decision-dw-404
resolution-undo: cfdacb7a3e8651e3640c76ae0343b42562c70a697c585e930278655cae3b750b 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 2b8128268e58
source_spec: `spec-dw-332-embedding-drift-warning-rearm.md`
archived: 2026-08-29

### DW-405: A single unlabelled legacy vector satisfies `kept.length > 0` and re-arms `drift:<active model>` on a corpus where every labelled vector is still stale, so a genuinely un-rebuilt corpus can repeat the

status: done 2026-08-29
resolution: resolved by sweep bundle dw-decision-dw-405
resolution-undo: 4c8db2531685e908deb653b0b51867faff0f7335da87372d944149e467972190 2026-08-29 7374617475733a206f70656e
origin: spec-deferred f6e0ffb78ddc
source_spec: `spec-dw-332-embedding-drift-warning-rearm.md`
archived: 2026-08-29

### DW-406: `relatedByVector` runs the same model filter but neither warns nor re-arms, so a deployment whose only vector traffic is page-render related lookups observes neither the drift nor its recovery.
origin: spec-deferred da6f7511b5fb
source_spec: `spec-dw-332-embedding-drift-warning-rearm.md`
location: src/lib/embeddings.ts (relatedByVector)
severity: low
reason: src/lib/embeddings.ts relatedByVector applies `modelMatches` and silently returns [] on a drifted corpus. That muteness predates this change (DW-310 scoped the breadcrumb to searchByVector), but with drift now modelled as CLEARABLE state the asymmetry is newly consequential: a rebuild proven out only through relatedByVector never re-arms the key. Worth either one sentence of recorded rationale or a decision to widen the door.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-related-by-vector-drift-voice
resolution-undo: 41c6f505ef7bd8c3b921e54d2f717048d006ed58790d2ce489533009da760ef5 2026-09-01 7374617475733a206f70656e

### DW-407: WikiWorkbench's CreateWikiDialog confirm stays live on its own unconfirmed path, so a second press seeds a duplicate wiki.

status: done 2026-08-22
origin: spec-deferred bd7e96f62f0e
source_spec: `spec-dw-374-375-376-unconfirmed-write-reporting.md`
archived: 2026-08-29

### DW-408: saveWorkbenchSettings parses a 2xx body with a bare `await response.json()`, so an unparseable 200 is reported as a failed save over a patch the route accepted.

status: done 2026-08-22
origin: spec-deferred 9a20e32ce553
source_spec: `spec-dw-374-375-376-unconfirmed-write-reporting.md`
archived: 2026-08-29

### DW-409: WikiSwitcher.switchWiki starts no latch on an unconfirmed switch, so a second PUT can be issued over a first whose outcome is unknown.

status: done 2026-08-28
origin: spec-deferred 53cfbf951e42
source_spec: `spec-dw-374-375-376-unconfirmed-write-reporting.md`
archived: 2026-08-29

### DW-410: The dataVersion refresh budget is per MOUNTED WATCHER, not per tab, so any remount silently re-arms it.

status: done 2026-08-28
origin: spec-deferred 9aba3688e217
source_spec: `spec-dw-377-data-version-refresh-budget.md`
archived: 2026-08-29

### DW-411: `pnpm vitest` and `pnpm lint` abort before running, so the repo's own documented commands cannot be used and every verification runs through `npx`.

status: done 2026-08-26
origin: spec-deferred a82805fc5057
source_spec: `spec-dw-377-data-version-refresh-budget.md`
archived: 2026-08-29

### DW-412: Opening Settings still unmounts the Preview column, silently discarding its unsaved markdown draft — the same loss DW-373 fixed one column over.

status: done 2026-08-22
origin: spec-deferred 5531bcb9520c
source_spec: `spec-dw-373-settings-canvas-mount-preservation.md`
archived: 2026-08-29

### DW-413: Opening Settings moves focus nowhere, so in a real browser a keyboard user inside the canvas is dropped on <body> when it goes `display: none`.

status: done 2026-08-22
origin: spec-deferred 019e0d5eb098
source_spec: `spec-dw-373-settings-canvas-mount-preservation.md`
archived: 2026-08-29

### DW-414: `useDialogA11y`'s close path can restore focus into a hidden canvas while Settings is showing.

status: done 2026-08-22
origin: spec-deferred 7ceac9bfb832
source_spec: `spec-dw-373-settings-canvas-mount-preservation.md`
archived: 2026-08-29

### DW-415: The `[hidden]` withdrawal rules have no specificity floor, so a later shell-scoped `display` rule beats them.

status: done 2026-08-22
origin: spec-deferred 6ddef8b35447
source_spec: `spec-dw-373-settings-canvas-mount-preservation.md`
archived: 2026-08-29

### DW-416: The mode canvas's scroll offset is not preserved across a Settings visit.

status: done 2026-08-28
origin: spec-deferred 86882ef5b044
source_spec: `spec-dw-373-settings-canvas-mount-preservation.md`
archived: 2026-08-29

### DW-417: The reason a refused `OLLAMA_BASE_URL` was ignored reaches no MOUNTED surface in the one deployment state DW-402 describes, so that owner still reads a bare "No LLM provider configured".

status: done 2026-08-27
origin: spec-deferred 7864c5a12629
source_spec: `spec-dw-402-403-endpoint-refusal-and-readiness.md`
archived: 2026-08-29

### DW-418: `yopedia status` prints the provider verdict with no reason, so the CLI — the surface a headless operator actually reaches — still reports "not configured" for a variable the deployment saw and refuse

status: done 2026-08-27
origin: spec-deferred 6fcc711d76d0
source_spec: `spec-dw-402-403-endpoint-refusal-and-readiness.md`
archived: 2026-08-29

### DW-419: The Ollama Cloud note is the same shape of picker-conditional pointer as the custom-endpoint note and is still unassociated with the provider picker.

status: done 2026-08-27
origin: spec-deferred bfa78eb632ac
source_spec: `spec-dw-400-provider-endpoint-note-a11y.md`
archived: 2026-08-29

### DW-420: The primary picker's credential-status line sits beside the control with nothing associating it.

status: done 2026-08-27
origin: spec-deferred 35a109f64410
source_spec: `spec-dw-400-provider-endpoint-note-a11y.md`
archived: 2026-08-29

### DW-421: `useDialogA11y`'s new `withdrawn()` guard knows only the `hidden` attribute, so an opener hidden by CSS alone still takes a focus() that a browser silently drops.

status: done 2026-08-28
origin: spec-deferred 515a14088b1b
source_spec: `spec-dw-412-413-414-settings-transition-focus-and-state.md`
archived: 2026-08-29

### DW-422: A withdrawn Preview column keeps its whole data lifecycle running, so a refresh during a Settings visit can refetch and announce into a live region nobody can hear.
origin: spec-deferred db251d594798
source_spec: `spec-dw-412-413-414-settings-transition-focus-and-state.md`
location: src/components/workbench/PreviewColumn.tsx (fetch effect / refresh announcements)
severity: medium
reason: Keeping `PreviewColumn` mounted (DW-412) keeps its fetch effect, `requestDataVersionCheck()` and its polite live region live while the column is `hidden`. A `DataVersionWatcher` bump mid-visit can therefore refetch the row, flip to the stale note, or report a removal into a region that is out of the accessibility tree — the announcement is spent with nobody to hear it, and the column the owner comes back to has changed under them with no report. The spec's Never clause held the fetch/edit lifecycle out of scope, but the mount change is what makes it run off screen at all. `ModeCanvas` has the same shape and the same unanswered question.
status: open
decision: 2026-08-28 Pause while withdrawn — Gate PreviewColumn's fetch effect, dataVersion checks and live-region writes on surface visibility (extending the existing SurfaceVisibilityProvider), resuming with one refresh on return; apply the same shape to ModeCanvas.
decision: 2026-08-26 Pause while withdrawn — Gate PreviewColumn's fetch effect, dataVersion checks and live-region writes on surface visibility (extending the existing SurfaceVisibilityProvider), resuming with one refresh on return; apply the same shape to ModeCanvas.

### DW-423: Back or a popstate that closes Settings unmounts `SettingsCanvas` under the keyboard, and DW-413 makes focus-in-Settings the normal case rather than the rare one.

status: done 2026-08-28
origin: spec-deferred e21c6087e070
source_spec: `spec-dw-412-413-414-settings-transition-focus-and-state.md`
archived: 2026-08-29

### DW-424: `ShortcutsHelp` renders `role="dialog"` without `aria-modal`, so a global `g <key>` still fires from inside the open help overlay.

status: done 2026-08-28
origin: spec-deferred 84f95020424e
source_spec: `spec-dw-412-413-414-settings-transition-focus-and-state.md`
archived: 2026-08-29

### DW-425: A second `g s` while Settings is already open announces Settings but moves no focus, so the key cannot be used to recover a lost keyboard.

status: done 2026-08-28
origin: spec-deferred 01eefb117c1c
source_spec: `spec-dw-412-413-414-settings-transition-focus-and-state.md`
archived: 2026-08-29

### DW-426: The `g s`-over-an-open-dialog rows of the DW-373 suite now pin a path a real keyboard user can no longer take.

status: done 2026-08-28
origin: spec-deferred ba989ecca8af
source_spec: `spec-dw-412-413-414-settings-transition-focus-and-state.md`
archived: 2026-08-29

### DW-427: DW-408's prescribed fix does not remove the harm its own ledger entry states: an unparseable 200 still answers `unconfirmed: false`, so the owner keeps a version the save superseded and the next save

status: done 2026-08-29
resolution: resolved by sweep bundle dw-settings-unreadable-2xx-verdict
resolution-undo: 4d80075769a62111f426aa27ea50d8781617bbcfe442aaaa529e20b88bcfb7fa 2026-08-29 7374617475733a206f70656e
origin: spec-deferred a42911c607ff
source_spec: `spec-dw-407-408-unconfirmed-write-reporting-gaps.md`
archived: 2026-08-29

### DW-428: No canvas-level test drives SettingsCanvas with a 2xx whose body read fails, so the DW-408 verdict is pinned only at the client's return value and never at the seam that acts on it.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-settings-unreadable-2xx-verdict
resolution-undo: 4d80075769a62111f426aa27ea50d8781617bbcfe442aaaa529e20b88bcfb7fa 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 14da776e2f5c
source_spec: `spec-dw-407-408-unconfirmed-write-reporting-gaps.md`
archived: 2026-08-29

### DW-429: When the unconfirmed-write latch lifts with the dialog still open, the confirm comes back live underneath a now-stale "the outcome is unknown" alert, on both the card and the switcher.

status: done 2026-08-28
origin: spec-deferred f88ef8ffaa49
source_spec: `spec-dw-407-408-unconfirmed-write-reporting-gaps.md`
archived: 2026-08-29

### DW-430: Dismissing the card's create dialog on the unconfirmed path destroys the only explanation the owner has, and the disabled opener behind it says nothing.

status: done 2026-08-28
origin: spec-deferred 4b773b607140
source_spec: `spec-dw-407-408-unconfirmed-write-reporting-gaps.md`
archived: 2026-08-29

### DW-431: The Dockerfile's deps stage does not copy the new root pnpm-workspace.yaml while its build stage's `COPY . .` does, so the two stages disagree about whether /app is a workspace root, and no docker bui
origin: spec-deferred ef4f6e35a444
source_spec: `spec-dw-411-pnpm-workspace-root.md`
location: Dockerfile:5-13
severity: low
reason: Dockerfile:5-6 copies only `package.json pnpm-lock.yaml` and then runs `pnpm install --frozen-lockfile`; Dockerfile:13's `COPY . .` brings `pnpm-workspace.yaml` into the build stage before `pnpm build`, and `.dockerignore` does not exclude it. Nothing observably breaks today (the image has no ancestor workspace file to adopt, and the build stage only builds), but the divergence is unverified: `docker build .` was not part of this story's verification.
status: open

### DW-432: `.github/workflows/deploy-cloudflare.yml`'s `paths:` filter does not list pnpm-workspace.yaml, so changing or deleting that file alone never triggers the workflow it protects.
origin: spec-deferred 2ff1a73d7250
source_spec: `spec-dw-411-pnpm-workspace-root.md`
location: .github/workflows/deploy-cloudflare.yml (paths filter)
severity: low
reason: The filter names `pnpm-lock.yaml`, `package.json` and `workers/**`. The root workspace file is now load-bearing for `pnpm --dir workers/sandbox-runner install --frozen-lockfile` at deploy-cloudflare.yml:82, but a commit touching only that file skips the workflow. `.github/` is declared protected in AGENTS.md, so this run could not edit it.
status: done 2026-09-01
resolution: resolved by sweep bundle dw3-decision-dw-432
resolution-undo: 79ff9d6505e892e971f9f5bddefda4bf8271ba4377d7e84b19e49851c64332da 2026-09-01 7374617475733a206f70656e
decision: 2026-08-22 Bounded per-page read fallback — For slugs the index misses, fall back to a bounded per-page read (cap at MAX_BULK_DELETE) on this listing path only, so orphan rows list and become deletable while the read cost stays bounded.

### DW-433: The bundle this story came from is keyed to DW-415, but its Intent prose describes DW-411; the work done resolves DW-411 and leaves DW-415 untouched.

status: done 2026-08-28
resolution: resolved by sweep bundle dw-hidden-attribute-css-specificity
resolution-undo: 0246f6f8e779adb192b20a5b5d4e65bf176f3a9f988d26736265065d89b48fc6 2026-08-28 7374617475733a206f70656e
origin: spec-deferred 0566328f37bb
source_spec: `spec-dw-411-pnpm-workspace-root.md`
archived: 2026-08-29

### DW-434: The nested-package guard derives its targets from `--dir`/`-C` workflow flags and on-disk lockfiles, so a package reached by `working-directory:` or `cd x && pnpm install` is only caught once it has a
origin: spec-deferred 6ef21c2d1d6d
source_spec: `spec-dw-411-pnpm-workspace-root.md`
location: src/lib/__tests__/pnpm-workspace-root.test.ts (pnpmDirTargets)
severity: low
reason: `pnpmDirTargets` in src/lib/__tests__/pnpm-workspace-root.test.ts matches pnpm's two directory flags. A workflow step using GitHub Actions' `working-directory:` key, or a plain `cd`, is not scraped. The on-disk lockfile walk added in review covers every real nested package (a pnpm package installed with --frozen-lockfile necessarily has one), so the residual gap is a directory installed without a committed lockfile.
status: open

### DW-435: Silo sync and remove still copy and delete only `raw/sources/<slug>.md`, never the hashed Intake trees at `raw/sources/<slug>/<rawId>.md`.

status: done 2026-08-29
resolution: resolved by sweep bundle dw2-silo-hashed-intake-paths
resolution-undo: b93b423a86d58364e5a339d9d48dc71e3a0c74a67af6165b596a23ee8af952c6 2026-08-29 7374617475733a206f70656e
origin: migrated from legacy ledger ("Deferred from: code review of spec-2-1-upload-drag-drop-and-url-intake.md (2026-08-22)"), 2026-08-26
archived: 2026-08-29

### DW-436: An identical re-arrival still creates an Ingest job even though the Source bytes are not rewritten.

status: done 2026-08-26
origin: migrated from legacy ledger ("Deferred from: code review of spec-2-1-upload-drag-drop-and-url-intake.md (2026-08-22)"), 2026-08-26
archived: 2026-08-29

### DW-437: `listRawSources` is still non-recursive, so CLI and lint listings miss hashed `raw/sources/<slug>/<id>.md` arrivals.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-raw-source-listing-and-store-safety
resolution-undo: f70d4b195f464d4688dec5b40f14604450c2e6decd6f6fbe9e31200977b4a25c 2026-08-29 7374617475733a206f70656e
origin: migrated from legacy ledger ("Deferred from: code review of spec-2-1-upload-drag-drop-and-url-intake.md (2026-08-22)"), 2026-08-26
archived: 2026-08-29

### DW-438: `alreadyStored` followed by `writeFile` is not exclusive, so two concurrent stores of the same new key can overwrite each other.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-raw-source-listing-and-store-safety
resolution-undo: f70d4b195f464d4688dec5b40f14604450c2e6decd6f6fbe9e31200977b4a25c 2026-08-29 7374617475733a206f70656e
origin: migrated from legacy ledger ("Deferred from: code review of spec-2-1-upload-drag-drop-and-url-intake.md (2026-08-22)"), 2026-08-26
archived: 2026-08-29

### DW-439: The client's 15s send deadline wraps a server URL fetch that already uses the same 15s budget, so a slow but valid fetch surfaces as an unconfirmed write.
origin: migrated from legacy ledger ("Deferred from: code review of spec-2-1-upload-drag-drop-and-url-intake.md (2026-08-22)"), 2026-08-26
location: src/lib/workbench-request.ts:33
reason: `send` / `sendForm` time out at 15s, and the server URL-intake path it calls is itself budgeted at 15s. A slow but ultimately successful HTML fetch can therefore trip the client deadline and be reported as an unconfirmed write while the route completes and stores the source anyway. Deferred because fixing it means renegotiating the two budgets rather than a local change.
status: done 2026-09-01
resolution: resolved by sweep bundle dw3-email-worker-reply-path-hardening
resolution-undo: 16241f8bbbbe6d9e8a8a58c17639242b50895154f05c12d8dc3280fcb3a8727f 2026-09-01 7374617475733a206f70656e
decision: 2026-08-31 Raise the client deadline above the server's — Raise the client `REQUEST_TIMEOUT_MS` above `FETCH_TIMEOUT_MS` by a margin that covers request and response overhead, so the server's own timeout always fires first and the client reports a real refusal instead of an unconfirmed write. Add a comment at both constants naming the required ordering, and pin the ordering in a test so the two cannot silently converge again.

### DW-440: When store succeeds but enqueue returns `queued: false`, the batch sentence still claims "Ingest is queued."

status: done 2026-08-26
origin: migrated from legacy ledger ("Deferred from: code review of spec-2-1-upload-drag-drop-and-url-intake.md (2026-08-22)"), 2026-08-26
archived: 2026-08-29

### DW-441: `fetchUrlContent` skips the content-type allowlist entirely when the response omits a Content-Type header.
origin: migrated from legacy ledger ("Deferred from: code review of spec-2-1-upload-drag-drop-and-url-intake.md (2026-08-22)"), 2026-08-26
location: src/lib/fetch.ts:232
reason: The guard reads `if (mimeType && !allowed.includes(...))`, so a response with no Content-Type passes unchecked regardless of what it actually contains. Deferred as pre-existing empty-header behaviour: this story only narrowed the allowlist that is passed in, and tightening the empty case changes behaviour for every existing caller of the shared fetch path.
status: open
decision: 2026-08-28 Sniff, then refuse — When Content-Type is absent, sniff the body's leading bytes against the allowlist and refuse only what does not match, so well-behaved headerless servers still work; apply to both doors and pin with fixtures.
decision: 2026-08-26 Sniff, then refuse — When Content-Type is absent, sniff the body's leading bytes against the allowlist and refuse only what does not match, so well-behaved headerless servers still work; apply to both doors and pin with fixtures.

### DW-442: Legacy manual `sourceUrls` are still accepted by research creation even though automated runs replace them with provider results.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-decision-dw-442
resolution-undo: 92d359a3936d4daee6e56d3792bac58f226453fcacde09bb56c9e52e9a464593 2026-08-29 7374617475733a206f70656e
origin: migrated from legacy ledger ("Deferred from: code review of spec-6-1-through-6-5-deep-research.md (2026-08-24)"), 2026-08-26
archived: 2026-08-29

### DW-443: The shared kernel URL guard rejects literal private hosts but never resolves DNS before fetching, leaving a DNS-rebinding SSRF gap.
origin: migrated from legacy ledger ("Deferred from: code review of spec-6-1-through-6-5-deep-research.md (2026-08-24)"), 2026-08-26
location: src/lib/url-safety.ts:95
reason: The guard blocks private and reserved addresses only when they appear literally in the URL; a hostname that resolves to such an address — or re-resolves to one between check and fetch — passes. Deferred because the gap predates Epic 6 and lives in the shared fetch path used well beyond Deep Research, so closing it is a cross-cutting change rather than a Deep Research fix.
status: open
decision: 2026-08-28 Per-runtime guard — Make validateUrlSafety async, add a Node implementation that resolves DNS and pins the resolved address through to connect time, and a Workers implementation that relies on an egress proxy or allowlist; document which protection each target actually has.
decision: 2026-08-26 Egress allowlist — Leave the guard synchronous and place the real control at egress — an allowlist or proxy the deployment configures — documenting that literal-IP checking is defence in depth, not the boundary.

### DW-444: Extract pending-turn and session transport from ChatCanvas.tsx.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-chat-canvas-transport-extract
resolution-undo: 15ccf449508fbd8379a414a463000c49908da298a2d9e5fa1070dde78ed5d402 2026-08-29 7374617475733a206f70656e
origin: migrated from legacy ledger ("Deferred from: split of epic-8-retro-architecture-follow-on (2026-08-26)"), 2026-08-26
archived: 2026-08-29

### DW-445: Extract the API/MCP category from the generic Settings pair.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-settings-api-mcp-category-extract
resolution-undo: efd74897002ddbf6666e6d804364305806fd666f85c17f9f6ff37c11ab8de695 2026-08-30 7374617475733a206f70656e
origin: migrated from legacy ledger ("Deferred from: split of epic-8-retro-architecture-follow-on (2026-08-26)"), 2026-08-26
archived: 2026-08-31

### DW-446: Inline parts still consume attachment-count slots and aggregate-budget bytes while being excluded from every countable loss, so the over-cap sentence can quote a limit the sender never reached and an

status: done 2026-08-29
resolution: resolved by sweep bundle dw-email-inline-part-eligibility
resolution-undo: ac9ad29685934186b979a6658e3dfa457129a22e708f46200863174ccbf96506 2026-08-29 7374617475733a206f70656e
origin: spec-deferred de0d1c34e95a
source_spec: `spec-dw-358-362-email-worker-caps-and-aggregate-budget.md`
archived: 2026-08-29

### DW-447: Raising the raw cap widens the band in which the Worker forwards a single attachment above the route's per-document ceiling, and the route answers that with a 400 that loses the body and every sibling

status: done 2026-08-28
origin: spec-deferred 3496e6f2df4d
source_spec: `spec-dw-358-362-email-worker-caps-and-aggregate-budget.md`
archived: 2026-08-29

### DW-448: Nothing bounds the parse-time buffered peak, which this change roughly doubled by raising the raw cap.

status: done 2026-08-28
origin: spec-deferred 32f52b5643ef
source_spec: `spec-dw-358-362-email-worker-caps-and-aggregate-budget.md`
archived: 2026-08-29

### DW-449: The 62.4 MB now quoted to senders may exceed Cloudflare Email Routing's own inbound message ceiling, making the widening unreachable in production.
origin: spec-deferred a47c1f40039c
source_spec: `spec-dw-358-362-email-worker-caps-and-aggregate-budget.md`
location: workers/email-ingest/index.ts (MAX_RAW_EMAIL_MB refusal copy)
severity: low
reason: Email Routing is reported to enforce an inbound per-message limit of roughly 25 MiB. Nothing in `wrangler.jsonc`, `workers/email-ingest/README.md` or this repo records that figure, and it could not be verified offline, so nothing was clamped. If the premise holds, the shapes this derivation was widened to admit — ten byte-dense quoted-printable parts at 65,431,170 bytes — never reach the Worker at all, and the refusal copy invites a resend under a ceiling the transport rejects first.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-email-raw-message-ceiling
resolution-undo: 941783c3125f5f8699b110a7b68b54a08e8cf1ae9522ffaf4bf93696e37c16ae 2026-08-31 7374617475733a206f70656e
decision: 2026-08-28 Verify and clamp — Verify Email Routing's current inbound per-message limit, record it in workers/email-ingest/README.md and beside the constant, and clamp MAX_RAW_EMAIL_BYTES to it so MAX_RAW_EMAIL_MB quotes a figure a sender can actually reach.

### DW-450: `inlineAttachment` reads only `disposition`, so a signature logo sent with a Content-ID but no Content-Disposition header still produces the phantom skipped- attachment line DW-359 exists to remove.
origin: spec-deferred 1e0945b2e0c0
source_spec: `spec-dw-358-362-email-worker-caps-and-aggregate-budget.md`
location: workers/email-ingest/index.ts (inlineAttachment)
severity: low
reason: The predicate is `attachment.disposition === "inline"`, and its comment records the deliberate choice to treat a `null` disposition as a real attachment rather than risk dropping a file the sender really sent. postal-mime also exposes `contentId` and a `related` flag, and DW-359's own text describes the noisy parts as having `disposition: "inline"` AND a `contentId`. A client that emits `Content-ID` without a disposition header therefore keeps the behaviour the entry was filed against. Widening the predicate is a separate decision about which signal to trust.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-email-inline-part-eligibility
resolution-undo: ca6a99e4053222951e4d8167e59176aefdde374e63efe44589a9fd964c207ee9 2026-08-31 7374617475733a206f70656e
decision: 2026-08-28 Trust Content-ID too — Widen inlineAttachment to treat a part carrying a contentId that the HTML body references as inline even when disposition is absent, leaving a bare null disposition with no contentId as a real attachment, and pin both shapes with fixtures.

### DW-451: The Worker computes the trimmed site URL twice, so the two copies can still drift; hoisting one const would remove the drift class the new link tests guard against.
origin: spec-deferred e486073282e7
source_spec: `spec-dw-253-357-363-364-366-367-email-ingest-route-and-worker-tests.md`
location: workers/email-ingest/index.ts:752
severity: low
reason: `(env.YOPEDIA_SITE_URL || "").replace(/\/+$/, "")` appears at workers/email-ingest/index.ts:752 (forwarded request) and again at :813 (acknowledgement links). DW-363 exists only because the second copy was unpinned. Both are now pinned, but a single `const site` hoisted above the `try` -- keeping `if (!site) throw` inside it -- would make drift structurally impossible. Pre-existing duplication; this change pinned it rather than removing it.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-email-worker-forward-reply-tail
resolution-undo: 0cb9a33bc525713fffef0734acfa7653afe9bcd687b5c890c878fb529e1fd75b 2026-08-31 7374617475733a206f70656e

### DW-452: The Worker's `!response.ok` exit replies with the route's error alone, discarding every loss sentence, so a route refusal hides which attachments were dropped.
origin: spec-deferred 29a0cc7bff66
source_spec: `spec-dw-253-357-363-364-366-367-email-ingest-route-and-worker-tests.md`
location: workers/email-ingest/index.ts:808
severity: low
reason: `if (!response.ok) { await reply(message, subject, safeError(result)); return; }` at workers/email-ingest/index.ts:808 drops `oversizedLine`, `overBudgetLine` and the over-cap and unsupported sentences. Pre-existing shape -- this change adds a fourth sentence to the set that exit already discarded.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-email-worker-forward-reply-tail
resolution-undo: 0cb9a33bc525713fffef0734acfa7653afe9bcd687b5c890c878fb529e1fd75b 2026-08-31 7374617475733a206f70656e

### DW-453: Nothing asserts that the Worker's body truncation lands exactly on MAX_EMAIL_CONTENT_CHARS, so an off-by-one there would 400 every long email with the route's new gate test green.
origin: spec-deferred 1973ea48dc02
source_spec: `spec-dw-253-357-363-364-366-367-email-ingest-route-and-worker-tests.md`
location: workers/email-ingest/index.ts:739
severity: low
reason: `rawContent.slice(0, MAX_EMAIL_CONTENT_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER` at workers/email-ingest/index.ts:739 is untouched by this change and unobserved. DW-366 now pins the route's `content.length > MAX_EMAIL_CONTENT_CHARS` 400, which makes the pairing load-bearing: the Worker must truncate to a length the route accepts.
status: done 2026-08-31
resolution: already resolved: workers/email-ingest/index.ts:228-230 — MAX_RAW_EMAIL_BYTES is now ceil(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES x WORST_CASE_TRANSFER_ENCODING_FACTOR) + MIME_ENVELOPE_HEADROOM_BYTES = 65,496,679, not the 14,414,471 this entry describes. Against the 10 MiB per-document ceiling (index.ts:46) an attachment now survives the raw gate up to ~47.8 MB decoded under base64 and ~20.97 MB under quoted-printable, so the per-file oversize skip at index.ts:508-513 has a 10 MiB-to-~21 MB band, not the ~50 KB band the entry names. DW-358 and DW-362 widened the cap 4.5x after this entry was filed.

### DW-454: The Worker's forwarded `attachmentNames` uses a bare `|| "unnamed attachment"` with no trim, so a whitespace-named part is called "unnamed attachment" in the reply but forwarded as whitespace, which t
origin: spec-deferred fae8dd937071
source_spec: `spec-dw-253-357-363-364-366-367-email-ingest-route-and-worker-tests.md`
location: workers/email-ingest/index.ts:747
severity: low
reason: workers/email-ingest/index.ts:747 builds the recorded names with `attachment.filename || "unnamed attachment"`, while `replyAttachmentName` (:429) scrubs and trims before falling back. `sanitizeAttachmentNames` in src/lib/email-ingest.ts then drops the whitespace name, so the recorded list and the sender's reply disagree about the same part. Pre-existing; routing that build through `replyAttachmentName` would settle it.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-email-worker-forward-reply-tail
resolution-undo: 0cb9a33bc525713fffef0734acfa7653afe9bcd687b5c890c878fb529e1fd75b 2026-08-31 7374617475733a206f70656e

### DW-455: `fix_lint_issue` on the HTTP MCP transport gates `type` but still forwards `slug`, `target` and `message` to the handler with no check, so the two lint-fix doors now enforce different contracts for th

status: done 2026-08-29
resolution: resolved by sweep bundle dw-mcp-rest-door-parity
resolution-undo: e61b6550811aed7194f363080d6b27679d0d79c5aa1900b253385cd30754f0d9 2026-08-29 7374617475733a206f70656e
origin: spec-deferred e087978212e5
source_spec: `spec-dw-341-343-346-347-348-advertised-input-and-fix-type-parity.md`
archived: 2026-08-29

### DW-456: `POST /api/lint/fix` never passes the owner's handle as `author`, so every REST lint fix is attributed to the default `"lint-fix"` while both MCP doors pass the real principal.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-mcp-rest-door-parity
resolution-undo: e61b6550811aed7194f363080d6b27679d0d79c5aa1900b253385cd30754f0d9 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 679ba44876d9
source_spec: `spec-dw-341-343-346-347-348-advertised-input-and-fix-type-parity.md`
archived: 2026-08-29

### DW-457: `missing-concept-page` is effectively unreachable over both MCP transports: `slug` is required in both schemas though the type reads `message` alone.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-mcp-rest-door-parity
resolution-undo: e61b6550811aed7194f363080d6b27679d0d79c5aa1900b253385cd30754f0d9 2026-08-29 7374617475733a206f70656e
origin: spec-deferred fa89864ceffa
source_spec: `spec-dw-341-343-346-347-348-advertised-input-and-fix-type-parity.md`
archived: 2026-08-29

### DW-458: `autoFixRefusal(type, "")` renders `PATCH /api/wiki/` with an empty slug segment, contradicting the copy-pasteability rationale the change states for gating at the doors.
origin: spec-deferred 48ad75afbe4a
source_spec: `spec-dw-341-343-346-347-348-advertised-input-and-fix-type-parity.md`
location: src/lib/lint-fix.ts:830
severity: low
reason: Both doors deliberately pass `""` when no usable slug arrived. For `disputed-page` the `NOT_AUTO_FIXABLE` sentence then reads `Reconcile the conflicting claims in "", then clear the Disputed toggle in the page editor (PATCH /api/wiki/ with metadata { disputed: false })` — a path that 404s if pasted. `src/mcp.ts`'s own comment argues the sentence must name the sibling slug to be worth keeping. No test sends a slug-less non-fixable type to either door.
status: open

### DW-459: `MaintainFixType` has no compile-time constraint to `AutoFixableCheckType`, so it remains an un-derived restatement of a subset of the fixable list.
origin: spec-deferred e7aae2c2adb1
source_spec: `spec-dw-341-343-346-347-348-advertised-input-and-fix-type-parity.md`
location: src/lib/tasks.ts:285
severity: low
reason: This change pins `MAINTAIN_FIX_TYPES` to `MaintainFixType` in both directions, but the union itself (`src/lib/tasks.ts:285-292`) is a bare literal union with no reference to `AutoFixableCheckType`. A member dropped from `AUTO_FIXABLE_CHECK_TYPES` would still compile here and surface only as a runtime `FixValidationError` on the maintenance path (`src/app/api/tasks/run/route.ts:255`). The bundle intent named the restatements of the fixable list, not the subset relation between the two lists.
status: done 2026-09-01
resolution: resolved by sweep bundle dw3-email-worker-decoded-byte-budget
resolution-undo: 87e62427843d8e17e02e56e9c5a773a3944f09414b9994ebdacf950be5f20cf4 2026-09-01 7374617475733a206f70656e

### DW-460: The graph-page source scan parses the `<canvas>` opening tag with `<canvas\b[^>]*>`, which any `>` inside a prop breaks.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-test-pin-hardening
resolution-undo: d2ceccf34b82290c82fc411e41049bc02d8bbd0be47cc5f524d0e7fecac6df5c 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 1bedb5b742ac
source_spec: `spec-dw-128-131-338-339-340-doc-drift-retired-surfaces.md`
archived: 2026-08-29

### DW-461: The DW-131 escape hatch is pinned only by regex over the page's source text; no test renders the page and asserts a reachable link.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-test-pin-hardening
resolution-undo: d2ceccf34b82290c82fc411e41049bc02d8bbd0be47cc5f524d0e7fecac6df5c 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 45addfb1aca0
source_spec: `spec-dw-128-131-338-339-340-doc-drift-retired-surfaces.md`
archived: 2026-08-29

### DW-462: Nothing pins the Knowledge *tab* itself, only the route the escape hatch points at.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-test-pin-hardening
resolution-undo: d2ceccf34b82290c82fc411e41049bc02d8bbd0be47cc5f524d0e7fecac6df5c 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 7ef8dc4c1588
source_spec: `spec-dw-128-131-338-339-340-doc-drift-retired-surfaces.md`
archived: 2026-08-29

### DW-463: The graph canvas is keyboard-focusable and click-activated with no keyboard activation path.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-graph-canvas-keyboard-activation
resolution-undo: 32586a7c4c5492e415950355d85f9578133b9cb67663ae831ca00f641416c26b 2026-08-29 7374617475733a206f70656e
origin: spec-deferred fe831dd7f6d5
source_spec: `spec-dw-128-131-338-339-340-doc-drift-retired-surfaces.md`
archived: 2026-08-29

### DW-464: `KNOWLEDGE_TREE_HREF` carries no lens scope, while the graph it is an alternative to is scoped by `?scope=`.

status: done 2026-08-28
origin: spec-deferred 438c15df14ac
source_spec: `spec-dw-128-131-338-339-340-doc-drift-retired-surfaces.md`
archived: 2026-08-29

### DW-465: `ensureDiscussDir()`'s doc comment still says it creates the directory, above an empty no-op body.
origin: spec-deferred 7735b56e55bd
source_spec: `spec-dw-128-131-338-339-340-doc-drift-retired-surfaces.md`
location: src/lib/talk.ts:63
severity: low
reason: src/lib/talk.ts:63 reads "Creates the `discuss/` directory if it doesn't exist" over a body whose only content is `/* Storage provider creates parent directories on write — no-op. */`. This pass corrected SCHEMA.md about exactly this fact and left the comment a caller actually reads as the stale one.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-talk-surface-truth
resolution-undo: 6aa52e284f23545e6b9c56b7d5165ef2332d8c9cd738d7063d87f10bdf8ba617 2026-09-02 7374617475733a206f70656e

### DW-466: `.yoyo/status.md`'s header metrics are far staler than the two lines this pass pinned.
origin: spec-deferred 6c491673c35d
source_spec: `spec-dw-128-131-338-339-340-doc-drift-retired-surfaces.md`
location: .yoyo/status.md:4
severity: low
reason: `**Generated:** 2026-06-02`, `- **API routes:** 32` (148 `route.ts` files under src/app/api), `- **Test files:** 58` (325), `- **Test count:** 2,054` (7,461 passing). Pinning the MCP tool list and the lint-check list makes the surrounding metrics read as maintained when they are not.
status: open

### DW-467: DESIGN-triggers.md contradicts itself on lint-check counts, and none of the three numbers is pinned.
origin: spec-deferred 5c7ee32b3da7
source_spec: `spec-dw-128-131-338-339-340-doc-drift-retired-surfaces.md`
location: DESIGN-triggers.md:454
severity: low
reason: `:141` and `:404` say "15 lint check types"; `:454` says "lint checks already detect 14 condition types". 15 matches `ALL_CHECK_TYPES` (src/lib/lint-types.ts) today, so `:454` is the wrong one — but all three are hand-written, and the file's only pin is the MCP tool count in mcp-annotations.test.ts.
status: open

### DW-468: `showSplitHandle`'s collapsed-column branch is still unmounted — nothing observes that a collapsed left column withdraws its divider.
origin: spec-deferred 38041b9ba57d
source_spec: `spec-dw-108-111-113-dom-test-environment-fidelity.md`
location: src/components/workbench/__tests__/workbench-split-wiring.test.tsx
severity: low
reason: The width harness makes the branch reachable for the first time, but the new cases only exercise `previewOpen` (the Preview divider's condition) and the measured guard. A shell that rendered a tree divider over a zero-width track would keep the whole suite green: `showSplitHandle("tree", …)` returns `!layout.collapsed`, and no mounted case sets `writeStoredCollapsed(true)` at a declared width.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-mounted-rail-tree-split-coverage
resolution-undo: 799de0dacb06db7787a2e0686669e6e5f90cd096c1a99f801dff5da0a487db3b 2026-09-02 7374617475733a206f70656e

### DW-469: DW-24's roving `tabindex` / arrow-key surface is now mountable, and the comment that used to excuse it no longer does.
origin: spec-deferred fe6c2e7d46db
source_spec: `spec-dw-108-111-113-dom-test-environment-fidelity.md`
location: src/components/workbench/TreePanel.tsx
severity: low
reason: `TreePanel.tsx`'s docblock rested the deliberate not-an-ARIA-tree decision on there being no way to verify focus machinery. That premise was corrected in this pass (the `dom` project executes focus order — `workbench-sheet.test.tsx` asserts `document.activeElement` after synthetic Tab), which leaves the decision itself defended only by the assistive-technology half. Whether the tablist and the tree rows keep their full keyboard surface is now testable and untested.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-mounted-rail-tree-split-coverage
resolution-undo: 799de0dacb06db7787a2e0686669e6e5f90cd096c1a99f801dff5da0a487db3b 2026-09-02 7374617475733a206f70656e

### DW-470: Two source-tree walkers still hand-roll the traversal `walkFiles` now owns, and both descend into `__tests__`.
origin: spec-deferred d6e15d9fde5e
source_spec: `spec-dw-112-117-228-test-infra-shared-helpers.md`
location: src/lib/__tests__/read-only-door-coverage.test.ts:113
severity: low
reason: `routeFiles()` (src/lib/__tests__/read-only-door-coverage.test.ts:113) and `retiredSurfacesOnDisk()` (src/lib/__tests__/retired-surfaces.test.ts:49) implement the same "descend and collect by basename" contract as the seven suites migrated here, with no exclusions at all. Neither is named `walk()`, so neither appeared in the intent's census of eight; migrating them was out of scope on the intent's own authority. No file exists under a `__tests__` directory that either would currently mishandle, so this is latent rather than active.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-shared-test-helper-extraction
resolution-undo: 48060ee7b14d816f7b1256e34b9a261a5a5e2d6b6603343dde92f9e75b28e0c0 2026-09-02 7374617475733a206f70656e

### DW-471: The fifth mounted Settings suite still carries its own ~50-field payload because the shared harness is not reachable from its directory.
origin: spec-deferred 9a412cc9857a
source_spec: `spec-dw-112-117-228-test-infra-shared-helpers.md`
location: src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx
severity: low
reason: `src/app/settings/__tests__/settings-page-legacy-surface-parity.test.tsx` duplicates the fixture the new `settings-harness.tsx` consolidates for the four workbench suites, but the harness lives inside `src/components/workbench/__tests__/` and is reachable only by a `./` sibling import. Folding it in would need the harness to move somewhere aliasable (mirroring `src/test/`), which the intent did not ask for.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-settings-test-harness-consolidation
resolution-undo: ccb2e9575c2032e960306922bd121dc1431d74a0658669a4eb7435a96b013cc3 2026-09-02 7374617475733a206f70656e

### DW-472: Two settings fixtures override `version` to a different stamp shape than the shared base with no explanation of why both shapes exist.
origin: spec-deferred 5159aae5de1b
source_spec: `spec-dw-112-117-228-test-infra-shared-helpers.md`
location: src/components/workbench/__tests__/settings-vector-namespace.test.tsx
severity: low
reason: `settings-vector-namespace.test.tsx` and `settings-embedding-provider-switch.test.tsx` state `version: "w1:2-0000000000000000"` where `settingsPayload()`'s base is `"s1:00000000000000000000000000000000"`. No assertion in either file reads `version`, and both values predate this change, so the consolidation preserved rather than caused the divergence — but it is now visible as an unexplained delta on the shared base.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-settings-test-harness-consolidation
resolution-undo: ccb2e9575c2032e960306922bd121dc1431d74a0658669a4eb7435a96b013cc3 2026-09-02 7374617475733a206f70656e

### DW-473: IDENTIFIER_ALLOWLIST still waives the X-Yopedia-* wire headers as an unanchored SHAPE, which is the same defect DW-352 fixed for the lowercase-hyphen family.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-test-pin-hardening
resolution-undo: d2ceccf34b82290c82fc411e41049bc02d8bbd0be47cc5f524d0e7fecac6df5c 2026-08-29 7374617475733a206f70656e
origin: spec-deferred cddb7f5d81ed
source_spec: `spec-dw-351-356-brand-copy-scan-coverage.md`
archived: 2026-08-29

### DW-474: Minimality is enforced for YOPEDIA_HYPHEN_IDENTIFIERS only; every other yopedia waiver and all of WORKWIKI_IDENTIFIER_ALLOWLIST can outlive what it waived.
origin: spec-deferred 1f50b75afdfc
source_spec: `spec-dw-351-356-brand-copy-scan-coverage.md`
location: src/lib/__tests__/brand-copy.test.ts
severity: low
reason: The new "keeps every waived yopedia resource name earning its place" test sweeps the corpus for the hyphen enumeration only. /u/yopedia, the health-check bodies, yopedia.yolog.dev, yopedia.yuanhao-li.workers.dev, yologdev/yopedia, yopedia--, yopedia_ and the whole workwiki allowlist have no equivalent, so a retired identifier leaves its word permanently waived as display copy -- the failure mode the enumeration comment itself argues is real.
status: open

### DW-475: The anchored hyphen family's LEADING boundary allows a dot, so a lookalike host such as cdn.yopedia-raw.example.com stays waived.
origin: spec-deferred 22fbd3206d59
source_spec: `spec-dw-351-356-brand-copy-scan-coverage.md`
location: src/lib/__tests__/brand-copy.test.ts (YOPEDIA_HYPHEN_BOUNDS)
severity: low
reason: YOPEDIA_HYPHEN_BOUNDS blocks [A-Za-z0-9_-] on both sides. A trailing dot is deliberately allowed and documented (live workers.dev hostname, /tmp/*.log basenames); a LEADING dot is allowed only as a side effect. A leading slash must stay allowed for /tmp/yopedia-r2.log, so this is a narrowing of the lookbehind, not a removal.
status: open

### DW-476: `parseRegistry` refuses a non-array registry but validates no element, so an array of non-project entries still crashes later with an opaque TypeError.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-research-store-input-and-cap-hardening
resolution-undo: f70679012685b822f439980b39143a3ed0cc418fae086e8cb4ced5c0b240e6bf 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 0cd43f136117
source_spec: `spec-dw-296-297-298-research-store-hardening.md`
archived: 2026-08-29

### DW-477: A non-list registry now wedges a tenant with no in-product repair path.
origin: spec-deferred a0633dfd255b
source_spec: `spec-dw-296-297-298-research-store-hardening.md`
location: src/lib/research-projects.ts:184
severity: medium
reason: Every research operation for that owner refuses, including the deletes that could shrink the file, and the 500 body carries no remediation. The lease equivalent tells the operator what to do (`research-runtime.ts:886`: "Repair the lease state, then retry."). Refusing is the intended DW-297 behaviour; the missing half is a recovery route.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-registry-repair-and-urls
resolution-undo: e8b9a10d3b9074e753b1f390284d92f6fbda87d9ef747da900adb55e0d9c41e1 2026-08-31 7374617475733a206f70656e
decision: 2026-08-28 Quarantine-and-restart route — Add an owner-only repair route that moves an unparseable registry aside to a timestamped quarantine key, starts a fresh empty registry, and returns the quarantined path; have the refusing 500 body name that route, and pin that no readable registry is ever quarantined.

### DW-478: `PATCH`/`DELETE /api/research/[id]` and the v1 `deep_research` action still map `ClientInputError` to 500, the same misclassification DW-296 fixed one door over.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-research-store-input-and-cap-hardening
resolution-undo: f70679012685b822f439980b39143a3ed0cc418fae086e8cb4ced5c0b240e6bf 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 189d32bd8390
source_spec: `spec-dw-296-297-298-research-store-hardening.md`
archived: 2026-08-29

### DW-479: `retireResearchProject`'s soft delete counts against the create cap while the panel hides those rows.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-research-store-input-and-cap-hardening
resolution-undo: f70679012685b822f439980b39143a3ed0cc418fae086e8cb4ced5c0b240e6bf 2026-08-29 7374617475733a206f70656e
origin: spec-deferred d96380ea82bf
source_spec: `spec-dw-296-297-298-research-store-hardening.md`
archived: 2026-08-29

### DW-480: `POST /api/research/[id]/run` still classifies failures by message regex.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-research-run-route-error-typing
resolution-undo: 17fc47581e89988766b4bf51ab5b234bd3c8e4474e8e477ca08cb273685072bd 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 1caab8b40809
source_spec: `spec-dw-296-297-298-research-store-hardening.md`
archived: 2026-08-31

### DW-481: Sibling `/required|invalid/i` status regexes remain on three other routes.
origin: spec-deferred 5dbcff19cdef
source_spec: `spec-dw-296-297-298-research-store-hardening.md`
location: src/app/api/monitors/route.ts:53
severity: low
reason: `src/app/api/monitors/route.ts:53`, `src/app/api/system/evaluations/route.ts:58` and `src/app/api/review/proposals/route.ts:78` each 400 any message matching `/required|invalid|.../i`, so a storage `EINVAL` is reported as the caller's fault there for the same reason DW-296 named.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-store-fault-status-classification
resolution-undo: ecd678bb69e1aee9ec59fdf681c8cfbab068953218fa2141f628b2a97d6aa1ff 2026-08-31 7374617475733a206f70656e

### DW-482: A corrupt registry now makes a `run-research` task retry to the DLQ instead of poisoning on first delivery, and the task classifier has no row for a store fault.
origin: spec-deferred c27d0a0a7d14
source_spec: `spec-dw-296-297-298-research-store-hardening.md`
location: src/app/api/tasks/run/route.ts:932
severity: low
reason: Before DW-297 a non-list registry made `getResearchProject` return null, so `runResearchProject` threw "Research project not found", which `src/app/api/tasks/run/route.ts:918` poisons at 422. The new throw matches neither `/not found/i` nor `ClientInputError`, so it falls to the 500 at `:932` and the queue re-delivers up to `max_retries: 3` before the DLQ. Bounded and arguably the correct classification for a repairable server fault, but it is an unpinned behaviour change with no test at the task surface.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-store-fault-status-classification
resolution-undo: ecd678bb69e1aee9ec59fdf681c8cfbab068953218fa2141f628b2a97d6aa1ff 2026-08-31 7374617475733a206f70656e

### DW-483: The DW-290 future-dated-mtime warn fires on every sweep pass for as long as the clock has not caught up, with no dedupe or rate limit.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-wiki-sweep-warn-and-tombstones
resolution-undo: 020b057c8448b3b983440c1987b281d5c8db0827df3245aef020dde13923241e 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 675f89601c07
source_spec: `spec-dw-210-290-291-382-383-wiki-sweep-and-lifecycle-tails.md`
archived: 2026-08-31

### DW-484: A registry write that reports failure after its bytes actually landed leaves the registry on the new scenario and the artifacts on the old, with a "clean" rollback and therefore no bump.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-scenario-template-failure-truth
resolution-undo: 7d1542c4c2d4b1fa95833a726570cdeb403e73d0fc63131b28636e52d3b80b5d 2026-08-30 7374617475733a206f70656e
origin: spec-deferred c22cef649f92
source_spec: `spec-dw-210-290-291-382-383-wiki-sweep-and-lifecycle-tails.md`
archived: 2026-08-31

### DW-485: The pre-existing DW-289 cap rows became calendar-dependent when the per-pass window started rotating on a UTC-day clock.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-wiki-sweep-warn-and-tombstones
resolution-undo: 020b057c8448b3b983440c1987b281d5c8db0827df3245aef020dde13923241e 2026-08-30 7374617475733a206f70656e
origin: spec-deferred f8ca87e4f546
source_spec: `spec-dw-210-290-291-382-383-wiki-sweep-and-lifecycle-tails.md`
archived: 2026-08-31

### DW-486: The middleware admits the owner by stable Clerk id while every `isOwnerHandle` route gate refuses by handle, so the two owner identities can disagree and lock the real owner out.

status: done 2026-08-29
resolution: resolved by sweep bundle dw2-owner-identity-gate-on-stable-id
resolution-undo: da460d2e7d3f42e3a08000de9503b7dfd13243050a8732f8a265db152127f867 2026-08-29 7374617475733a206f70656e
origin: spec-deferred da7ec1fb2ee0
source_spec: `spec-dw-159-288-wiki-ownership-gate-and-sweep-scope.md`
archived: 2026-08-29

### DW-487: `requireOwnerPrincipal` is fail-OPEN when no owner handle is configured while the direct `isOwnerHandle` gates are fail-CLOSED, and nothing records the divergence.

status: done 2026-08-29
origin: spec-deferred 4a169ed4676e
source_spec: `spec-dw-159-288-wiki-ownership-gate-and-sweep-scope.md`
archived: 2026-08-31

### DW-488: Stale discard tombstones on pre-gate non-owner tenants are cleared by nothing, which is a second residual beyond the orphan directories the DW-288 scope note records.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-wiki-sweep-warn-and-tombstones
resolution-undo: 020b057c8448b3b983440c1987b281d5c8db0827df3245aef020dde13923241e 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 1ea21f891a70
source_spec: `spec-dw-159-288-wiki-ownership-gate-and-sweep-scope.md`
archived: 2026-08-31

### DW-489: A `wiki/` display path asked for directly still previews one object and saves another: the read gate and the preview route's slug derivation were left at their old reach, so only the LISTING door was
origin: spec-deferred 2bf03502f431
source_spec: `spec-dw-202-203-204-workbench-file-path-invariants.md`
location: src/app/api/workbench/preview/route.ts (slug derivation); src/lib/workbench-files.ts (resolveWorkbenchFile)
severity: medium
reason: DW-202/203 was fixed at the listing on the authority of the recorded 2026-08-19 decision ("list only the canonical `<slug>.md` row and drop the variant-cased sibling from the Files tab"), and the ledger itself records the defect as "pre-existing at the read and edit layers". So the harm is narrowed but not closed: `readWorkbenchFile`/`workbenchFileExists` still serve `wiki/cased.MD`, and `src/app/api/workbench/preview/route.ts` still hands it slug `cased` with `editable: true`. A deep link, a restored selection from `workbench-state`, or any API caller that names the display path directly reproduces the original defect — preview `cased.MD`, save `cased.md`. Deliberately not closed here: the route's page/file disambiguation is what DW-41's intent put out of bounds, and reverting the slug for an odd-cased name would re-break the case-INSENSITIVE store, where that name IS the Page and a case-sensitive test there once made it read-only from the Files tab. Closing it properly needs a rule t
status: done 2026-09-03
resolution: resolved by sweep bundle dw-case-variant-file-election
resolution-undo: 3f66b2f76858108684d8faa716744803eec6d82813c511fa74a7ac95d9683b0e 2026-09-03 7374617475733a206f70656e
decision: 2026-08-28 Extend the election to the read layer — Give resolveWorkbenchFile, readWorkbenchFile, workbenchFileExists and the preview route's slug derivation the same elected-winner rule the listing uses, so a directly-named case variant answers exactly as the listing does on both store kinds, and pin the case-insensitive-store behaviour that a naive revert would break.

### DW-490: The row that CREATES a collision is still editable: a lone `wiki/cased.MD` on a case-sensitive store lists, is handed slug `cased`, and the first save from it writes `wiki/cased.md` — orphaning the pr
origin: spec-deferred 1aade515c369
source_spec: `spec-dw-202-203-204-workbench-file-path-invariants.md`
location: src/lib/wiki.ts (writeWikiPage / writeWikiPageIfContentMatches); src/app/api/workbench/preview/route.ts
severity: medium
reason: The elected-winner rule keys on the candidate names present AT LISTING TIME, which is what lets a lone variant keep listing (it must: on a case-INSENSITIVE store that name is the only real Page). But the wiki write path targets `<slug>.md` unconditionally (`writeWikiPage`/`writeWikiPageIfContentMatches`, `src/lib/wiki.ts`), so on a case-sensitive store the first save from that row creates a SECOND object. From then on the collision exists, the election correctly drops the `.MD` row, and its bytes are orphaned with no surface that mentions them. So the decision's mechanism ("drop the sibling") is implemented while its stated purpose ("every visible row reads and writes the same object") holds only after a collision already exists — never for the row that creates one. Same root cause as the entry above: the fix has to reach the save half, which the recorded decision scoped out.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-case-variant-file-election
resolution-undo: 3f66b2f76858108684d8faa716744803eec6d82813c511fa74a7ac95d9683b0e 2026-09-03 7374617475733a206f70656e
decision: 2026-08-28 Write to the object that was read — Make the wiki write path target the object the row was read from rather than an unconditional <slug>.md, so a save from a lone case-variant row rewrites that object instead of creating a second one, and pin the behaviour on both a case-sensitive and a case-insensitive store.

### DW-491: `raw/assets/<slug>/<file>` is silo-mirrored and still spells a hidden page's slug, so DW-32's disclosure survives in the assets subtree.

status: done 2026-08-28
resolution: resolved by sweep bundle dw-workbench-raw-path-gate-parity
resolution-undo: 78fc2a306dbc82574ae9fc972ff0290fa59608409488f39809bb76b051332b92 2026-08-28 7374617475733a206f70656e
origin: spec-deferred 5c91aa99b543
source_spec: `spec-dw-32-42-workbench-read-write-gate-parity.md`
archived: 2026-08-29

### DW-492: A page slugged plain `queries` with sharded sources is not refused — the two-segment `queries/<leaf>` branch swallows the snapshot id.
origin: spec-deferred 62d6499278be
source_spec: `spec-dw-32-42-workbench-read-write-gate-parity.md`
location: src/lib/workbench-files.ts:207
severity: low
reason: `validateSlug` admits `queries` as an ordinary one-segment slug as well as the prefixed `queries/<leaf>` shape. For a page slugged `queries`, `saveRawSourceFor` writes `raw/sources/queries/<sha>.md`; `rawPathSlug` sees head `queries` with a following segment and returns `queries/<sha>` instead of `queries`, so a hidden page slugged `queries` is not refused. Fix: have `rawPathAllowed` test BOTH candidates (`queries` and `queries/<leaf>`) when the head is `queries`. Triaged `patch` (low), not applied — session budget.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-raw-path-gate-reach
resolution-undo: f947a5bf826190bd472159a840ecbf21c37c9d84390482c41b43c01afa2c23e6 2026-09-03 7374617475733a206f70656e

### DW-493: `rescanSources`' `hiddenSlugs` forwarding is never exercised with a non-empty set, so the gate on the one door a caller can point at an arbitrary raw path is unpinned.

status: done 2026-08-28
resolution: resolved by sweep bundle dw-workbench-raw-path-gate-parity
resolution-undo: 78fc2a306dbc82574ae9fc972ff0290fa59608409488f39809bb76b051332b92 2026-08-28 7374617475733a206f70656e
origin: spec-deferred eb0f588d2212
source_spec: `spec-dw-32-42-workbench-read-write-gate-parity.md`
archived: 2026-08-29

### DW-494: `frontmatterOf`'s docblock and two test comments claim parity with `PUT /api/wiki/[slug]` for an UNPARSEABLE frontmatter block; that route answers 500, not 403.

status: done 2026-08-28
resolution: resolved by sweep bundle dw-workbench-raw-path-gate-parity
resolution-undo: 78fc2a306dbc82574ae9fc972ff0290fa59608409488f39809bb76b051332b92 2026-08-28 7374617475733a206f70656e
origin: spec-deferred 52b740415ffc
source_spec: `spec-dw-32-42-workbench-read-write-gate-parity.md`
archived: 2026-08-29

### DW-495: Merge-base reads outside the three files this bundle named still read through pageCache without strict, including the MCP edit door that documents itself as mirroring the PUT route this change fixed.
origin: spec-deferred 98230f132919
source_spec: `spec-dw-378-379-merge-base-freshness.md`
location: src/mcp.ts:282
severity: medium
reason: Each site reads a page and hands those bytes back as `expectedContent`: src/mcp.ts:282 -> :349 (handleUpdatePage, whose comment at :286 says it "mirrors the REST surface at PUT /api/wiki/[slug]"), src/mcp.ts:1371 -> :1408, src/cli.ts:431 -> :468, src/lib/query.ts:507 -> :521, src/lib/ingest.ts:1432 -> :1484, src/lib/document-sources.ts:93 -> :126, src/lib/source-cascade.ts:229 -> :263, src/lib/agents.ts:792 -> :832 and :934 -> :977, src/lib/ingest-bookkeeping.ts:53 -> :76 and :186 -> :207. DW-379's location field named only patch-metadata.ts, merge.ts and lint-fix.ts, so these are out of this bundle's scope on the intent's own authority -- but they are the same hazard, and handleUpdatePage still answers "Page not found" (src/mcp.ts:284) for an unreadable page, which is DW-378 on the surface that claims parity with the fixed route.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-strict-merge-base-sweep
resolution-undo: e8a2283706b9dc11d8d1fa887133c755d62ae90ca3440755c2847c170ff1d1cf 2026-09-03 7374617475733a206f70656e

### DW-496: Write-authorizing reads that are not merge bases -- the DELETE route's ACL read and the two create-conflict guards -- still swallow a storage blip as "absent" and read through pageCache.
origin: spec-deferred e8080be9a31e
source_spec: `spec-dw-378-379-merge-base-freshness.md`
location: src/app/api/wiki/[slug]/route.ts:50
severity: medium
reason: src/app/api/wiki/[slug]/route.ts:50 sits inside DELETE (handlers at 26 / 146 / 356), not a GET: its frontmatter feeds canWriteFrontmatter at :60, and a non-ENOENT failure answers `page not found: <slug>` at :51-56, the exact DW-378 symptom on the delete door. src/app/api/wiki/route.ts:104 and src/mcp.ts:222 are the mirror case: `const existing = await readWikiPage(slug)` refusing with 409 / "Page already exists" when truthy, so a blip reads as "absent" and lets a create proceed against a page that exists. Structurally identical to lint-fix.ts:351, which this bundle did convert. Not named by DW-378 or DW-379, so out of scope here. NOTE: this spec's Never clause misdescribes route.ts:50 as a GET read serving a response; the exclusion is right by the intent's enumeration, the stated reason is not.
status: done 2026-09-02
resolution: already resolved: src/app/api/wiki/[slug]/route.ts:63-66, src/app/api/wiki/route.ts:114 and src/mcp.ts:258 now all read with { fresh: true, strict: true }, with the DW-378 rationale recorded at route.ts:57 and mcp.ts:254-257.

### DW-497: The revision-list GET still reports a storage blip as `page not found`, so DW-378's misreport survives on the read surface a human actually hits.
origin: spec-deferred 4f2ccecea4f4
source_spec: `spec-dw-378-379-merge-base-freshness.md`
location: src/app/api/wiki/[slug]/revisions/route.ts:29
severity: low
reason: src/app/api/wiki/[slug]/revisions/route.ts:29 reads without strict and turns the resulting null into a 404. DW-378's location field names only src/lib/wiki.ts:409 and the page write, and the read serves a response body rather than backing a write, so it is out of this bundle's scope -- but the harm DW-378 describes (an answer that makes a human stop retrying and start recovering) applies to a reader at least as much as a writer.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-strict-merge-base-sweep
resolution-undo: e8a2283706b9dc11d8d1fa887133c755d62ae90ca3440755c2847c170ff1d1cf 2026-09-03 7374617475733a206f70656e

### DW-498: `listNamesTerms` returns entries that are frozen at runtime while the exported `NamesTermEntry` type and the `Promise<NamesTermEntry[]>` return type still advertise them as mutable, so a would-be muta
origin: spec-deferred fe0bcfad64a2
source_spec: `spec-dw-394-397-names-terms-memo-hardening.md`
location: src/lib/names-terms.ts:16
severity: low
reason: DW-397 was closed with `Object.freeze` plus tests, and the spec put `readonly` types explicitly out of scope as a ripple beyond the fix. The residual asymmetry is real: `createNamesTerm` / `updateNamesTerm` return UNFROZEN entries of the same declared type, and both shapes reach `src/app/api/names-terms/route.ts` as `NamesTermEntry`, so a consumer reasoning from the type is right only half the time. A readonly return type (e.g. `Readonly<Omit<NamesTermEntry, "aliases">> & { readonly aliases: readonly string[] }`) would move the failure to compile time.
status: open
decision: 2026-08-31 Split the read type — Give listNamesTerms a distinct FrozenNamesTermEntry (Readonly<NamesTermEntry>) return type while NamesTermEntry itself stays mutable for the create and update paths, so the freeze is expressed in the type of the read without rippling into the write surface. Update the five read-only consumers to the new type and pin that a write through a read result fails to compile.

### DW-499: A corrupt `names-terms.json` holding a non-object element alongside real entries still throws out of the sort comparator in `resolveSortedEntries`, so the read fails rather than degrading.
origin: spec-deferred 3df66eaf3804
source_spec: `spec-dw-394-397-names-terms-memo-hardening.md`
location: src/lib/names-terms.ts:169
severity: low
reason: `readEntries` validates only `Array.isArray(parsed)`. The freeze loop added by this story now skips non-object elements, but the `.sort()` that runs BEFORE it dereferences `a.kind` / `a.canonical`, so `[null, entry]` throws `TypeError: Cannot read properties of null (reading 'kind')`. Confirmed empirically during this story: `[null]` alone resolves (the comparator is never called for a single element), two-or-more does not. Pre-existing — the throw predates this change and is unrelated to DW-394/DW-397 — but nothing validates entry shape at the read boundary.
status: open

### DW-500: `e2eOwnerHandle()`'s consumers were entirely unpinned before this change: every fixture set `NEXT_PUBLIC_OWNER_HANDLE` to the literal string `E2E_DEFAULT_HANDLE` already is.
origin: spec-deferred 9d558a647013
source_spec: `spec-dw-155-156-157-158-owner-and-schema-resolution-pins.md`
location: src/lib/__tests__/auth.test.ts and src/lib/__tests__/middleware-write-gate.test.ts
severity: low
reason: `E2E_DEFAULT_HANDLE` is `"e2e-owner"` (`src/lib/e2e-identity.ts:24`), and `e2e-identity.test.ts`, `auth.test.ts`, `middleware-write-gate.test.ts` and `e2e/env.ts` all configured exactly that handle, so `expect(x ?? DEFAULT).toBe(DEFAULT)` was the shape of every assertion — replacing the function body with `return E2E_DEFAULT_HANDLE;` left the whole suite green. This change closes the hole at the handle itself (`src/lib/__tests__/e2e-identity.test.ts`), but the SAME same-string-as-the-default fixture convention still governs `YOPEDIA_OWNER_USER_ID` / `e2eOwnerUserId()` and the middleware write gate, so sibling assertions there may be vacuous for the same reason. Pre-existing; the convention predates this change.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-test-suite-determinism
resolution-undo: c31fee82fe2c024a94a6fbc49e87257a58f1d712556f3a00390c1a71f11a685c 2026-09-02 7374617475733a206f70656e

### DW-501: `src/lib/__tests__/lint.test.ts:670` still `process.chdir`s into its tmpdir, which makes the suite cwd-sensitive if it ever throws before the `finally`.
origin: spec-deferred 3964a9e36702
source_spec: `spec-dw-155-156-157-158-owner-and-schema-resolution-pins.md`
location: src/lib/__tests__/lint.test.ts:670
severity: low
reason: The `includes SCHEMA.md conventions in contradiction detection prompt` test changes the process working directory and restores it in a `finally`. Vitest runs a file's tests in one worker process, so a restore that is skipped leaves every later test in that worker with a cwd it did not set, and `rootSchemaPath()` is `${process.cwd()}/SCHEMA.md`. The new DW-158 block deliberately avoids `chdir` for exactly this reason; making the older test use the explicit `schemaPath` override instead would remove the hazard. Pre-existing.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-test-suite-determinism
resolution-undo: c31fee82fe2c024a94a6fbc49e87257a58f1d712556f3a00390c1a71f11a685c 2026-09-02 7374617475733a206f70656e

### DW-502: `runStatus()` never awaits `loadConfig()`, so `yopedia status` reports env-only settings and is blind to anything the owner stored.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-cli-status-config-load
resolution-undo: d1de44965745c9ea1c77d07106312772d442610b53dfe209dff67edc7de99718 2026-08-29 7374617475733a206f70656e
origin: spec-deferred de4446ecbf37
source_spec: `spec-dw-369-417-418-provider-verdict-surfaces.md`
archived: 2026-08-29

### DW-503: `getConfiguredModel`'s pre-switch guard refuses a keyless Custom provider with no Settings destination, unlike its five sibling refusals.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-settings-pointer-derivation
resolution-undo: 3b9756105e36d2bdcec8197080dcb7f249c0fb81e9e5de622a3a05178883792b 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 13c8781cd594
source_spec: `spec-dw-369-417-418-provider-verdict-surfaces.md`
archived: 2026-08-31

### DW-504: Three constants in `chat-agent.ts` hand-type "Settings -> API + MCP", the same drift class DW-369 removed from `llm.ts`.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-settings-pointer-derivation
resolution-undo: 3b9756105e36d2bdcec8197080dcb7f249c0fb81e9e5de622a3a05178883792b 2026-08-30 7374617475733a206f70656e
origin: spec-deferred c0bc147e9aef
source_spec: `spec-dw-369-417-418-provider-verdict-surfaces.md`
archived: 2026-08-31

### DW-505: Selecting the blank "— Select provider —" option leaves the picker announcing the STORED provider's credential state.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-provider-form-a11y-and-blank-state
resolution-undo: 3e2d5baff6802c382679716007ee154ee8811511d2a1859edf259f294a8ab014 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 72044b520973
source_spec: `spec-dw-419-420-provider-picker-a11y-associations.md`
archived: 2026-08-29

### DW-506: The model input's "Leave empty to use the default model" hint is the same unassociated-sibling shape, four lines from the two this story fixed.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-provider-form-a11y-and-blank-state
resolution-undo: 3e2d5baff6802c382679716007ee154ee8811511d2a1859edf259f294a8ab014 2026-08-29 7374617475733a206f70656e
origin: spec-deferred cef642ce43c1
source_spec: `spec-dw-419-420-provider-picker-a11y-associations.md`
archived: 2026-08-29

### DW-507: Under an EMBEDDING_PROVIDER pin the provider row's hint still ends "What you save here applies only once that variable is unset", which promises a save the pin now refuses.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-embedding-provider-env-pin
resolution-undo: a5eabdf2ca61356e0076d774a6f82c9650d82e7cc792e80ee23143ab6f1544b3 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 9522d426da47
source_spec: `spec-dw-333-398-401-embedding-provider-resolution.md`
archived: 2026-08-29

### DW-508: An unsupported EMBEDDING_PROVIDER has no owner-visible signal on the embeddings surface at all — no pin, no invalid-value sentence, only the standing hint.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-embedding-provider-env-pin
resolution-undo: a5eabdf2ca61356e0076d774a6f82c9650d82e7cc792e80ee23143ab6f1544b3 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 187f1b705e53
source_spec: `spec-dw-333-398-401-embedding-provider-resolution.md`
archived: 2026-08-29

### DW-509: The runtime resolver and the vector gate disagree about a junk EMBEDDING_PROVIDER — the resolver refuses outright, the gate falls back to the stored provider.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-embedding-provider-env-pin
resolution-undo: a5eabdf2ca61356e0076d774a6f82c9650d82e7cc792e80ee23143ab6f1544b3 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 920819acd68d
source_spec: `spec-dw-333-398-401-embedding-provider-resolution.md`
archived: 2026-08-29

### DW-510: DW-398's pin is browser-side only — PUT /api/settings still accepts an embeddingProvider patch under an env pin and still deletes the stored key and endpoint.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-embedding-provider-env-pin
resolution-undo: a5eabdf2ca61356e0076d774a6f82c9650d82e7cc792e80ee23143ab6f1544b3 2026-08-29 7374617475733a206f70656e
origin: spec-deferred c65a495caed9
source_spec: `spec-dw-333-398-401-embedding-provider-resolution.md`
archived: 2026-08-29

### DW-511: The DW-373 rail rows pin a state the rail control itself cannot produce: with a Create Wiki dialog open, a real user can reach Settings through neither opener.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-rail-reachability-under-dialogs
resolution-undo: 2b14b7b7e64af745bcdb3bfa6488baee3e4f65c663e39178471fb84326e90b65 2026-08-29 7374617475733a206f70656e
origin: spec-deferred b7350e592148
source_spec: `spec-dw-167-423-425-426-settings-url-and-focus-lifecycle.md`
archived: 2026-08-29

### DW-512: Back from a deep-linked `?settings=1` still leaves the app holding the unsaved Settings draft, because the mount seed adds no entry.
origin: spec-deferred 0b5ecd6edb91
source_spec: `spec-dw-167-423-425-426-settings-url-and-focus-lifecycle.md`
location: src/components/workbench/Workbench.tsx (the mount seed)
severity: low
reason: The seed uses `replaceState`, matching the mode restore's own contract that Back must still leave the app on the first press. So a `?settings=1` link opened in a fresh tab is the first entry of its session and has nothing behind it to close the surface on — verbatim the symptom DW-167 describes, now reachable through the URL the fix introduces. Fixed for the in-session case only; the code comment states the residue rather than claiming otherwise. Closing it needs a decision about seeding a second entry on load, which would change the mode's Back contract too.
status: open
decision: 2026-08-28 Seed a second entry — Push a second history entry on a deep-linked ?settings=1 load so Back closes the Settings surface in a fresh tab, accepting and re-pinning the matching change to the mode's Back contract.

### DW-513: The popstate focus bump is unconditional on where the keyboard was, so Back pressed with focus on the rail still pulls it to `#wb-canvas`.
origin: spec-deferred 0af697b7be93
source_spec: `spec-dw-167-423-425-426-settings-url-and-focus-lifecycle.md`
location: src/components/workbench/Workbench.tsx (the popstate listener)
severity: low
reason: DW-423's own text scopes the defect to "if the owner is inside the Settings surface". The rail-close path deliberately leaves focus alone for exactly that reason — the control the owner pressed holds the keyboard — so the two paths are asymmetric. A narrowing (`document.getElementById(CANVAS_ID)?.contains(document.activeElement)` sampled in the handler, before the commit) would restore the symmetry; nothing pins the case today.
status: open

### DW-514: The URL names the Settings surface but not its category, so a copied link reopens the default pane while the live region announces it.
origin: spec-deferred 592f71cccf15
source_spec: `spec-dw-167-423-425-426-settings-url-and-focus-lifecycle.md`
location: src/lib/workbench-url.ts (the not-in-the-URL list)
severity: low
reason: `settingsCategoryId` is local `useState` with no URL and no storage. DW-167 asks only that the link reopen the surface, so this is within intent — but it means the address bar and the announced sentence can disagree about which pane the visitor lands on. Documented as an exclusion in `workbench-url.ts`'s header alongside the tab, the collapse flag, the selection and the widths.
status: open
decision: 2026-08-28 Put the category in the URL — Add a settings-category param to workbench-url.ts, write it on category change and restore it on mount, so a copied link reopens the pane the address bar names and the announcement agrees with it.

### DW-515: `applyTemplate`'s unconfirmed sentence is never dropped when the server render lands, so the card's re-template confirm comes back live under a stale "the outcome is unknown" alert — DW-429's harm on
origin: spec-deferred 2988d6ff7781
source_spec: `spec-dw-409-429-430-workbench-unconfirmed-write-latch.md`
location: src/components/WikiWorkbench.tsx (applyTemplate)
severity: medium
reason: `applyTemplate` (src/components/WikiWorkbench.tsx) composes the same unconfirmed sentence through `writeFailure` and fires `router.refresh()`, but raises no latch, so there is nothing for the new release effect to gate on and `templateError` is not among the errors it clears. The dialog stays open (`setTemplateOpen(false)` runs only on success) and the reset effect keys on `[currentWikiId, currentId]`, which a re-template does not move. After the refresh the owner sees a live `Overwrite` under an alert saying nobody knows what happened, over a card already showing the new scenario. Deliberately out of this bundle's scope — the confirm is idempotent per scenario, which answers the double-write risk but not the stale-sentence one.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-unconfirmed-write-latch-shared
resolution-undo: 914c2a4c0ce15566f349d93894c9882140d41913af71eaa25a9b1e26f7fbbdcf 2026-09-02 7374617475733a206f70656e

### DW-516: The card's `awaitingCreate` and the header switcher's `awaitingWrite` are independent flags on two components rendered in the same viewport, so an unconfirmed create on one surface leaves the other's
origin: spec-deferred 4dcd16aec101
source_spec: `spec-dw-409-429-430-workbench-unconfirmed-write-latch.md`
location: src/components/WikiWorkbench.tsx and src/components/workbench/WikiSwitcher.tsx
severity: medium
reason: `Workbench.tsx` renders `WikiSwitcher` in the left column header and `WikiWorkbench` as `children` at the same time. An unconfirmed create from the card raises `awaitingCreate` and dims its `Create Wiki`, while the header's `New Wiki` — which opens the same `CreateWikiDialog` onto the same `POST /api/wikis` — is not latched at all, and the inverse holds. Nothing enforces unique wiki names, so one click on the other surface seeds the second wiki the latch exists to prevent. Pre-existing since DW-375/DW-407 shipped the two flags separately; no suite mounts both surfaces together.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-unconfirmed-write-latch-shared
resolution-undo: 914c2a4c0ce15566f349d93894c9882140d41913af71eaa25a9b1e26f7fbbdcf 2026-09-02 7374617475733a206f70656e

### DW-517: A latched `<select>` refuses a switch silently: it reports as enabled, snaps back with no announcement, and `selectDescribedBy` names no reason.
origin: spec-deferred 36079a9e55f4
source_spec: `spec-dw-409-429-430-workbench-unconfirmed-write-latch.md`
location: src/components/workbench/WikiSwitcher.tsx (the switcher <select> and selectDescribedBy)
severity: low
reason: While `awaitingWrite` is up the picker carries `disabled={switching}` (false) and `aria-disabled` only for `readOnly`, so it announces as an ordinary live combobox; the change is swallowed by `switchWiki`'s early return and React re-applies the value. The switcher's own `<p role="alert">` is on screen and was announced when it appeared, but it carries no id and is not in `selectDescribedBy`, so a keyboard or screen-reader owner who tries again gets nothing at all. This is the shape the neighbouring `WIKI_READ_ONLY_COPY` description exists to avoid for the read-only refusal.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-unconfirmed-write-latch-shared
resolution-undo: 914c2a4c0ce15566f349d93894c9882140d41913af71eaa25a9b1e26f7fbbdcf 2026-09-02 7374617475733a206f70656e

### DW-518: DW-429's recorded `decision:` names a kernel remedy this bundle did not implement, and its cited coordinates no longer match the tree.
origin: spec-deferred 9ea259f90049
source_spec: `spec-dw-409-429-430-workbench-unconfirmed-write-latch.md`
location: _bmad-output/implementation-artifacts/deferred-work.md (DW-429 decision text)
severity: low
reason: The ledger entry's decision reads "Add a fail-soft `bumpDataVersion()` tail to `setCurrentWiki` outside the lock ... rewrite the exemption rationale at workbench-data-version.test.ts:1067-1071 and raise the count guard at :1088-1089 to 6". This bundle's intent directed implementing the entry's REASON instead, which is a client-side release-effect fix, so nothing in `src/lib/wikis.ts` was touched. The decision's own line numbers are also stale: that suite already asserts six `bumpRefreshSignal` sites around line 1213 and states the `setCurrentWiki` exemption rationale near line 1174. So the decision's separate concern — that a switch moves no `dataVersion` — is neither implemented nor retired, and a future sweep re-reading it would chase dead coordinates.
status: done 2026-09-02
resolution: already resolved: src/lib/wikis.ts:1738-1754 — setCurrentWiki now carries the fail-soft bumpDataVersion() tail outside the lock citing DW-518/DW-429, with the refreshed exemption rationale and count guard at src/lib/__tests__/workbench-data-version.test.ts:1163 and :1184.
decision: 2026-08-28 Implement the kernel tail — Add the fail-soft bumpDataVersion() tail to setCurrentWiki outside the lock as the recorded DW-429 decision directs, updating the exemption rationale and raising the bumpRefreshSignal count guard in workbench-data-version.test.ts at their current lines rather than the decision's stale ones.

### DW-519: SourcesTree carries the exact rAF-cancel-without-flush cleanup DW-208 removed from TreePanel, plus DW-206's single-offset-across-the-breakpoint storage shape, and has no test coverage at all.
origin: spec-deferred fefed9ac57e0
source_spec: `spec-dw-206-208-410-416-421-workbench-surface-visibility-lifecycle.md`
location: src/components/workbench/SourcesTree.tsx (the scroll-memory effect)
severity: medium
reason: `src/components/workbench/SourcesTree.tsx` scroll-memory effect is byte-for-byte the pre-DW-208 shape: the frame writes `writeStoredSourcesScroll(panel.scrollTop)` and the cleanup is only `removeEventListener` + `cancelAnimationFrame` with no flush. Its restore is a `[]`-keyed mount effect, and `Workbench.tsx` renders it as `mode === "sources" && ...` inside a `settingsOpen ? null : ...` branch, so the component genuinely unmounts on a mode switch and on opening Settings and the cleanup path really runs. `readStoredSourcesScroll` / `writeStoredSourcesScroll` / `WORKBENCH_SOURCES_SCROLL_KEY` appear only in those two files; no suite mounts SourcesTree, so deleting the effect outright would leave the suite green. `readStoredSourcesScroll()` is also a single number shared across the 900px breakpoint, and `.wb-sources-tree` is `overflow: auto` inside a column whose narrow layout is a stacked row.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-uncovered-scroll-surfaces
resolution-undo: a77242f208825ae4061ba3c53569e4636dceb406df12f5e707f81015b64f8d8b 2026-09-02 7374617475733a206f70656e

### DW-520: The Preview column's scroll boxes are discarded by the same Settings visit DW-416 fixes for the mode canvas, with no restore and no test.
origin: spec-deferred 23a6419658a0
source_spec: `spec-dw-206-208-410-416-421-workbench-surface-visibility-lifecycle.md`
location: src/components/workbench/PreviewColumn.tsx (the `.wb-preview` aside)
severity: medium
reason: `globals.css` gives `.wb-preview` and `.wb-preview-body` `overflow: auto` (the latter capped at `50vh` below 899px) and `.wb-preview[hidden] { display: none }` withdraws the column for the same visit under DW-412, so `display: none` discards those scroll boxes exactly as it discards the canvas's. `PreviewColumn.tsx` holds no ref or effect for scroll. The existing DW-412 case only compares the editor node and its value, never `scrollTop`. Two of the three surfaces that visit withdraws now come back where the owner left them and the third does not.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-uncovered-scroll-surfaces
resolution-undo: a77242f208825ae4061ba3c53569e4636dceb406df12f5e707f81015b64f8d8b 2026-09-02 7374617475733a206f70656e

### DW-521: The restore-clamp-persist echo DW-206 describes still exists WITHIN a band and on the mode canvas; band keying removes the cross-breakpoint route only.
origin: spec-deferred 470a00a54a16
source_spec: `spec-dw-206-208-410-416-421-workbench-surface-visibility-lifecycle.md`
location: src/components/workbench/TreePanel.tsx (restore + persist effects), src/components/workbench/ModeCanvas.tsx (the DW-416 effect)
severity: low
reason: Both TreePanel's and ModeCanvas's restores assign a stored offset and then leave a `scroll` listener live. A `scrollTop` assignment's own `scroll` event is dispatched at the next rendering update (CSSOM View), so the listener receives it regardless of attachment order. Where the surface has not reached its previously persisted content height (async tree data, a shorter list after a refresh, a shorter viewport against `40vh`), the browser clamps the assignment and the echo records the clamp over the owner's offset. Closing it means suppressing a write the restore itself provoked - the second fix DW-206's ledger entry offered and the intent did not choose - which is a mechanism decision, not a patch.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-scroll-restore-clamp-and-timing
resolution-undo: f4ff31b9d10103cffa554d3315b914a8fee23c87de8b65ba53ef656058c6c3db 2026-09-02 7374617475733a206f70656e

### DW-522: `useDialogA11y`'s widened `withdrawn()` still misses `visibility: hidden`, `content-visibility: hidden` and `inert`, which drop a focus() the same way.
origin: spec-deferred 42d31b7c4a2c
source_spec: `spec-dw-206-208-410-416-421-workbench-surface-visibility-lifecycle.md`
location: src/hooks/useDialogA11y.ts (withdrawn)
severity: medium
reason: `getClientRects()` is non-empty for a `visibility: hidden` element, and `globals.css`'s `@media (max-width: 899px)` block hides the closed rail exactly that way (`.wb-rail { transform: translateX(-100%); visibility: hidden }`, its own comment saying visibility is what "takes them out of both"). The predicate's docblock claims "only the ELEMENT can answer it ... a node cannot lie about it", which is broader than what it covers. No currently reachable dialog has a rail control as its opener, so this is not a demonstrated failure - but closing it needs a mechanism the node suites can execute (`Element.checkVisibility` is the candidate), and this spec's Never list rules out the computed-style route.
status: open

### DW-523: Below 900px with a docked Preview the DOCUMENT scrolls rather than `.wb-canvas`, so DW-416's ref records and restores 0 at that width.
origin: spec-deferred c3f825a7b28d
source_spec: `spec-dw-206-208-410-416-421-workbench-surface-visibility-lifecycle.md`
location: src/components/workbench/ModeCanvas.tsx (the DW-416 effect)
severity: low
reason: `globals.css`'s narrow block makes `.wb-shell` `overflow: visible` / `height: auto` while a Preview is docked, and its own comment says the canvas row then "resolves to its content instead of scrolling inside `.wb-canvas`'s own `overflow: auto`". At that width the owner's real position lives on the scrolling element, which the new effect never reads, and ModeCanvas's comment states "`.wb-canvas` is the mode canvas's SCROLL CONTAINER" without qualifying the width.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-scroll-restore-clamp-and-timing
resolution-undo: f4ff31b9d10103cffa554d3315b914a8fee23c87de8b65ba53ef656058c6c3db 2026-09-02 7374617475733a206f70656e

### DW-524: Both scroll restores run in `useEffect` rather than `useLayoutEffect`, so the surface paints at the top before it is scrolled back.
origin: spec-deferred 87f90b629902
source_spec: `spec-dw-206-208-410-416-421-workbench-surface-visibility-lifecycle.md`
location: src/components/workbench/TreePanel.tsx, src/components/workbench/ModeCanvas.tsx
severity: low
reason: `TreePanel`'s restore (pre-existing) and `ModeCanvas`'s new one both assign `scrollTop` from a passive effect, which runs after paint. The `hidden` attribute is removed in the commit, the browser paints the surface at 0, and only then is the offset re-applied - a visible jump on every un-withdrawal. `useLayoutEffect` puts the pixels back before paint. jsdom cannot observe the difference, so no suite would catch a regression either way.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-scroll-restore-clamp-and-timing
resolution-undo: f4ff31b9d10103cffa554d3315b914a8fee23c87de8b65ba53ef656058c6c3db 2026-09-02 7374617475733a206f70656e

### DW-525: The `dom` vitest project is red at BASELINE — 13 files / 229 tests fail with `TypeError: Cannot read properties of undefined (reading 'clear')` on `window.localStorage`. Unrelated to this change and o

status: done 2026-08-29
origin: spec-deferred 199a5cbc7479
source_spec: `spec-dw-385-read-only-kernel-guards.md`
archived: 2026-08-31

### DW-526: The research, Names & Terms and email-ingest route catches now classify a mid-request-flip `ReadOnlyError` as 400 or 500 instead of 403.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-read-only-lifecycle-route-status
resolution-undo: 8d0d9d1b39fad0e0145b43bf523a8c44a01125170236b0b6b41ab2d01975abaf 2026-08-30 7374617475733a206f70656e
origin: spec-deferred d082697c56ec
source_spec: `spec-dw-385-read-only-kernel-guards.md`
archived: 2026-08-31

### DW-527: The research CAS primitives stay writable by a direct library caller, so DW-385's guarantee has a named hole at `PATCH /api/research/[id]`'s writer.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-research-read-only-gates
resolution-undo: decad39e69a2c98280db3b6a268b2eed07cb4f509aa48fa266810968411b6482 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 9303b9f7d20e
source_spec: `spec-dw-385-read-only-kernel-guards.md`
archived: 2026-08-31

### DW-528: `reconcileResearchProjects` would relabel a read-only refusal as a damaged project.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-research-read-only-gates
resolution-undo: decad39e69a2c98280db3b6a268b2eed07cb4f509aa48fa266810968411b6482 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 5c97dda65344
source_spec: `spec-dw-385-read-only-kernel-guards.md`
archived: 2026-08-31

### DW-529: A fourth research refusal sentence lives one screen away, inline and unowned: the Workbench Deep Research canvas.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-read-only-client-refusal-parity
resolution-undo: 615600ac4e8f50e2aa5c551cc7c336110956d0d7909f068f2bbaf7e239cbff25 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 03ea64393d30
source_spec: `spec-dw-386-387-read-only-client-parity.md`
archived: 2026-08-31

### DW-530: The Knowledge Studio panels outside the Research desk still compose writes in front of doors that refuse, with no read-only term at all.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-read-only-client-refusal-parity
resolution-undo: 615600ac4e8f50e2aa5c551cc7c336110956d0d7909f068f2bbaf7e239cbff25 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 879face3635e
source_spec: `spec-dw-386-387-read-only-client-parity.md`
archived: 2026-08-31

### DW-531: Three Workbench canvases gate the read-only flag with plain `disabled=`, the DW-191/DW-299 shape the rest of the codebase argues against.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-read-only-client-refusal-parity
resolution-undo: 615600ac4e8f50e2aa5c551cc7c336110956d0d7909f068f2bbaf7e239cbff25 2026-08-30 7374617475733a206f70656e
origin: spec-deferred e6d35d1920b4
source_spec: `spec-dw-386-387-read-only-client-parity.md`
archived: 2026-08-31

### DW-532: `spec-dw-75-76-lint-check-parity-and-disputed-surface.md`'s golden example still quotes the pre-DW-389 `disputed-page` suggestion verbatim.
origin: spec-deferred 2d89eeccb2ef
location: _bmad-output/implementation-artifacts/spec-dw-75-76-lint-check-parity-and-disputed-surface.md:140-146
source_spec: `spec-dw-389-392-authz-gate-and-copy-tails.md`
severity: low
reason: Line 144 of that done spec reproduces the old one-line `suggestion` template, which no longer matches `checkDisputedPages` now that the clause comes from `disputedClearGuidance`. It reads as a record of what DW-76 built rather than a live expectation, and DW-389's decision authorised renegotiating only `spec-dw-121-230-269-270-…`, so it was left as recorded rather than edited. A reader consulting that spec for the current copy gets the version the realm gate falsified.
status: open

### DW-533: `SCHEMA.md` still carries the unqualified "clear it with the Disputed toggle" instruction DW-121 falsified.
origin: spec-deferred f6826d0c0181
location: SCHEMA.md:633-641
source_spec: `spec-dw-389-392-authz-gate-and-copy-tails.md`
severity: medium
reason: The `disputed-page` entry in the lint-check reference says clearing is "done via the Disputed toggle in the page editor (`PATCH /api/wiki/<slug>` with metadata `{ disputed: false }`)" with no admin/service qualification. DW-389 enumerated the two lint COPY sites (`lint-fix.ts`, `lint-checks.ts`) and both now render `disputedClearGuidance`; this is a third, reader-facing site of the same falsified sentence, in documentation rather than lint output, and it was already wrong before this change.
status: open

### DW-534: Under the armed E2E cookie identity there is no `ClerkProvider`, so every client identity gate — Revert now included — fails closed for the E2E owner.
origin: spec-deferred d182696f7703
location: src/app/layout.tsx:88, src/lib/viewer-handle.ts
source_spec: `spec-dw-389-392-authz-gate-and-copy-tails.md`
severity: low
reason: `src/app/layout.tsx:88` renders the shell WITHOUT `<ClerkProvider>` when `isE2eIdentityArmed()`, while `middleware.ts` admits the owner from the `yopedia_e2e` cookie. `useViewerHandle` reads Clerk, so `isSignedIn` and `handle` are unavailable on that path: Delete and Re-ingest were already hidden from the E2E owner for this reason, and DW-392's signed-in term extends the same blind spot to Revert. Nothing breaks today — neither `e2e/workbench-owner.spec.ts` nor `e2e/retired-routes.spec.ts` exercises an article affordance — but an E2E case that ever does will see a control the server would admit.
status: open

### DW-535: Deleting talk.ts's derived-index hooks left syncDiscussStatsForSlug and recordTalkForAuthor with zero production callers, and their doc comments still describe the deleted talk.ts caller.
origin: spec-deferred 34c447f2691e
location: src/lib/discuss-stats-index.ts:69, src/lib/contributor-index.ts:218
source_spec: `spec-dw-390-retire-dead-talk-writers.md`
severity: medium
reason: `src/lib/talk.ts`'s `syncDiscussStatsHook` and `recordTalkContributorHook` were the only production callers of `syncDiscussStatsForSlug` (discuss-stats-index.ts:69) and `recordTalkForAuthor` (contributor-index.ts:218). After DW-390 both are reached only from their own unit tests. Their prose is now stale: discuss-stats-index.ts:6 says the index is "maintained incrementally directly from talk.ts", :65 says the function is "called from talk.ts mutations ... under the discuss:<slug> lock" (that lock is gone), and contributor-index.ts:25 and :214 still call it "the talk hook". Both modules were deliberately left untouched: the DW-390 decision says to leave the discuss-stats/contributor indexes exactly as they are, so this is recorded rather than resolved. This is the DW-390 shape one module out.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-contributor-and-discuss-index-residue
resolution-undo: 2baf9665322cad66955e33280ea2f14cc21bb9001001db28e5c48764a5941ea4 2026-09-02 7374617475733a206f70656e

### DW-536: `/api/assets/[...path]` gates only on `visibility: private`, so the assets of a page the Knowledge tab hides for any OTHER reason are still served to anyone, unauthenticated.
origin: spec-deferred 898a204cc270
location: src/app/api/assets/[...path]/route.ts:73
source_spec: `spec-dw-491-493-494-workbench-raw-path-gate-parity.md`
severity: medium
reason: DW-491 closed the disclosure at the Workbench doors (`listWorkbenchFilePaths`, `readWorkbenchFile`, `readWorkbenchFileBytes`, `/api/workbench/media`), which all route through `rawPathAllowed`. `/api/assets/[...path]` reads the SAME bytes out of the same `raw/assets/<slug>/<file>` tree (route.ts:83, `rawRelPath("assets/" + segments.join("/"))`) and its only gate is `page.frontmatter.visibility === "private"` (route.ts:73-79). `hiddenSlugs` is broader than that: `workbenchSlugGate` refuses every slug the principal's index named that `buildKnowledgeTree` dropped — agent-scoped types and artifacts included, none of which need `visibility: private`. So after this change the Files tab withholds `raw/assets/agentpage/pic.png` while a plain `GET /api/assets/agentpage/pic.png` still returns the bytes. Pre-existing: that route's gate predates DW-491 and was not touched here. Whether the two gates SHOULD agree is a product decision — `/api/assets/` is deliberately no-auth so public pages skip pri
status: done 2026-09-03
resolution: resolved by sweep bundle dw-raw-path-gate-reach
resolution-undo: f947a5bf826190bd472159a840ecbf21c37c9d84390482c41b43c01afa2c23e6 2026-09-03 7374617475733a206f70656e
decision: 2026-08-29 Align the assets route on hiddenSlugs — Give `/api/assets/[...path]` the same `hiddenSlugs`/`rawPathAllowed` gate the Workbench doors use, derived for the request's principal, keeping the no-auth path only for slugs that gate admits. Pin that an agent-scoped page's asset is refused unauthenticated and that an ordinary public page's asset still serves with no session.
decision: 2026-08-29 Align the assets route on hiddenSlugs — Give `/api/assets/[...path]` the same `hiddenSlugs`/`rawPathAllowed` gate the Workbench doors use, derived for the request's principal, keeping the no-auth path only for slugs that gate admits. Pin that an agent-scoped page's asset is refused unauthenticated and that an ordinary public page's asset still serves with no session.

### DW-537: The v1 rescan ROUTE's `v1SlugGate` -> `hiddenSlugs` wiring is still unpinned; DW-493 pinned the forward inside `rescanSources`, one level below the door.
origin: spec-deferred 85f7687e3987
location: src/app/api/v1/projects/[wikiId]/sources/rescan/route.ts:82
source_spec: `spec-dw-491-493-494-workbench-raw-path-gate-parity.md`
severity: medium
reason: DW-493's new case calls `rescanSources` directly and does pin the forward at src/lib/source-rescan.ts:126 (verified: replacing it with `new Set()` fails exactly that case and nothing else). What remains untested is the route that a real caller hits: `POST /api/v1/projects/[wikiId]/sources/rescan` derives the gate with `v1SlugGate(caller.principal)` and spreads it into the call (route.ts:82-88). Nothing asserts that derivation yields a NON-EMPTY `hiddenSlugs` for a hidden page, or how it composes with the route's own `!path.startsWith("raw/sources/")` -> 403 scope check — because `src/lib/__tests__/epic8-v1-routes.test.ts:54` mocks `@/lib/source-rescan` wholesale, so no test in the suite drives the real function through the POST door. Pre-existing: that mock and that wiring predate this change.
status: open

### DW-538: The eight `.wb-canvas-pad` mode panes are withdrawn with the same `hidden` mechanism but have no backing CSS rule at all, so their withdrawal rests on the user-agent default alone.
origin: spec-deferred cdc2936054f0
location: src/app/globals.css:2686 / src/components/workbench/ModeCanvas.tsx:185
source_spec: `spec-dw-433-hidden-attribute-css-specificity.md`
severity: medium
reason: `src/components/workbench/ModeCanvas.tsx` sets `hidden={mode !== "…" || hidden}` on eight `.wb-canvas-pad` divs (lines 185, 206, 218, 233, 249, 263, 280, 299). `.wb-canvas-pad` at `src/app/globals.css:2686` declares only `padding` — there is no `.wb-canvas-pad[hidden]` rule. The UA sheet's `[hidden] { display: none }` loses to ANY author `display` declaration, which is a strictly weaker position than the (0,2,0) one DW-415 judged insufficient for the four sibling surfaces. Not caused by this change and not named by DW-415, whose scope is the specificity of withdrawal rules that already exist; adding a fifth rule is separate work. The new scan `every [hidden] withdrawal in the stylesheet carries the floor` would enforce the floor on such a rule the moment one is written, but cannot require that it exist.
status: open

### DW-539: On Node 26 the vitest dom project cannot run at all — `window.localStorage` is undefined, so 229 tests across 13 files die in `beforeEach`.

status: done 2026-08-29
origin: spec-deferred f743cf8764f7
source_spec: `spec-dw-433-hidden-attribute-css-specificity.md`
archived: 2026-08-31

### DW-540: A truncated backup keeps whatever the storage walk happened to reach first, so which of the owner's data survives the cut is arbitrary rather than prioritised.
origin: spec-deferred a560134e9889
location: src/lib/backups.ts:94-120
source_spec: `spec-dw-215-artifact-revision-retention.md`
severity: medium
reason: `walkFiles` recurses in raw `listFiles` order and the filesystem provider returns `fs.readdir` order unsorted (`src/lib/storage/filesystem.ts:315-327`), so a single oversized silo early in the walk can consume the whole file/byte budget and every later prefix — including `wiki/`, the owner's actual pages — is dropped, flagged only as "partial". DW-215's own framing ("so a large artifact history degrades") reads as: the oversized history is what should fall off first. The literal instruction was "truncate ... instead of throwing", which this satisfies, so an ordering policy (walk `wiki/` before `raw/`, or exclude `revisions/` from a truncating pass) is a separate decision, not this story's.
status: done 2026-09-02
resolution: already resolved: src/lib/backups.ts:163-207 — walkFiles now runs three ordered, name-sorted passes (wiki, then live data, then history) with HISTORY_DIR_NAMES at :129 and the DW-540 citation at :133-135.
decision: 2026-08-29 Priority walk order — Give `walkFiles` an explicit prefix priority — `wiki/` first, then the rest of the owner's live data, with `revisions/` and other append-only history last — so a truncating pass drops history before pages. Sort within a prefix so the result is deterministic rather than readdir-ordered. Pin that a budget exceeded by an oversized silo still yields a backup containing every `wiki/` page.
decision: 2026-08-29 Priority walk order — Give `walkFiles` an explicit prefix priority — `wiki/` first, then the rest of the owner's live data, with `revisions/` and other append-only history last — so a truncating pass drops history before pages. Sort within a prefix so the result is deterministic rather than readdir-ordered. Pin that a budget exceeded by an oversized silo still yields a backup containing every `wiki/` page.

### DW-541: The retention cap deletes artifact revisions silently — no surface tells the owner the history they are looking at is the newest 50 rather than all of them.
origin: spec-deferred 097ec847ef17
location: src/components/workbench/PreviewColumn.tsx
source_spec: `spec-dw-215-artifact-revision-retention.md`
severity: medium
reason: The backup half carries its truncation all the way out (manifest -> `BackupSummary` -> `/api/system/backups` -> the health desk row). The revision half carries nothing: `GET /api/workbench/artifact/revisions` returns the bounded list with no `limit` or `truncated` sibling, and the History panel (`src/components/workbench/PreviewColumn.tsx`, around the `revisions.map(...)` render) shows a complete-looking list. The same Workbench already has `FILES_TRUNCATED_COPY` and `PREVIEW_TRUNCATED_COPY` for exactly this shape. The spec's Block If froze `ArtifactRevision` and the response shape, but a sibling response field plus a panel note would not violate it.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-canvas-reflow-and-revision-cap
resolution-undo: 358fdc0eb187500bae67cda8a18d4ee078bc352b79ea908756f8f1ba3bfeb602 2026-09-02 7374617475733a206f70656e

### DW-542: The backup copy loop reads a file's whole contents before discovering it does not fit under the byte ceiling.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-backups-oversize-read-avoidance
resolution-undo: 6d34716c3469f637fd2d9e86f29ec50257de069b2e0d7f30137bc03814cd184d 2026-08-30 7374617475733a206f70656e
origin: spec-deferred f22219934525
source_spec: `spec-dw-215-artifact-revision-retention.md`
archived: 2026-08-31

### DW-543: An agent handle owning the survivor resolves guidance against the agent's own tenant silo rather than the human's, so an agent-owned page folds with no Workspace Purpose and no dictionary.
origin: spec-deferred 005cb3050e8f
location: src/lib/merge.ts (guidanceOwner resolution) and src/lib/ingest.ts:1760
source_spec: `spec-dw-323-merge-door-workspace-guidance.md`
severity: medium
reason: `ownerToTenant` (src/lib/links.ts) lowercases and path-sanitizes but does not strip the `--` agent suffix, so `alice--yoyo` keys its own tenant. The same-owner guard 40 lines above the fold deliberately collapses that pair via `sameHumanOwner`/`humanOf` (src/lib/ingest.ts), so the two treat the same handle differently. The ingest door passes the raw handle too, so this is a codebase-wide convention question, not a merge-door bug: deciding it means deciding whether guidance is addressed by silo or by human, for every prompt site at once. Out of scope for DW-323, whose intent is the door asymmetry.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-merge-guidance-human-owner
resolution-undo: 17abc39e4af7cb778dfe6734aba416a4571451cee580e490b7918905d761e612 2026-09-01 7374617475733a206f70656e
decision: 2026-08-29 Guidance is addressed by human owner — Resolve guidance through `humanOf` everywhere it is looked up — the merge door's guidanceOwner resolution and the ingest door at src/lib/ingest.ts:1760 — so an agent handle reads its human's Workspace Purpose and dictionary. Leave `ownerToTenant` alone as the storage-addressing function it is, and name the distinction in both modules. Pin an agent-owned survivor folding with the human's guidance.
decision: 2026-08-29 Guidance is addressed by human owner — Resolve guidance through `humanOf` everywhere it is looked up — the merge door's guidanceOwner resolution and the ingest door at src/lib/ingest.ts:1760 — so an agent handle reads its human's Workspace Purpose and dictionary. Leave `ownerToTenant` alone as the storage-addressing function it is, and name the distinction in both modules. Pin an agent-owned survivor folding with the human's guidance.

### DW-544: `synthesizeResearchBrief` still reads `textStream`, so a fired deadline commits a truncated research brief as a finished wiki page.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-truncated-answer-honesty
resolution-undo: ed6948179efc323971f746c3008e9ecc1fc40dcf2a83002ec2f1f340c86d00de 2026-08-30 7374617475733a206f70656e
origin: spec-deferred d3ff3aae961a
source_spec: `spec-dw-64-stream-deadline-owner-copy.md`
archived: 2026-08-31

### DW-545: `/api/query` still returns `getErrorMessage(error)` verbatim, so a fired deadline reaches the owner as raw transport vocabulary there.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-truncated-answer-honesty
resolution-undo: ed6948179efc323971f746c3008e9ecc1fc40dcf2a83002ec2f1f340c86d00de 2026-08-30 7374617475733a206f70656e
origin: spec-deferred f674f51728cf
source_spec: `spec-dw-64-stream-deadline-owner-copy.md`
archived: 2026-08-31

### DW-546: `query-stream-route.test.ts`'s `callLLMStream` mock returns an async generator, so all three #413 filtering tests run through the route's 500 catch and prove nothing about a completing route.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-query-stream-test-fidelity
resolution-undo: 86011a6e06f073ca67735f2f1c7b8c3c0f00c2e9679b85f77684c5156ce44759 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 1fb55ed9ac95
source_spec: `spec-dw-64-stream-deadline-owner-copy.md`
archived: 2026-08-31

### DW-547: The `QUERY_MAX_OUTPUT_TOKENS` cap truncates a streamed answer as silently as the deadline used to.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-truncated-answer-honesty
resolution-undo: ed6948179efc323971f746c3008e9ecc1fc40dcf2a83002ec2f1f340c86d00de 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 714ac53dacf9
source_spec: `spec-dw-64-stream-deadline-owner-copy.md`
archived: 2026-08-31

### DW-548: `hasLLMKey()` reads `loadConfigSync()` for the two store-only providers, so a cold CLI or MCP process tells an owner who saved Ollama or Custom that no API key is configured.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-cli-config-warm-and-status
resolution-undo: a03d638ef5170f352ddfe9f8eca27752064289754188259e18a74eb976a43feb 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 3903ad16168b
source_spec: `spec-dw-502-cli-status-config-load.md`
archived: 2026-08-31

### DW-549: `yopedia status` prints "not configured" for a config object it could not read, which is the same sentence it prints when nothing was ever stored.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-cli-config-warm-and-status
resolution-undo: a03d638ef5170f352ddfe9f8eca27752064289754188259e18a74eb976a43feb 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 28bf2339b3bc
source_spec: `spec-dw-502-cli-status-config-load.md`
archived: 2026-08-31

### DW-550: `loadConfigSync()`'s doc comment still justifies its `{}` answer with a startup sequence that does not exist in this repo.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-config-single-read-resolution
resolution-undo: 918c9d4112f6248cfdcfe721ad357c3745c069bc57d18c4196811f896d74d7a7 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 6cf381b01ada
source_spec: `spec-dw-502-cli-status-config-load.md`
archived: 2026-08-31

### DW-551: `src/cli.ts` calls `main()` unconditionally at module load, so every test that imports it runs a CLI command and could exit the vitest worker.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-cli-config-warm-and-status
resolution-undo: a03d638ef5170f352ddfe9f8eca27752064289754188259e18a74eb976a43feb 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 86487c972526
source_spec: `spec-dw-502-cli-status-config-load.md`
archived: 2026-08-31

### DW-552: DW-509 aligned only the RUNTIME gate on a junk EMBEDDING_PROVIDER, so the route's and the browser's halves of canEnableVectorSearch now disagree with it for that state.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-settings-vector-provider-parity
resolution-undo: 8702654b59a7343943e3c6868041bcb678e3cfc2b59cf167c6a6307a9c17901b 2026-08-30 7374617475733a206f70656e
origin: spec-deferred dd238fd4fbbe
source_spec: `spec-dw-507-508-509-510-embedding-provider-env-pin.md`
archived: 2026-08-31

### DW-553: A stale tab refused by the new route pin has no way forward: the draft keeps the blanked endpoint and key, so every retry re-sends the same move and gets the same 400.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-settings-save-refusal-recovery
resolution-undo: 716f1e124d71c877be120780325383a2aebe3196b7bdc13ffbcd71d99803527f 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 77772d2be117
source_spec: `spec-dw-507-508-509-510-embedding-provider-env-pin.md`
archived: 2026-08-31

### DW-554: `SETTINGS_SAVE_FAILED_COPY` tells the owner their settings were not saved on the one branch whose whole justification is that nobody knows whether they were.
origin: spec-deferred 9e310e9c443f
location: src/lib/workbench-settings.ts:3232 and src/lib/workbench-settings.ts (SETTINGS_SAVE_FAILED_COPY)
source_spec: `spec-dw-427-428-applied-but-unreadable-save-verdict.md`
severity: medium
reason: The `unreadable` verdict clears the held version on the stated ground that a 2xx is no proof the route did not run (`src/lib/workbench-settings.ts:3103-3119`), and the canvas acts on it (`SettingsCanvas.tsx:343`). The sentence shown beside that action is "Settings couldn't be saved." — an assertion the same reasoning says nobody is in a position to make. The neighbouring `it.each` docblock in `workbench-settings.test.ts` spells out exactly that objection for the sibling branch. Fixing it means a new owner-facing sentence for a third outcome, which is an intent-level copy decision this bundle's intent did not open.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-settings-save-verdict-contract
resolution-undo: 48ddddf59b44b2fa625d50086b3ffe9dfc1d4b907dd025ba89846c1f242105aa 2026-09-02 7374617475733a206f70656e
decision: 2026-08-29 Add a third sentence for the unknown outcome — Add a distinct copy constant for the `unreadable` verdict saying the outcome is unknown and what to do about it (reload to see what landed), matching the vocabulary the unconfirmed-write sentences already use elsewhere in the Workbench. Route `SettingsCanvas` onto it for that branch only, leave `SETTINGS_SAVE_FAILED_COPY` for real failures, and extend the existing `it.each` to assert each verdict's sentence.
decision: 2026-08-29 Add a third sentence for the unknown outcome — Add a distinct copy constant for the `unreadable` verdict saying the outcome is unknown and what to do about it (reload to see what landed), matching the vocabulary the unconfirmed-write sentences already use elsewhere in the Workbench. Route `SettingsCanvas` onto it for that branch only, leave `SETTINGS_SAVE_FAILED_COPY` for real failures, and extend the existing `it.each` to assert each verdict's sentence.

### DW-555: Once the held version is cleared, the Settings canvas is a dead end: every later save is refused 428 and the only recovery is a reload that destroys the draft.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-settings-save-refusal-recovery
resolution-undo: 716f1e124d71c877be120780325383a2aebe3196b7bdc13ffbcd71d99803527f 2026-08-30 7374617475733a206f70656e
origin: spec-deferred cd771655dc8e
source_spec: `spec-dw-427-428-applied-but-unreadable-save-verdict.md`
archived: 2026-08-31

### DW-556: `savePreviewBody` reads its 2xx body with an unguarded `.catch(() => null)` and still answers `{ status: "ok" }`, so a body read that dies mid-stream is reported to Preview as a LANDED save.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-settings-save-verdict-shape
resolution-undo: 767f82478d968c4df48c9d522d07cb841eed608792f8c167449df57b42c12e27 2026-08-30 7374617475733a206f70656e
origin: spec-deferred c4281a7f973b
source_spec: `spec-dw-427-428-applied-but-unreadable-save-verdict.md`
archived: 2026-08-31

### DW-557: The refusal branch's body parse in `saveWorkbenchSettings` is unguarded, so a refusal body read that dies mid-stream is classified as an arrived, fully read refusal.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-settings-save-verdict-shape
resolution-undo: 767f82478d968c4df48c9d522d07cb841eed608792f8c167449df57b42c12e27 2026-08-30 7374617475733a206f70656e
origin: spec-deferred fd171f2e691e
source_spec: `spec-dw-427-428-applied-but-unreadable-save-verdict.md`
archived: 2026-08-31

### DW-558: `SettingsSaveResult`'s two booleans can express four states when only three are legal; nothing forbids `{ unconfirmed: true, unreadable: true }`.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-settings-save-verdict-shape
resolution-undo: 767f82478d968c4df48c9d522d07cb841eed608792f8c167449df57b42c12e27 2026-08-30 7374617475733a206f70656e
origin: spec-deferred e475024c9518
source_spec: `spec-dw-427-428-applied-but-unreadable-save-verdict.md`
archived: 2026-08-31

### DW-559: Both model hints instruct the owner to empty a box that the env-locked branch renders as a non-editable div.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-env-locked-credential-affordances
resolution-undo: a2bc3f517016d00b840c4497974d90581053315b9d7eac5a37d8febc1b69824d 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 244ab0dbc5d6
source_spec: `spec-dw-505-506-provider-blank-state-and-model-hint.md`
archived: 2026-08-31

### DW-560: The page's one read-only sentence is announced in opposite positions on the two model boxes of the same `/settings` page.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-env-locked-model-box-a11y
resolution-undo: 2da0f761c09c8f4d644476d18e47381a0defd84f8c642938b538355d9b71d9b2 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 5dbca5767630
source_spec: `spec-dw-505-506-provider-blank-state-and-model-hint.md`
archived: 2026-08-31

### DW-561: On a blank pick the model placeholder still names the STORED provider's default model while the credential line beside it says nothing is selected.
origin: spec-deferred ba44856607a4
location: src/components/ProviderForm.tsx:355
source_spec: `spec-dw-505-506-provider-blank-state-and-model-hint.md`
severity: medium
reason: `ProviderForm.tsx:355-359` keeps `DEFAULT_MODELS[effectiveProvider]`, so a blank picker over a stored `openai` shows placeholder `gpt-4o` one line below "Select a provider to check its server credential". Two statements about the same control now disagree, which is the DW-505 harm shape applied to a different node. Out of scope on the intent's own authority — it says to keep the stored-provider fallback for everything but the credential line — so the disagreement is a consequence this bundle was told to accept, not a deviation from it.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-provider-form-pick-and-env-label
resolution-undo: 634001e4acbf6f0e4e4a1898a00439359c4b7ab473f5b67ee08a08d8692debe8 2026-09-01 7374617475733a206f70656e
decision: 2026-08-29 Blank the placeholder on a blank pick — Extend the blank-pick rule from the credential line to the model placeholder, so a blank provider selection shows no model default rather than the stored provider's. Keep the stored-provider fallback everywhere the pick is not blank. Pin that the credential line and the model placeholder make the same statement for every pick state.
decision: 2026-08-29 Blank the placeholder on a blank pick — Extend the blank-pick rule from the credential line to the model placeholder, so a blank provider selection shows no model default rather than the stored provider's. Keep the stored-provider fallback everywhere the pick is not blank. Pin that the credential line and the model placeholder make the same statement for every pick state.

### DW-562: The env-locked model boxes have no accessible NAME — their `<label htmlFor>` points at an id no element carries.

status: done 2026-08-29
resolution: resolved by sweep bundle dw-env-locked-model-box-a11y
resolution-undo: 2da0f761c09c8f4d644476d18e47381a0defd84f8c642938b538355d9b71d9b2 2026-08-29 7374617475733a206f70656e
origin: spec-deferred 0af3363949ae
source_spec: `spec-dw-505-506-provider-blank-state-and-model-hint.md`
archived: 2026-08-31

### DW-563: Every other `ToolDef.run` in `MCP_TOOLS` still spreads-and-casts `tools/call` arguments with no runtime check, because `dispatchMcp` validates nothing generically -- DW-455 closed this for `fix_lint_i

status: done 2026-08-30
resolution: resolved by sweep bundle dw-mcp-door-hardening
resolution-undo: 69668be5bc24c764633fb3e08e3c2a165cd7fed4b1be2c9451585feb8d1d19fb 2026-08-30 7374617475733a206f70656e
origin: spec-deferred ee1aa179380d
source_spec: `spec-dw-395-455-456-457-mcp-rest-door-parity.md`
archived: 2026-08-31

### DW-564: The REST lint-fix door names the field `targetSlug` while both MCP doors name it `target`, so an agent's request body is not portable between the two surfaces the bundle set out to bring to one contra
origin: spec-deferred 8a6272c94a12
location: src/app/api/lint/fix/route.ts:32 vs src/lib/mcp-http.ts:509
source_spec: `spec-dw-395-455-456-457-mcp-rest-door-parity.md`
severity: medium
reason: `LINT_FIX_REQUEST` (src/app/api/lint/fix/route.ts:29-34) declares `targetSlug`; `src/mcp.ts`'s registered schema and `src/lib/mcp-http.ts`'s `inputSchema` both declare `target`, and `handleFixLintIssue` forwards `args.target` into `fixLintIssue`'s `targetSlug` parameter. Pre-existing and untouched by DW-455/DW-457, but it now means the two doors' new "Invalid request field `...`" messages name different fields for the same value. `src/app/api/lint/workbench-fix/route.ts:27-32` already accepts BOTH names, which is the precedent for an alias.
status: open

### DW-565: A supported document a sending client labels `Content-Disposition: inline` is now dropped with no acknowledgement line at all, and some mainstream clients label genuinely-attached files inline.
origin: spec-deferred 8d6dcf5ac9ae
location: workers/email-ingest/index.ts (eligibleAttachments, and the acknowledgement's loss lines)
source_spec: `spec-dw-446-email-inline-part-eligibility.md`
severity: medium
reason: DW-446's recorded 2026-08-28 decision is "never forwarded", and this change implements it: an inline part leaves eligibility, so it is not forwarded, not named in `attachmentName`, and contributes to none of the four loss terms. A message whose only part is an inline `.md` is therefore answered with "work-wiki found no email text to ingest." — a document arrived and no sentence in the reply mentions it. Apple Mail and Outlook are reported to mark PDFs and images rendered in the message body as inline, so the false-positive population is not empty. Two readings were raised by review and both were rejected by the recorded decision rather than by evidence: forward-but-count (make the accounting honest instead of eligibility narrower), and drop-but-report (one "not queued" line naming inline documents). Revisiting means re-opening a decision a human already made, which is why it is deferred rather than patched.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-email-inline-part-eligibility
resolution-undo: ca6a99e4053222951e4d8167e59176aefdde374e63efe44589a9fd964c207ee9 2026-08-31 7374617475733a206f70656e
decision: 2026-08-29 Drop, but report — Keep inline parts out of eligibility exactly as DW-446 decided, and add one acknowledgement line naming supported documents that were not queued because they were labelled inline, so a message is never answered as if nothing arrived. Count them in a fifth loss term rather than reshaping the existing four. Pin the reply for a message whose only part is an inline supported document.
decision: 2026-08-29 Drop, but report — Keep inline parts out of eligibility exactly as DW-446 decided, and add one acknowledgement line naming supported documents that were not queued because they were labelled inline, so a message is never answered as if nothing arrived. Count them in a fifth loss term rather than reshaping the existing four. Pin the reply for a message whose only part is an inline supported document.

### DW-566: DW-450's recorded decision to widen `inlineAttachment` to trust `contentId` becomes a data-loss change once it lands on top of DW-446, not the cosmetic reply-line fix it was filed as.
origin: spec-deferred 7dff0e55af2e
location: workers/email-ingest/index.ts (inlineAttachment)
source_spec: `spec-dw-446-email-inline-part-eligibility.md`
severity: medium
reason: `inlineAttachment` reads `disposition` and nothing else, and DW-450 carries a 2026-08-28 decision to treat a part with a `Content-ID` and no `Content-Disposition` as inline. Under DW-359 that predicate governed only which parts were COUNTED, so widening it could at worst suppress a reply sentence. After DW-446 the same predicate governs whether a part is forwarded at all, so widening it silently discards every supported document a client tags with a Content-ID. Neither entry records the interaction, and whichever lands second inherits a blast radius its own reason never described.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-email-inline-part-eligibility
resolution-undo: ca6a99e4053222951e4d8167e59176aefdde374e63efe44589a9fd964c207ee9 2026-08-31 7374617475733a206f70656e
decision: 2026-08-29 Split the predicate in two — Separate the counting predicate from the forwarding predicate: let the counting one trust `Content-ID` (which is what DW-450 was filed to fix — the phantom skipped-attachment line) while the forwarding one keeps reading `disposition` only, so no document is dropped on a Content-ID alone. Record the interaction in both call sites. Pin a Content-ID-only signature logo (no phantom line, not forwarded) and a Content-ID-only supported document (still handled).
decision: 2026-08-29 Split the predicate in two — Separate the counting predicate from the forwarding predicate: let the counting one trust `Content-ID` (which is what DW-450 was filed to fix — the phantom skipped-attachment line) while the forwarding one keeps reading `disposition` only, so no document is dropped on a Content-ID alone. Record the interaction in both call sites. Pin a Content-ID-only signature logo (no phantom line, not forwarded) and a Content-ID-only supported document (still handled).

### DW-567: No real-MIME fixture omits `Content-Disposition` entirely, so the `null`-disposition branch — whose stakes this change raised — has only mocked coverage.
origin: spec-deferred 2ad4fdb0a5d9
location: src/lib/__tests__/email-ingest-worker.test.ts (multipartEmail)
source_spec: `spec-dw-446-email-inline-part-eligibility.md`
severity: low
reason: `inlineAttachment`'s doc treats a `null` disposition as a deliberate decision: an unlabelled part is likelier to be a real attachment than a decoration, and "guessing wrong there would silently drop a file the sender really did send". After DW-446 that sentence is literal rather than figurative. `multipartEmail` in `src/lib/__tests__/email-ingest-worker.test.ts` always emits a `Content-Disposition` header — the `disposition` option replaces the derived line, it cannot remove it — so the real-parser suite cannot express a headerless part, and the only coverage is incidental, from mocked fixtures that leave the field undefined.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-email-worker-test-fidelity
resolution-undo: fee602981736015948778469cab29e9edf1d22991431f300ccd76609002a87cb 2026-08-31 7374617475733a206f70656e

### DW-568: `listRawSourceSnapshots` emits bogus `{slug: "sources"}` rows for any flat Source whose filename stem is all hexadecimal.
origin: spec-deferred 1cde32eceb16
location: src/lib/raw.ts:348
source_spec: `spec-dw-437-438-raw-source-listing-and-store-safety.md`
severity: low
reason: The walk's second root is `raw/`, whose child directory `sources` passes `validateSlug`, so the flat files inside it are read as that directory's snapshots. `RAW_ID_RE` is `/^[a-f0-9]+$/` with no length bound, so `raw/sources/cafe.md` yields `{slug: "sources", rawId: "cafe"}`. Pre-existing — `wiki-retrieve.ts` already builds a duplicate retrieval document from it; this change surfaces it as a bogus CLI row too.
status: open

### DW-569: Binary Sources are still absent from every listing, so a PDF-only workspace keeps reporting zero Sources.
origin: spec-deferred 943ed05871fa
location: src/lib/raw.ts:369
source_spec: `spec-dw-437-438-raw-source-listing-and-store-safety.md`
severity: medium
reason: `listRawSourceSnapshots` skips any child not ending in `.md`, and `listRawSources` is non-recursive, so bytes stored by `saveRawSourceBytes` at `raw/sources/<slug>/<id>.<ext>` appear in neither. The DW-437 decision named `listRawSourceSnapshots` as the listing to move the callers onto, so closing this needs a separate decision about what the listing's unit is.
status: open
decision: 2026-08-29 One row per stored artefact — Make `listRawSourceSnapshots` recurse and return one row per stored artefact regardless of extension, carrying the media type so callers that only want markdown can filter explicitly. Audit every caller the DW-437 decision moved onto it and state which ones filter. Pin that a PDF-only workspace reports a non-zero Source count and that markdown-only callers are unchanged.
decision: 2026-08-29 One row per stored artefact — Make `listRawSourceSnapshots` recurse and return one row per stored artefact regardless of extension, carrying the media type so callers that only want markdown can filter explicitly. Audit every caller the DW-437 decision moved onto it and state which ones filter. Pin that a PDF-only workspace reports a non-zero Source count and that markdown-only callers are unchanged.

### DW-570: `storeRawSource`'s silo repair falls back to mirroring the REQUEST body when re-reading the stored bytes fails, which its own comment forbids.
origin: spec-deferred bcbe0252414f
location: src/lib/raw.ts:199
source_spec: `spec-dw-437-438-raw-source-listing-and-store-safety.md`
severity: low
reason: `stored` is initialised to `content` and only replaced on a successful `readFile`; the surrounding comment says copying a re-offered body "would show Files a Source the flat key does not hold". Pre-existing — the branch predates this change and no test pins it.
status: open

### DW-571: `checkIncompleteCoverage` compares only the first readable snapshot, and a page that also has a flat blob never has its snapshots compared at all.
origin: spec-deferred ec2d5d5cf4b9
location: src/lib/lint-checks.ts:1040
source_spec: `spec-dw-437-438-raw-source-listing-and-store-safety.md`
severity: medium
reason: The fallback breaks on the first snapshot that opens, and `readRawSource` is tried first, so a page assembled from several hashed Sources is judged against one of them chosen by directory-listing order. The DW-437 decision is about candidacy and counting; which bytes reach the LLM is a separate question this change did not settle.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-snapshot-coverage-and-archive-lookup
resolution-undo: 07a4b5b8a44b8a65a0b1c538e87fae9d53c4b4f8686762b90f112510c146d6e3 2026-08-31 7374617475733a206f70656e

### DW-572: Other content-addressed binary writers still publish through the overwrite door, so FR-2 exclusivity holds only for the `raw.ts` path.
origin: spec-deferred 47e89b1d5d12
location: src/lib/document-sources.ts:156
source_spec: `spec-dw-437-438-raw-source-listing-and-store-safety.md`
severity: medium
reason: `document-sources.ts` writes `raw/originals/<tenant>/<slug>/<digest>-<file>` and extracted assets, and `fetch.ts` writes page images, all through `writeAsset`. `writeAssetIfAbsent` now exists on the provider interface, so migrating them is cheap — but it is outside DW-438, whose location is `src/lib/raw.ts:116`.
status: open

### DW-573: Both create-only filesystem writes depend on `fs.link`, which some filesystems do not support.
origin: spec-deferred a988edfb1e14
location: src/lib/storage/filesystem.ts:397
source_spec: `spec-dw-437-438-raw-source-listing-and-store-safety.md`
severity: low
reason: `createOnlyWrite` publishes by hard-linking a complete tmp inode and treats only `EEXIST` as "occupied"; on exFAT or a FUSE/network mount without hard links the call would fail with `EPERM`/`ENOSYS` and every Source arrival would throw where the old rename-based `writeAsset` succeeded. Pre-existing for `writeFileIfAbsent`, which has shipped on this mechanism since DW-272.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-filesystem-publication-mechanics
resolution-undo: 3a20726c29e49a4647a7fdb4db75d437b0ae720271919e0b709895b24a73ac04 2026-09-01 7374617475733a206f70656e

### DW-574: The create-only door has no fault-identity coverage on either provider.
origin: spec-deferred 1ef653883586
location: src/lib/__tests__/storage-fs-fault-identity.test.ts
source_spec: `spec-dw-437-438-raw-source-listing-and-store-safety.md`
severity: low
reason: `storage-fs-fault-identity.test.ts` pins that a failed publication leaves no scratch file and propagates the original error for `atomicWrite`; nothing does the same for `createOnlyWrite` (a non-`EEXIST` `fs.link` failure, tmp cleanup on a throwing publish) or for a rejecting R2 `put`.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-filesystem-publication-mechanics
resolution-undo: 3a20726c29e49a4647a7fdb4db75d437b0ae720271919e0b709895b24a73ac04 2026-09-01 7374617475733a206f70656e

### DW-575: `parseRegistry`'s bare `JSON.parse` still lets a raw `SyntaxError` escape, unlike the `parseSlots` it mirrors.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-research-store-parse-and-guards
resolution-undo: 04528005c204bdaa752cc306b31fd1cc0c7aa3a7952ef6613b409978b94e6a61 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 7b7a597668da
source_spec: `spec-dw-476-478-479-research-store-input-and-cap-hardening.md`
archived: 2026-08-31

### DW-576: `GET /api/research/[id]/run` has no catch, so a refused registry escapes as a framework 500 with no `{ error }` body.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-research-run-route-error-typing
resolution-undo: 17fc47581e89988766b4bf51ab5b234bd3c8e4474e8e477ca08cb273685072bd 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 5bac45c721bc
source_spec: `spec-dw-476-478-479-research-store-input-and-cap-hardening.md`
archived: 2026-08-31

### DW-577: `POST /api/research/[id]/run` still classifies by message regex and has no `ClientInputError` branch.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-research-run-route-error-typing
resolution-undo: 17fc47581e89988766b4bf51ab5b234bd3c8e4474e8e477ca08cb273685072bd 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 0bb1680d33f8
source_spec: `spec-dw-476-478-479-research-store-input-and-cap-hardening.md`
archived: 2026-08-31

### DW-578: `ClientInputError` is classified by `instanceof` at ~16 route sites, the mechanism `read-only.ts` documents as unreliable across a duplicated module graph.
origin: spec-deferred af2f5b90fa56
location: src/lib/errors.ts:21
source_spec: `spec-dw-476-478-479-research-store-input-and-cap-hardening.md`
severity: low
reason: `src/lib/read-only.ts:20-22` states `isReadOnlyError` matches on `err.name` rather than `instanceof` "so a duplicated module graph (vitest's two projects, bundler chunking, the stdio MCP entry point) cannot turn a route's 403 back into a 500." The identical failure mode applies to every `error instanceof ClientInputError` site and would degrade silently to 500 in production with no test able to see it. A `isClientInputError(err)` helper beside the class in `errors.ts` would close it repo-wide. Pre-existing across every such site; this change added four more.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-module-graph-fragility
resolution-undo: 3b6de595a5695a7cd945cc07198a564a1a29c8e59dbd7d8d94fb6846c2032adb 2026-09-02 7374617475733a206f70656e

### DW-579: `research-completion.ts` dereferences `project.completion.sources` after only a phase check, so a wrong-shaped `completion` still dies with an opaque TypeError.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-research-store-parse-and-guards
resolution-undo: 04528005c204bdaa752cc306b31fd1cc0c7aa3a7952ef6613b409978b94e6a61 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 08eb77ec7c66
source_spec: `spec-dw-476-478-479-research-store-input-and-cap-hardening.md`
archived: 2026-08-31

### DW-580: The v1 façade answers 4xx with machine tokens everywhere except the new `deep_research` 400, which emits an English sentence.
origin: spec-deferred 1a77a9c8b8f4
location: src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:167
source_spec: `spec-dw-476-478-479-research-store-input-and-cap-hardening.md`
severity: low
reason: `v1-contract.ts` supplies `unknown_action` / `not_found` / `wiki_not_found`, and the route's other 4xx bodies use them, so an agent switch-casing on `error` gets a token — except this branch, which passes the store's prose through `getErrorMessage`. Nothing in the repo pins a v1 4xx vocabulary and the door's 403 already emits a sentence, so this is an inconsistency in the façade's error contract rather than a broken one. Worth one focused pass over v1 error bodies.
status: open

### DW-581: The DW-26 mode-switch block clicks rail controls with a Create Wiki dialog open, the same unreachable pointer path DW-511 removed from the Settings suite.
origin: spec-deferred f315fb6d2101
location: src/components/workbench/__tests__/wiki-canvas-persistence.test.tsx (the DW-26 block)
source_spec: `spec-dw-511-rail-reachability-under-dialogs.md`
severity: medium
reason: `describe("an open Create Wiki dialog survives a mode switch (DW-26)")` opens the dialog with `openCreateWith(...)` and then drives a rail control while the backdrop is live: `fireEvent.click(rail("Chat"))` at ~l.178, ~l.198 and ~l.230, and `clickRail("Chat")` / `clickRail("Wiki")` at ~l.274 and ~l.279. `CreateWikiDialog`'s root is the same `fixed inset-0 z-[120] ... bg-black/40` overlay, and `.wb-rail` carries no `z-index`, so in a browser those clicks land on the backdrop — whose `onMouseDown` CANCELS the dialog, meaning the mode switch never happens and the draft the block exists to preserve is discarded. The cases pass only because jsdom does no hit-testing. PRE-EXISTING: this file was not touched by DW-511, which fixed the Settings suite only. The fix shape is the one DW-511 used — seed the reachable route before the dialog opens, then traverse — plus the executable backdrop pin the Settings suite now carries.
status: open

### DW-582: The SSE event regex is unanchored, so a block with no `event:` line whose data payload contains the text `event: done` is read as a done frame.
origin: spec-deferred 3260fb33b7ec
location: src/lib/chat-session-transport.ts:48
source_spec: `spec-dw-444-chat-canvas-transport-extract.md`
severity: low
reason: `EVENT_RE = /event:\s*(\w+)/` is matched against the whole block rather than a line start, so `readSidecarSseBlock` returns `{event:"done"}` for `data: {"delta":"see event: done for details","content":"FAKE"}`. Moved verbatim from `ChatCanvas.tsx` at `ab263b98`, so it predates DW-444; the extraction is what made it reachable from a test. `/^event:\s*(\w+)/m` would close it. Low today because the sidecar's `formatSse` always writes the `event:` line first.
status: open

### DW-583: A malformed `data:` payload throws a raw SyntaxError that kills a turn the owner is already reading.
origin: spec-deferred aaaf8e503d3f
location: src/lib/chat-session-transport.ts:63-71
source_spec: `spec-dw-444-chat-canvas-transport-extract.md`
severity: low
reason: `readSidecarSseBlock` calls `JSON.parse` with no guard, and the throw escapes `consumeSidecarStream`, so `turnFailureCopy` shows the parser's own sentence. Pre-existing: identical code in `applySseBlock` at `ab263b98`. Returning `null` for an unparseable payload would match the module's stated "an unknown block must not kill an answer" rule.
status: open

### DW-584: The stream reader is never released or cancelled when a turn throws, so an `error` or `cancelled` frame leaves the response body locked and undrained.
origin: spec-deferred db7f98cf4216
location: src/lib/chat-session-transport.ts:113-133
source_spec: `spec-dw-444-chat-canvas-transport-extract.md`
severity: low
reason: `consumeSidecarStream` has no `try/finally` around the read loop; after an `error` frame `body.locked` stays true and `cancel()` is never called. Pre-existing shape from `ab263b98`. A `finally { reader.cancel().catch(() => {}) }` would close it. Bounded impact: the door is a local loopback connection.
status: open

### DW-585: `frame.citations ?? turn.fallbackCitations` never fires, because the sidecar sends `citations: []` rather than omitting the field.
origin: spec-deferred 8e4217424fcf
location: src/lib/chat-pending-turn.ts:139
source_spec: `spec-dw-444-chat-canvas-transport-extract.md`
severity: low
reason: `??` only substitutes on null/undefined. `sidecar/agent.mjs` and `sidecar/chat-transport.mjs` emit `citations: []` on the settle paths, so `OpenTurn.fallbackCitations` is effectively dead and such an answer is reduced to the coverage sentence. Moved verbatim from `ab263b98`, so the behaviour is unchanged by DW-444; deciding whether the assemble's citations should stand in for an empty array is a Chat-behaviour question, not a refactor one.
status: open
decision: 2026-08-31 Rescue an empty settle — Change the read to `frame.citations?.length ? frame.citations : turn.fallbackCitations` so a settle frame carrying no citations falls back to the ones assemble already resolved, and pin the rescue with a transport test that settles with an empty array and asserts the fallback citations reach the rendered turn.

### DW-586: Nothing asserts that pressing Stop, or unmounting, actually aborts an in-flight turn.
origin: spec-deferred 4f9a3c88807a
location: src/components/workbench/ChatCanvas.tsx:278
source_spec: `spec-dw-444-chat-canvas-transport-extract.md`
severity: low
reason: `stopTurn()` and the unmount effect abort `abortRef`, and `driveTurn` forwards `controller.signal` to `runSidecarTurn`; the transport suite only checks that whatever signal it is handed is forwarded. No mounted test presses Stop. The gap predates DW-444, but the abort hop now crosses a module boundary, so it is worth a mounted assertion.
status: open

### DW-587: ChatCanvas is still 1,247 lines: conversation CRUD, persistence, the assemble call, the Skill scan, attachments, regenerate and save-to-wiki remain inline beside the JSX.
origin: spec-deferred 176bde474e77
location: src/components/workbench/ChatCanvas.tsx
source_spec: `spec-dw-444-chat-canvas-transport-extract.md`
severity: low
reason: DW-444 named exactly two subjects and both are out, but the retro finding that opened this thread was about file size. A further decomposition pass (the conversation store, and the composer's non-render concerns) is the natural next follow-on to `epic-8-retro-architecture-follow-on`.
status: open

### DW-588: The whole vitest `dom` project is broken on Node 26: `window.localStorage` is undefined, so 13 files / 233 mounted tests fail before asserting anything.

status: done 2026-08-29
origin: spec-deferred cf14d367093b
source_spec: `spec-dw-460-461-462-473-test-pin-hardening.md`
archived: 2026-08-31

### DW-589: The DW-356 AGENTS.md parity test is per-PATTERN, so a member added to or dropped from a multi-member enumeration never has to be documented.
origin: spec-deferred 250f5205735c
location: src/lib/__tests__/brand-copy.test.ts (AGENTS.md yopedia parity test)
source_spec: `spec-dw-460-461-462-473-test-pin-hardening.md`
severity: medium
reason: `brand-copy.test.ts`'s "AGENTS.md's yopedia prose and IDENTIFIER_ALLOWLIST agree in both directions" asserts only that each allowlist PATTERN matches at least one backticked spelling in the frozen-identifier section. Both enumerated families are one pattern each, so a fifth `X_YOPEDIA_HEADERS` member — or a fifteenth `YOPEDIA_HYPHEN_IDENTIFIERS` member — satisfies direction 2 on the strength of a sibling and is never forced into the prose. The minimality sweep forces a member to exist in the shipped TREE, not in AGENTS.md. Pre-existing since DW-352 created the first enumerated family; DW-473 extends it to a second. A per-member parity assertion would close it for both at once.
status: open

### DW-590: Three more call sites from the same 308-shim conversion -- IngestSuccess, BatchItemRow (via BatchIngestForm) and useGlobalSearch's router.push -- are still unpinned, so reverting any of them to slugPa
origin: spec-deferred 6c8f87fdc7ed
location: src/components/IngestSuccess.tsx:20
source_spec: `spec-dw-259-325-component-anchor-and-flake-coverage.md`
severity: medium
reason: This story's intent enumerated three components (RecentIngests, ActionInbox, BulkDocumentImport) and those are now pinned. `src/components/IngestSuccess.tsx:20,35` (rendered by `src/app/ingest/page.tsx:71`), `src/components/BatchItemRow.tsx:43` (fed `hrefForSlug` as a prop from `src/components/BatchIngestForm.tsx:319`) and `src/hooks/useGlobalSearch.ts:197` (`router.push(hrefForSlug(slug))`, consumed by `GlobalSearch.tsx`) come from the same sweep, and no `*.test.ts`/`*.test.tsx` under `src/` references any of the three. Demonstrated during review: all four sites were reverted to a `/u/yopedia/${slug}` answer at once and `pnpm test` was byte-identical to the unmutated tree -- 13 failed / 331 passed files, 233 failed / 7728 passed tests -- not one extra failure. `IngestSuccess` and `BatchItemRow` take plain props and drop straight into `owner-scoped-anchors.test.tsx`; `useGlobalSearch` is a navigation, so it fits that file's existing `nav.router.push` mock instead of an href assertion.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-owner-scoped-anchor-coverage
resolution-undo: 318b6dbe48121400504d2c2e9904638ba9d872615ae0de480663dd4e2480a269 2026-09-02 7374617475733a206f70656e

### DW-591: On Node 26 the runtime's own localStorage global shadows jsdom's, so `window.localStorage` is undefined in the dom project and 13 workbench suites (233 tests) fail before any assertion.

status: done 2026-08-29
origin: spec-deferred 06d79b086f45
source_spec: `spec-dw-259-325-component-anchor-and-flake-coverage.md`
archived: 2026-08-31

### DW-592: DW-325 closed the flake class for one case; ~14 structurally identical `returnToTab()` + `waitFor` cases in the same describe keep the same millisecond-budget exposure.
origin: spec-deferred bdd55ed0cf5a
location: src/components/__tests__/workspace-purpose-settings.test.tsx:796
source_spec: `spec-dw-259-325-component-anchor-and-flake-coverage.md`
severity: low
reason: `src/components/__tests__/workspace-purpose-settings.test.tsx` still contains ~83 `waitFor(` calls, and the describe at `:796` holds roughly fourteen cases with the same `render -> waitFor(fieldset enabled) -> returnToTab() -> waitFor(badge/status)` shape -- including `await waitFor(() => expect(badge()).toBe("no wiki"))` at `:1008`, which is the literal assertion whose expiry produced the observed red. This story's intent named one case and its spec forbade widening, so the scoping is deliberate; the exposure is simply still there, and `settleUntil` now exists in the file as the clock-free replacement.
status: done 2026-09-02
resolution: already resolved: commit 48412822 — src/components/__tests__/workspace-purpose-settings.test.tsx now holds one 20-line case with zero waitFor and zero returnToTab calls; the ~14-case describe block carrying the exposure no longer exists.

### DW-593: ActionInbox never reads `ActionItem.sourceMissing`, so a to-do whose cited Source was cascade-deleted still renders a live `source · <slug>` link into a page that is gone.
origin: spec-deferred 0ee77ef63189
location: src/components/ActionInbox.tsx:387
source_spec: `spec-dw-259-325-component-anchor-and-flake-coverage.md`
severity: low
reason: `src/lib/action-items.ts:26` declares `sourceMissing` with the comment "The cited Source was cascade-deleted. The todo itself is kept." `grep -c sourceMissing src/components/ActionInbox.tsx` is 0, and the chip at `:387` is gated only on `item.sourceSlug`. Pre-existing production behaviour, surfaced because this story gave the component its first test of any kind; pinning or fixing it is a separate change.
status: open

### DW-594: The graph canvas's fallback `<a href={KNOWLEDGE_TREE_HREF}>` child is itself focusable, so a keyboard reader can still land on a focus stop inside the canvas that renders nothing on screen.
origin: spec-deferred f1185431fee3
location: src/app/wiki/graph/page.tsx:201
source_spec: `spec-dw-463-graph-canvas-keyboard-activation.md`
severity: medium
reason: Verified in this repo's jsdom: the fallback anchor reports `tabIndex === 0` and becomes `document.activeElement` after `.focus()`. Browsers likewise include focusable canvas fallback content in the sequential focus order — that is what `CanvasRenderingContext2D.drawFocusIfNeeded` exists for. `role="img"` prunes the subtree from the ACCESSIBILITY tree, which is a different thing from the focus order. Pre-existing (the fallback child predates DW-463) and out of DW-463's scope, which named the canvas element itself; the DW-463 pin is deliberately narrowed to the element and says so.
status: open

### DW-595: Graph nodes remain unreachable by keyboard: DW-463 was resolved by removing the inert focus stop, so the intent's other branch — a keyboard-owned node cursor plus onKeyDown reaching the same handler t
origin: spec-deferred a4bc6951fdb6
location: src/app/wiki/graph/page.tsx:186
source_spec: `spec-dw-463-graph-canvas-keyboard-activation.md`
severity: medium
reason: `handleClick` (src/hooks/useGraphSimulation.ts:272-291) hit-tests `e.clientX/clientY` against node positions, and `hoveredRef` is written only by `handleMouseMove`, so there is no keyboard-addressable node. Opening a wiki page from the graph is therefore pointer-only. The text alternative (the Workbench Knowledge tree) covers it for WCAG purposes but is not an exact substitute — the graph is `?scope=` lens-scoped and the tree is not, as the page's own block comment records. The only trace of the unbuilt branch today is a code comment and a test failure message.
status: open
decision: 2026-08-29 Build the keyboard node cursor — Give the graph a keyboard-owned node cursor: a focusable canvas with an owned index into the node set, arrow keys moving it, Enter/Space reaching the same handler `handleClick` does, and a visible cursor indication drawn on the canvas plus an accessible announcement of the focused node. Keep the pointer path unchanged and route both through one activation function. Pin keyboard activation opening the same page a click does.
decision: 2026-08-29 Build the keyboard node cursor — Give the graph a keyboard-owned node cursor: a focusable canvas with an owned index into the node set, arrow keys moving it, Enter/Space reaching the same handler `handleClick` does, and a visible cursor indication drawn on the canvas plus an accessible announcement of the focused node. Keep the pointer path unchanged and route both through one activation function. Pin keyboard activation opening the same page a click does.

### DW-596: Nothing pins that the graph canvas's click activation path stays wired, so dropping `onClick` would leave the canvas fully inert with every accessibility test still green.
origin: spec-deferred 4ffcbecbb9b6
location: src/app/wiki/graph/__tests__/graph-escape-hatch-mounted.test.tsx
source_spec: `spec-dw-463-graph-canvas-keyboard-activation.md`
severity: low
reason: `graph-escape-hatch-mounted.test.tsx` stubs `useGraphSimulation`, and its `handleClick` is a fresh `vi.fn()` per render that no test dispatches a click at; no other suite mounts this page or exercises the hook. "Pointer is the remaining activation path" is the premise the DW-463 removal rests on, asserted in three comments and observed nowhere. A hoisted spy plus `fireEvent.click(theCanvas())` would make it a fact.
status: open

### DW-597: Thirteen dom suites under src/components/workbench/__tests__/ fail at window.localStorage.clear() on Node 26, unrelated to any code change.

status: done 2026-08-29
origin: spec-deferred 8c924f9045ee
source_spec: `spec-dw-393-bulk-ingest-delete-per-entry-outcomes.md`
archived: 2026-08-31

### DW-598: DW-404's own recorded reproduction (topK 1, one stale-tagged and one current-tagged vector, alternating queries) still emits four drift lines under the narrowed whole-window gate, so the entry's named
origin: spec-deferred 13bb0e02d8ee
location: src/lib/embeddings.ts (searchByVector re-arm branch)
source_spec: `spec-dw-404-drift-rearm-whole-window.md`
severity: medium
reason: `queryEmbeddings` sorts and slices to topK BEFORE `searchByVector` applies the model filter, so with `topK: 1` the window holds a single match; when that match is the current-tagged vector the window matches wholly and re-arms exactly as `kept.length > 0` did. Reproduced independently by two reviewers against the patched code: four lines before, four lines after. Closing it needs a corpus-level signal (the rebuild-completion epoch the ledger names as the alternative fix), which the 2026-08-22 decision did not authorize and this spec forbids.
status: open
decision: 2026-08-29 Filter before the topK slice — Apply the model filter inside `queryEmbeddings` before the sort-and-slice, so the window `searchByVector` judges is a filtered one and a topK-1 window can no longer be wholly-current by accident. This stays inside the authorized whole-window gate rather than reopening the decision. Pin DW-404's own reproduction — topK 1, one stale-tagged and one current-tagged vector, alternating queries — as the case that must emit one line, not four.
decision: 2026-08-29 Filter before the topK slice — Apply the model filter inside `queryEmbeddings` before the sort-and-slice, so the window `searchByVector` judges is a filtered one and a topK-1 window can no longer be wholly-current by accident. This stays inside the authorized whole-window gate rather than reopening the decision. Pin DW-404's own reproduction — topK 1, one stale-tagged and one current-tagged vector, alternating queries — as the case that must emit one line, not four.

### DW-599: After the narrowing, one stale ORPHAN vector wedges `drift:<model>` shut permanently, so a second genuine drift ships silent on any store that has ever deleted, renamed, or emptied a page.
origin: spec-deferred 238c046ea45c
location: src/lib/embeddings.ts (warnedMisconfigurations drift bullet; rebuildVectorStore)
source_spec: `spec-dw-404-drift-rearm-whole-window.md`
severity: medium
reason: `rebuildVectorStore` never deletes (its own docblock says so) and `continue`s past pages with empty content or a failed embed, so a COMPLETED rebuild can still leave stale-tagged vectors behind. Every window containing one is mixed forever, and a mixed window no longer re-arms. Verified by probe: two vectors, a completed rebuild re-tagging only the live one, then a genuine re-drift under the same active model produced ONE warning where the DW-332 pins assert two. Documented in prose on `warnedMisconfigurations` by this change, but not mitigated and not pinned by any test — mitigating it would need the rebuild to delete, or persisted rebuild state, both Block-If conditions here.
status: open
decision: 2026-08-29 Persist rebuild state and re-arm from it — Persist the completion of a rebuild (an epoch or generation stamp) and re-arm the drift warning from that rather than from the composition of a query window, so an orphan vector cannot wedge the warning shut. Leave `rebuildVectorStore`'s never-delete contract intact. Pin the probe's scenario: two vectors, a completed rebuild re-tagging only the live one, then a genuine re-drift must warn again.
decision: 2026-08-29 Persist rebuild state and re-arm from it — Persist the completion of a rebuild (an epoch or generation stamp) and re-arm the drift warning from that rather than from the composition of a query window, so an orphan vector cannot wedge the warning shut. Leave `rebuildVectorStore`'s never-delete contract intact. Pin the probe's scenario: two vectors, a completed rebuild re-tagging only the live one, then a genuine re-drift must warn again.

### DW-600: `spec-dw-404-405-406-embedding-drift-rearm-gate.md` is still `status: in-review` though it was never implemented, and now prescribes a predicate that contradicts the 2026-08-22 human decision.
origin: spec-deferred 3019a8e56821
location: _bmad-output/implementation-artifacts/spec-dw-404-405-406-embedding-drift-rearm-gate.md
source_spec: `spec-dw-404-drift-rearm-whole-window.md`
severity: medium
reason: That spec reconciles DW-404 and DW-405 into `matches.every((m) => m.metadata.model === model)` and also rewrites `relatedByVector` (DW-406). HEAD before this run still had `kept.length > 0`, so none of it ever landed. A later run routing on its `in-review` status would re-derive the strict-label gate and silently close DW-405, which the human decision deliberately left open, and would pull DW-406 in with it. It needs to be withdrawn or re-scoped by whoever owns the ledger.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-related-by-vector-drift-voice
resolution-undo: 41c6f505ef7bd8c3b921e54d2f717048d006ed58790d2ce489533009da760ef5 2026-09-01 7374617475733a206f70656e
decision: 2026-08-29 Withdraw the spec — Move the spec's status from `in-review` to `withdrawn` with a note recording that DW-404 and DW-405 were settled by the 2026-08-22 decision and closed by later sweeps, and that its prescribed predicate contradicts that decision. Name the commits that closed them so a reader can find the shipped behaviour. Leave DW-406 to be re-filed on its own terms if it is still wanted.
decision: 2026-08-29 Withdraw the spec — Move the spec's status from `in-review` to `withdrawn` with a note recording that DW-404 and DW-405 were settled by the 2026-08-22 decision and closed by later sweeps, and that its prescribed predicate contradicts that decision. Name the commits that closed them so a reader can find the shipped behaviour. Leave DW-406 to be re-filed on its own terms if it is still wanted.

### DW-601: No test discriminates the permissive whole-window gate from the strict-label variant, so the DW-405 decision point rests on one code line with zero coverage in either direction.

status: done 2026-08-29
origin: spec-deferred 0e302255352d
source_spec: `spec-dw-404-drift-rearm-whole-window.md`
archived: 2026-08-31

### DW-602: Two `searchByVector` calls in flight at once can interleave so that a window read BEFORE the drift key was burnt applies its re-arm AFTER, un-burning the key and letting the same standing drift speak
origin: spec-deferred 66e879681741
location: src/lib/embeddings.ts:1015 (searchByVector re-arm/warn branch chain)
source_spec: `spec-dw-405-drift-rearm-labelled-proof.md`
severity: low
reason: The gate, the `warnOnceAbout` burn and the `rearmWarningAbout` delete all run after `await getStorage().queryEmbeddings(...)`, and nothing carries a sequence number across that await. A healthy read that resolves late therefore re-arms on evidence gathered before another query burnt the key, and the next drifted read emits a second line — the repetition DW-310's throttle exists to prevent. Pre-existing and independent of the gate's shape: it holds identically under DW-332's `kept.length > 0`, DW-404's whole-window gate and this one, so this change neither causes nor worsens it. Not reproduced by a test: it needs a specific interleave of concurrent in-flight queries, unlike DW-404's and DW-405's reproductions, which are deterministic on sequential reads. Cost when it does happen is one extra breadcrumb line, and a guard would mean threading a burn sequence number through the door.
status: open

### DW-603: `cleanUrls`' 40-item and 2000-character caps and its dedupe are untested on what is now the only write path for a project's source URLs.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-research-store-parse-and-guards
resolution-undo: 04528005c204bdaa752cc306b31fd1cc0c7aa3a7952ef6613b409978b94e6a61 2026-08-30 7374617475733a206f70656e
origin: spec-deferred 57ce341dfb77
source_spec: `spec-dw-442-research-create-drops-source-urls.md`
archived: 2026-08-31

### DW-604: No operator-facing surface documents WORKWIKI_SIDECAR_ALLOWED_ORIGINS, so an owner whose deployed page reports down has nowhere outside the source to learn the knob exists.
origin: spec-deferred 709eca390daa
location: .env.example
source_spec: `spec-dw-25-sidecar-cross-origin-contract.md`
severity: low
reason: The env is described only in a JSDoc in sidecar/server.mjs and the module comment in src/lib/sidecar.ts. `.env.example` and DEPLOY.md carry no sidecar variables at all, so there is no existing convention this change skipped — but the whole point of DW-25 is explainability to the owner, and the two places it is explained are both source files.
status: open

### DW-605: LOOPBACK_ORIGIN_RE admits only 127.0.0.1 and localhost, so a dev server on IPv6 loopback (http://[::1]:3000) is refused with no configuration.
origin: spec-deferred 95592f2fb71c
location: sidecar/server.mjs:88
source_spec: `spec-dw-25-sidecar-cross-origin-contract.md`
severity: low
reason: sidecar/server.mjs:88 is `^https?://(127\.0\.0\.1|localhost)(:\d+)?$`. Pre-existing since Epic 3 and deliberately untouched here (the intent forbids widening the regex); the new contract prose now states the limit explicitly rather than fixing it.
status: open

### DW-606: The `listen()` test harness is now duplicated in three suites, which will drift.
origin: spec-deferred b50971939acf
location: src/lib/__tests__/sidecar.test.ts
source_spec: `spec-dw-25-sidecar-cross-origin-contract.md`
severity: low
reason: Near-verbatim copies live in src/lib/__tests__/sidecar.test.ts, src/lib/__tests__/workbench-epic8.test.ts and src/lib/__tests__/epic8-remediation.test.ts, `as never` casts included. AGENTS.md's test-infra conventions call for one shared helper per concern (the DW-117 precedent for `walkFiles`); extracting one is a separate change touching three suites.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-shared-test-helper-extraction
resolution-undo: 48060ee7b14d816f7b1256e34b9a261a5a5e2d6b6603343dde92f9e75b28e0c0 2026-09-02 7374617475733a206f70656e

### DW-607: An owner on an unconfigured deployed origin still sees "Start the local sidecar..." for a sidecar that is running — the product copy cannot distinguish "not running" from "running but unreachable from
origin: spec-deferred d3589d54789c
location: src/lib/workbench-modes.ts:81
source_spec: `spec-dw-25-sidecar-cross-origin-contract.md`
severity: medium
reason: CHAT_SIDECAR_DOWN_COPY (src/lib/workbench-modes.ts:81) is unchanged and useSidecarStatus still collapses every failure into "down". This change makes that state configurable away and explicable to a reader of the source, but not to the owner in the product. The recorded 2026-08-28 decision names only sidecar/server.mjs, src/lib/sidecar.ts and the pins, so distinguishing the two states in copy is beyond it.
status: open

### DW-608: `reconcileSilos`' forward pass gates on the wiki md, so a page whose silo copy is already current never re-syncs its Sources — flat or hashed.
origin: spec-deferred 89c8fd2fb206
location: src/lib/silo.ts:263
source_spec: `spec-dw-435-silo-hashed-intake-paths.md`
severity: medium
reason: src/lib/silo.ts:263-281 calls syncSiloForPage only when the silo `tenants/<t>/wiki/<slug>.md` is missing or its bytes differ from flat; otherwise the page counts as `alreadyCurrent`. lifecycle.ts writes silo and flat from the identical `op.content`, so a live page always lands on `alreadyCurrent`. A Source added after the page md was mirrored is therefore never repaired by reconcile. This predates DW-435 and applies identically to the flat `raw/sources/<slug>.md` mirror; widening the gate means listing raw sources for every page on every reconcile, which is its own subrequest-budget decision.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-silo-sync-gate-coverage
resolution-undo: ef2ba2220bf852973feea77d5c94951d2c7caf702969056eef229a5d63f9de5a 2026-09-01 7374617475733a206f70656e

### DW-609: A normal page delete never routes through `removeSiloForPage`, so silo raw artifacts (flat source, hashed tree, discuss, assets) leak on deletion.
origin: spec-deferred 3f311ceb04e9
location: src/lib/lifecycle.ts:618
source_spec: `spec-dw-435-silo-hashed-intake-paths.md`
severity: medium
reason: lifecycle.ts:618-638 deletes the silo wiki md, the flat wiki md and both revision layouts directly; lifecycle.ts:932-936 records that the syncSiloForPage/removeSiloForPage mirror was deliberately retired from that path. removeSiloForPage's only production caller is the reverse-orphan pass (src/lib/silo.ts:311), which discovers ghosts by scanning `tenants/<t>/wiki/*.md` — a hard-deleted page's silo md is already gone, so its slug never appears. Pre-existing and identical for the assets directory and the discuss thread; DW-435's new deleteDirSafe inherits the shape rather than introducing it.
status: open

### DW-610: The legacy hashed root `raw/<slug>/<rawId>.md` is still never mirrored into any silo, so pre-move hashed arrivals stay invisible in Files.
origin: spec-deferred c6af80f1ec65
location: src/lib/silo.ts:121
source_spec: `spec-dw-435-silo-hashed-intake-paths.md`
severity: low
reason: `readRawSourceById` falls back to `rawRelPath(<slug>/<rawId>.md)` and `listRawSourceSnapshots` enumerates `rawRelPath("")` as a second root, so workspaces written before Sources moved under `raw/sources/` demonstrably hold hashed bytes only there. The flat legacy `raw/<slug>.md` IS mirrored two lines above for exactly that reason. DW-435's intent names only `raw/sources/<slug>/<rawId>.md`, so the widening is out of scope here.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-silo-sync-gate-coverage
resolution-undo: ef2ba2220bf852973feea77d5c94951d2c7caf702969056eef229a5d63f9de5a 2026-09-01 7374617475733a206f70656e

### DW-611: `raw/sources/<name>/` is shared by page slugs and folder-import roots; nested import content is never mirrored but IS recursively deleted.
origin: spec-deferred 44d9476a0211
location: src/lib/silo.ts:223
source_spec: `spec-dw-435-silo-hashed-intake-paths.md`
severity: low
reason: `saveRawSourceTree` (src/lib/raw.ts:459) writes `raw/sources/<dir>/<file>` at any depth with every segment validateSlug'd, so a folder-import root can collide with a page slug. The new sync loop copies top-level files only, while `deleteDirSafe` is recursive on both providers (filesystem.ts fs.rm recursive; r2.ts prefix sweep). A page slugged the same as an import root therefore mirrors that import's top-level files into its silo and deletes the whole import tree with the page. The namespace ambiguity predates DW-435; this change exercises it.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-silo-sync-gate-coverage
resolution-undo: ef2ba2220bf852973feea77d5c94951d2c7caf702969056eef229a5d63f9de5a 2026-09-01 7374617475733a206f70656e

### DW-612: A drifted-handle owner now passes the gate but still addresses a handle-keyed silo, so their writes land in a tenant nothing reads.
origin: spec-deferred c9f4e0a090a3
location: src/app/api/wikis/route.ts:85
source_spec: `spec-dw-486-owner-identity-gate-on-stable-id.md`
severity: medium
reason: `isOwnerPrincipal` resolves WHO the owner is by the stable Clerk id, but WHICH tenant they address is still derived from `principal.handle`: `POST /api/wikis` calls `createWiki(principal.handle, ...)` (src/app/api/wikis/route.ts) while the Schema that executes is read from `getOwnerHandle()` (`readActiveWikiSchema`, src/lib/wikis.ts:2149), and `PUT /api/workbench/artifact` writes to the caller's tenant. Before this change the owner-by-id whose handle had drifted got a loud 403; now they get a 200 whose bytes land in a silo (named after the raw Clerk id, in the no-username case) that no prompt or reader ever opens. Both routes' own comments describe exactly that "silently inert save" as the thing their gate existed to prevent. DW-486's recorded decision covered owner-ness only; which silo the admitted owner addresses is a separate fact needing its own decision, and the fix has more than one defensible shape (route the owner's tenant through `getOwnerHandle()`; refuse when the id-owner's
status: open
decision: 2026-08-31 Canonical tenant for id-owners — Route an owner admitted by stable id through getOwnerHandle() when deriving the tenant, so id-owners always address the canonical silo regardless of their current handle. Audit every write door that derives a tenant from principal.handle for the same substitution and pin that a drifted-handle owner's write lands where the reads look.

### DW-613: The three client owner gates cannot see the stable id, so client and server owner-ness can now disagree in BOTH directions, and the harness written to catch that never runs with an owner id configured
origin: spec-deferred 5863e6ee762f
location: src/components/__tests__/article-actions-delete-gate.test.tsx:211
source_spec: `spec-dw-486-owner-identity-gate-on-stable-id.md`
severity: medium
reason: `NavHeader.tsx:53`, `ArticleActions.tsx:118` and `RevisionHistory.tsx:132` stay on `isOwnerHandle` because `YOPEDIA_OWNER_USER_ID` is server-only and is never inlined into the bundle. With an id configured the client answer is no longer merely NARROWER than the server's: an impostor holding a stale `NEXT_PUBLIC_OWNER_HANDLE` is refused by every server gate yet is still shown the owner affordances, and the id-matching owner whose handle drifted is shown none. `src/components/__tests__/article-actions-delete-gate.test.tsx` is the one harness that compares the client gate against the real `canWritePage`, and it sets only `NEXT_PUBLIC_OWNER_HANDLE` in its `beforeEach` (:211) so both sides resolve from the same fact and agree by construction; running it with `YOPEDIA_OWNER_USER_ID=user_2stable` produces 4 failures, including "offers Delete to nobody the server would refuse". Closing this needs a decision: hand the islands a server-computed `isOwner` prop, or accept the divergence and parame
status: open
decision: 2026-08-31 Pass a server-computed flag — Compute isOwner on the server and pass it as a prop down to NavHeader, ArticleActions and RevisionHistory, so the client gate is the server's answer rather than an independent re-derivation, and reparameterize the harness to drive the two sides from different facts so a divergence is visible.

### DW-614: `src/mcp.ts` mints `service:mcp` principal ids from a raw string literal rather than the shared `SERVICE_PRINCIPAL_ID_PREFIX`.

status: done 2026-08-30
resolution: resolved by sweep bundle dw-mcp-door-hardening
resolution-undo: 69668be5bc24c764633fb3e08e3c2a165cd7fed4b1be2c9451585feb8d1d19fb 2026-08-30 7374617475733a206f70656e
origin: spec-deferred bf8b971590b0
source_spec: `spec-dw-486-owner-identity-gate-on-stable-id.md`
archived: 2026-08-31

### DW-615: Pre-existing: 13 workbench DOM test files fail on this branch because `window.localStorage` is undefined under jsdom.

status: done 2026-08-29
origin: spec-deferred 6e6c028887b0
source_spec: `spec-dw-486-owner-identity-gate-on-stable-id.md`
archived: 2026-08-31

### DW-616: The Workers AI dimensions sentence on the flat page's embedding model hint is selected by model NAME alone, so an `EMBEDDING_MODEL=@cf/baai/bge-m3` pin on a non-Workers-AI provider claims the deployme
origin: spec-deferred 601986049e42
location: src/components/EmbeddingSettings.tsx:303
source_spec: `spec-dw-66-559-env-locked-credential-affordances.md`
severity: low
reason: `EmbeddingSettings.tsx`'s hint appends the sentence on `effectiveModel === "@cf/baai/bge-m3"` with no provider term, and the component is never handed the embedding provider. Pre-existing: the same name-only condition selected the same sentence before this change, which only added the pin sentence in front of it. Reaching the state needs `EMBEDDING_MODEL` pinned to the Workers AI model while `embeddingProvider` is something else, where the resolver substitutes and the override note already fires — so the dimensions claim is the one sentence still wrong.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-workers-ai-dimension-hint
resolution-undo: 230d26a038a235adb0b6b87f9e0696c484f9e3040fbdab982ccde3f9ed66bf85 2026-09-01 7374617475733a206f70656e

### DW-617: The env-locked `Ollama Base URL` box has the same nameless-locked-box defect DW-562 just fixed on the two model boxes, and no mounted test renders that branch at all.
origin: spec-deferred d980917f3388
location: src/components/ProviderForm.tsx — the `Ollama Base URL` env branch
source_spec: `spec-dw-560-562-env-locked-model-box-a11y.md`
severity: medium
reason: `ProviderForm.tsx` renders `<label htmlFor="ollamaBaseUrl">` unconditionally, while the `settings?.ollamaBaseUrlSource === "env"` branch renders a bare `<div>` with no id — so on an `OLLAMA_BASE_URL`-pinned deployment the label names an id nothing carries and the value is announced with no accessible name, exactly the state removed from `#model` and `#embeddingModel`. Excluded by this bundle's intent, which names only the model boxes. Nothing would catch it drifting further: a repo-wide search for `ollamaBaseUrlSource: "env"` matches only `src/lib/__tests__/config.test.ts` (a server-side resolver test that renders nothing), and every mounted suite uses `config` sources for that field. The fix is the same one-line element swap plus a twin of the accessible-name case.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-provider-form-pick-and-env-label
resolution-undo: 634001e4acbf6f0e4e4a1898a00439359c4b7ab473f5b67ee08a08d8692debe8 2026-09-01 7374617475733a206f70656e

### DW-618: `src/lib/llm.ts` resolves one model client out of several independent entries into the 5 s config cache — the same straddle DW-334 closed inside `config.ts`.
origin: spec-deferred b016a504ab40
location: src/lib/llm.ts:231-242, src/lib/llm.ts:392-451
source_spec: `spec-dw-334-550-config-single-read-resolution.md`
severity: medium
reason: `hasLLMKey` (src/lib/llm.ts:231-242) reads `const cfg = loadConfigSync()` and then asks `providerIsConfigured("custom")` without passing it, and `getConfiguredModel`'s explicit-provider / workload path (src/lib/llm.ts:392-451) calls `getChatModelSettings()` / `getIngestModelSettings()`, `apiKeyForProvider(provider)` and `getCustomBaseUrl()` / `getOllamaBaseUrl()` as separate reads before handing all of them to one `createOpenAI({apiKey, baseURL}).chat(model)`. That path bypasses `getResolvedCredentials`, which this story did close. The optional `cfg` parameters added here make each of these a one-argument fix.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-single-snapshot-config-resolution
resolution-undo: 06861f86ef74e7b9ec7887b6e852e833442ae0c6312c9e5790cd67090c7ed933 2026-09-01 7374617475733a206f70656e

### DW-619: `chatModelForRetrieve` builds one `chatModel` answer from two or three config-cache entries.
origin: spec-deferred 6c595b6cbe1a
location: src/lib/wiki-retrieve.ts:543-549
source_spec: `spec-dw-334-550-config-single-read-resolution.md`
severity: low
reason: `src/lib/wiki-retrieve.ts:543-549` calls `getChatModelSettings()` and then `getCustomBaseUrl()` (or `getOllamaBaseUrl()`) with no shared snapshot, and puts `provider` / `model` / `configured` on `AssembledContext`. Same shape as the legs closed here; both resolvers now take a `cfg`.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-single-snapshot-config-resolution
resolution-undo: 06861f86ef74e7b9ec7887b6e852e833442ae0c6312c9e5790cd67090c7ed933 2026-09-01 7374617475733a206f70656e

### DW-620: The settings payload straddles an `await`, and three of its resolvers still take no `cfg`.
origin: spec-deferred 4ad30020b011
location: src/app/api/settings/route.ts, src/lib/config.ts:getWorkbenchSettings
source_spec: `spec-dw-334-550-config-single-read-resolution.md`
severity: low
reason: `src/app/api/settings/route.ts` resolves `getEffectiveSettings()` and then `getWorkbenchSettings(...)` after an async hop; `getWorkbenchSettings` makes its own `loadConfigSync()` read and calls `getFirecrawlSettings()`, `getResearchSettings()` and `getVectorSearchSettings()`, none of which accepts a snapshot. One HTTP response can therefore describe two config generations across the two panes it renders.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-settings-read-and-write-confirmation
resolution-undo: 0695e4e7909c9421514bc7a7f8b25a5ec79d7345ee66f9e723598d198e60c235 2026-09-02 7374617475733a206f70656e

### DW-621: `hasLLMKey()` keys only off `cfg.provider`, so a store that selects a store-only provider through `chatProvider` or `ingestProvider` alone still reports that nothing is configured.
origin: spec-deferred f1e1f0e2caf6
location: src/lib/llm.ts:247-270
source_spec: `spec-dw-548-549-551-cli-config-warm-and-status.md`
severity: low
reason: The gate reads `cfg.provider` and nothing else (`src/lib/llm.ts:247-270`), but `AppConfig` carries `chatProvider` and `ingestProvider` as independent workload selections (`src/lib/config.ts:63,66`) and the resolvers honour them (`getChatModelSettings` at `src/lib/config.ts:1351`, `getIngestModelSettings` at `:1362`). A deployment that sets only `chatProvider: "ollama"` therefore has Chat refused by the gate at `src/lib/chat.ts:865` for a provider the workload resolver would have constructed. Pre-existing — the gate has always read that one field; DW-548 changed WHERE the field is read from, not WHICH field.
status: open

### DW-622: `src/app/api/status/route.ts` still reads through `loadConfig()`, so the web status surface keeps the unreadable-versus-absent conflation DW-549 just closed on the CLI.
origin: spec-deferred 3ea22bfe0219
location: src/app/api/status/route.ts:6-8
source_spec: `spec-dw-548-549-551-cli-config-warm-and-status.md`
severity: low
reason: `src/app/api/status/route.ts:7` awaits `loadConfig()`, which flattens `readStoredConfig`'s `unreadable` answer to `{}` (`src/lib/config.ts:813`). The served `ProviderInfo` therefore reports `configured: false` for a config that exists but could not be parsed, exactly as `yopedia status` used to. `readConfig()` keeps the distinction and is the same single round-trip. DW-549's intent named `yopedia status` only, so the web route was out of scope for this bundle.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-config-read-and-set-text-arms
resolution-undo: a9cfbe9fcdd5f656398928ae099370542c662a0f2e3631a21fbcc2d15c23a136 2026-09-01 7374617475733a206f70656e

### DW-623: `applyWorkbenchSettings`'s `setText` still resolves a non-string to `""` and then reads `""` as the delete, so the two halves of the settings body now answer differently about the same stored key.
origin: spec-deferred fa5b85674318
location: src/lib/config.ts (applyWorkbenchSettings -> setText)
source_spec: `spec-dw-328-372-settings-route-write-semantics.md`
severity: low
reason: DW-328 named only the route's four flat text fields, and the spec's Never list kept `setText` out on the grounds that its parameter is typed `string | null | undefined` and `validateWorkbenchSettingsPatch` runs above it, so the arm is unreachable by construction. That is still true. What changed is the symmetry: a flat `embeddingModel` carrying a non-string now leaves the stored key untouched, while `workbench.embeddingModel` carrying one would delete it. `config.ts` already imports from `workbench-settings.ts`, so `flatTextFieldAction` is importable there and the collapse is available.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-config-read-and-set-text-arms
resolution-undo: a9cfbe9fcdd5f656398928ae099370542c662a0f2e3631a21fbcc2d15c23a136 2026-09-01 7374617475733a206f70656e

### DW-624: The DW-556 misclassification is still live on three sibling write paths: a 2xx body read that dies mid-stream is swallowed and the write is reported as LANDED.
origin: spec-deferred 2d2d9d53df50
location: src/hooks/useSettings.ts:356, src/components/WikiEditor.tsx:282, src/lib/workbench-request.ts:66
source_spec: `spec-dw-556-557-558-settings-save-verdict-shape.md`
severity: medium
reason: `savePreviewBody` and `saveWorkbenchSettings` now rethrow an `unconfirmedCause` out of their 2xx body parse. Three siblings do not. `useSettings.ts:356` reads `PUT /api/settings`'s answer with a bare `.catch(() => null)` and then shows "Settings saved."; `WikiEditor.tsx:282` does the same on `PUT /api/wiki/[slug]` and adopts the pre-save version before navigating away; `send` and `sendForm` (`workbench-request.ts:66,98`) swallow it into `{}`, so the destructure that follows can report a landed create, rename or delete as a failure. The same abort or dropped socket therefore still reaches the owner as a settled outcome on all three. Out of scope here — this bundle's intent names the two Workbench write clients only.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-settings-read-and-write-confirmation
resolution-undo: 0695e4e7909c9421514bc7a7f8b25a5ec79d7345ee66f9e723598d198e60c235 2026-09-02 7374617475733a206f70656e

### DW-625: `SkillsCanvas.toggle` shows the unknown-outcome sentence for a toggle that may have landed and never re-scans, so the rail can keep showing the pre-toggle state.
origin: spec-deferred 644532dc68c4
location: src/components/workbench/SkillsCanvas.tsx:106-118
source_spec: `spec-dw-556-557-558-settings-save-verdict-shape.md`
severity: low
reason: `SkillsCanvas.tsx:106-118` calls `saveWorkbenchSettings` and re-scans only on `result.status === "ok"`; every error path sets the message and returns. A `"unconfirmed"` verdict means the enablement flip may already be stored, so the list it renders can disagree with the sidecar until something else triggers a scan. Pre-existing since DW-376 — the verdict collapse only made the state readable by name — and this is the one `saveWorkbenchSettings` call site the intent deliberately left untouched.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-workbench-canvas-write-feedback
resolution-undo: c42e6fa28f2308f0f028590bd078867406b513eac598acdc8ff8036eec3a94bb 2026-09-02 7374617475733a206f70656e

### DW-626: Edits typed while a save is in flight are silently dropped, and the DW-555 recovery read doubles the window in which that can happen.
origin: spec-deferred 72bb54e8c37e
location: src/components/workbench/SettingsCanvas.tsx (save)
source_spec: `spec-dw-553-555-settings-save-refusal-recovery.md`
severity: low
reason: `SettingsCanvas.save` captures `const current = draftRef.current` before the awaits, and only the Save button is disabled while `saving` — the field-level `aria-disabled` attributes key off `readOnly`/`envPinned`, not `saving`. A landed save then re-seeds the draft from the answered payload, so a keystroke made during the round trip is neither sent nor kept. Pre-existing, but on a surface holding no version the window is now two sequential `REQUEST_TIMEOUT_MS` deadlines rather than one.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-settings-save-in-flight-freshness
resolution-undo: da15ea5de83fe8fdcb5e911d0c2d65e67d416f176617fa044ae72da0891d817d 2026-09-01 7374617475733a206f70656e

### DW-627: `mountWritable` and `patchOf` are now copied verbatim into a second mounted Settings suite, the duplication DW-228 consolidated the rest of that harness to remove.
origin: spec-deferred d82e8f3af1e3
location: src/components/workbench/__tests__/settings-harness.tsx
source_spec: `spec-dw-553-555-settings-save-refusal-recovery.md`
severity: low
reason: `settings-read-only.test.tsx` and `settings-embedding-provider-switch.test.tsx` each carry their own one-response-per-call mount helper and PUT-body reader, differing only in the category mounted. `settings-harness.tsx` already exists as the stated shared home for exactly this kind of helper, and its header explains why a per-file copy is what drifts.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-settings-test-harness-consolidation
resolution-undo: ccb2e9575c2032e960306922bd121dc1431d74a0658669a4eb7435a96b013cc3 2026-09-02 7374617475733a206f70656e

### DW-628: `PUT /api/settings` sends no machine-readable code for the env-pin refusal, so the browser recognises it by matching the English sentence.
origin: spec-deferred 96463401329e
location: src/app/api/settings/route.ts:434-437
source_spec: `spec-dw-553-555-settings-save-refusal-recovery.md`
severity: low
reason: `settingsRefusalPinsEmbeddingProvider` compares the refusal body against every sentence `settingsEnvProviderPinRefusalCopy` can mint. That is exact, closed and fails closed, and `settings-route.test.ts` now pins the route's body against the same predicate — but a surface branching on copy is a coupling a wire-level code would remove. Adding one was ruled out of this bundle as a wire-contract change.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-settings-save-verdict-contract
resolution-undo: 48ddddf59b44b2fa625d50086b3ffe9dfc1d4b907dd025ba89846c1f242105aa 2026-09-02 7374617475733a206f70656e

### DW-629: `sidecar/mcp.mjs`'s `MCP_INSTRUCTIONS` still hand-types the `api-mcp` category label, the last copy of the destination DW-504 derived.
origin: spec-deferred 97b7ae61e968
location: sidecar/mcp.mjs:54
source_spec: `spec-dw-503-504-settings-pointer-derivation.md`
severity: low
reason: `sidecar/mcp.mjs:52-55` reads "the owner has switched the API off in Settings → API + MCP" — the same sentence as `CHAT_API_DISABLED_COPY`, still a literal. It is the standing instruction text every MCP client reads before its first call, so it is owner-facing. `grep -rn MCP_INSTRUCTIONS` returns only its definition (`:50`) and its `McpServer` registration (`:345`); no test asserts its content. Renaming `api-mcp` in `SETTINGS_CATEGORIES` now moves the three `chat-agent.ts` sentences automatically and leaves this one stale with the whole suite green. A plain import cannot fix it — AD-6 forbids the sidecar importing `src/lib` — so it needs a shared `.mjs` constant, or a node-project test that imports `MCP_INSTRUCTIONS` (the idiom `epic8-chat-agent.test.ts` already uses for `sidecar/shell.mjs`) and asserts it contains `settingsPointer("api-mcp", SETTINGS_LABEL)`.
status: open

### DW-630: Two provider refusals send the owner to a bare "Settings" with no category, now less specific than the guard DW-503 just fixed.
origin: spec-deferred 2d9ef479a717
location: src/lib/llm.ts:303, src/lib/structured-knowledge.ts:299
source_spec: `spec-dw-503-504-settings-pointer-derivation.md`
severity: low
reason: `src/lib/llm.ts:303-308` (`getModel`'s no-provider-at-all throw) ends "…or configure a provider in Settings.", and `src/lib/structured-knowledge.ts:299-301` throws "Structured Knowledge needs a configured extraction provider. Choose one in Settings; credentials stay in server secrets." Neither names a category, so neither can drift — but both are now WEAKER than the sentence thrown 130 lines below the first one, which reads "Set it in Settings → LLM Models." The no-provider case is the most common keyless path, so the owner most in need of the pointer is the one who does not get it. Neither line contains "Set it in ", so the widened byte scan added in this bundle walks straight past both.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-llm-refusal-copy-pointers
resolution-undo: e5f8862d4adc585244981e15513e397db3b6a4e95ea23993dc3dd48c9b0096ae 2026-09-01 7374617475733a206f70656e

### DW-631: `getModel`'s Ollama Cloud refusal hand-types the display label `providerLabel` owns and names no destination.
origin: spec-deferred 23ccead14b73
location: src/lib/llm.ts:380
source_spec: `spec-dw-503-504-settings-pointer-derivation.md`
severity: low
reason: `src/lib/llm.ts:378-382` throws "Ollama Cloud requires OLLAMA_API_KEY to be configured as a server secret." It spells "Ollama Cloud", which is `PROVIDER_INFO`'s label for `ollama-cloud` (`src/lib/providers.ts:17`) and is now derived through `providerLabel` at the sibling guard this bundle fixed — so the same rename that moves one leaves the other. It also names an env var and no Settings field, where the five DW-369 refusals and the DW-503 guard all end in the derived pointer. Same `switch` the change touched; outside the intent's named sites.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-llm-refusal-copy-pointers
resolution-undo: e5f8862d4adc585244981e15513e397db3b6a4e95ea23993dc3dd48c9b0096ae 2026-09-01 7374617475733a206f70656e

### DW-632: A keyless `custom` provider gets two different diagnoses depending on which resolution ladder it arrives on.
origin: spec-deferred 1ae87fbfb4c3
location: src/lib/llm.ts:433
source_spec: `spec-dw-503-504-settings-pointer-derivation.md`
severity: low
reason: Both ladders now end at the same derived destination, but they disagree on what is wrong. `getModel` (`src/lib/llm.ts:336-360`) checks the base URL first and then says "The Custom provider needs an API key."; `getConfiguredModel`'s pre-switch guard (`:433`) fires before the `custom` case and says "The Custom provider is not configured on this server." — reporting the missing key before the missing base URL, the reverse of its sibling's order. DW-503 asked only for the destination and the display label, both delivered; the diagnosis half is untouched and pre-existing. `llm.test.ts:544`'s cross-ladder parity test sets `LLM_CUSTOM_API_KEY` specifically to step past this guard, so the one Custom state where the two ladders disagree is the state it does not cover. Not already in the ledger: `deferred-work.md:3748` is DW-503 itself, which names the ordering but does not record the divergence.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-llm-refusal-copy-pointers
resolution-undo: e5f8862d4adc585244981e15513e397db3b6a4e95ea23993dc3dd48c9b0096ae 2026-09-01 7374617475733a206f70656e

### DW-633: The `starting` loopback health status renders the pane's "The sidecar is running" sentence, because the health ternary only special-cases port_conflict, unreachable and error.
origin: spec-deferred ab4203592b4f
location: src/components/workbench/SettingsApiMcpPane.tsx (the apiLive health ternary)
source_spec: `spec-dw-445-settings-api-mcp-extract-2.md`
severity: medium
reason: `LOOPBACK_STATUSES` in `src/lib/v1-contract.ts` is ["starting","running","port_conflict","error"], and `classifyLoopbackHealth` returns "starting" verbatim. The pane's ternary falls through everything that is not port_conflict/unreachable/error to SETTINGS_API_HEALTH_RUNNING_COPY, so a starting sidecar is described as running. There is no SETTINGS_API_HEALTH_STARTING_COPY to render instead. Pre-existing: moved verbatim out of SettingsCanvas by DW-445, not introduced by it, and outside that refactor's byte-identical mandate.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-settings-api-mcp-pane-copy-a11y
resolution-undo: 604cf3a3a782e41a24cdbea1692df2ab53db681409d2e8fe316a7c05660863e6 2026-09-01 7374617475733a206f70656e

### DW-634: The API token row's hint span carries an id that no control references, so the env-pinned and "copy it now" sentences are announced by nothing.
origin: spec-deferred 36697e62aabe
location: src/components/workbench/SettingsApiMcpPane.tsx (the API token row)
source_spec: `spec-dw-445-settings-api-mcp-extract-2.md`
severity: medium
reason: The span is `id={field("apiToken-hint")}`, but Generate, Show/Hide and Copy all point their `aria-describedby` at `field("apiToken-label")`. The workbench-settings.ts source scan only asserts every `wb-set-hint` span HAS an id, never that a control references it, so this reads as covered while the sentence is unannounced. Pre-existing: moved verbatim by DW-445.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-settings-api-mcp-pane-copy-a11y
resolution-undo: 604cf3a3a782e41a24cdbea1692df2ab53db681409d2e8fe316a7c05660863e6 2026-09-01 7374617475733a206f70656e

### DW-635: SETTINGS_API_TOKEN_ABSENT_COPY can render twice on screen at once — as the token row's hint and again as the wb-set-warn status note.
origin: spec-deferred 38456ba05e5b
location: src/components/workbench/SettingsApiMcpPane.tsx (token hint + missing-token note)
source_spec: `spec-dw-445-settings-api-mcp-extract-2.md`
severity: low
reason: With the door open, unauth off and no token anywhere, the hint's final fallback branch selects SETTINGS_API_TOKEN_ABSENT_COPY and `draftApiTokenMissing` renders the same sentence again as a role="status" note. The new dom suite has to work around the duplicate with `getAllByRole("status").find(...)` rather than `getByText`. One of the two should say something different. Pre-existing: moved verbatim by DW-445.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-settings-api-mcp-pane-copy-a11y
resolution-undo: 604cf3a3a782e41a24cdbea1692df2ab53db681409d2e8fe316a7c05660863e6 2026-09-01 7374617475733a206f70656e

### DW-636: The vector rule's `provider` leg carries no note naming `EMBEDDING_PROVIDER`, so an env-owned refusal tells the owner to supply a provider through a select that cannot supply it.
origin: spec-deferred 130f32473799
location: src/lib/workbench-settings.ts:1530
source_spec: `spec-dw-552-settings-vector-provider-parity.md`
severity: medium
reason: `vectorSearchMissingLegs` attaches `SETTINGS_VECTOR_BINDING_ENV_NOTE` to the `binding` leg exactly when `providerOrigin === "env"` (DW-281), but the `provider` leg early-returns `{field: "provider", phrase: "an embedding provider"}` with no note at all. DW-552 makes `providerOrigin === "env"` reachable for the provider leg for the first time, so the refusal now reads "…needs an embedding provider…" / "Turn it off, or supply what is missing." on a deployment where the only fix is correcting the variable. Partly mitigated today: the provider ROW already renders `settingsEnvProviderInvalidCopy`, which does name the variable — so the fact is on screen, just not in the refusal. Adding the note is a new user-visible sentence and a copy decision, which is why it was not taken here.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-env-embedding-provider-seam
resolution-undo: c5512aa2469afa8d8c6b97c0ced1a122f8201ecf81a5da1ca3a3b65e918695f0 2026-09-01 7374617475733a206f70656e

### DW-637: The embedding half refuses a junk env provider by JOINING and rewriting `provider`/`providerOrigin`, while the research twin in the same file refuses its own junk variable by an early return — two mec
origin: spec-deferred c4ff31440000
location: src/lib/workbench-settings.ts:2873
source_spec: `spec-dw-552-settings-vector-provider-parity.md`
severity: low
reason: `draftResearchProviderConfigured` (src/lib/workbench-settings.ts:2873) does `if (payload.envResearchProviderInvalid) return false` and leaves the reported provider untouched; `draftVectorInputs`/`mergedVectorInputs` instead join the filtered and invalid fields and derive the origin from the join. The DW-552 doc comments call the two fields "exact mirrors", which now overstates the symmetry. Either converge the mechanisms or say in the comment why they must differ (the vector rule reports a provider and an origin; the research predicate reports only a boolean).
status: done 2026-09-01
resolution: resolved by sweep bundle dw-env-embedding-provider-seam
resolution-undo: c5512aa2469afa8d8c6b97c0ced1a122f8201ecf81a5da1ca3a3b65e918695f0 2026-09-01 7374617475733a206f70656e

### DW-638: "raw EMBEDDING_PROVIDER wins, then the store" is now spelled independently in three places, which is the same copy-drift shape DW-552 exists to close.
origin: spec-deferred bad8126eda5f
location: src/lib/workbench-settings.ts:2463
source_spec: `spec-dw-552-settings-vector-provider-parity.md`
severity: low
reason: `getVectorSearchSettings` (src/lib/config.ts:1623) reads the variable raw; `mergedVectorInputs` (src/lib/workbench-settings.ts:2463) and `draftVectorInputs` (:2969) each re-join the filtered and invalid halves in their own expression. DW-552 was caused by exactly this: one of three copies moved. A shared helper — `resolveEnvEmbeddingProvider(filtered, invalid)` used by both halves, over a single raw reader — would remove the remaining chances to drift. Today only the tests hold them together.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-env-embedding-provider-seam
resolution-undo: c5512aa2469afa8d8c6b97c0ced1a122f8201ecf81a5da1ca3a3b65e918695f0 2026-09-01 7374617475733a206f70656e

### DW-639: DELETE /api/research/[id] still answers a mid-request read-only refusal as 500, the exact defect class this bundle fixed at nine sibling doors.
origin: spec-deferred c60cf410a39a
location: src/app/api/research/[id]/route.ts:103
source_spec: `spec-dw-316-319-526-read-only-lifecycle-route-status.md`
severity: low
reason: `retireResearchProject` opens with `assertWritable(READ_ONLY_REFUSAL.researchMutate)` (src/lib/research-runtime.ts:463), and the DELETE handler's catch is the unchanged `error instanceof ClientInputError ? 400 : 500` shape, so a flag that flips between the route's `isReadOnly()` gate and the writer is reported as a server fault. Not named by DW-316, DW-319 or DW-526, whose intent enumerates the doors to fix, so it was left out of this bundle rather than swept in. Its suite (`research-run-route.test.ts:305`) pins the 400-vs-500 classification with a plain Error and a ClientInputError only, so nothing there would surface it. PATCH on the same file is NOT affected: `updateResearchProjectIf` reaches no `assertWritable`; the only two in `research-projects.ts` are at :442 and :656.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-readonly-refusal-voice
resolution-undo: d9280ca728025e6e9e089519d77381fd9c531c6935fbefe138797ad0a1c3f0f1 2026-08-31 7374617475733a206f70656e

### DW-640: No source scan enforces the read-only treatment on the wiki-lifecycle, workspace-profile, Names & Terms, email-settings or research writers, so the next door added repeats the defect with the suite gr
origin: spec-deferred 58b7385a8d66
location: src/lib/__tests__/read-only-door-coverage.test.ts:34
source_spec: `spec-dw-316-319-526-read-only-lifecycle-route-status.md`
severity: low
reason: `read-only-door-coverage.test.ts` exists precisely to catch "the door added TOMORROW", but its `KERNEL_WRITERS`/`WRITER_EXPORTS` cover only `writeWikiPageWithSideEffects`, `deleteWikiPage`, `patchMetadata` and `writeWikiArtifact`. `createWiki`, `renameWiki`, `deleteWiki`, `setCurrentWiki`, `applyScenarioTemplate`, `saveWorkspaceProfile`, `createNamesTerm`/`updateNamesTerm`/`deleteNamesTerm`, `saveEmailIngestConfig`, `createResearchProject` and `retireResearchProject` are all gated in the kernel (DW-266, DW-314, DW-385) yet invisible to it. Every one of the eleven handlers fixed in this pass is pinned only by a hand-written per-door case. Widening the map is a change of its own: it would also demand a treatment on the doors listed in the entry above and on `PUT /api/settings`, `POST /api/tasks/scan` and the rebuild-embeddings doors, none of which this bundle's intent reaches.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-read-only-kernel-writer-registry
resolution-undo: 86395c2554442a6c9e3653cb0c4c0110c976443ee4c7abbc5da2f9d82150f850 2026-09-02 7374617475733a206f70656e

### DW-641: POST /api/names-terms and PUT /api/names-terms/[id] still answer a storage fault 400, telling the owner their input was wrong — DW-319's complaint at a different door.
origin: spec-deferred 814be1124eb2
location: src/app/api/names-terms/route.ts:57
source_spec: `spec-dw-316-319-526-read-only-lifecycle-route-status.md`
severity: low
reason: Both catches end `{ status: error instanceof NamesTermConflictError ? 409 : 400 }`, so an EACCES, a full disk or a lock timeout inside `createNamesTerm` / `updateNamesTerm` is reported as the caller's bad input, the exact reasoning DW-319 used against `PUT /api/workspace-profile`. Sibling `DELETE /api/names-terms/[id]` already answers 500 for the same class, so the one store states two verdicts about itself. Pre-existing and untouched by this pass, which only prepended the 403 branch; no DW entry names it.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-door-fault-status-parity
resolution-undo: 55cea626308cacfd74b08a598aed97d3a6cc2fad5ca81b56dcfd92ab69786367 2026-09-02 7374617475733a206f70656e

### DW-642: The door-coverage registry still omits every gated store writer outside the wiki-lifecycle family, so a future route importing one untreated stays invisible to the scan.
origin: spec-deferred e64fee3b9328
location: src/lib/__tests__/read-only-door-coverage.test.ts:36
source_spec: `spec-dw-302-315-317-read-only-kernel-writer-coverage.md`
severity: low
reason: `KERNEL_WRITERS` in `read-only-door-coverage.test.ts` now names the page/artifact, wiki-lifecycle and workspace-profile writers. Still absent and still carrying `assertWritable`: `createNamesTerm`, `updateNamesTerm`, `deleteNamesTerm` (`src/lib/names-terms.ts:322,354,378`), `createResearchProject` / `deleteResearchProject` (`src/lib/research-projects.ts`), `saveEmailIngestConfig` (`src/lib/email-ingest.ts:107`), plus `lifecycle.ts`'s `pruneStaleIndexEntry` (:1118) and `deleteWikiPageWhileLocked` (:1205). Their doors are enumerated by name in `read-only-copy-parity.test.ts` rather than derived, so nothing is broken today — the gap is prospective, the same one DW-315 named for the wiki-lifecycle writers. The new `KERNEL_WRITERS` docblock records the omission explicitly, so this is a recorded scope boundary rather than an oversight. Out of this bundle's intent, which names only the wiki-lifecycle and workspace-profile writers.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-read-only-kernel-writer-registry
resolution-undo: 86395c2554442a6c9e3653cb0c4c0110c976443ee4c7abbc5da2f9d82150f850 2026-09-02 7374617475733a206f70656e

### DW-643: The Workbench Todos canvas still folds the standing read-only refusal into plain `disabled=`, in front of a door that DOES refuse.
origin: spec-deferred 3b2a6f3f943e
location: src/components/workbench/TodosCanvas.tsx:216
source_spec: `spec-dw-529-530-531-read-only-client-refusal-parity.md`
severity: medium
reason: `src/components/workbench/TodosCanvas.tsx` gates every write control with `disabled={readOnly || …}` (216, 224, 266, 286, 307, 316, 319, 356, 364, 376, 388, 398, 406, 419, 428) and renders no read-only sentence at all, while `POST /api/todos` and `PATCH`/`DELETE /api/todos/[id]` answer `READ_ONLY_REFUSAL.todos`. It takes the same `readOnly` from the same parent (`ModeCanvas.tsx:226`) as the two canvases DW-531 named, uses the same `.wb-todos-btn` class this change gave an `aria-disabled` face, and has no client mirror and no parity-suite row. `todos-canvas.test.tsx:145-158` pins the OLD shape, so adopting the new one is a test change too. Not in DW-531's five controls, so left alone rather than widened into this change.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-workbench-canvas-write-feedback
resolution-undo: c42e6fa28f2308f0f028590bd078867406b513eac598acdc8ff8036eec3a94bb 2026-09-02 7374617475733a206f70656e

### DW-644: The Deep Research canvas HIDES its row controls under read-only instead of refusing them, so `RESEARCH_MUTATE_READ_ONLY_COPY` has no Workbench voice.
origin: spec-deferred 0ee6df37af63
location: src/components/workbench/ResearchCanvas.tsx:403
source_spec: `spec-dw-529-530-531-read-only-client-refusal-parity.md`
severity: low
reason: `src/components/workbench/ResearchCanvas.tsx:403,409` render Cancel and Start/Retry only when `!readOnly`, so on a read-only deployment the controls vanish rather than standing refused with a reason — a third shape beside `disabled` and `aria-disabled`, and the one that explains least. Their door is `POST /api/research/[id]/run`, whose sentence `RESEARCH_MUTATE_READ_ONLY_COPY` this change moved into `src/lib/research-panel.ts` for the canvases and which still has exactly one consumer, the Studio. DW-531 named only the five `disabled=` controls in Graph and Review, and the bundle intent excluded ResearchCanvas, so the hidden rows were left as they are.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-readonly-refusal-voice
resolution-undo: d9280ca728025e6e9e089519d77381fd9c531c6935fbefe138797ad0a1c3f0f1 2026-08-31 7374617475733a206f70656e

### DW-645: Three in-repo sites assert the wrong queue semantics for a read-only 403 — the code is right and the comments are wrong, and DEPLOY.md now contradicts them.
origin: spec-deferred ca7d934d9456
location: src/app/api/tasks/run/route.ts:166
source_spec: `spec-dw-268-388-read-only-operator-docs.md`
severity: medium
reason: `src/app/api/tasks/run/route.ts:166-173` states "4xx means the consumer ACKS AND DROPS the message ... work queued against a read-only deployment is discarded rather than replayable"; `src/app/api/tasks/scan/route.ts:73-77` repeats "the consumer treats a 4xx as terminal"; and `src/lib/__tests__/scan-route.test.ts:409-414` restates it inside a passing test's rationale. `workers/task-consumer/index.ts:114` acks and drops on `400 || 404 || 422` only; a 403 falls to the transient branch at `:126-139` and is retried to `MAX_DELIVERY_ATTEMPTS = 4`, then parked in the DLQ. The first draft of this doc inherited the falsehood from the route comment, which is how it was found. Whoever edits the consumer next reads these comments, not DEPLOY.md.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-read-only-comment-truth
resolution-undo: a4b2c4f930729f550cf24f419a5b644f479db5900b99c75475e3d7074d3b711b 2026-09-02 7374617475733a206f70656e

### DW-646: `POST /api/tasks/run`'s read-only 403 is pinned by no test, and the one check that touches it passes even if the gate is deleted.
origin: spec-deferred ffc35a87d8c8
location: src/lib/__tests__/tasks-route.test.ts
source_spec: `spec-dw-268-388-read-only-operator-docs.md`
severity: low
reason: `READ_ONLY_REFUSAL.queuedWork` has exactly two references repo-wide — its definition at `src/lib/read-only.ts:255` and the route at `src/app/api/tasks/run/route.ts:176` — and no test reference. `src/lib/__tests__/tasks-route.test.ts` never sets `YOPEDIA_READONLY`. `read-only-copy-parity.test.ts:376-397` lists `tasks/scan` but not `tasks/run`. `read-only-door-coverage.test.ts:225-249` is a source regex matching `isReadOnly()` OR `isReadOnlyError(`, and the route's catch already uses the latter, so removing the early gate keeps it green. The scan's identical claims are pinned twice; this door's are pinned zero times, and DEPLOY.md now publishes both its status and its sentence as an operator alerting contract.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-read-only-queue-door-pins
resolution-undo: 87db21e3fc1d4f1a373fcbb0cde12f1e1100e4f0265997879449e9dc97888c0f 2026-09-02 7374617475733a206f70656e

### DW-647: `task-consumer.test.ts` never drives a 403, leaving the poison-set boundary that DEPLOY.md's "replayable, not lost" rests on unpinned.
origin: spec-deferred f2819b49faf0
location: src/lib/__tests__/task-consumer.test.ts
source_spec: `spec-dw-268-388-read-only-operator-docs.md`
severity: low
reason: The suite asserts only 200, 422 -> ack and 503 -> retry. Both are satisfied by many poison sets, including one containing 403. Appending `|| res.status === 403` to `workers/task-consumer/index.ts:114` keeps every case green and silently inverts the documented outcome to the one that discards queued ingests.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-read-only-queue-door-pins
resolution-undo: 87db21e3fc1d4f1a373fcbb0cde12f1e1100e4f0265997879449e9dc97888c0f 2026-09-02 7374617475733a206f70656e

### DW-648: DEPLOY.md quotes two `READ_ONLY_REFUSAL` sentences verbatim with no parity pin, though the repo established that idiom twice for this same file.
origin: spec-deferred ab31cf5b052b
location: src/lib/__tests__/read-only-copy-parity.test.ts
source_spec: `spec-dw-268-388-read-only-operator-docs.md`
severity: low
reason: `src/lib/__tests__/workbench-settings.test.ts:5599` ("keeps DEPLOY.md's quoted refusal identical to the constant it quotes (DW-222)") and `src/components/__tests__/embedding-substitution-copy-parity.test.tsx:191` both read DEPLOY.md off disk and compare against the shipped copy. Neither can reach the new section: both harvest only lines beginning with `>`, and the new quotes are inline JSON in prose. Rewording either constant leaves every suite green and DEPLOY.md quoting a body no deployment returns — exactly the drift those two pins exist to stop, and the section's alerting advice depends on the bodies being exact.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-read-only-queue-door-pins
resolution-undo: 87db21e3fc1d4f1a373fcbb0cde12f1e1100e4f0265997879449e9dc97888c0f 2026-09-02 7374617475733a206f70656e

### DW-649: `agents/[id]/route.ts`'s comment states unconditionally that `updateAgent` writes through the kernel before persisting, which is true only when the request adds pages.
origin: spec-deferred 3c1f46522c38
location: src/app/api/agents/[id]/route.ts:268
source_spec: `spec-dw-268-388-read-only-operator-docs.md`
severity: low
reason: `src/app/api/agents/[id]/route.ts:268-272` says `updateAgent` "writes the agent's identity PAGE through the kernel before it persists the profile with `registerAgent`". In `src/lib/agents.ts:772-846` that `writeWikiPageWithSideEffects` call sits inside `if (options.addPages && options.addPages.length > 0)`; a name, description, trigger, instructions, `defaultVault` or `removePages` edit reaches only `registerAgent`, a bare `storage.writeFile`, and returns 200 on a read-only deployment. DEPLOY.md now documents the split correctly, so the comment is the remaining wrong statement.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-read-only-comment-truth
resolution-undo: a4b2c4f930729f550cf24f419a5b644f479db5900b99c75475e3d7074d3b711b 2026-09-02 7374617475733a206f70656e

### DW-650: `POST /api/tasks/run` still decides a task's poison-vs-retry by `/not found/i` over the message, and it is the consumer of `runResearchProject`'s newly typed not-found throw.
origin: spec-deferred 6e4bccef92b7
location: src/app/api/tasks/run/route.ts:918
source_spec: `spec-dw-480-576-577-research-run-route-error-typing.md`
severity: low
reason: `src/app/api/tasks/run/route.ts:918` returns 422 (permanent, poison the task) when the message matches `/not found/i`, and `:883` uses the same regex for the Graphify terminal decision. `runResearchProject` now throws `ResearchProjectNotFoundError` at `src/lib/research-runtime.ts:1303` and `:1491`, and the `run-research` task lands in exactly that catch. Nothing breaks today only because this bundle preserved the message verbatim — the poison decision is now silently coupled to the class's DEFAULT message string, with no test pinning the coupling. It is the same anti-pattern DW-480/DW-577 retired, one door over, and out of this bundle's named scope.
status: open

### DW-651: Same-shaped refusals at `POST /api/research/[id]/run` still answer 500, including one retired project that the GET on the same path answers 404 for.
origin: spec-deferred a81ed2c6e1d2
location: src/lib/research-runtime.ts:322
source_spec: `spec-dw-480-576-577-research-run-route-error-typing.md`
severity: low
reason: `"Research project is retired"` (`src/lib/research-runtime.ts:322`), `"Research project completion is still being delivered"` (`:325`, `:390`), the rerun-baseline race (`:393`) and `applyResearchProjectMutation`'s `"Research projects were busy; retry the request."` (`src/lib/research-projects.ts:387`) all stay plain `Error` and so keep the 500 the old regex ladder also gave them. Two are genuinely caller-visible states: a retired project is a 404 on `GET /api/research/[id]/run` and a 500 on the POST, and a CAS exhaustion is transient contention reported as a permanent server fault with no retry signal. Deliberately excluded here — the bundle intent authorises typing not-found and conflict, not remapping statuses — and now documented as excluded in `ResearchProjectConflictError`'s docblock.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-run-typed-errors
resolution-undo: 30d111d96d511fffe5331db6b138a1f0750cd84436b648ab84a37e7156aa4720 2026-08-31 7374617475733a206f70656e

### DW-652: `commitResearchPage`'s `completion?.sources?.length` fallbacks persist a truthy non-array `sources` forward before the drain guard can refuse it.
origin: spec-deferred bca3a66d4ead
location: src/lib/research-completion.ts:536
source_spec: `spec-dw-575-579-603-research-store-parse-and-guards.md`
severity: low
reason: `src/lib/research-completion.ts:536` writes `sources: project.completion?.sources?.length ? project.completion.sources : sources`, so a stored `completion: { phase: "page", sources: "https://example.com/a" }` is rewritten to `phase: "sources"` KEEPING the string, with `progress.message` reporting the string's character count as a source count ("Ingesting 21 sources."). Only the drain immediately after refuses it. The two lines cannot simply be routed through `requireCompletionSources`: a missing or empty list there is the ordinary first-commit path, so guarding them as written would refuse an ordinary commit. Closing this needs a "completion exists but its sources are not a list" test distinct from "no completion yet". Pre-existing; DW-579 named the `findIndex`/`map` dereferences, not this write. Now named accurately in the `requireCompletionSources` docblock.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-completion-source-shape
resolution-undo: 1f9a4fa7559578c88819e37359f617dc72862d79ecff039b2f7084793a90c4b5 2026-08-31 7374617475733a206f70656e

### DW-653: The drain's follow-up mutator guard is defense-in-depth that no test can reach.
origin: spec-deferred db1d294b915f
location: src/lib/research-completion.ts:921
source_spec: `spec-dw-575-579-603-research-store-parse-and-guards.md`
severity: low
reason: `requireCompletionSources(project.completion).map(...)` at `src/lib/research-completion.ts:921` re-reads the row inside the post-ingest CAS, so it fires only when a concurrent writer corrupts `completion.sources` after the loop guard at `:908` has already read it AND after every `checkpointSource` in the loop has finished. An independent mutation check confirmed reverting it alone leaves all four research suites green. The sibling guard at `:692` is now pinned (a mid-drain corruption row added during review); this one still is not, and the window it protects is narrow enough that a later edit could strip it unnoticed.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-completion-source-shape
resolution-undo: 1f9a4fa7559578c88819e37359f617dc72862d79ecff039b2f7084793a90c4b5 2026-08-31 7374617475733a206f70656e

### DW-654: `requireCompletionSources` validates only `Array.isArray`, so an array of wrong-shaped ELEMENTS reproduces DW-579's failure class one level down.
origin: spec-deferred d18a4d5b9054
location: src/lib/research-completion.ts:89
source_spec: `spec-dw-575-579-603-research-store-parse-and-guards.md`
severity: low
reason: `["https://example.com/a"]`, `[null]` and `[{}]` all pass the guard and then reach `source.url === url` in `checkpointSource` and `meta.url` / `meta.slug` in the drain loop — undefined-keyed `byUrl` lookups and the same opaque `TypeError` class DW-579 set out to remove, one level in. The limit is deliberate and now named in the helper's docblock: a per-element notion of "valid completion source" belongs beside `isResearchProject`, not as a second divergent one here. Closing it means deciding whether the registry guard should start validating nested optional structures, which its own docblock currently declines to do.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-completion-source-shape
resolution-undo: 1f9a4fa7559578c88819e37359f617dc72862d79ecff039b2f7084793a90c4b5 2026-08-31 7374617475733a206f70656e

### DW-655: `cleanUrls`' 2000-character slice and its slice-before-dedupe order are silent data loss, now pinned as expected behaviour by characterization tests.
origin: spec-deferred d77a9c6122e5
location: src/lib/research-projects.ts:181
source_spec: `spec-dw-575-579-603-research-store-parse-and-guards.md`
severity: low
reason: The slice stores a DIFFERENT, still-parseable URL that resolves somewhere else than the one the provider returned, and because `cleanList` slices before it dedupes, two distinct URLs agreeing on their first 2000 characters collapse into one stored entry — two sources become one with nothing said. The new DW-603 rows (`src/lib/__tests__/research-projects.test.ts`) document both and say so in their own comments ("Documented, not desired"); this bundle's `Never` clause forbade changing the behaviour. The 40-item cap has the same silence and is the exposure DW-603's reason actually names: the Studio's "Collect N URLs" reports N with nothing saying the tail was dropped.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-registry-repair-and-urls
resolution-undo: e8b9a10d3b9074e753b1f390284d92f6fbda87d9ef747da900adb55e0d9c41e1 2026-08-31 7374617475733a206f70656e

### DW-656: `markResearchDeliveryBlocked` tells the operator to "Repair the reported lock" for every drain fault, and its Retry re-hits a shape refusal forever.
origin: spec-deferred 2aaff0311e76
location: src/lib/research-runtime.ts:246
source_spec: `spec-dw-575-579-603-research-store-parse-and-guards.md`
severity: low
reason: `src/lib/research-runtime.ts:246-270` writes `progress.message: "Research delivery is blocked. Repair the reported lock, then retry."` and surfaces the caught message as `error`. Both drain call sites (`:606-613`, `:1310-1314`) route through it, so the new `Research completion sources are not a list.` refusal is presented under an instruction naming a lock that is not involved, pointing at a Retry that re-enters the same refusal. Separately `:498` and `:500` swallow drain faults with `.catch(() => undefined)`, so cancel and retire silently no-op against a corrupt completion. Pre-existing for every fault class this path already carried; the shape refusal only makes the mismatch easier to hit.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-readonly-door-copy
resolution-undo: 29a632c1ea181e185ada6accb74536744b733b4fbc46bd814f83b101a119807e 2026-08-31 7374617475733a206f70656e

### DW-657: The runtime's gated entry points report a mid-request read-only refusal as "Research project not found." instead of a refusal.
origin: spec-deferred 26f2c8480da4
location: src/lib/research-runtime.ts:490
source_spec: `spec-dw-527-528-research-store-read-only-refusal.md`
severity: medium
reason: DW-527 made the CAS return `null` when read-only, and `mutateResearchProject` collapses it for its fail-soft callers. Three GATED, throwing entry points read that `null` as "the row is gone": `retireResearchProject` (src/lib/research-runtime.ts:490) returns `false`, which `DELETE /api/research/[id]` serves as 404; `queueResearchProject` (:413) and `cancelResearchProject` (:437) raise `ResearchProjectNotFoundError`, which `POST /api/research/[id]/run` serves as 404. Only reachable when the flag flips between an entry point's own `assertWritable` and its CAS write, and nothing is written either way — but the owner is told a stored project does not exist. `editResearchProject`, `createResearchProject` and `deleteResearchProject` each convert that same window back into a `ReadOnlyError`; these three were left on the collapse because DW-527's intent names the owner-editing entry point only.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-readonly-cas-sentinel
resolution-undo: 6db65d75791f16d07c198c524b8447e266052eee0cd9774c0e011f6242b92109 2026-08-31 7374617475733a206f70656e

### DW-658: A deployment that turns read-only mid-run aborts the run with "Research attempt was replaced" and leaves the row at `collecting`.
origin: spec-deferred 5e5b20d7ebc8
location: src/lib/research-runtime.ts:236
source_spec: `spec-dw-527-528-research-store-read-only-refusal.md`
severity: medium
reason: `note` (src/lib/research-runtime.ts:236) and `updateResearchAttempt` (:312) turn a `null` from the CAS into `ResearchLeaseError("Research attempt for <id> was replaced.")`. Since DW-527 that `null` is also how a read-only refusal arrives, so a mid-run flip reports lease replacement rather than the deployment state, and the failure-marking write that would follow is refused too — the row stays `collecting` until the deployment is writable again and reconcile reaps it. Nothing is written, so this is a labelling and recovery-latency cost, not damage. No test flips the flag during a run.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-readonly-cas-sentinel
resolution-undo: 6db65d75791f16d07c198c524b8447e266052eee0cd9774c0e011f6242b92109 2026-08-31 7374617475733a206f70656e

### DW-659: `createResearchProject` answers a mid-flip refusal with `researchMutate` while its own gate answers `researchCreate`.
origin: spec-deferred 93d5fb006b8c
location: src/lib/research-projects.ts:571
source_spec: `spec-dw-527-528-research-store-read-only-refusal.md`
severity: low
reason: src/lib/research-projects.ts:571 throws `new ReadOnlyError(READ_ONLY_REFUSAL.researchMutate)` on the sentinel, three lines below a gate that throws `READ_ONLY_REFUSAL.researchCreate`. One door, two sentences — and `researchCreate` exists precisely because it says the thing `researchMutate` cannot: that nothing was created. The wording was pinned by this spec's own I/O matrix, so the code is correct as specified; the matrix row is what should have said `researchCreate`.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-readonly-door-copy
resolution-undo: 29a632c1ea181e185ada6accb74536744b733b4fbc46bd814f83b101a119807e 2026-08-31 7374617475733a206f70656e

### DW-660: Reconcile's orphan-outbox catch still calls a read-only refusal a damaged outbox — the sibling of the line DW-528 fixed.
origin: spec-deferred 348e7e8f6ccb
location: src/lib/research-runtime.ts:843
source_spec: `spec-dw-527-528-research-store-read-only-refusal.md`
severity: low
reason: src/lib/research-runtime.ts:843 logs `reconcile skipped damaged orphan outbox <id>` for every fault, and `drainResearchOutbox` reaches the gated kernel page writers, so a `ReadOnlyError` lands there exactly as it lands in the per-project catch one loop above. DW-528's intent names the per-project catch only, so the orphan loop was left alone rather than swept in.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-readonly-door-copy
resolution-undo: 29a632c1ea181e185ada6accb74536744b733b4fbc46bd814f83b101a119807e 2026-08-31 7374617475733a206f70656e

### DW-661: The read-only sentinel is distinguishable only at the CAS primitive; every fail-soft runtime caller still sees a plain `null`.
origin: spec-deferred a9fa661e1eb6
location: src/lib/research-projects.ts:649
source_spec: `spec-dw-527-528-research-store-read-only-refusal.md`
severity: low
reason: `mutateResearchProject` (src/lib/research-projects.ts:649) collapses `RESEARCH_WRITE_REFUSED` to `null`, which is what keeps the ~30 `research-runtime`/`research-completion` call sites unedited. So at the surface DW-527's intent named — "the fail-soft research-runtime callers can distinguish" — a refusal is still indistinguishable from a lost CAS race; only a direct caller of `applyResearchProjectMutation` can tell them apart, via `isResearchWriteRefused`. Closing that would mean editing the call sites one at a time, which is the larger change the ledger entry itself set aside.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-readonly-cas-sentinel
resolution-undo: 6db65d75791f16d07c198c524b8447e266052eee0cd9774c0e011f6242b92109 2026-08-31 7374617475733a206f70656e

### DW-662: `/api/query` still returns a cap-truncated answer as a finished one — the silent truncation DW-547 closed for the streaming route only.
origin: spec-deferred a75695c8b05a
location: src/lib/query.ts:349
source_spec: `spec-dw-544-545-547-truncated-answer-honesty.md`
severity: medium
reason: `src/lib/query.ts:349` passes the same `QUERY_MAX_OUTPUT_TOKENS` to `callLLM`, and `callLLM` (`src/lib/llm.ts`) destructures only `{ text }` from `generateText`, discarding `finishReason` entirely. So a capped answer on this route simply ends, looking whole. Not a dead path: `useStreamingQuery` sends `slides` and `html` here ALWAYS (`src/hooks/useStreamingQuery.ts:105-119`) and falls back to it on any non-2xx from the stream route. Closing it needs `callLLM` to surface `finishReason`, which this intent's third sentence scopes to `src/app/api/query/stream/route.ts` and the spec's Never list forbids.
status: open

### DW-663: A research brief truncated by its own 7,000-token output cap is still committed as a finished wiki page.
origin: spec-deferred cc24ba54e0bb
location: src/lib/research-runtime.ts:1239
source_spec: `spec-dw-544-545-547-truncated-answer-honesty.md`
severity: medium
reason: `synthesizeResearchBrief` (`src/lib/research-runtime.ts:1239`) ignores the `finish` part, so `finishReason: "length"` — which means the brief was CUT at the budget `callLLMStream` was given, not that it fit — falls through and `raw` commits. Same owner-visible failure as DW-544 (half a brief published as a whole one) from the cap rather than the deadline. Left as it was because the intent scopes research to "an abort or deadline error part"; the code comment and the covering test now say so explicitly instead of claiming the brief finished under its budget.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-synthesis-truncation-truth
resolution-undo: 870eae26d3846c71ae6c841fe343e771637229641273c5a90b0ad3bd0ea0a52d 2026-08-31 7374617475733a206f70656e

### DW-664: A non-deadline `error` part that ENDS the synthesis stream still commits a truncated research brief.
origin: spec-deferred 57cdfe8e1b86
location: src/lib/research-runtime.ts:1217
source_spec: `spec-dw-544-545-547-truncated-answer-honesty.md`
severity: medium
reason: `src/lib/research-runtime.ts:1217` fails only on an `error` part `isLlmDeadlineAbort` accepts; every other one is skipped as "warning-shaped". `ai@6` closes the source after an `error` part (the same SDK fact DW-64 relied on for its iterator argument), so an error part that terminates the stream ends the `for await` normally and the partial `raw` flows into `commitResearchPage`. The new suite only models an `error` part followed by more deltas and a `finish`. Pre-existing — `textStream` dropped those parts too — and outside an intent naming abort and deadline error parts only.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-synthesis-truncation-truth
resolution-undo: 870eae26d3846c71ae6c841fe343e771637229641273c5a90b0ad3bd0ea0a52d 2026-08-31 7374617475733a206f70656e

### DW-665: The research run's other `callLLM` calls still put SDK transport vocabulary in the owner-visible `project.error`.
origin: spec-deferred 4e4bfd7b67f0
location: src/lib/research-runtime.ts:1335
source_spec: `spec-dw-544-545-547-truncated-answer-honesty.md`
severity: medium
reason: Evidence condensation (`src/lib/research-runtime.ts:1335`) and hierarchical reduction (`:1397`) run under the same `llmTimeoutOption()`, and `retryWithBackoff` rethrows the original error unwrapped, so a fired deadline there reaches `runResearchProject`'s catch as "The operation was aborted due to timeout" and `src/components/workbench/ResearchCanvas.tsx:374` renders it verbatim. Only the synthesis stream and its fallback were in DW-544's scope, so the "no transport vocabulary in the research panel" property is true of the synthesis, not of the run.
status: done 2026-08-31
resolution: resolved by sweep bundle dw-research-run-typed-errors
resolution-undo: 30d111d96d511fffe5331db6b138a1f0750cd84436b648ab84a37e7156aa4720 2026-08-31 7374617475733a206f70656e

### DW-666: The stream route still closes silently for a `finish` whose reason is `content-filter`, `error` or `other`.
origin: spec-deferred f8c182c122de
location: src/app/api/query/stream/route.ts:282
source_spec: `spec-dw-544-545-547-truncated-answer-honesty.md`
severity: low
reason: `src/app/api/query/stream/route.ts:282` branches on `length` alone; every other non-`stop` reason falls into the bookkeeping tail and the body just ends — a half answer reading as a whole one, which is DW-547's own failure from a third cause. `content-filter` is the concrete one: the model stopped, the owner is told nothing. The intent names `finishReason === "length"`, and the covering tests deliberately pin the other reasons as emitting nothing.
status: open

### DW-667: The `@/lib/wiki` mock stubs `isArtifactType` as `t === "html"`, but the real predicate also matches `"slides"`, so the artifact-exclusion test cannot see a route that stopped filtering slides.
origin: spec-deferred b08856857e56
location: src/lib/__tests__/query-stream-route.test.ts:27
source_spec: `spec-dw-546-query-stream-test-fidelity.md`
severity: low
reason: `src/lib/page-types.ts:32-34` is `type === "html" || type === "slides"`. The test factory at `src/lib/__tests__/query-stream-route.test.ts:27` returns true for `"html"` only, and the fixture at the artifact test carries no `slides` page. Pre-existing (that mock line is untouched by DW-546).
status: done 2026-09-02
resolution: resolved by sweep bundle dw-query-stream-mock-fidelity
resolution-undo: 626a80cf51e9055d13eb57089c4250fed7f09f165d6df5e5678ef86e858ff032 2026-09-02 7374617475733a206f70656e

### DW-668: The 401 test's comment claims "no page selection, no LLM stream" but only `selectPagesForQuery` is asserted; nothing pins that `callLLMStream` stayed uncalled, on either the 401 or the 400 path.
origin: spec-deferred 45bfa2c22e06
location: src/lib/__tests__/query-stream-route.test.ts:186
source_spec: `spec-dw-546-query-stream-test-fidelity.md`
severity: low
reason: The claim holds only transitively — the route reaches `callLLMStream` (route.ts:174) strictly after `selectPagesForQuery` (route.ts:156). `mockedStream` is now in scope in the test file but is never asserted. Confirmed independently by two review layers. Left alone because the intent covers only the three filtering cases.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-query-stream-assertion-coverage
resolution-undo: f163537416edcd225ae11115ce86825fb3596ceebf8e008553b8ec41575442d5 2026-09-02 7374617475733a206f70656e

### DW-669: `hasLLMKey` is mocked synchronously (`vi.fn(() => true)`) while production is `async` — the same species of mock-shape drift DW-546 just fixed one line below it, in the same factory.
origin: spec-deferred 204e0da86d06
location: src/lib/__tests__/query-stream-route.test.ts:31
source_spec: `spec-dw-546-query-stream-test-fidelity.md`
severity: low
reason: `src/lib/llm.ts:248` is `export async function hasLLMKey(): Promise<boolean>`. The mock passes only because `await true` works. This repo already treats that gate's promise-ness as load-bearing (DW-548 / `llm-key-cold-config.test.ts`). Pre-existing; the mock line is untouched by DW-546.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-query-stream-mock-fidelity
resolution-undo: 626a80cf51e9055d13eb57089c4250fed7f09f165d6df5e5678ef86e858ff032 2026-09-02 7374617475733a206f70656e

### DW-670: No test covers an unscoped query whose readable pages are ALL agent-scoped — the `#413` filter empties `entries` and the route answers a user-visible "The wiki is empty" 400.
origin: spec-deferred 4ff35f3d03d1
location: src/lib/__tests__/query-stream-route.test.ts:155
source_spec: `spec-dw-546-query-stream-test-fidelity.md`
severity: low
reason: route.ts:124-139 — the filter runs, then the empty-entries branch returns 400. That outcome is produced entirely by the filter this file exists to test, and only the non-streaming path covers it (`query.test.ts:726`). Pre-existing gap.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-query-stream-assertion-coverage
resolution-undo: f163537416edcd225ae11115ce86825fb3596ceebf8e008553b8ec41575442d5 2026-09-02 7374617475733a206f70656e

### DW-671: The `format: "html"` test's title promises "(and accepts format:html)" but nothing asserts the format reached `buildQuerySystemPrompt`; a route that coerced every request to `"prose"` would still pass
origin: spec-deferred d8e5399a588a
location: src/lib/__tests__/query-stream-route.test.ts:155
source_spec: `spec-dw-546-query-stream-test-fidelity.md`
severity: low
reason: `buildQuerySystemPrompt` is mocked and observable (test file line 45), and the route passes `queryFormat` to it at route.ts:165-171. The test asserts only a 200 and the filtered entry list. Pre-existing naming/coverage mismatch.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-query-stream-assertion-coverage
resolution-undo: f163537416edcd225ae11115ce86825fb3596ceebf8e008553b8ec41575442d5 2026-09-02 7374617475733a206f70656e

### DW-672: Array elements declared as objects reach the handler unchecked, and `seed_agent` answers a malformed section with a TypeError the stdio door refuses cleanly at zod.
origin: spec-deferred 5bc1e171e489
location: src/lib/mcp-http.ts (validateToolArguments) + src/mcp.ts handleSeedAgent
source_spec: `spec-dw-563-614-mcp-door-hardening.md`
severity: medium
reason: The HTTP gate reads `items.type` only for primitive elements, by design. Two reviewers independently drove `seed_agent {agent_id, name, description, sections:[{slug:"s"}]}` through `dispatchMcp` and got `Error: Cannot read properties of undefined (reading 'split')`, thrown by `section.content.split` in `src/lib/agents.ts`. The stdio door refuses the same body at `z.object({...})`. `handleSeedAgent` validates nothing — it maps and delegates — so nothing between the wire and `agents.ts` speaks for the nested `required: ["slug","title","type","content"]` that the schema already declares. Pre-existing (the crash predates this change); surfaced because the gate's doc block had to state what it does not cover. Same shape for `update_agent.addPages`.
status: open

### DW-673: The HTTP `inputSchema` declarations are now enforced at runtime, but nothing pins them against the stdio door's zod schemas they are supposed to mirror.
origin: spec-deferred 1ba349db68fb
location: src/lib/__tests__/mcp-http.test.ts (MCP_TOOLS ↔ stdio registration parity)
source_spec: `spec-dw-563-614-mcp-door-hardening.md`
severity: medium
reason: `MCP_TOOLS ↔ stdio registration parity` compares tool names, the `write`/`readOnlyHint` flag, and (new) that every `required` name is a declared property with a decidable `type`. It does not compare the two doors' `required` lists or declared types. Before this change a drift there was cosmetic; now a field the HTTP schema calls `required` while the stdio zod calls it `.optional()`, or a `number` against a `z.string()`, refuses every real call to that tool at one door only. A hand comparison of ~11 fields found no live disagreement, so this is an unpinned risk rather than a present defect, and seven tools have no authenticated door-level row that would notice.
status: open

### DW-674: `newestWriteTime` guards its mtime with `Number.isFinite` but not against `Date`'s +/-8.64e15 ms range, so a wild provider mtime turns the future-dated log line into a `RangeError` that aborts the who
origin: spec-deferred 3528a52f021c
location: src/lib/wikis.ts:1688
source_spec: `spec-dw-483-485-488-wiki-sweep-warn-and-tombstones.md`
severity: low
reason: `newestWriteTime` accepts any finite number (src/lib/wikis.ts:1592, :1601), and the future-dated branch formats it with `new Date(newest).toISOString()` (src/lib/wikis.ts:1688), which throws `RangeError: Invalid time value` outside that range. The throw escapes `sweepOrphans` — every other per-candidate step in that loop is deliberately fail-soft — and `sweepOrphanWikiDirs` swallows it as "removed 0", so a single bogus mtime silently stops the tenant's reclaim on every pass. Pre-existing: the same expression shipped with DW-290; this change only moved it into a helper.
status: done 2026-09-01
resolution: resolved by sweep bundle dw-wikis-sweep-compensation-guards
resolution-undo: c8dd7a5cb1b45e4c52c6519b7e2159ea749b4c97f2af089075852d3f5a23a411 2026-09-01 7374617475733a206f70656e

### DW-675: `createWiki`'s compensation still assumes a `writeRegistry` that threw never landed — the assumption DW-484 has just falsified for `applyScenarioTemplate`.
origin: spec-deferred 970513e5d9db
location: src/lib/wikis.ts (createWiki failure path; also setCurrentWiki, renameWiki, deleteWiki)
source_spec: `spec-dw-381-484-scenario-template-failure-truth.md`
severity: medium
reason: `createWiki`'s catch reasons "no registry entry names it, so discarding the whole directory is the exact undo", and `discardCreatedWikiDirectory` repeats "The registry never named this id". A review agent drove the case against the repo's real temp-DATA_DIR harness with a `writeFile` spy that writes `wikis.json` through and THEN throws: `createWiki` rejects, and afterwards the stored registry contains the new entry AND `currentId` points at it, while the compensation has deleted that wiki's directory — a tenant whose CURRENT wiki has no `purpose.md`, no `schema.md` and no profile on disk, and no bump. The record is well-formed so `normalizeRegistry` keeps it, and `sweepOrphanWikiDirectories` has no directory left to reclaim, so it persists. Every existing create row passes because `failWritesTo` rejects WITHOUT calling through, so the registry those rows compare byte-for-byte never moves. `setCurrentWiki`, `renameWiki` and `deleteWiki` carry the milder version of the same shape: the re
status: done 2026-09-01
resolution: resolved by sweep bundle dw-wikis-sweep-compensation-guards
resolution-undo: c8dd7a5cb1b45e4c52c6519b7e2159ea749b4c97f2af089075852d3f5a23a411 2026-09-01 7374617475733a206f70656e

### DW-676: Nothing reconciles or surfaces the registry/artifact divergence DW-484 now detects — the bump and a server-side warning are the whole remedy.
origin: spec-deferred a6d2e8e62045
location: src/lib/wikis.ts (applyScenarioTemplate failure tail) / src/app/api/wikis/[id]/template/route.ts
source_spec: `spec-dw-381-484-scenario-template-failure-truth.md`
severity: low
reason: `registryNamesScenario` is documented "DETECTS, DOES NOT RECONCILE", which is what the intent asked for, but the state it detects is left standing: `POST /api/wikis/[id]/template` still answers a bare 500 with the original error, `WikiWorkbench.applyTemplate`'s catch calls `router.refresh()` only on an `unconfirmed` failure, and the switcher row silently re-labels itself with the new scenario once the 10s `DATA_VERSION_POLL_MS` watcher picks the bump up. So the owner is told the re-template failed while the surface goes on to say it succeeded. The module already has `sweepOrphanWikiDirectories` as precedent for a maintenance-scan repair; no owner exists for this one.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-wiki-create-and-template-failure-truth
resolution-undo: 93e7441d5b4648d5269eb89c6196d2f266087bdf94e5bcfe8489e6c96d4e03fd 2026-09-03 7374617475733a206f70656e
decision: 2026-08-31 Repair it in the maintenance scan — Give the divergence a reconciler in the maintenance scan, following the `sweepOrphanWikiDirectories` precedent: detect a registry entry whose scenario disagrees with the artifacts on disk and re-derive one from the other, reporting what it repaired. Leave the failure response as it is once the scan closes the window, and pin the repair.

### DW-677: The backup copy loop still materialises every file that DOES fit, in full, and holds it through `sha256`, so one large-but-fitting object can exhaust the Workers isolate long before the 2 GiB total ce
origin: spec-deferred e8197b7f615b
location: src/lib/backups.ts:176-186
source_spec: `spec-dw-542-backup-oversize-read-avoidance.md`
severity: low
reason: `createOwnerBackupUnlocked` reads each fitting file with `readAsset` into a whole ArrayBuffer, then hashes and writes it. There is no per-file size guard and no streaming/chunked copy. `MAX_BACKUP_BYTES` is 2 GiB while the Workers isolate memory limit is a small fraction of that, so the OOM arrives from a single large object rather than from the ceiling that was designed to stop it. DW-542 removed the wasted read of a file that does NOT fit; it does not bound the read of one that does.
status: done 2026-09-02
resolution: already resolved: src/lib/backups.ts:296 — the copy loop now skips a file above MAX_BACKUP_FILE_BYTES (32 MiB, :88) before reading it, with the DW-677 citation at :19-21 and :285.

### DW-678: A throw partway through the copy loop leaves already-written backup files orphaned with no manifest and no ledger line, and nothing ever prunes them.
origin: spec-deferred 938b9e785214
location: src/lib/backups.ts:139-198
source_spec: `spec-dw-542-backup-oversize-read-avoidance.md`
severity: low
reason: `createOwnerBackupUnlocked` has no try/catch: when `stat` or `readAsset` rejects mid-copy, the files already written under `backups/<tenant>/<id>/files/` stay forever, `writeManifest` never runs, and unlike `verifyOwnerBackup` — which records a `status: "failed"` operation — no ledger line is recorded at all. `backups.ts` has no pruning of any kind, so repeated failures accumulate silently and invisibly. Pre-existing; the new `stat` call rejects on exactly the same path the read did.
status: done 2026-09-02
resolution: already resolved: src/lib/backups.ts:357-380 — createOwnerBackupUnlocked now wraps the copy in try/catch that deletes the orphaned prefix (:367) and records a status:"failed" ledger line (:369-375), citing DW-678 at :227.

### DW-679: `buildPortableArchive` has the read-then-check shape DW-542 just replaced in the backup loop.
origin: spec-deferred ac599c73e868
location: src/lib/portable-archive.ts:89-92
source_spec: `spec-dw-542-backup-oversize-read-avoidance.md`
severity: low
reason: It calls `readAsset` on each file, adds `data.byteLength` to `totalBytes`, and only then throws past `MAX_BYTES` — so the object that trips the 500 MB limit is pulled fully into memory before the failure. It throws rather than truncating, so its observable contract differs from the backup loop's, but the read-avoidance argument applies unchanged.
status: done 2026-09-02
resolution: already resolved: src/lib/portable-archive.ts:122-126 — buildPortableArchive now stats and refuses past MAX_BYTES before the readAsset at :128, with the DW-679 citation at :94.

### DW-680: A read-only `queueResearchProject` releases the project's research slot before its CAS refuses, so a refused start still mutates the deployment.
origin: spec-deferred 4cb96e41f86f
location: src/lib/research-runtime.ts:412
source_spec: `spec-dw-657-658-661-research-readonly-cas-sentinel.md`
severity: low
reason: `queueResearchProject` calls `releaseResearchSlotAndConfirmGone` (src/lib/research-runtime.ts:412) ahead of the CAS, and `research-concurrency.ts` carries no `isReadOnly`/`assertWritable` gate of its own. Demonstrated during review: with a project holding a real lease and the flag set, the call throws `ReadOnlyError` as intended, but `research-leases.json` goes from `[{projectId, attemptId, ...}]` to `[]` while the row still records that `runAttemptId`. Pre-existing — the same release ran before this change, which merely relabelled what the CAS then threw — so it is out of this bundle's scope, but it is a write on a deployment that refused the request, which is the invariant the research read-only work exists to hold. `read-only-store-gate.test.ts`'s queue case now excludes the lease file from its byte comparison and says why, rather than seeding the lease to manufacture a green whole-tree snapshot.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-research-readonly-write-leaks
resolution-undo: 20c12edfdd4db126d5fbdbc91b4636b85eecf0b0d1807832b664447ac4560f00 2026-09-03 7374617475733a206f70656e

### DW-681: Reconcile's orphan-outbox loop deletes an UNCLAIMED orphan outbox on a read-only deployment, writing where the deployment promises to write nothing.
origin: spec-deferred dbfaa9d6f88f
location: src/lib/research-completion.ts:991
source_spec: `spec-dw-656-659-660-research-readonly-door-copy.md`
severity: low
reason: `reconcileResearchProjects`' orphan loop calls `drainResearchOutbox`, which for a missing project row calls `drainOrphanOutbox` (src/lib/research-completion.ts:991-994). When `outbox.claimed !== true` that path calls `deleteResearchOutbox` and returns — and `deleteResearchOutbox` (research-completion.ts:314-321) is an ungated `clearResearchStaging` + `getStorage().deleteFile`, so it destroys the outbox on a deployment that has refused every other write. The gated writer DW-660 branches on is only reached for a CLAIMED outbox, so the new `isReadOnlyError` branch does not cover this shape at all. Reachable today only by a direct library caller: `GET /api/research` skips reconciliation when read-only and `POST /api/tasks/run` refuses, the same caveat DW-528's per-project branch carries.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-research-readonly-write-leaks
resolution-undo: 20c12edfdd4db126d5fbdbc91b4636b85eecf0b0d1807832b664447ac4560f00 2026-09-03 7374617475733a206f70656e

### DW-682: A cancel that lands on a project whose stored completion is malformed can no longer finalize: `commitResearchPage` now refuses before the cancel-teardown branch that used to delete the completion and
origin: spec-deferred 275568ef7f5b
location: src/lib/research-completion.ts:570
source_spec: `spec-dw-652-653-654-research-completion-source-shape.md`
severity: low
reason: Before this change a `cancelRequested` row carrying a wrong-shaped completion at `phase: "page"` flowed past the `(cancelRequested || cancelled) && !completion` early return into the claim CAS, whose `authorized` mutator declined and dropped into the cancel-finalize branch (src/lib/research-completion.ts ~636-651): completion deleted, status `cancelled`, outbox removed. The new pre-claim shape guard throws first, so that teardown is unreachable and the row stays `cancelRequested`. Teardown never dereferences `sources` - it deletes the whole completion - so this door now refuses for a value it would not have touched. Not stranded: the `deleteRequested` branch sits above the guard, so deleting the project still works, and refusing loudly is this module's declared fail-closed discipline. Closing it means deciding whether teardown paths should be exempt from the shape guard.
status: open
decision: 2026-09-03 Exempt teardown from the guard — Skip the pre-claim shape guard when the row is cancelRequested or cancelled (or move the guard below the claim CAS), so the cancel-finalize teardown that deletes the completion outright can still run. Pin that a cancelRequested row carrying a wrong-shaped completion finalizes to cancelled with the completion and outbox removed.

### DW-683: The non-streamed `callLLM` synthesis fallback passes the same 7,000-token cap but cannot see `finishReason`, so a fallback brief cut by that cap is still committed as a finished wiki page.
origin: spec-deferred 1f5ffc7edfac
location: src/lib/research-runtime.ts:1451
source_spec: `spec-dw-663-664-research-synthesis-truncation-truth.md`
severity: low
reason: `synthesizeResearchBrief`'s catch takes the `callLLM` fallback whenever the stream ended before producing text (`receivedStreamContent === false`), including on the two endings DW-663/DW-664 just made fatal. That call passes the identical `{ maxOutputTokens: 7_000 }`, and `callLLM` (`src/lib/llm.ts:513-537`) destructures only `{ text }` from `generateText`, discarding `finishReason` — so a fallback brief cut at the cap is indistinguishable from a whole one and commits. Pinned by the two boundary tests added in this pass, which assert the fallback path completes and writes a page. Closing it means surfacing `finishReason` from `callLLM`, which this spec's Never list rules out.
status: open

### DW-684: The three sibling research doors still answer 500 for the contended-store fault this bundle made a 503 at the run door.
origin: spec-deferred f7d67f62ac0a
location: src/app/api/research/route.ts:156
source_spec: `spec-dw-651-665-research-run-typed-errors.md`
severity: low
reason: `applyResearchProjectMutation` is the shared mutation primitive, and its exhausted-CAS refusal is now `ResearchProjectBusyError` (`src/lib/research-projects.ts`). `POST /api/research` (`src/app/api/research/route.ts:156`), `PATCH` and `DELETE /api/research/[id]` (`src/app/api/research/[id]/route.ts:99`, `:132`) all still classify with `error instanceof ClientInputError ? 400 : 500`, so the identical transient contention — whose own sentence says "retry the request." — is a retryable 503 at one door and a permanent server fault at three. DW-651 names only `POST /api/research/[id]/run`, so the siblings were out of this bundle's scope; the split is now recorded in `ResearchProjectBusyError`'s docblock but nothing pins it as intended.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-door-fault-status-parity
resolution-undo: 55cea626308cacfd74b08a598aed97d3a6cc2fad5ca81b56dcfd92ab69786367 2026-09-02 7374617475733a206f70656e

### DW-686: The related-pages render path calls `relatedByVector` unconditionally, ignoring the `vectorSearchEnabled` setting that gates `searchByVector`, so vector-backed related pages keep running on a deployment that turned vector search off.
origin: migrated from legacy ledger (flat-append deferral bullet, code review of spec-dw-406-related-by-vector-drift-parity.md), 2026-08-31
location: src/lib/search.ts:299
source_spec: `spec-dw-406-related-by-vector-drift-parity.md`
reason: `mergeVectorHits` (src/lib/wiki-retrieve.ts:317) early-returns on `!enabled` so `searchByVector` is unreachable with the setting off, but `findSimilarPages` (src/lib/search.ts:299) and its caller `ArticleView.tsx:168` consult no such gate. Pre-existing and untouched by DW-406, which only added logging to that door — but DW-406 makes it visible, since such a deployment can now be told to "rebuild embeddings" for a feature it believes is off. The line is accurate for the door it sits on (related pages genuinely does use vectors there); the question is whether the door should be running at all.
status: open

### DW-687: The render door is a high-frequency writer to the process-global drift key, so on a partially rebuilt corpus different anchors can alternate warn and re-arm per page render, and its re-arm evidence is a topically-clustered neighbour window rather than a query window.
origin: migrated from legacy ledger (flat-append deferral bullet, code review of spec-dw-406-related-by-vector-drift-parity.md), 2026-08-31
location: src/lib/search.ts:299
source_spec: `spec-dw-406-related-by-vector-drift-parity.md`
reason: `findSimilarPages` passes `limit + 10` and runs on every article render, so where `searchByVector` wrote to `drift:<model>` once per distinct query, page A's wholly-stale window can warn while page B's wholly-current window re-arms, repeatedly. The neighbour window is also clustered by construction, so a rebuild that landed for one topic can re-arm the process-wide key on evidence local to that cluster — strictly weaker than DW-598's already-open query-window case. Same residue family as DW-598 and DW-599; closing it needs the corpus-level rebuild-epoch signal both entries name, which spec-dw-406's Never list forbids reaching for here.
status: open

### DW-685: `isStoreFault`'s `/^E[A-Z0-9]+$/` errno probe matches any errno-shaped code, so non-storage failures (network `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`) classify and log as "store fault", while Node's
origin: spec-deferred d73affa2aca5
location: src/lib/errors.ts:41
source_spec: `spec-dw-481-482-store-fault-status-classification.md`
severity: low
reason: The predicate keys on the SHAPE of `code`, not on a storage errno set. No status outcome changes today: at `POST /api/tasks/run` a network errno reached the same 500 by fall-through before this change, and its message ("getaddrinfo ENOTFOUND host") never matched `/not found/i`. What is wrong today is the NAME and the log line `task "<kind>" hit a store fault`, which sends an operator to the disk for an outbound-network fault. An allowlist was considered and not taken here: it would have to enumerate storage errnos, and it would still miss the `ERR_FS_*` family, so it trades one wrong answer for another without the intent to say which is preferred.
status: open

### DW-688: A wedged tenant is told to issue `POST /api/research/repair` by hand; no control anywhere in the product performs it.
origin: spec-deferred 3d0ce9242795
location: src/components/KnowledgeStudio.tsx (research error banner), src/lib/research-projects.ts (REPAIR_HINT)
source_spec: `spec-dw-477-655-research-registry-repair-and-urls.md`
severity: medium
reason: `REPAIR_HINT` now ends every `parseRegistry` refusal, and the Studio's research fetch surfaces the server's `error` sentence verbatim in its banner (`KnowledgeStudio.tsx`), so a non-technical owner meets "Research projects file is unreadable. Repair it with POST /api/research/repair, then retry." with nothing to press. Grepping `src` for `research/repair` finds only the route file and its test — no client fetch, no button, and the Workbench's `ResearchCanvas` shows the same sentence with the same absence. The recorded DW-477 decision names a route and a 500 body that names it, and both shipped; the ledger entry's own title says "no IN-PRODUCT repair path", and that half is still open. A Repair control on the research desk's error banner would close it.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-owner-facing-error-recovery
resolution-undo: a4820839fd04990c90d76b6dbaf7c3d6c4224f637df6e712c782b253ef59d36f 2026-09-03 7374617475733a206f70656e

### DW-689: `PUT /api/workbench/artifact` relays a raw storage errno — message and filesystem path — into the owner's save banner as a 500 body.
origin: resolve-deferred dw3-wiki-door-unreadable-contract
location: src/lib/wikis.ts:982, src/app/api/workbench/artifact/route.ts:86-90
severity: low
reason: `writeWikiArtifact`'s pre-overwrite read is fail-soft except for a precondition-bearing caller, where `if (expectedVersion !== undefined) throw error` (src/lib/wikis.ts:982) rethrows the storage error UNWRAPPED — deliberately, so a blip is never reported as somebody else's save. The route catch then classifies only `isReadOnlyError`, `isWriteConflictError` and `ClientInputError`, so it falls through to `json({ error: getErrorMessage(error) }, 500)` at :86-90 and `savePreviewBody` renders that string verbatim. The owner meets an errno sentence naming a server path (`EACCES: permission denied, open '/…'`) where every neighbouring door gives them a sentence. 500 is the right STATUS for a storage fault; the message is the defect. The fix wants a typed unreadable error at the `wikis.ts` boundary plus a classifying branch and an owner-worded constant in the route — a different mechanism from the `strict:` read option that closed the DW-378 family, which is why it was cut from the `wiki-door-unreadable-contract` bundle rather than folded into it. Noted in that bundle's Intent since 2026-08-22 but backed by no entry until now.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-owner-facing-error-recovery
resolution-undo: a4820839fd04990c90d76b6dbaf7c3d6c4224f637df6e712c782b253ef59d36f 2026-09-03 7374617475733a206f70656e

### DW-690: The email-ingest route dedups recorded attachment names BEFORE sanitizing them, so any part whose recorded name and forwarded file name differ only after scrubbing inflates `attachmentNames` and repor
origin: spec-deferred d9ac1e51bdec
location: src/app/api/email/ingest/route.ts:236
source_spec: `spec-dw-451-452-454-email-worker-forward-reply-tail.md`
severity: low
reason: `src/app/api/email/ingest/route.ts:236` builds `sanitizeAttachmentNames(Array.from(new Set([...payload.attachmentNames, ...payload.attachments.map((file) => file.name)])))` -- the `Set` collapses RAW strings, and `sanitizeAttachmentNames` scrubs afterwards, so two raw names that scrub to the same string survive as duplicates. `localSkipped` (route.ts:372-376) then takes `attachmentNames.length - attachments.length` as a floor and reports a skip that did not happen. Reachable at HEAD, before and independently of this change, by the most ordinary case: a supported part with no filename at all. The Worker records it as `unnamed attachment` and forwards the Blob as `attachment-1`, so the `Set` holds two entries for one file and the floor is 1 -- a message whose single unnamed attachment ingested cleanly is reported as having skipped one. Verified by evaluating the route's own expression against those two inputs. This change shifts WHICH malformed name trips it rather than creating the clas
status: open

### DW-691: The DELETE door DW-496 just hardened can still report a stored page as absent: `deleteWikiPage`'s own read, and the MCP delete mirror, are both still unqualified.
origin: spec-deferred 866174ab7f8d
location: src/lib/lifecycle.ts:1179 and src/mcp.ts:434
source_spec: `spec-dw-496-wiki-door-unreadable-contract.md`
severity: low
reason: `src/lib/lifecycle.ts:1179` runs `const page = await readWikiPage(slug)` with no options and throws `page not found: ${slug}` on the resulting `null`. That call happens AFTER the route's now-strict ACL read, and the route's catch keeps `page not found` -> 404, so a non-ENOENT blip landing on this second read still answers the caller "your page is gone" through the very door this bundle fixed. `src/mcp.ts:434` is the same shape on the agent-facing surface -- `readWikiPageWithFrontmatter(args.slug)` with no options, throwing `page not found: ${args.slug}` at :435-437 -- under a comment at :427 that claims it "mirrors the REST surface at DELETE /api/wiki/[slug]", a parity claim this change makes false. Neither site is named by DW-495 (merge-base reads), DW-496 (the three sites this bundle converted) or DW-497 (the revisions GET), so neither is covered by an open entry. Both are pre-existing and outside this bundle's enumerated scope; raised by three independent review layers.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-strict-merge-base-sweep
resolution-undo: e8a2283706b9dc11d8d1fa887133c755d62ae90ca3440755c2847c170ff1d1cf 2026-09-03 7374617475733a206f70656e

### DW-692: Multipart transport inflates the forwarded body by one character per newline, so a body the Worker considers within the cap can still trip `/api/email/ingest`'s `> MAX_EMAIL_CONTENT_CHARS` gate — trun
origin: spec-deferred c6b8dc0c71a5
location: workers/email-ingest/index.ts:1029-1031, src/app/api/email/ingest/route.ts:292
source_spec: `spec-dw-453-567-email-worker-truncation-boundary.md`
severity: high
reason: The multipart/form-data encoding algorithm normalizes every lone LF and CR in an entry value to CRLF, so the `content` the route reads is longer than the string the Worker computed. Measured under Node/undici in this repo: - a `MAX + 1` single-line body appends at 100000 and reads back at 100002 (the marker's `"\n\n"` arriving as `"\r\n\r\n"`); - an UNTRUNCATED 98,599-character body carrying 3,398 newlines reads back at 101,997. The second measurement is the one that reframes this. The problem is NOT confined to truncated bodies and is therefore NOT fixed by a Worker-side truncation budget: any body whose character count plus newline count exceeds `MAX_EMAIL_CONTENT_CHARS` trips the route's gate at `src/app/api/email/ingest/route.ts:292`, and the Worker's own `>` test at `workers/email-ingest/index.ts:1029` never fires on it. The sender then loses their body AND every attachment: the route's 400 sends the Worker down `if (!response.ok)` (`workers/email-ingest/index.ts:1142`), which rep
status: done 2026-09-02
resolution: already resolved: Premise disproven and pinned: spec-dw-692-multipart-transport-newline-budget.md (status done) and src/lib/__tests__/email-ingest-workerd.test.ts, added by merge 9b4d5ab2, prove the Worker’s configured workerd runtime preserves lone LF and CR; the inflation was a Node/undici artifact and the Worker and route are byte-identical to baseline.

### DW-693: `ingestImage` derives the asset key from the pre-uniquified slug, so two image ingests that share a title and filename collide on one `raw/assets/<slug>/<filename>` key and one of the two pages render
origin: spec-deferred 5585c25d7e6c
location: src/lib/ingest.ts:425
source_spec: `spec-dw-570-572-content-addressed-write-immutability.md`
severity: medium
reason: `src/lib/ingest.ts:425` calls `storeImageBytes(bytes, slug, filename)` with `slug = slugify(title)`, computed BEFORE `ingest()` uniquifies the page slug (`findFreeSlug`). Two ingests deriving the same title and sanitized filename therefore address the same asset key while landing on two different pages. This change did not create the collision, but it moved which page is wrong: with the overwrite door the second upload replaced the first page's image; with the create-only door the second page renders the first upload's bytes. The freeze is now logged (`storeImageBytes` warns on an occupied key) but nothing surfaces it to the user, and no test exercises the collision at the `ingestImage` boundary — every ingest-level suite mocks `storeImageBytes` away. The fix is to key the asset off the final page slug or off a digest, not to revert the create-only door.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-ingest-read-and-asset-keying
resolution-undo: e1e7d6e89229fea29659ce26502686b549c0d62bcbb9dfba1a16c2f555af437b 2026-09-03 7374617475733a206f70656e

### DW-694: `handleRevertRevision` performs no write ACL at all, so on the HTTP MCP surface any authenticated principal can revert a Page they cannot edit through `update_page`.
origin: spec-deferred 09fbd9dcf213
location: src/mcp.ts:1421
source_spec: `spec-dw-424-426-mcp-and-delete-fresh-merge-bases.md`
severity: high
reason: `src/mcp.ts:1421` declares `args: { slug; timestamp; author? }` — no `principal` — and the handler never calls `canWriteFrontmatter`; the lifecycle writer it delegates to adds none. Its REST twin runs `canWriteFrontmatter(existing.frontmatter, principal, "body")` with the 404/403 cloak immediately after the identical fresh+strict read (`src/app/api/wiki/[slug]/revisions/route.ts:138` and just below), and the sibling MCP write doors (`handleUpdatePage`, `handleDeletePage`, `handleUpdateMetadata`) all take a `principal`. `src/lib/mcp-http.ts:763` registers `revert_revision` with `write: true` but passes only `author: p!.handle` (`:777`), so the caller's identity never reaches an authorization check. A caller `handleUpdatePage` would refuse can restore any prior revision of the same Page — including a private one in another owner's realm — which is a write-authorization bypass, not a wording bug. The only `revert_revision` rows in `src/lib/__tests__/mcp-http.test.ts` (`:1491-1552`) assert
status: done 2026-09-02
resolution: already resolved: merge 0facd000 — src/mcp.ts handleRevertRevision now takes a principal and runs canWriteFrontmatter with the read-cloaked 404 denial, mirroring the REST revert surface, and src/lib/mcp-http.ts:787 passes principal: p.

### DW-695: `extractPptx` indexes the unzipped archive map with a relationship-derived path, so a crafted PPTX turns document ingest into an uncaught `TypeError` (HTTP 500) and silently discards the deck's real s
origin: spec-deferred d1ac81be373c
location: src/lib/document-extract.ts:595
source_spec: `spec-dw-365-571-snapshot-coverage-and-archive-lookup.md`
severity: medium
reason: `src/lib/document-extract.ts:595` filters slides with `Boolean(files[slide.path])` and `:602` reads `const bytes = files[path]`, where `path` comes from `relationshipMap` -> `resolveArchiveTarget` over an uploaded archive's `Target` attribute. A `ppt/_rels/presentation.xml.rels` entry of `Target="../constructor"` resolves to the bare key `constructor`, which the plain index answers with the inherited `Object` constructor function: the `Boolean(...)` filter keeps the bogus slide, `ordered.length` is non-zero so it OVERRIDES the correct `fallbackSlides`, and `new TextDecoder().decode(fn)` throws `TypeError: The "list" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView`. Three independent reviewers built the fixture and reproduced it. Because it is not a `ClientInputError`, `src/app/api/ingest/document/route.ts` answers 500 rather than the 400 the extractor's contract promises, and the readable `ppt/slides/slide1.xml` in the same archive is never extracted.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-inherited-prototype-indexing
resolution-undo: e1b250c9774399a4fd7170de3d0862fe2b5f07daf4488461685aefe4992c8165 2026-09-02 7374617475733a206f70656e

### DW-696: A concurrently in-review spec lists `src/cli.ts:366` — this bundle's create-conflict guard — in its Never clause as a "pure display read", so a later sweep acting on that clause could revert the guard
origin: spec-deferred 8d301557101f
location: _bmad-output/implementation-artifacts/spec-dw-495-496-497-merge-base-strict-reads.md:37
source_spec: `spec-dw-425-create-conflict-fresh-reads.md`
severity: low
reason: `_bmad-output/implementation-artifacts/spec-dw-495-496-497-merge-base-strict-reads.md` (`status: in-review`, another session's in-flight bundle) groups `src/cli.ts:366` with `src/cli.ts:279` and `:327` under "Do not convert reads that do not authorize a write and do not serve an existence answer -- the pure display reads ... stay exactly as they are." `:366` is neither: it is `runCreate`'s conflict guard, whose `null` is the sole authorization for the create below, and DW-496's own `reason` (`deferred-work.md:3717`) names the create-conflict guards as the mirror case in scope. That same spec also plans to convert `src/cli.ts:431` -- the SAME site this bundle converted -- and prescribes the opposite handling there ("A rethrow reaches `main().catch` ... correct already, no repair needed"), where this bundle's intent explicitly requires a distinct "could not read" exit message. If the stale Never clause is later acted on, the create guard reverts to a cached-negative read and a create can
status: open

### DW-697: The 20 MB aggregate attachment budget quoted to accepted senders is itself unreachable over Email Routing, so the same defect DW-449 fixed for the refusal copy survives at the acknowledgement.
origin: spec-deferred 76510c3ef8c7
location: workers/email-ingest/index.ts (MAX_EMAIL_AGGREGATE_DOCUMENT_MB acknowledgement copy)
source_spec: `spec-dw-449-email-raw-message-ceiling.md`
severity: low
reason: `MAX_EMAIL_AGGREGATE_DOCUMENT_MB` is quoted in the over-budget acknowledgement (`workers/email-ingest/index.ts`, "the 20 MB total attachment budget"), but 20 MiB of decoded payload is ~27.4 MiB of base64 and ~62 MiB of quoted-printable — both above the 25 MiB inbound ceiling this bundle just recorded. It is reachable only from a client sending unencoded (`7bit`/`8bit`) parts, which is not a shape any mainstream client emits for the PDF/DOCX/XLSX formats the Worker advertises. `README.md` records the arithmetic honestly, but the sender-facing sentence still names a budget no real message can spend, and the DW-360 selection loop it guards is correspondingly unreachable in the field — the suite now has to build synthetic `7bit` PDF fixtures to exercise it at all. Out of scope here: the recorded decision named only `MAX_RAW_EMAIL_BYTES`, and lowering the budget moves constants this spec's Block If holds back.
status: open

### DW-698: The realm-fork guard at src/lib/ingest.ts:1952 reads through `pageCache` and flattens a non-ENOENT storage failure to `null`, so a provider blip skips the fork and lets a non-owner's ingest overwrite
origin: spec-deferred fdc2ba92f626
location: src/lib/ingest.ts:1952
source_spec: `spec-dw-427-ingest-fresh-merge-bases.md`
severity: low
reason: Traced during the DW-427 review (not executed). `const resolvedExisting = await readWikiPageWithFrontmatter(slug)` at src/lib/ingest.ts:1952 is the only gate that forks to a free slug when the resolved slug landed on another owner's PRIVATE page. Without `strict` a blip answers `null`, the guard is skipped, and the ingest proceeds to the merge base at :2068 — which DOES find the private page, preserves its `owner`/`visibility` (:2140-2146) and writes the actor's body over it. `writeWikiPageWithSideEffects` in lifecycle.ts carries no authorization of its own, so nothing downstream re-decides the fork. The DW-427 bundle named this line only as one of the "roughly eight pure existence probes" to leave alone; it did not name this harm, and the intent's Never clause kept it out of scope for this session.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-ingest-read-and-asset-keying
resolution-undo: e1e7d6e89229fea29659ce26502686b549c0d62bcbb9dfba1a16c2f555af437b 2026-09-03 7374617475733a206f70656e

### DW-699: QueryResultPanel's Sources chip and saved-answer "View" link are hrefForSlug call sites that no suite renders, because the only file that mounts the panel always passes sources: [] and no save state.
origin: spec-deferred 9065fc4dffed
location: src/components/QueryResultPanel.tsx:201
source_spec: `spec-owner-scoped-anchor-pins.md`
severity: medium
reason: src/components/__tests__/renderer-slug-tenant-adoption.test.tsx:110,122 mount QueryResultPanel with `result={{ answer: ..., sources: [] }}` and assert only the in-content wikilink, so the `result.sources.length > 0` branch at QueryResultPanel.tsx:192 and the `saveState.status === "saved"` branch at :277 never render. Demonstrated during review: both anchors reverted to `/u/yopedia/<slug>` at once and `pnpm vitest run --project dom` stayed green -- 68 files / 1000 tests, not one extra failure. Out of scope here: this story's intent named exactly three consumers (IngestSuccess, useGlobalSearch, LintClient) and this is a fourth. The saved-answer link is the more interesting half: its `saveState.url ?? hrefForSlug(...)` fallback is the branch that matters, and ChatWorkspace's "falls back to the map when the save response carries no url" case is the existing model for it.
status: done 2026-09-02
resolution: resolved by sweep bundle dw-owner-scoped-anchor-coverage
resolution-undo: 318b6dbe48121400504d2c2e9904638ba9d872615ae0de480663dd4e2480a269 2026-09-02 7374617475733a206f70656e

### DW-700: A fixed client margin cannot bound the server's TOTAL work, so DW-439's unconfirmed-write report is still reachable on two intake paths this story's ordering does not reach.
origin: spec-deferred b3a0e1fc00d6
location: src/lib/fetch.ts:175 / src/app/api/workbench/intake/route.ts:640
source_spec: `spec-dw-439-workbench-request-deadline-ordering.md`
severity: medium
reason: The ordering shipped here guarantees only that the server's FETCH deadline fires before the client's. Two paths outlast any fixed margin: 1. `fetchFollowingRedirects` (src/lib/fetch.ts:163-201) arms `AbortSignal.timeout(FETCH_TIMEOUT_MS)` INSIDE the `for (let hop = 0; hop <= MAX_REDIRECTS; hop++)` loop at :175, with `MAX_REDIRECTS = 5` (:169) -- five redirects, so up to six fetches with a full 15 s each, up to 90 s server-side. 2. `src/app/api/workbench/intake/route.ts:640` ends in `enqueueOrInline(jobId, task, () => ingest(title, text, options))`. Where `enqueueTask` returns false (src/lib/ingest-async.ts:52-58, the off-Workers deployment), the FULL `ingest()` -- LLM map/reduce, retries, embeddings, image downloads -- runs inside the request the client deadline wraps, and `storeAndQueue` has already stored the Source before that call. In both, the client aborts first, `unconfirmedCause` (src/lib/workbench-request.ts) classifies the `TimeoutError` as unconfirmed, and the owner is told
status: open

### DW-701: A tenant path occupied by a DIRECTORY is now recorded as an ordinary archive collision instead of failing loudly.
origin: spec-deferred 725e18a278b9
location: src/lib/portable-archive.ts:225
source_spec: `spec-dw-293-679-bulk-read-and-write-cost.md`
severity: low
reason: `parseArchive`'s collision probe changed from `readAsset` to `stat` (DW-679's read-avoidance). `fs.readFile` on a directory raised `EISDIR`, which the `else` branch rethrew; `fs.stat` succeeds, so the entry lands in `collisions` and, under `collision: "skip"`, is silently skipped rather than rejecting the import. Closing it needs a way to ask the provider whether a path is a directory — `FileInfo` carries only `size` and `lastModified`, and widening `StorageProvider` is outside this bundle's intent. Reachable only when a tenant holds files under `tenants/<t>/<archive entry path>/...`, which `walk()` would have archived as children rather than as that path.
status: open

### DW-702: A merge fold that returns non-empty text carrying no prose still overwrites the survivor's body and then hard-deletes the absorbed page.
origin: spec-deferred 8401ccfd4da9
location: src/lib/merge.ts:530
source_spec: `spec-c3-merge-empty-reconcile-guard.md`
severity: medium
reason: The new `emptyFallback: "throw"` guard only fires when the parsed body trims to empty. Two shapes slip past it and produce the same destruction this bundle set out to stop: `parseDisputedMarker` only matches `(yes|true)`, so a response of exactly "DISPUTED: no\n" is returned verbatim as the merged body (verified against the regex at src/lib/ingest.ts:1183); and a heading-only fold such as "# Agent Harness\n" is likewise non-empty. Either becomes `mergedBody`, is written over the survivor, lands in `MergeOperationReceipt.mergedContent` (replayed verbatim by Retry), and the absorbed page is hard-deleted with its revisions. Pre-existing — not introduced by this change, and outside this bundle's intent, which names only the empty-response fallback.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-merge-candidate-and-fold-quality
resolution-undo: f3854e9d9961147b3bf3667ab6c448f96e0c6e0474fded509adac00d3458a761 2026-09-03 7374617475733a206f70656e

### DW-703: A `PATCH` whose `fetch` REJECTS after the body `PUT` landed still shows a bare transport message, so the exact harm DW-428 exists to prevent is live on that one branch.
origin: spec-deferred 8ec100877273
location: src/components/WikiEditor.tsx (handleSave outer catch) and src/components/__tests__/page-write-read-only.test.tsx
source_spec: `spec-dw-428-editor-per-leg-save-reporting.md`
severity: medium
reason: `handleSave`'s prefix sits inside the metadata leg's `!res.ok` branch, so a dropped or aborted `PATCH` falls straight to the outer `catch` and the owner reads only "Failed to fetch" over a body that is already on disk — and retypes or reloads over it, which is the whole harm the change exists to remove. The omission is deliberate and argued (`partialSaveMessage`'s docblock, and the case `makes no claim about a metadata leg whose fetch never came back`): the decision's frozen sentence asserts "the metadata change was not", which nobody can claim about a request that never came back, and it interpolates a `<served error>` that branch does not have. Saying only the provable half — that the text was saved, and that the metadata outcome is unknown — needs a SECOND owner-facing sentence, which is an intent-level copy decision the 2026-08-22 decision did not open.
status: open

### DW-704: A ledger row the listing now surfaces because its page is on disk but missing from the page index is still refused by DELETE, so the owner sees a row that can never be cleared.
origin: spec-deferred 450979fe0e60
location: src/app/api/ingest/history/route.ts (DELETE ingestIds preflight and the DW-270 read gate)
source_spec: `spec-dw-432-ingest-history-orphan-listing.md`
severity: medium
reason: GET now admits an index-missing slug whose page the caller can read (src/app/api/ingest/history/route.ts, the orphan probe in the ledger walk). DELETE was deliberately left alone: its `ingestIds` preflight and its DW-270 read gate both test the index-backed `readable` set built from `listReadableWikiPages`, so the same row answers `SELECTION_NOT_FOUND` and lands in `failed[]`. The owner therefore gets a visible, selectable row whose delete always fails with a sentence that says it was "not found", which is a wrong answer about a row the same route just listed. The gap is the second half of this bundle's own decision ("orphan rows list AND become deletable"); it was not shipped because that decision also says "on this listing path only", and `spec-dw-393-bulk-ingest-delete-per-entry-outcomes.md` shipped the opposing constraint for the delete path ("Do not add a disk fallback for orphan slugs -- the ledger/index contract stays as-is"). Closing it means overturning a shipped human decisio
status: open

### DW-705: The envelope's new body term charges MAX_EMAIL_CONTENT_CHARS as if each UTF-16 code unit were one byte, so it buys a maximal ASCII body only; a non-ASCII body of the same length is up to ~3x larger on
origin: spec-deferred ab4ee59f10f8
location: workers/email-ingest/index.ts (MIME_ENVELOPE_HEADROOM_BYTES)
source_spec: `spec-dw-455-email-envelope-body-budget.md`
severity: low
reason: MIME_ENVELOPE_HEADROOM_BYTES adds Math.ceil(MAX_EMAIL_CONTENT_CHARS * WORST_CASE_TRANSFER_ENCODING_FACTOR) = 312,000, but MAX_EMAIL_CONTENT_CHARS bounds code units (rawContent.length / rawContent.slice at the Worker's truncation, content.length on the route). 100,000 non-ASCII BMP characters are up to ~300,000 decoded bytes and ~936,000 on the worst-case quoted-printable wire, against 312,000 bought plus 65,509 bytes of structural slack. 312,000 is the figure the recorded DW-455 decision named, so it was documented rather than re-derived. Inert today: since DW-449 the Math.min picks EMAIL_ROUTING_MAX_INBOUND_BYTES, so AGGREGATE_DERIVED_RAW_EMAIL_BYTES gates nothing -- it becomes live only if the platform ceiling rises above the derivation (the open DW-457 question).
status: open

### DW-706: Nine code and test sites now cite DW-457 for the email inbound-ceiling decision, but the ledger entry under that id is an unrelated, already-closed MCP `missing-concept-page` slug-parity defect.
origin: spec-deferred 7b2a0e867d77
location: workers/email-ingest/index.ts (EMAIL_ROUTING_MAX_INBOUND_BYTES, MAX_RAW_EMAIL_BYTES)
source_spec: `spec-dw-457-email-inbound-ceiling-provenance.md`
severity: low
reason: `_bmad-output/implementation-artifacts/deferred-work.md:3386` reads "### DW-457: `missing-concept-page` is effectively unreachable over both MCP transports", status done 2026-08-29, and `src/mcp.ts` already cites DW-457 for that. The email-ceiling decision reached this work only through a `decision:` line misfiled onto that archived entry -- a misfiling `spec-dw-395-455-456-457-mcp-rest-door-parity.md:214` already flagged as "worth correcting in the ledger". A maintainer grepping DW-457 after this change now gets two unrelated defects and no way to tell which citation belongs to which. Fixing it means correcting the ledger, which this run was forbidden to touch.
status: open

### DW-707: The Sources-pane rescan lists `raw/sources/**` only, so a legacy-address silo mirror is visible in the Files tab but never in Sources.
origin: spec-deferred 05bb5603ea70
location: src/lib/workbench-files.ts:726
source_spec: `spec-dw-608-610-611-silo-sync-gate-coverage.md`
severity: low
reason: `listRawSourceFilePaths` (src/lib/workbench-files.ts:726) walks the silo `raw/` root but descends only toward `raw/sources` (`underSources`/`towardSources`, :770-776), while `listWorkbenchFilePaths` walks the whole root. Both legacy addresses this mirror writes — `tenants/<t>/raw/<slug>.md` (pre-existing) and `tenants/<t>/raw/<slug>/<rawId>.<ext>` (DW-610, added here) — therefore list in Files and never in the Sources pane. DW-610's harm is stated as "invisible in Files" and that surface IS closed; the Sources pane is a second surface the bundle never named. Pre-existing for the flat legacy address, and unchanged by the address-preserving choice recorded in this spec's Design Notes.
status: open

### DW-708: `POST /api/wikis` answers 500 while the wiki was in fact created and made current, whenever `writeRegistry` stores `wikis.json` and then rejects.
origin: spec-deferred d843fdc55060
location: src/app/api/wikis/route.ts (POST); src/lib/wikis.ts createWiki failure tail
source_spec: `spec-dw-674-675-wikis-sweep-compensation-guards.md`
severity: low
reason: DW-675's fix makes `createWiki` keep the new wiki's directory when the read-back positively finds the record, and bump `dataVersion` — but the original storage error is still re-thrown unwrapped, so the route answers 500. The owner is told the create failed while the switcher, the workbench heading and every artifact read now resolve against the new wiki, and a retry mints a second one against `MAX_WIKIS`. This is the create-route sibling of the shape DW-676 already records for `POST /api/wikis/[id]/template` after DW-484; neither the bundle intent nor either ledger entry names the route surface, both stop at the bytes.
status: done 2026-09-03
resolution: resolved by sweep bundle dw-wiki-create-and-template-failure-truth
resolution-undo: 93e7441d5b4648d5269eb89c6196d2f266087bdf94e5bcfe8489e6c96d4e03fd 2026-09-03 7374617475733a206f70656e

### DW-709: Workspace guidance is still resolved from the raw handle at every prompt site outside the merge and ingest doors, so an agent-owned page's action and structured-knowledge extraction still reads the ag
origin: spec-deferred 7ba7fdd655e1
location: src/lib/action-extractor.ts:44 and src/lib/structured-knowledge.ts:310
source_spec: `spec-dw-543-guidance-by-human-owner.md`
severity: low
reason: DW-543 scoped the fix to the two doors its `location:` field names, but the decision's `reason:` frames the convention as settling guidance addressing "for every prompt site at once". A concrete agent-reachable path remains: `src/app/api/agents/[id]/ingest/route.ts` sets `owner = asOwner ? agentRecord.owner : id` (the agent id) and records it as the job/task owner; `src/app/api/tasks/run/route.ts` then derives `actionOwner = task.triggeredBy || task.owner || task.author` and hands that agent id to `extractActionsFromPage` (`src/lib/action-extractor.ts:44`) and `extractStructuredKnowledge` (`src/lib/structured-knowledge.ts:310`), each of which calls `buildWorkspaceGuidance(owner)` / `listNamesTerms(owner)` unreduced. So the same agent-owned page whose ingest prompt now carries alice's standards has its follow-on extraction run unguided. Same shape at `src/lib/source-monitors.ts:387-388` (`monitor.owner`), `src/lib/monitor-digests.ts:437` and `src/lib/action-items.ts:102,180`. Not agent-
status: open

### DW-710: With vector search switched ON but no embedding provider actually resolvable, `findMergeCandidates` now takes the vector branch, gets an empty result, and returns early instead of falling through to t
origin: spec-deferred eacd5deb7dad
location: src/lib/ingest.ts:1048
source_spec: `spec-dw-68-70-embedding-config-plumbing.md`
severity: low
reason: `getVectorSearchSettings()` always passes `hasWorkersAiBinding: null` (config.ts:1653, DW-225), and `vectorSearchMissingLegs` applies the binding leg only on an explicit `false` (workbench-settings.ts:1588). So a store holding `embeddingProvider: "workers-ai"`, a supported `@cf/` model and `vectorSearchEnabled: true`, running OFF Workers, reports `enabled: true` while `resolveEmbeddingProvider` returns `null`. `searchByVector` then returns `[]` (embeddings.ts:1106) and `findMergeCandidates` returns that empty list without reaching `buildCorpusStats`/`bm25Score`. Before DW-68 the gate was `hasEmbeddingSupport()`, which is `false` there, so the BM25 branch ran and merge de-duplication worked. Consequence on such a deployment: every ingest forks a new page instead of merging, silently. Root cause is the pre-existing `hasWorkersAiBinding: null` hole rather than this change, and the three candidate fixes (fall through on empty results, conjoin `hasEmbeddingSupport()`, or close the binding h
status: done 2026-09-03
resolution: resolved by sweep bundle dw-merge-candidate-and-fold-quality
resolution-undo: f3854e9d9961147b3bf3667ab6c448f96e0c6e0474fded509adac00d3458a761 2026-09-03 7374617475733a206f70656e

### DW-711: The Chat send path gates on two different answers — `ChatCanvas` on the WORKLOAD model's `configured`, `chat.ts` on `hasLLMKey()`'s PRIMARY answer — so a `chatProvider`-only store passes the first and throws at the second.
origin: escalation resolution of spec-dw-618-619-621-single-snapshot-model-client.md via /bmad-loop-resolve, 2026-09-01
location: src/components/workbench/ChatCanvas.tsx:472 and src/lib/chat.ts:865
source_spec: `spec-dw-618-619-621-single-snapshot-model-client.md`
severity: low
reason: `ChatCanvas.tsx:472` refuses on `!assembled.chatModel.configured`, which comes from `chatModelForRetrieve` → `getChatModelSettings` (`wiki-retrieve.ts:544`) — the WORKLOAD resolver, which honours `cfg.chatProvider`. `chat.ts:865` then refuses on `!(await hasLLMKey())`, which reads `cfg.provider` only. For a store holding `chatProvider: "ollama"` and no `provider` the two disagree: the UI gate passes (workload resolves ollama, keyless, `configured: true`), the send proceeds, and the runtime gate throws `No LLM provider is configured.` — so the owner is told Chat is ready and then told nothing is configured, on the same click. Underneath sits the real gap DW-621 misdiagnosed as a `hasLLMKey` widening: NO production call site passes `workload` to `getConfiguredModel` (only tests do), and Epics 2 and 3, which `llm.ts:400-406` and `config.ts:1578-1591` name as owning those call sites, are `done` in `sprint-status.yaml` without having wired it — so `chatProvider`/`ingestProvider` change what the UI reports but never which model a call actually uses. Fixing this means either routing chat/ingest by workload at the call sites or making both gates ask one question; picking between those is a story, not a predicate change. See that spec's Design Notes ("The DW-621 finding") for the measurement that ruled out widening the gate on its own.
status: open

### DW-712: `assembleWikiContext` resolves its `chatModel` payload from a config cache nothing on that route ever warms, so a cold process reports a correctly configured provider as `configured: false`.
origin: spec-deferred 0810f95490ab
location: src/lib/wiki-retrieve.ts:552
source_spec: `spec-dw-618-619-621-single-snapshot-model-client.md`
severity: medium
reason: `chatModelForRetrieve` is synchronous and its only production caller, `src/app/api/v1/projects/[wikiId]/retrieve/route.ts:51`, never awaits `loadConfig()` (grepped: the file contains no `loadConfig` call). On a process nothing else warmed, `loadConfigSync()` answers `{}` and re-stamps it for another 5 s (`src/lib/config.ts:1180-1186`), so `provider`, `model`, `configured` and `baseUrl` all describe an empty store and the public retrieve API tells a caller the wiki has no chat model. This is DW-548's class of defect — the one that forced `hasLLMKey` to become async — at a different surface. PRE-EXISTING: the bare `getChatModelSettings()` had the same cold read before DW-619 threaded a snapshot through it, and DW-619 neither caused nor names it. Not covered by the suite, which module-mocks `loadConfigSync`.
status: open

### DW-713: `getConfiguredModel` never reads `cfg.model` or `LLM_MODEL`, so a stored primary model refuses a `custom` provider the primary ladder builds fine.
origin: spec-deferred a5a25d7b2c00
location: src/lib/llm.ts:519
source_spec: `spec-dw-630-631-632-llm-refusal-copy-pointers.md`
severity: low
reason: DW-632 aligned the two ladders' KEYLESS diagnoses; the MODEL gap still diverges, and this one is not copy. `getResolvedCredentials` (`src/lib/config.ts:2613-2632`) resolves the model from `LLM_MODEL`, then `cfg.model`; `getConfiguredModel`'s explicit-provider branch (`src/lib/llm.ts:519-524`) resolves only `options.model`, the workload settings, `OLLAMA_MODEL` and `DEFAULT_MODELS[provider]` — and `DEFAULT_MODELS.custom` is deliberately absent. Verified with a seeded config `{provider: "custom", model: "my-model", customApiKey, customBaseUrl}`: `getModel` builds the client, while `getConfiguredModel({provider: "custom"})` throws "The Custom provider needs a model name." Reachable in production at `src/lib/agent-runtime.ts:156`, which spreads `provider` with no `model` when an agent carries no model override — so a correctly configured custom endpoint is refused for a model the owner did set. Pre-existing and outside this bundle's named sites; the new cross-ladder equality tests delibera
status: open

### DW-714: Every `SourceBadge`-bearing label on /settings computes an accessible name with no separating space, so a screen reader announces "Modelfrom environment" and "Ollama Base URLfrom environment".
origin: spec-deferred 8a0b73bf34b1
location: src/components/SourceBadge.tsx and the SourceBadge-bearing labels in src/components/ProviderForm.tsx
source_spec: `spec-dw-561-617-provider-form-pick-and-env-label.md`
severity: low
reason: `SourceBadge.tsx` relies on the badge span's `ml-2` class for visual spacing only, and the labels in `ProviderForm.tsx` render `{settings && <SourceBadge …/>}` directly after the label text with no whitespace node between them. The accessible name is therefore the two strings run together, which both `provider-form.test.tsx` cases now pin verbatim ("Modelfrom environment", "Ollama Base URLfrom environment") as the name a browser computes. `EmbeddingSettings.tsx` already writes `Embedding Model{" "}` before its span, so the repo carries both spellings and the fix pattern is settled. Pre-existing and repo-wide across Provider, Model and Ollama Base URL; surfaced here because DW-617 pinned a second instance of it.
status: open

### DW-715: The `/settings` embedding hint claims "a 1,024-dimensional Vectorize index" on the strength of the resolved Workers AI provider alone, but the Vectorize binding is independently optional, so a deploym
origin: spec-deferred 29bf19d57bde
location: src/components/EmbeddingSettings.tsx:380
source_spec: `spec-dw-616-workers-ai-dimension-hint.md`
severity: low
reason: `resolveEmbeddingProvider` answers `workers-ai` when the Cloudflare `AI` binding is bound (src/lib/embeddings.ts); that says nothing about `YOPEDIA_VECTORIZE`. `R2Storage` holds `this.vectorize` as `VectorizeIndex | undefined` (src/lib/storage/r2.ts:86,91) and guards every vector operation on it (:404, :430, :454, :467, :477), so the index half of the sentence can be false while the provider half is true. Pre-existing and untouched by DW-616, which narrowed only the provider half. The settings route already resolves binding facts server-side (`getWorkersAiBinding()`, served as `hasWorkersAiBinding`), so the same door could answer this one.
status: open

### DW-716: The Skill count is appended to the health line for every health, so a sidecar that never answered still renders "0 Skills on disk." as a statement of fact.
origin: spec-deferred e26f7ee1a820
location: src/components/workbench/SettingsApiMcpPane.tsx (the apiLive health note's Skill count)
source_spec: `spec-dw-633-634-635-settings-api-mcp-pane-copy-a11y.md`
severity: low
reason: `probeLoopbackApiPane` runs the Skills scan independently of `/health` and swallows its failure into `skills: []`. `SettingsApiMcpPane` then renders `${apiLive.skills.length} Skills on disk.` unconditionally beside whichever health sentence it chose. With nothing serving on 19828 — the ordinary state of a wiki whose sidecar is not started — the pane says "The sidecar is not running on 127.0.0.1:19828. 0 Skills on disk.", asserting something about the machine that the failed scan could not establish: the count is "the scan did not answer", not zero. Same false-claim class as DW-633, which this bundle fixed for the health sentence only. Pre-existing and unchanged by this story; the count rides along with the sentence exactly as before.
status: open

### DW-717: Eighteen components and libs carry their own hand-rolled copy of `send`'s body parse, each with the bare `.catch(() => ({}))` this bundle just replaced — so the DW-556 misclassification is still live
origin: spec-deferred 74dfd93a18c0
location: src/components/*.tsx (16 files), src/lib/chat-session-transport.ts, src/lib/chat.ts
source_spec: `spec-dw-620-624-settings-read-and-write-confirmation.md`
severity: low
reason: A repo-wide grep for the literal `response.json().catch(() => ({}))` finds it in `SystemHealthDesk.tsx`, `LocalSyncPanel.tsx`, `ActionInbox.tsx`, `SourceMonitorDesk.tsx`, `NamesTermsSettings.tsx`, `IntegrationDesk.tsx`, `MonitorDigestPanel.tsx`, `ReviewDesk.tsx`, `AgentWorkspaceDesk.tsx`, `BulkDocumentImport.tsx`, `ArticleActions.tsx`, `VaultExplorer.tsx`, `KnowledgeStudio.tsx`, `ChatWorkspace.tsx`, `KnowledgeAtlas.tsx`, `RecentIngests.tsx`, `chat-session-transport.ts` and `chat.ts` — none of which imports `workbench-request`. On each, a 2xx whose body read dies mid-stream resolves an empty object, so the destructure that follows reports a landed write as a failure (or a shapeless success), exactly the defect DW-624 names. The fix is `send`'s now-shipped gate: `if (response.ok && unconfirmedCause(cause)) throw cause;` plus a `writeFailure` at the catch. Not a call site of anything this bundle changed — these are independent copies of the helper.
status: open

### DW-718: `WorkspacePreview` renders a second `.wb-preview` column whose `<header className="wb-preview-header">` matches no rule anywhere in globals.css, so that column's title and path have zero padding and n
origin: spec-deferred 8f5d4c2edc3f
location: src/components/workbench/WorkspacePreview.tsx:84
source_spec: `spec-dw-205-207-split-handle-hit-and-focus.md`
severity: low
reason: `WorkspacePreview.tsx:77` renders its own `<aside className="wb-preview">` for Agent-workspace picks, and its header at `:84` carries the class `wb-preview-header` — one letter off `wb-preview-head`, and `grep -n "wb-preview-header" src/app/globals.css` returns nothing. The class is dead: no padding, no `border-bottom`, no flex row, so the `<h2>` and the path sit flush at the column's x=0 while `PreviewColumn`'s equivalent header is a padded, bordered strip. That is pre-existing and independent of this change, but DW-205 widens the mismatch inside that one column from 16px to 24px, because `.wb-preview-body` there IS matched by the clearance rule and the header still is not. The fix is a component change (render `wb-preview-head`, or declare the missing rule), which moves that column's header geometry — outside a stylesheet-only bundle.
status: open

### DW-719: ModeCanvas picks its scroller once per `hidden` transition, so docking or undocking a Preview, or crossing the stacking breakpoint, leaves the listener on the element that no longer scrolls.
origin: spec-deferred 081c8fe49767
location: src/components/workbench/ModeCanvas.tsx (the DW-416/DW-523 effect)
source_spec: `spec-dw-521-523-524-scroll-restore-clamp-and-timing.md`
severity: low
reason: `canvasScroller` answers a layout question but the effect is keyed on `[hidden]` alone, and `globals.css` flips which element scrolls on three conditions that never change `hidden`: docking a Preview below 899px (`:5341-5370`), crossing the breakpoint, and opening the mode sheet, which re-applies the clamp (`:5372-5382`). `previewOpen` flips when the owner picks a tree row (`Workbench.tsx` `onDockPreview={selectRow}`) with the canvas still showing, so at narrow width the listener stays on `.wb-canvas` after the document has become the scroller and records nothing for the rest of the visit -- DW-523's failure shape reached by dock rather than by width. Across runs the single `canvasScrollRef` can also re-apply an offset recorded on one scroller to the other. Closing it needs either a preview/breakpoint input threaded into `ModeCanvas` (it takes neither today) or a re-probe trigger; the spec's contract forbids listening on both surfaces at once, so it is a mechanism decision rather than
status: open

### DW-720: WorkspacePreview, the Agent-output Preview column, renders the same two `.wb-preview` / `.wb-preview-body` scroll boxes under the same `hidden` withdrawal and did not get DW-520's scroll memory.
origin: spec-deferred 2876b98a3cb2
location: src/components/workbench/WorkspacePreview.tsx:77-113
source_spec: `spec-dw-519-520-uncovered-scroll-surfaces.md`
severity: low
reason: `Workbench.tsx:1917-1923` mounts `WorkspacePreview` from the same block as `PreviewColumn`, with the same `id={PREVIEW_ID}` and the same `hidden={!previewOpen}` (`previewOpen = previewDocked && !settingsOpen`, `Workbench.tsx:401`). `WorkspacePreview.tsx:77-113` renders `<aside className="wb-preview">` around `<div className="wb-preview-body">` — both `overflow: auto` (`globals.css:4214`, `:4262`) and both discarded by `.wb-preview[hidden] { display: none }` (`globals.css:2782`) — and holds no ref, no restore and no listener. In Chat mode with an `agent-workspace/` file picked (`shouldDockPreview` docks for `mode === "chat"`, `workbench-tree.ts:511-525`) an owner who scrolls a long Agent report, opens Settings and closes it lands back at the top of both boxes: exactly the loss DW-520 names, at a component neither ledger entry mentions. The only suite that mounts it (`epic8-chat-ui.test.tsx:233`) passes no `hidden` prop and asserts only the fetched body.
status: open

### DW-721: A create that SUCCEEDS on either wiki surface leaves the other surface's create fully live for the length of `router.refresh()`, so one click there still seeds the second wiki the latch exists to prev
origin: spec-deferred d337f0eae1fc
location: src/components/WikiWorkbench.tsx (create, success branch) and src/components/workbench/WikiSwitcher.tsx (create, success branch)
source_spec: `spec-dw-515-516-517-unconfirmed-write-latch-shared.md`
severity: low
reason: Pre-existing and unchanged by DW-515/516/517, which share the UNCONFIRMED half only. `WikiWorkbench.create`'s success path raises the component-local `awaitingCreate` (read by that card's opener and confirm alone); `WikiSwitcher.create`'s success path raises nothing at all. Both surfaces stay mounted together and both POST `/api/wikis`, and nothing enforces unique wiki names. Demonstrated by mounting both under one `WorkbenchDataProvider`, letting the card's create resolve 2xx, and pressing the header's `Create`: a second `POST /api/wikis` is issued while every existing suite stays green. The consequence is the one the shared latch was built for — a duplicate wiki made active, moving every prompt onto its template.
status: open

### DW-722: `storage-fs.test.ts`'s `reapStrandedScratchFiles` cases fail under full `node`-project load, so `pnpm test` — the repo's own CI command — is not reliably green independent of any change.
origin: spec-deferred 0cd1c133cb89
location: src/lib/__tests__/storage-fs.test.ts:1229
source_spec: `spec-dw-257-468-469-mounted-rail-tree-split-coverage.md`
severity: low
reason: Reproduced at BASELINE with every file from this bundle removed from the working tree (`git stash` + the new file moved aside): three consecutive `pnpm vitest run --project node` runs failed, 2/2/1 cases respectively, always in `FilesystemStorageProvider > reapStrandedScratchFiles` ("stops at STRANDED_SCRATCH_CANDIDATE_CAP…" and "honours an explicit window…", `AssertionError: expected 3 to be 1`). The same file passes in 685ms when run alone. The cases plant scratch files at explicit mtimes and reap against a grace window measured in wall-clock milliseconds (1_000 / 5_000), so under parallel load a candidate crosses the window mid-pass. Independently observed by a review layer on the unmodified tree. This bundle touches only the `dom` project, which is fully green (72 files, 1111 tests).
status: done 2026-09-02
resolution: resolved by sweep bundle dw-test-suite-determinism
resolution-undo: c31fee82fe2c024a94a6fbc49e87257a58f1d712556f3a00390c1a71f11a685c 2026-09-02 7374617475733a206f70656e

### DW-723: A component mounted while /api/wiki/routes was failing still keeps its DEFAULT_TENANT hrefs for its whole lifetime when no OTHER component mounts afterwards, because the only recovery signal is anothe
origin: spec-deferred be34af8b6828
location: src/hooks/useSlugTenants.ts:165
source_spec: `spec-dw-234-262-slug-tenant-map-lifecycle.md`
severity: low
reason: DW-234 is closed by propagation: `loadSlugTenants` broadcasts a successful cache fill to every mounted hook. Verified by grep over src/, e2e/ and workers/ that nothing outside `useSlugTenants` calls `loadSlugTenants()`, so "the next cold caller" is always a later MOUNT. On a surface that goes idle after the outage — a Workbench sitting still, no navigation, no panel opening — no later mount occurs, nothing re-fetches, and that component stays on the wrong-handle 308 hop until reload. Closing it needs a self-initiated refresh (retry-after-degraded, or a visibility/focus signal), which this spec's Never clause rules out on the authority of DW-234's own reason field ("the next cold caller re-fetches").
status: open

### DW-724: extractPptx accepts any archive entry as a slide, so a crafted presentation rel aimed at a real non-slide part (an image, docProps) passes the existence filter, makes `ordered` non-empty and silently
origin: spec-deferred d2fdde158ba7
location: src/lib/document-extract.ts:605
source_spec: `spec-dw-232-695-inherited-prototype-indexing.md`
severity: low
reason: src/lib/document-extract.ts:605 filters the presentation-order list with `Boolean(files[slide.path])` only — it never checks that the resolved path is a slide part. `resolveArchiveTarget("ppt/presentation.xml", "media/photo.jpg")` yields `ppt/media/photo.jpg`, a key the archive really holds, so the bogus entry survives, `ordered.length` is non-zero and it overrides `fallbackSlides`. The deck's readable `ppt/slides/slideN.xml` parts are then never extracted and the image bytes are decoded as slide XML, producing an empty section instead. Reachable through the live ZIP door (`extractDocumentTextAsync`'s zip branch), and distinct from the inherited-prototype defect this bundle closed: it is path confusion, not prototype indexing, and a null-prototype archive does not address it. A `/^ppt\/slides\/slide\d+\.xml$/i` test on `slide.path` alongside the existence check is the shape of the fix.
status: open

### DW-725: `isStoreFault` still leads with `error instanceof StoreFaultError`, the exact identity check DW-578 removed from `ClientInputError` three lines above it in the same file.
origin: spec-deferred dcc09c8cca55
location: src/lib/errors.ts:82
source_spec: `spec-dw-271-578-module-graph-fragility.md`
severity: low
reason: `src/lib/errors.ts` now classifies `ClientInputError` structurally on `err.name`, and its doc block cites `isStoreFault` as the ordering precedent — but `isStoreFault` itself is still an identity check plus an errno probe. A `StoreFaultError` from a second copy of the module carries no errno `code`, so it falls through to `false`. At `src/app/api/tasks/run/route.ts:929` that loses the transient 500-and-retry and drops the task onto the `/not found/i` 422 below it, poisoning work that should have been retried. A `err.name === "StoreFaultError"` arm would close it the same way this pass closed the sibling. Out of scope here: the bundle intent names `ClientInputError` and `commons.ts` only.
status: open

### DW-726: The streaming query route excludes saved artifacts only on the UNSCOPED path, while the non-streaming query() excludes them regardless of scope, so a scoped stream query can feed artifact markup into
origin: spec-deferred a3109c8fb2a9
location: src/app/api/query/stream/route.ts:124-128
source_spec: `spec-dw-667-669-query-stream-mock-fidelity.md`
severity: medium
reason: `src/lib/query.ts:298-306` filters `!isArtifactType(e.type)` BEFORE the scope branch, with an explicit comment: artifacts "must never enter the LLM context - so exclude them REGARDLESS of scope (incl. a vault that curated one, or the owner/'Mine' scope)". `src/app/api/query/stream/route.ts:124-128` applies the same predicate INSIDE `if (!scopeSlugs)`, so it only runs on an unscoped query. `resolveScopeSlugs` for `mine` / `owner:<handle>` returns that owner's slugs, which include their saved `html`/`slides` pages - so an owner-scoped streaming question can answer from raw artifact markup (and inlined illustration data URIs) that the non-streaming path deliberately withholds. Pre-existing and untouched by this story; surfaced by the review because DW-667 widened the artifact stub at exactly that filter. No test covers the scoped-artifact case in either streaming suite.
status: open

### DW-727: A sixth verbatim ~50-field WorkbenchSettingsPayload literal survives in a mounted Settings suite that the harness could always have reached, so the "one home for the payload" property this bundle clai
origin: spec-deferred 825944fdb6e0
location: src/components/workbench/__tests__/epic8-skills-canvas.test.tsx:50
source_spec: `spec-dw-471-472-627-settings-test-harness-consolidation.md`
severity: low
reason: `src/components/workbench/__tests__/epic8-skills-canvas.test.tsx:50-98` holds the same ~50-field literal, differing from `settingsPayload()` in exactly four fields (`hasEmbeddingApiKey: true`, `apiEnabled: true`, `hasLoopbackApiToken: true`, `loopbackTokenSource: "store"`). It sits in the directory the harness used to occupy, so the reachability argument DW-471 makes never applied to it — it was simply not named by DW-228's census or by this bundle's intent, which names the fifth suite only. It can import `settingsPayload` alone, exactly as the parity suite now does, with no `installSettingsFetchMock`. Left as-is here because the intent names one suite; folding it is the same mechanical change and would finish the property.
status: open

### DW-728: `reapStrandedScratchFiles`' two grace-window cases in `storage-fs.test.ts` fail intermittently under full-suite load, so `pnpm test` is not reliably green.
origin: spec-deferred 535aa7a613ec
location: src/lib/__tests__/storage-fs.test.ts
source_spec: `spec-dw-470-606-shared-test-helper-extraction.md`
severity: low
reason: Two cases — "stops at STRANDED_SCRATCH_CANDIDATE_CAP and reclaims the remainder next pass" and "honours an explicit window, so the grace period is a parameter and not a hardcode" — failed in three of five full-suite runs during this story and passed in the other two. They pass standalone every time. Proven pre-existing and unrelated to this change: with every file of this story stashed (`git stash -u`, tree at f095692c), a full `pnpm test` failed the same two cases. The assertions turn on real wall-clock mtime grace windows (one case took 5352 ms), so they lose under the scheduling pressure of 369 parallel test files. Nothing in this story touches `storage-fs.ts` or its suite.
status: open

### DW-729: `research-runtime.test.ts`'s "deep research — remediations" rows time out under parallel `node`-project load, so `pnpm test` still has a load-sensitive row after DW-722 closed the `storage-fs.test.ts`
origin: spec-deferred 2b6e6d159ded
location: src/lib/__tests__/research-runtime.test.ts
source_spec: `spec-dw-500-501-722-test-suite-determinism.md`
severity: low
reason: Observed on the FINISHED tree of this story, in both halves of two concurrent `npx vitest run --project node` runs: run A failed "logs a read-only skip, not data damage, when a delete is refused" and "still names a DAMAGED project when the fault is not a refusal"; run B failed the same two. ~5.1s against the 5s default timeout — a duration failure, not an assertion. The file is NOT touched by this story (absent from `git diff --name-only`), so its behaviour is identical to the 2c00cfaede05a95c326bf1c59447f9e305b0b958 baseline; it passes in a normal single run and in `pnpm test` (369 files green). Same class as DW-722 — the repo's own CI command is not reliably green independent of any change — but a different file that this bundle's intent did not name.
status: open

### DW-730: "Queued work is replayable, not lost" rests on the consumer's queue CONFIG, and no test reads that config at all.
origin: spec-deferred 8fdbff417df2
location: workers/task-consumer/wrangler.jsonc:27
source_spec: `spec-dw-646-647-648-read-only-queue-door-pins.md`
severity: low
reason: `workers/task-consumer/wrangler.jsonc` declares the `yopedia-tasks` consumer's `dead_letter_queue: "yopedia-tasks-dlq"` and `max_retries: 3`, which paired with `MAX_DELIVERY_ATTEMPTS = 4` (`workers/task-consumer/index.ts:56`) is what turns "the consumer retried" into "the message survived". Repo-wide, the only tests that open either wrangler file are `src/lib/__tests__/e2e-identity.test.ts:147-157`, which asserts only `not.toMatch(/YOPEDIA_E2E\b/)`, and `brand-copy.test.ts:952,1000`, which are frozen spelling-list entries that never read the file. DW-647's new pins build `bindings` by hand and never touch the config. Deleting the `dead_letter_queue` line leaves the whole suite green while a read-only deployment DISCARDS every queued message once retries are exhausted — the exact inversion those pins exist to prevent. Bumping `max_retries` to 5 likewise stays green while `attempts = 4` stops being the final delivery, staling DEPLOY.md's "up to four delivery attempts". Only the code->con
status: open

### DW-731: Three comments state that a poison task goes to the DLQ; poison messages are acked and dropped and never reach it.
origin: spec-deferred e99a008cf7c7
location: src/lib/tasks.ts:454
source_spec: `spec-dw-645-649-read-only-comment-truth.md`
severity: low
reason: `src/lib/tasks.ts:452-454` (`parseTask` JSDoc) reads "reject malformed messages as poison (4xx -> DLQ) rather than retrying them forever"; `src/lib/tasks.ts:326-328` says a poison task "went to the DLQ"; `src/lib/__tests__/prose-inventory-parity.test.ts:347` restates "poison -> DLQ" inside a passing test's rationale. `workers/task-consumer/index.ts:114-125` acks and RETURNS for the poison set, so the message is discarded on the spot. `yopedia-tasks-dlq` is reached only through the transient/retry branch after `max_retries: 3` (`workers/task-consumer/wrangler.jsonc`). This is a different claim from DW-645 (which statuses are poison, now corrected): it is where a poison message ends up. The operational cost is an operator searching the DLQ for a malformed ingest that was never parked there. DW-645's own pass added the correct rule at `src/app/api/tasks/run/route.ts:144-145` ("discarded on the spot and never reaches the DLQ"), so the fix has an in-repo anchor to cite.
status: open

### DW-732: PATCH /api/v1/projects/[wikiId]/reviews/[reviewId] with action "deep_research" still answers 500 for the contended-store fault this bundle made a 503 at the three /api/research siblings.
origin: spec-deferred 58962a9085b1
location: src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:167
source_spec: `spec-dw-641-684-door-fault-status-parity.md`
severity: low
reason: That handler calls `createResearchProject` (`src/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route.ts:141`) — the same function whose exhausted CAS in `applyResearchProjectMutation` throws `ResearchProjectBusyError` — and its catch is still the pre-DW-684 ladder `isClientInputError(error) ? 400 : 500` at `:167`, whose own comment cites "the `src/app/api/research/route.ts` idiom", the ladder this pass changed out from under it. `createResearchProject`'s docblock already names it as the second caller ("the Review-accept handler"). So an API agent is told a permanent server fault for a registry write that provably never landed and would succeed on an immediate retry, while the in-product door for the same store tells it to retry. Out of scope here: DW-684's intent enumerates `POST /api/research`, `PATCH` and `DELETE /api/research/[id]` only. Its suite would not surface it either — `epic8-v1-routes.test.ts:598` has a `ClientInputError` row and an EINVAL row and no `ResearchProjectBusyE
status: open

### DW-733: `MarkMeetingControl` stands in front of a door that DOES refuse and folds the refusal into plain `disabled=`, with no sentence and no client mirror.
origin: spec-deferred 43c75138b2ac
location: src/components/workbench/MarkMeetingControl.tsx:72
source_spec: `spec-dw-643-625-workbench-canvas-write-feedback.md`
severity: low
reason: `src/components/workbench/MarkMeetingControl.tsx:72` gates its one write with `disabled={readOnly || busy}` and renders no read-only term, while `POST /api/sources/meeting` answers `READ_ONLY_REFUSAL.sourceMeeting` — pinned by NAME in the very door loop `read-only-copy-parity.test.ts:398` runs. `sourceMeeting` is the only `READ_ONLY_REFUSAL` key with ZERO client references, so nothing holds a client sentence to that 403 and the owner meets a dead control with no reason. The control renders on the Todos surface this change hardened (it is exercised in `todos-canvas.test.tsx`), but it is a different door and a different component, and the bundle intent named only `TodosCanvas`'s own write controls — so it was left alone rather than widened into this change.
status: open

### DW-734: Reconcile's done-phase branch and `drainResearchOutbox`'s two row-in-hand branches still empty `research-leases.json` and destroy an outbox plus its staged bodies on a read-only deployment.
origin: spec-deferred 4170863e3525
location: src/lib/research-runtime.ts:741
source_spec: `spec-dw-680-681-research-readonly-write-leaks.md`
severity: low
reason: DW-680/DW-681 closed the two paths their ledger entries name, but the same two shapes remain at sites this bundle did not name. `reconcileResearchProjects`' `completion.phase === "done"` branch calls the ungated `releaseResearchSlotAndConfirmGone` and `releaseExpiredResearchSlot` (src/lib/research-runtime.ts:733-740) and then `deleteResearchOutbox` (:741), and `drainResearchOutbox`'s own done-phase (src/lib/research-completion.ts:934) and `deleteRequested` (:971) branches call the same ungated helper — `clearResearchStaging` plus a raw `deleteFile`, so the staged bodies go with the outbox. The new reconcile case in `research-runtime.test.ts` drives that whole sweep under `YOPEDIA_READONLY=1` and proves the loop runs, but seeds only orphans, so nothing asserts what the done-phase branch does. Same reachability caveat DW-681 carries: `GET /api/research` skips reconciliation when read-only and `POST /api/tasks/run` refuses, so this is a direct-library-caller and mid-sweep-flip exposure ra
status: open

### DW-735: The partially-rolled-back re-template — the divergence flavour where `purpose.md` and `schema.md` name DIFFERENT Scenario Templates — is skipped by the new reconciler and reported by nothing.
origin: spec-deferred 53117c53a8d6
location: src/lib/wikis.ts (scenarioNamedByWikiArtifacts / reconcileWikiScenarioDrift)
source_spec: `spec-dw-676-708-wiki-create-and-template-failure-truth.md`
severity: low
reason: `applyScenarioTemplate`'s failure tail carries `rollbackIncomplete` (DW-210) alongside `registryLanded` (DW-484): a restore that could not put every file back leaves one artifact on the new template and one on the old. `scenarioNamedByWikiArtifacts` answers null the moment its two witnesses disagree, and `reconcileWikiScenarioDrift` is deliberately SILENT when it does not fire — so that state is now detected by nobody, repaired by nobody and logged by nobody, while the switcher still carries whichever label the registry write left. The unanimity rule is correct as written (there is no unambiguous answer to re-derive from two contradicting files, and both artifacts are owner-editable so a guess would overwrite the wrong one), which is exactly why closing this needs its own decision — probably a distinct signal rather than a repair.
status: open

### DW-736: `PUT /api/workbench/artifact` still relays a raw storage errno into the owner's save banner when the WRITE half of the save fails, not the read half this bundle typed.
origin: spec-deferred 0235d2b3e654
location: src/app/api/workbench/artifact/route.ts:112-116
source_spec: `spec-dw-688-689-owner-facing-error-recovery.md`
severity: low
reason: DW-689 scoped itself to `src/lib/wikis.ts:982` — the pre-overwrite READ — and that throw is now an `ArtifactUnreadableError` the route answers with `ARTIFACT_UNREADABLE_COPY`. The route's fallthrough is unchanged, so a storage fault raised by `putWikiArtifact` (or by `getWikiRegistry` inside the same `try`) still reaches `json({ error: getErrorMessage(error) }, 500)` and `savePreviewBody` renders it verbatim. `src/lib/__tests__/wiki-schema-edit.test.ts` ("answers a failed storage write with 500, and moves nothing") asserts only that the body's `error` is a string, and the suite's own stderr shows the raw message travelling that path. So the owner can still meet `EACCES: permission denied, open '/…'` in the save banner, by the other half of the same door.
status: open

### DW-737: `cascadeDeleteSource`'s enumeration read decides which pages enter the cascade at all, and a storage blip there drops a page silently while the raw source bytes are still deleted.
origin: spec-deferred 9072d1b0a96b
location: src/lib/source-cascade.ts:193
source_spec: `spec-dw-495-497-691-strict-merge-base-sweep.md`
severity: medium
reason: `src/lib/source-cascade.ts:193` runs `readWikiPageWithFrontmatter(entry.slug)` with no options inside the loop that builds `summaries` and `others`. A non-ENOENT blip flattens to `null`, `if (!page) continue` skips the page, and the result is PERSISTED into the resume marker written at `:203` — after which `if (resumed)` skips enumeration entirely, so a retry inherits the omission. The cascade then reaches `deleteRawSourceBytes` at `:281` and removes the raw bytes anyway, returning success with the skipped page still carrying a `sources:` entry that points at bytes that no longer exist. This is verbatim the harm that justifies the conversion 40 lines below it at `:229`, which this bundle did convert. The new row in `src/lib/__tests__/strict-merge-base-reads.test.ts` deliberately arms AROUND this read to reach the converted one, so the gap is now documented in a test rather than closed. Out of scope on the intent's own authority: the bundle intent and DW-495's location list name `source
status: open

### DW-738: A forked page's image stays in the OTHER page's asset directory, so `/api/assets/[...path]` gates it on the wrong page's visibility.
origin: spec-deferred 84c8352da242
location: src/lib/ingest.ts:425
source_spec: `spec-dw-698-693-ingest-read-and-asset-keying.md`
severity: medium
reason: `ingestImage` mints `assets/<slugify(title)>/…` before `ingest()` uniquifies, so when the realm guard forks (Alice's private `photo`, Bob's page `photo-2`) Bob's image is still stored under `assets/photo/`. `src/app/api/assets/[...path]/route.ts:69-76` reads `segments[0]` as the page slug and gates on THAT page: Bob's own image 404s for Bob and for every reader of his public page, while Alice — who owns neither the page nor the image — can fetch it. The mirror case (first page public, forked page private) serves a private page's image ungated. `syncSiloForPage` (`src/lib/silo.ts:281-295`) likewise mirrors Bob's bytes into Alice's tenant silo and never into his own. Pre-existing — the directory was always the pre-uniquified slug — and unchanged in kind by DW-693's digest keying, which the intent sanctioned as an alternative to keying off the final page slug. Keying off the final page slug (a post-ingest re-key plus body rewrite, or deferring the store) is the fix that would close it. `s
status: open

### DW-739: The same no-prose fold overwrites an existing page's whole body at the INGEST door, where the widened predicate deliberately does not run.
origin: spec-deferred a1c1635f9eac
location: src/lib/ingest.ts:1351
source_spec: `spec-dw-702-710-merge-fold-quality-and-candidate-fallback.md`
severity: low
reason: `reconcilePage`'s `"new"` path (the default) still returns the model's text verbatim, so a reconcile answering exactly "DISPUTED: no\n" or a bare heading becomes `wikiContent` at src/lib/ingest.ts:2408 and replaces the existing page's prose with that literal string. This is the identical shape DW-702 names, minus the hard delete: `spec-c3-merge-empty-reconcile-guard.md` and this spec both forbid changing the ingest door, and the new test at `src/lib/__tests__/ingest.test.ts` now PINS the verbatim return, so the residue is deliberate and enforced rather than merely unnoticed. Less severe than the merge door because `writeWikiPage` snapshots a revision first (src/lib/wiki.ts:596), so the prose is recoverable; the published page is still wrong until someone notices. Deciding whether the ingest door should degrade to `newBody` on a no-prose fold is a behaviour change to a door two specs have now declared out of scope, so it wants its own decision.
status: open

### DW-740: `createWikiPage` still creates `<slug>.md` unconditionally, so on a case-SENSITIVE store its "create only if absent" guard can miss a page already stored under a variant casing of the extension and cr
origin: spec-deferred d6a2dd77173b
location: src/lib/wiki.ts
source_spec: `spec-dw-489-490-case-variant-read-and-write-election.md`
severity: low
reason: `src/lib/wiki.ts:createWikiPage` builds `${slug}.md` and calls `writeFileIfAbsent` on it; unlike `writeWikiPage` and `writeWikiPageIfContentMatches` it was left untouched here on purpose (a Never clause of this spec). The reason is that the two decisions differ: a save is retargeting bytes onto the object the reader was shown, while "create if absent" is a CREATE-CONFLICT question — whether `cased.MD` counts as the page `cased` already existing — and answering it by probing three variants changes when a create is REFUSED, not merely where it lands. THE REACH IS WIDER THAN "a caller that skips the conflict read". The route- and MCP-level guards (`src/app/api/wiki/route.ts`, `src/mcp.ts`) do read through `readWikiPage` and so now see a recovered variant, but `src/lib/lifecycle.ts`'s `createOnly` branch (`:527-531`) carries its OWN precondition — `storageFileExists(wikiRelPath(`${slug}.md`))`, canonical only — and then calls `createWikiPage` twice (`:536` for the silo, `:541` for the flat
status: open

### DW-741: The delete and existence doors still address a Page as `<slug>.md` only, so a Page whose bytes this change deliberately parks on a case variant survives a "successful" hard delete and reads as absent
origin: spec-deferred b89aba842dc9
location: src/lib/lifecycle.ts (delete branch); src/lib/wiki.ts (wikiPageExists)
source_spec: `spec-dw-489-490-case-variant-read-and-write-election.md`
severity: medium
reason: This spec retargeted the three doors its decision named — `readWikiPage` recovery, `writeWikiPage` and `writeWikiPageIfContentMatches` — so a variant-held Page is now a live, listed, readable, WRITABLE state rather than an anomaly `readWikiPage` refused to serve at all. Two sibling doors did not move with it, and each is a wrong answer the owner can hit: (1) DELETE. `src/lib/lifecycle.ts`'s delete branch unlinks exactly `tenantWikiRelPath(deleteTenant, `${slug}.md`)` and `wikiRelPath(`${slug}.md`)`, swallowing ENOENT on both. On a case-SENSITIVE store holding only `wiki/cased.MD`, the pre-delete read NOW succeeds (it did not before this change), both unlinks miss, the op reports success — and the next `readWikiPage("cased")` recovers the variant and serves the full body. A hard delete that reports success and removes nothing is worse than the pre-change state, where the Page was simply unreadable through `readWikiPage`. (2) EXISTENCE. `wikiPageExists` (`src/lib/wiki.ts`) probes `tenant
status: open

### DW-742: `/api/raw/[slug]` serves the raw SOURCE text of a page the Knowledge tab hides to anyone, unauthenticated — the sources-half twin of the hole DW-536 just closed on the assets half.
origin: spec-deferred 6bfe3e1ce755
location: src/app/api/raw/[slug]/route.ts:24
source_spec: `spec-dw-492-536-raw-path-gate-reach.md`
severity: medium
reason: DW-536 aligned `/api/assets/[...path]` on `hiddenSlugs`/`rawPathAllowed`. `/api/raw/[slug]` (`src/app/api/raw/[slug]/route.ts:24-30`) reads the same silo tree — `readRawSource` / `readRawSourceById` over `raw/sources/<slug>.md` and `raw/sources/<slug>/<rawId>.<ext>` — and its ONLY gate is `canReadSlug(slug, principal)` (`src/lib/authz.ts:144-162`), which reads frontmatter visibility/owner and nothing else. Those are exactly the paths `rawPathAllowed` refuses for a hidden slug at `listWorkbenchFilePaths`, `resolveWorkbenchFile` and the `/api/v1` file doors. An `agent-*` typed page with `visibility: public` is kept by `listReadableWikiPages` but dropped by `buildKnowledgeTree` (`src/lib/workbench-tree.ts:656`), so its slug is in `hiddenSlugs` and the Files tab withholds its source — while `GET /api/raw/<that-slug>` returns the source text with no session. Verified by reading both routes; no test in the suite exercises that route's GET at all (only citation-href string assertions in `raw-
status: open
