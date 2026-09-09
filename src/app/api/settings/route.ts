import {
  readConfig,
  saveConfig,
  getEffectiveSettings,
  getWorkbenchSettings,
  applyWorkbenchSettings,
  workbenchSettingsStored,
  isValidProvider,
  isReadOnly,
  CONFIG_UNREADABLE_COPY,
  type AppConfig,
} from "@/lib/config";
import { getEffectiveProvider } from "@/lib/config";
import { loadEmailIngestConfig } from "@/lib/email-ingest";
import {
  SETTINGS_ENV_PROVIDER_PIN_CODE,
  SETTINGS_INVALID_URL_COPY,
  embeddingProviderChanged,
  flatMovableVectorLegs,
  flatTextFieldAction,
  isAbsoluteHttpUrl,
  settingsEnvProviderPinRefusalCopy,
  validateWorkbenchSettingsPatch,
} from "@/lib/workbench-settings";
/**
 * The ONE place the Cloudflare `AI` binding is read for the settings surface
 * (DW-225).
 *
 * Server-only, so importing `embeddings.ts` here is fine — `workbench-settings.ts`
 * must stay client-safe and `config.ts` must not deepen its edge into the embed
 * path, which is why the fact travels as DATA from this route into both halves
 * of the vector rule rather than being called from either.
 */
import { getWorkersAiBinding } from "@/lib/embeddings";
/**
 * The ONE place `YOPEDIA_VECTORIZE` is read for the settings surface (DW-715).
 *
 * Same shape as the `AI` binding above and for the same reason: server-only, so
 * the read lives in a route that already has a Workers request scope, and the
 * ANSWER — not the binding — is what crosses into the browser. The helper is
 * exported from the storage module because that module owns the binding's only
 * other consumer (`R2StorageProvider`) and reads it through the same OpenNext
 * context — see its docblock for the one path (`initCloudflareStorage(env)`)
 * that no production caller takes.
 */
import { hasVectorizeBinding } from "@/lib/storage";
import {
  PROVIDER_INFO,
  EMBEDDING_PROVIDERS,
  isEmbeddingProvider,
} from "@/lib/providers";
import { getErrorMessage } from "@/lib/errors";
import { READ_ONLY_REFUSAL } from "@/lib/read-only";
import { getPrincipal } from "@/lib/auth";
import { isOwnerPrincipal, ownerTenantHandle } from "@/lib/owner";
import {
  IF_MATCH_HEADER,
  WRITE_CONFLICT_COPY,
  WRITE_CONFLICT_STATUS,
  checkWritePrecondition,
} from "@/lib/write-precondition";

async function requireOwner() {
  const principal = await getPrincipal();
  return isOwnerPrincipal(principal) ? principal : null;
}

/**
 * The store could not be read — 503, the same sentence, on BOTH verbs.
 *
 * Same status and same wording deliberately: a `GET` that answered defaults and
 * a `PUT` that merged into `{}` would each be a different lie about the same
 * one fact. 503 rather than 500 because the condition is a store that is
 * temporarily unavailable, which is what the copy tells the owner to do about
 * it.
 */
function configUnreadable(): Response {
  return Response.json({ error: CONFIG_UNREADABLE_COPY }, { status: 503 });
}

// ---------------------------------------------------------------------------
// GET /api/settings — return effective settings with source annotations
// ---------------------------------------------------------------------------

export async function GET() {
  if (!(await requireOwner())) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  // The HONEST read (DW-192): an absent config is `{}` and a BROKEN one is a
  // refusal, where `loadConfig()` answers `{}` for both. A `GET` that served
  // defaults for an unreadable store would seed a draft from settings the owner
  // never chose, and the save that followed would write them in.
  const read = await readConfig();
  if (read.status === "unreadable") return configUnreadable();
  // Awaited BEFORE either resolver runs, rather than inline in the payload
  // below (DW-620). An `await` sitting between the reads that compose one
  // response is a window in which the 5 s-TTL config cache can expire — the
  // same defect the threaded snapshot closes, reached from the other side, and
  // the one an added `cfg` argument would not protect against on its own.
  const inbound = await inboundEmail();
  // From the snapshot this request already read (DW-620). `read.config` is the
  // exact object `readStoredConfig` primed the sync cache with, so passing it
  // is not a second source of truth — it is the ONE generation this whole
  // response describes, rather than whatever the 5 s-TTL cache happens to hold
  // by the time each resolver below runs.
  const settings = getEffectiveSettings(read.config);
  // ONE precondition, served twice (DW-63). Both Settings surfaces write the
  // same `AppConfig` through the same `PUT`, so both need the same one —
  // `/settings` reads the top-level field through `useSettings`, the Workbench
  // canvas reads it off the `workbench` object it already seeds its draft from.
  // Two derivations here would be two expressions that agree today.
  //
  // IT IS AN OPAQUE STAMP, NOT A HASH OF THE CONFIG (DW-198). `saveConfig`
  // generates it from randomness and stores it under a reserved key inside
  // `.llm-wiki-config.json`; nothing else in that file contributes to it. That
  // is what keeps the sentence below true: this response carries no secret
  // material and no function of any, where a content-derived version was a value
  // computed over `firecrawlApiKey`, `customApiKey` and `embeddingApiKey`.
  //
  // NOTHING ABOUT THE BYTES IS SERVED — which is not the same as nothing about
  // them being read (DW-372). `saveConfig` also stores a DIGEST of the config
  // under a second reserved key, and `readConfig` honours the stamp only while
  // that digest still matches what it recomputes, so a store changed by anything
  // other than a save answers the sentinel rather than a token that is no longer
  // true of it. The digest is canonical over sorted keys, so a hand-edited config
  // re-serialized in another key order is still not a conflict with itself. What
  // CROSSES this boundary is unchanged: the opaque `s1:` token, never the digest.
  //
  // `read.etag` is deliberately NOT here and never is: R2's etag IS a hash of
  // those bytes, secrets included, so it stays an internal input to the
  // compare-and-set on `PUT` (DW-272).
  const version = read.version;
  // Read ONCE and handed to the resolver: `workers-ai` is self-transporting
  // through this binding, so off Workers the vector switch must refuse rather
  // than turn on for a deployment that would embed nothing (DW-225). The browser
  // has no way to ask, so the answer rides on the payload.
  const hasWorkersAiBinding = getWorkersAiBinding() !== null;
  // A SECOND, INDEPENDENT binding — not implied by the one above (DW-715).
  // `YOPEDIA_VECTORIZE` is optional on `CloudflareEnv` and every vector call in
  // the R2 provider guards on it, so a deployment can resolve `workers-ai` as
  // its embedding provider with no index bound at all. The Settings hint used to
  // read the resolved provider and then assert "a 1,024-dimensional Vectorize
  // index" off it, which is a claim about infrastructure nothing had resolved.
  // The browser cannot ask — bindings exist only inside a Workers request scope
  // — so, like `hasWorkersAiBinding`, the fact rides on the payload as DATA.
  //
  // FLAT, beside the legacy fields rather than inside `workbench`: the hint it
  // gates renders on the flat `/settings` page, and `EffectiveSettings` in
  // `config.ts` deliberately cannot carry it — `getEffectiveSettings()` is sync
  // and cache-backed and can be called off a Workers request scope, where no
  // binding is readable. `GET` only: the hint renders on the env-locked branch,
  // which no `PUT` response feeds.
  const vectorizeBound = hasVectorizeBinding();
  // ONE settings API. Story 1.9's fields ride under ONE nested `workbench` key
  // beside the frozen legacy object — widening `EffectiveSettings` would force
  // edits to `settings-route.test.ts`'s whole-object fixture and to
  // `useSettings.ts`'s hand-duplicated type for fields neither of them uses.
  //
  // `getWorkbenchSettings()` builds that object, and it is the only thing that
  // may: no field it returns carries a stored API key — the three secrets become
  // `has*ApiKey` booleans (AD-23).
  return Response.json({
    ...settings,
    version,
    hasVectorizeBinding: vectorizeBound,
    workbench: {
      ...getWorkbenchSettings(hasWorkersAiBinding, inbound, read.config),
      version,
    },
  });
}

/**
 * The inbound-email door's stored state, for the Intake pane (Story 7.5).
 *
 * READ, never written from here: the pane renders the address and offers a
 * Copy button, and the door's own settings API stays the one writer. A failed
 * read degrades to "no address configured" rather than taking the whole
 * Settings response down — every other pane on the surface is unrelated to
 * this one field.
 */
async function inboundEmail(): Promise<{ enabled: boolean; address: string }> {
  try {
    const config = await loadEmailIngestConfig();
    return { enabled: config.enabled, address: config.inboundAddress };
  } catch {
    return { enabled: false, address: "" };
  }
}

/** The flat text fields of `AppConfig` this route merges through one applier. */
type FlatTextKey =
  | "model"
  | "structuredKnowledgeModel"
  | "ollamaBaseUrl"
  | "embeddingModel";

/**
 * ONE decision, for all four flat text fields (DW-305/DW-328).
 *
 * `model`, `structuredKnowledgeModel`, `ollamaBaseUrl` and `embeddingModel` are
 * the same kind of value — an optional trimmed string a blank body clears — and
 * four hand-written branches asking it four times is four chances to drift.
 * They are uniform here BY CONSTRUCTION rather than by four comments promising
 * they are.
 *
 * The DECISION is {@link flatTextFieldAction}, in `workbench-settings.ts`; this
 * is only the mutation that carries it out on a typed key. The split is what
 * makes the decision testable: a Next `route.ts` may export nothing but its HTTP
 * verbs, and the arm that matters most — a non-string leaving the stored field
 * UNTOUCHED (DW-328) — is defence in depth behind each field's 400, so no
 * request can reach it. The rule is executed directly by the node suite instead.
 */
function applyFlatTextField(
  updated: AppConfig,
  key: FlatTextKey,
  value: unknown,
): void {
  const action = flatTextFieldAction(value);
  if (action === "ignore") return;
  if (action === "delete") {
    delete updated[key];
    return;
  }
  updated[key] = action.store;
}

// ---------------------------------------------------------------------------
// PUT /api/settings — update the config file
// ---------------------------------------------------------------------------

export async function PUT(request: Request) {
  const principal = await requireOwner();
  if (!principal) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Optional deployment-wide kill switch. Cloud storage itself is writable;
  // credentials still remain server secrets and never pass through this API.
  if (isReadOnly()) {
    return Response.json(
      // ONE owner for this sentence (DW-387). The banner the owner read before
      // pressing renders `SETTINGS_READ_ONLY_COPY`, the character-identical
      // client mirror, so the page and the 403 can no longer disagree.
      { error: READ_ONLY_REFUSAL.settingsSave },
      { status: 403 },
    );
  }

  // ONE read per request, shared by the state the patch is VALIDATED against and
  // the payload the response re-seeds the draft from — two reads could differ
  // and would make the refusal and the redraw disagree (DW-225).
  const hasWorkersAiBinding = getWorkersAiBinding() !== null;

  try {
    const body = (await request.json()) as Partial<AppConfig> & {
      workbench?: unknown;
    };

    // Validate provider if provided
    if (body.provider !== undefined && body.provider !== null) {
      if (typeof body.provider !== "string" || !isValidProvider(body.provider)) {
        const valid = PROVIDER_INFO.map((p) => p.value).join(", ");
        return Response.json(
          { error: `Invalid provider: "${body.provider}". Must be one of: ${valid}` },
          { status: 400 },
        );
      }
    }

    // Validate the optional provider dedicated to schema-constrained Knowledge
    // Atlas extraction. This selects a server-side credential; keys never pass
    // through the settings API.
    if (
      body.structuredKnowledgeProvider !== undefined &&
      body.structuredKnowledgeProvider !== null
    ) {
      if (
        typeof body.structuredKnowledgeProvider !== "string" ||
        !isValidProvider(body.structuredKnowledgeProvider)
      ) {
        const valid = PROVIDER_INFO.map((p) => p.value).join(", ");
        return Response.json(
          {
            error: `Invalid structuredKnowledgeProvider: "${body.structuredKnowledgeProvider}". Must be one of: ${valid}`,
          },
          { status: 400 },
        );
      }
    }

    // Validate embeddingProvider if provided
    if (body.embeddingProvider !== undefined && body.embeddingProvider !== null) {
      if (
        typeof body.embeddingProvider !== "string" ||
        !isEmbeddingProvider(body.embeddingProvider)
      ) {
        return Response.json(
          {
            error: `Invalid embeddingProvider: "${body.embeddingProvider}". Must be one of: ${EMBEDDING_PROVIDERS.join(", ")}`,
          },
          { status: 400 },
        );
      }
    }

    // Validate model if provided
    if (body.model !== undefined && body.model !== null) {
      if (typeof body.model !== "string" || body.model.trim().length === 0) {
        return Response.json(
          { error: "Model must be a non-empty string" },
          { status: 400 },
        );
      }
    }

    if (
      body.structuredKnowledgeModel !== undefined &&
      body.structuredKnowledgeModel !== null
    ) {
      if (
        typeof body.structuredKnowledgeModel !== "string" ||
        body.structuredKnowledgeModel.trim().length === 0
      ) {
        return Response.json(
          { error: "Structured Knowledge model must be a non-empty string" },
          { status: 400 },
        );
      }
    }

    // Validate ollamaBaseUrl if provided
    if (body.ollamaBaseUrl !== undefined && body.ollamaBaseUrl !== null) {
      if (typeof body.ollamaBaseUrl !== "string") {
        return Response.json(
          { error: "ollamaBaseUrl must be a string" },
          { status: 400 },
        );
      }
      // THE SAME URL RULE EVERY WORKBENCH ENDPOINT PASSES (DW-304). Without it
      // this was the one endpoint stored on a bare `typeof` check, so
      // `"not-a-url"`, `"/api"` or `file:///etc/passwd` landed in the config.
      //
      // `getOllamaBaseUrl()` now checks it on the way OUT too (DW-326), so this
      // is no longer what stands between a junk value and the provider SDK. It
      // is still the door that has to refuse: the read side can only DISCARD an
      // unusable endpoint, silently falling back to the SDK's default, whereas
      // refusing here tells the owner their value was rejected and why — and
      // keeps the store from holding a setting nothing will ever honour. One
      // rule, said at the only place it can be said to a person.
      //
      // The same PREDICATE as `validateWorkbenchSettingsPatch`'s URL loop
      // (`isAbsoluteHttpUrl` over the trimmed value, refused with the same
      // sentence), but not byte-identical handling of whitespace: that loop skips
      // the literal `""` only, so a whitespace-only endpoint is refused there.
      // Here every blank form — `null`, `""` and whitespace — is a CLEAR, which
      // is what the merge branch below already does with it, so the rule applies
      // only to a value that is going to be stored.
      const trimmed = body.ollamaBaseUrl.trim();
      if (trimmed.length > 0 && !isAbsoluteHttpUrl(trimmed)) {
        return Response.json({ error: SETTINGS_INVALID_URL_COPY }, { status: 400 });
      }
    }

    // Validate embeddingModel if provided — TYPE only, like `ollamaBaseUrl`:
    // `null`, `""` and whitespace all still mean DELETE below.
    //
    // Without this, a non-string reaches the trimming branch, resolves to `""`
    // through the `typeof` ternary, and DELETES the owner's stored model while
    // answering 200. Every sibling flat field refuses a non-string outright, and
    // a silent delete is the worst possible reading of a malformed body.
    if (body.embeddingModel !== undefined && body.embeddingModel !== null) {
      if (typeof body.embeddingModel !== "string") {
        return Response.json(
          { error: "embeddingModel must be a string" },
          { status: 400 },
        );
      }
    }

    // Load existing config and merge with provided fields.
    //
    // THE HONEST READ, BEFORE ANY MERGE (DW-192). `loadConfig()` answers `{}`
    // for a config that is absent AND for one that failed to open, so a
    // transient storage error used to make `{}` the merge base — and a patch
    // merged into `{}` and written back deletes every stored field, the three
    // API keys included. Refusing costs the owner one retry; merging costs them
    // their credentials.
    const read = await readConfig();
    if (read.status === "unreadable") return configUnreadable();
    const existing = read.config;

    // THE WRITE PRECONDITION (DW-63), against the store state this request is
    // about to merge into — no second read, and no lock. Two surfaces write this
    // one file (`SettingsCanvas` and `/settings` through `useSettings`), so a
    // draft seeded on either before the other saved would otherwise silently put
    // back every field the other just changed.
    //
    // The version is the STORED STAMP read out of the config object, not a hash
    // of it (DW-198): `saveConfig` rotates it on every landed write, so a draft
    // seeded before someone else's save holds a token the store no longer has.
    //
    // This is the FIRST of two guards, and it is the owner-facing one. The
    // second is the compare-and-set at the write below, which covers the window
    // this check cannot see.
    //
    // Checked HERE rather than at the top of the handler because this is the
    // merge base: every branch above it refuses without writing, and moving the
    // check earlier would only mean reading a config the request never used.
    const precondition = checkWritePrecondition(
      request.headers.get(IF_MATCH_HEADER),
      read.version,
    );
    if (!precondition.ok) {
      return Response.json(
        { error: precondition.error },
        { status: precondition.status },
      );
    }

    // THE ENV PIN, SERVER-SIDE (DW-510).
    //
    // `SettingsCanvas` disables the embedding provider select under a supported
    // `EMBEDDING_PROVIDER` (DW-398), but that pin lives in the browser: a direct
    // PUT, a tab opened before the variable was set, or a CLI still reached the
    // `embeddingProviderChanged` clear below and deleted the stored embedding
    // key and endpoint — the credential belonging to the very vendor the
    // environment forces, destroyed by a request that could not change which
    // vendor embeds. This closes that bypass.
    //
    // A MOVE, never PRESENCE: `settingsSaveBody` sends `embeddingProvider` on
    // EVERY save, so a presence test would refuse every unrelated edit — a
    // timeout, the loopback switch — on a pinned deployment. The predicate is
    // `embeddingProviderChanged`, the same one both writers below clear on, so
    // the requests this refuses are exactly the requests that would have
    // cleared, and no others.
    //
    // BOTH WRITERS: the flat field and `workbench.embeddingProvider`. Measured
    // against `existing` and answered BEFORE `updated` is touched, so a refused
    // request leaves the store byte-identical.
    //
    // The pin reads the FILTERED value the select pins on — a junk variable
    // arrives as `null` here, so the route stays open exactly where the select
    // stays editable (DW-398's boundary: an unsupported value names no vendor,
    // so there is no credential a move could sabotage, and the store is what
    // applies the moment the variable is corrected).
    //
    // ONE construction of the pre-request store view, reused by every reader
    // that asks about `existing` — this pin, the gate's BASELINE argument, and
    // the backfill's "was the switch off before?" question. All three want the
    // same object; building it three times only invites the three to drift.
    // The `updated` and `merged` views stay their own calls: those are
    // deliberately computed at the point their input exists.
    const storedBefore = workbenchSettingsStored(existing, hasWorkersAiBinding);
    if (storedBefore.envEmbeddingProvider !== null) {
      const patch =
        typeof body.workbench === "object" && body.workbench !== null
          ? (body.workbench as { embeddingProvider?: unknown })
          : null;
      const storedProvider = existing.embeddingProvider ?? null;
      // Only `workbench.embeddingProvider` can still be malformed here: the flat
      // `body.embeddingProvider` was type-checked into a 400 by the validation
      // block above, so a non-string, non-null value never reaches this line
      // through that half. The `workbench` half is unvalidated until
      // `validateWorkbenchSettingsPatch` runs below, and it is left to that —
      // the pin answers about MOVES, not about shapes, and refusing a malformed
      // patch in this sentence would point the caller at a variable that is not
      // their problem.
      const moves = [body.embeddingProvider, patch?.embeddingProvider].some(
        (value) =>
          value !== undefined &&
          (value === null || typeof value === "string") &&
          embeddingProviderChanged(storedProvider, value ?? null),
      );
      if (moves) {
        return Response.json(
          {
            error: settingsEnvProviderPinRefusalCopy(storedBefore.envEmbeddingProvider),
            // The MACHINE fact beside the human one (DW-628). The browser's
            // recovery — put the three embedding legs back, so the retry is not
            // the identical refused move — used to be triggered by exact-matching
            // this English sentence. ADDITIVE: the sentence is unchanged, and a
            // client that ignores `code` still matches on it. The ONLY refusal on
            // this route that carries a code; nothing else on the wire branches
            // on one, so there is nothing here for a second field to disagree
            // with.
            code: SETTINGS_ENV_PROVIDER_PIN_CODE,
          },
          { status: 400 },
        );
      }
    }

    const updated: AppConfig = { ...existing };

    if (body.provider !== undefined) {
      if (body.provider === null) {
        delete updated.provider;
      } else {
        updated.provider = body.provider as AppConfig["provider"];
      }
    }

    // TRIMMED, like every neighbouring text field (DW-275). `getEffectiveProvider`
    // and the LLM call sites read `cfg.model` back LITERALLY, so a padded id
    // stored here is one the provider never recognises. The whitespace-only case
    // cannot reach the applier's clear arm — the non-empty check above already
    // answered 400 — but the decision is `embeddingModel`'s own, so it stays
    // identical wherever it does become reachable.
    applyFlatTextField(updated, "model", body.model);

    if (body.structuredKnowledgeProvider !== undefined) {
      if (body.structuredKnowledgeProvider === null) {
        delete updated.structuredKnowledgeProvider;
      } else {
        updated.structuredKnowledgeProvider = body.structuredKnowledgeProvider;
      }
    }

    // The delete decided on the TRIMMED value, like `model`, `ollamaBaseUrl` and
    // `embeddingModel` (DW-305). The literal `=== ""` arm this field once had was
    // the one out of four that asked a different question — and an unreachable
    // one at that, since the non-empty check above already answers 400 for `""`
    // and for whitespace. Uniform now by construction, so the day the check above
    // changes shape this field cannot become the odd behaviour out.
    applyFlatTextField(
      updated,
      "structuredKnowledgeModel",
      body.structuredKnowledgeModel,
    );

    // TRIMMED, exactly as `applyWorkbenchSettings`'s `setText` trims the other
    // endpoints (DW-275). The reader trims too since DW-326, so a padded value no
    // longer reaches `fetch` verbatim — but the store should not hold one either:
    // a stored `" http://x "` and a stored `"http://x"` are the same endpoint,
    // and only one of them is what the owner typed. Whitespace-only deletes the
    // key, matching what `""` and `null` already do.
    applyFlatTextField(updated, "ollamaBaseUrl", body.ollamaBaseUrl);

    // TRIMMED, exactly as `applyWorkbenchSettings`'s `setText` already trims for
    // the Workbench path (DW-221). This is the last writer that could still store
    // a padded id — one the vector gate accepts (it reads the value trimmed) and
    // the embed resolver then drops for the provider default. Whitespace-only
    // deletes the key rather than storing blanks.
    applyFlatTextField(updated, "embeddingModel", body.embeddingModel);

    if (body.embeddingProvider !== undefined) {
      // CLEAR ON SWITCH, through the SHARED predicate (DW-69/DW-72). This flat
      // branch is the SECOND writer of `embeddingProvider` — `applyWorkbenchSettings`
      // is the first — and leaving it out would mean the API path went on
      // handing the new vendor the old vendor's secret and endpoint.
      //
      // Measured against `existing`, the store as it was BEFORE this request,
      // and applied to `updated` BEFORE `workbenchSettingsStored(updated, …)` is
      // computed below, so the vector gate judges the CLEARED state: with the
      // switch stored ON and no new key, this refuses 400 rather than silently
      // switching effective vector search off.
      //
      // A body carrying BOTH halves clears once and then no-ops, PROVIDED the
      // two halves name the same provider — which is the only shape any shipped
      // surface produces, since no surface sends the flat field and the
      // `workbench` field with different values. `applyWorkbenchSettings`
      // receives this already-flat-merged `updated`, so by the time it runs
      // `existing.embeddingProvider` — which it reads from its own first
      // argument — is the value this branch just wrote, and its own switch test
      // is correctly `false`.
      //
      // A hand-written body whose two halves DISAGREE
      // (`{embeddingProvider: "google", workbench: {embeddingProvider: "openai"}}`
      // against a store on `openai`) clears here and clears AGAIN in the merge,
      // because each half really is a move. Such a body nets back to `openai`
      // and still ends with the pair gone, which is over-eager rather than
      // wrong: it errs toward deleting a credential rather than toward handing
      // one to a vendor it was not entered for, and that is the safe direction
      // for the only bodies that can reach it.
      if (
        embeddingProviderChanged(
          existing.embeddingProvider ?? null,
          body.embeddingProvider ?? null,
        )
      ) {
        delete updated.embeddingApiKey;
        delete updated.embeddingBaseUrl;
      }
      if (body.embeddingProvider === null) {
        delete updated.embeddingProvider;
      } else {
        updated.embeddingProvider = body.embeddingProvider;
      }
    }

    // Story 1.9's fields, applied AFTER every legacy branch and only when the
    // key is present — a body with no `workbench` produces byte-identically the
    // same saved object it did before this story.
    //
    // The client already disabled the vector control with
    // `canEnableVectorSearch`; re-running the same predicate here, over the
    // config this request is about to write, is what makes FR-56 a RULE rather
    // than a disabled button. `workbenchSettingsStored(updated)` is deliberately
    // the post-legacy-merge object: an `embeddingModel` set by the flat field in
    // this same request counts toward the gate.
    //
    // …which is precisely why the THIRD argument is `storedBefore` — the view of
    // `existing` hoisted above — rather than `updated` (DW-219). The gate now
    // re-runs only when the request MOVES something the rule reads, and that
    // question has to be asked against what the store held BEFORE this request.
    // Handed `updated` for both, a flat `embeddingModel` would already be baked
    // into the "before" picture, compare equal to itself, and skip the gate —
    // silently undoing the promise the paragraph above makes. `updated` stays
    // the MERGE TARGET; `storedBefore` is the BASELINE the move is measured
    // from.
    //
    // ONE rule, BOTH branches (DW-217). The gate used to live inside
    // `if (body.workbench !== undefined)`, so a flat-only body could move
    // `embeddingModel` or `embeddingProvider` into a state
    // `canEnableVectorSearch` rejects, answer 200, and switch effective vector
    // search off without ever saying so — `getVectorSearchSettings()` intersects
    // the stored flag with the same predicate, so the owner's switch simply
    // stopped meaning anything.
    //
    // An EMPTY patch is the reuse point: every field check in
    // `validateWorkbenchSettingsPatch` `continue`s on `undefined`, so `{}` falls
    // straight through to the vector rule with `enabled = stored.vectorSearchEnabled`
    // (the flat branch cannot move that flag, so `turningOn` is always `false`
    // here) and fires purely on `!vectorInputsEqual(current, merged)` — exactly
    // "this flat request moved something the rule reads". No second copy of the
    // rule, and no second copy of the refusal sentence.
    //
    // ONE question, asked ONCE: the same fact decides which patch is validated
    // and whether the patch is APPLIED, and the two readings are inverses of
    // each other. Written twice they could drift into validating `{}` and then
    // applying it, or validating a patch and then dropping it.
    //
    // …and the FOURTH argument is decided by that same one fact, for the same
    // reason (DW-303). A body carrying a `workbench` key came from a surface
    // that renders every embedding control, so any leg it is refused over is one
    // the owner can go and fix — `undefined` is "scope nothing". A flat-only
    // body came from `/settings`, which renders no embedding provider, endpoint
    // or key at all, so being refused over those legs leaves the owner nothing
    // to do; `flatMovableVectorLegs` narrows WHETHER the gate refuses at all —
    // to requests naming a leg this body could have moved, while a
    // configuration this request BROKE still refuses over any leg at all.
    //
    // …and its PRESENCE, separately, picks the switched-on frame's ACTION CLAUSE
    // (DW-329). The same fact, read a fourth time: a scoped argument means the
    // flat page asked, and that page renders no vector switch, so the sentence
    // ends by naming where the switch lives rather than telling the owner to
    // turn off something they cannot see. WHICH wording, never whether.
    //
    // There is no longer a second FRAME for it to choose against (DW-330): the
    // gate frames from the flag the REQUEST carries, which is `true` for every
    // refusal it can reach, so `vectorSearchInactiveCopy` is the only sentence
    // this route sends. "…before it can be turned on" is the browser's hint
    // beside an UNTICKED box and nothing this route can answer with. The THIRD
    // argument's stored flag still decides WHETHER, and no longer which.
    //
    // Four readings of one fact, all written from the same expression so they
    // cannot drift into scoping a patch that was never applied, or into
    // pointing a sentence at the surface that did not send the request.
    const hasWorkbenchKey = body.workbench !== undefined;
    const validation = validateWorkbenchSettingsPatch(
      hasWorkbenchKey ? body.workbench : {},
      workbenchSettingsStored(updated, hasWorkersAiBinding),
      storedBefore,
      hasWorkbenchKey ? undefined : flatMovableVectorLegs(body),
    );
    if (!validation.ok) {
      // Nothing is written: the refusal happens before `saveConfig`, so a
      // rejected vector switch leaves the store exactly as it was.
      return Response.json({ error: validation.error }, { status: 400 });
    }
    // `applyWorkbenchSettings` stays conditional on the KEY: a body with no
    // `workbench` that passes the gate saves the byte-identical object it did
    // before, so validating everything changed no legacy save's outcome.
    const merged = hasWorkbenchKey
      ? applyWorkbenchSettings(updated, validation.patch)
      : updated;

    // The version of what the store now HOLDS, from the one place that decides
    // it. `saveConfig` stamps the token inside the object it writes and returns
    // what it stamped — so there is nothing to predict and nothing to read back.
    // It also re-primes the sync cache with what it wrote, so the response below
    // and any immediate LLM request use the newly selected provider rather than
    // falling back to env detection.
    //
    // THE ETAG READ ABOVE GOES WITH IT (DW-272). The `If-Match` check upstream
    // compares the OWNER'S draft token against the store and catches a draft
    // seeded before someone else's save. It cannot catch a save that lands
    // between this request's read and this write — the read-modify-write window
    // inside one request — and that save would be silently overwritten by the
    // merge base read a moment before it. `writeFileIfMatch` refuses instead,
    // and a refused write leaves the other writer's value standing.
    //
    // The SAME sentence and the SAME status as the upstream check: to the owner
    // it is one fact — something else changed this while you were editing — and
    // two wordings for it would be two sentences to keep in step.
    const save = await saveConfig(merged, read.etag);
    if (save.status === "conflict") {
      return Response.json(
        { error: WRITE_CONFLICT_COPY },
        { status: WRITE_CONFLICT_STATUS },
      );
    }
    const version = save.version;

    const wasOff = storedBefore.vectorSearchEnabled !== true;
    const nowOn = workbenchSettingsStored(merged, hasWorkersAiBinding).vectorSearchEnabled === true;
    if (wasOff && nowOn) {
      const { enqueueEmbeddingBackfill } = await import("@/lib/ingest-embed");
      await enqueueEmbeddingBackfill(ownerTenantHandle(principal));
    }

    // Hoisted above BOTH resolvers, the way `GET` hoists it, and for the reason
    // stated there: an `await` between the reads that compose one response is a
    // window in which the config cache can expire.
    const inbound = await inboundEmail();
    // Return updated effective settings — RE-SEEDED FROM WHAT WAS JUST WRITTEN
    // (DW-620). `merged` is the merge base `saveConfig` was just handed: that
    // function strips its two reserved keys into a `stored` object of its own
    // before persisting and caching it, so this is not byte-identical to what
    // landed — but it IS the generation that landed, which is the whole of what
    // both halves of this response have to agree about. Reading the 5 s-TTL
    // cache again could answer them about a config this save superseded.
    const effective = getEffectiveProvider(merged);
    return Response.json({
      saved: true,
      effective,
      version,
      // The fresh stored values, so a landed save re-seeds the surface's draft
      // from what the kernel actually holds rather than from what was sent.
      workbench: {
        ...getWorkbenchSettings(hasWorkersAiBinding, inbound, merged),
        version,
      },
    });
  } catch (err) {
    const message = getErrorMessage(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
