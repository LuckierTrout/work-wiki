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
import {
  SETTINGS_INVALID_URL_COPY,
  flatMovableVectorLegs,
  isAbsoluteHttpUrl,
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
import {
  PROVIDER_INFO,
  EMBEDDING_PROVIDERS,
  isEmbeddingProvider,
} from "@/lib/providers";
import { getErrorMessage } from "@/lib/errors";
import { getPrincipal } from "@/lib/auth";
import { isOwnerHandle } from "@/lib/owner";
import {
  IF_MATCH_HEADER,
  checkWritePrecondition,
} from "@/lib/write-precondition";

async function requireOwner() {
  const principal = await getPrincipal();
  return principal && isOwnerHandle(principal.handle) ? principal : null;
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
  const settings = getEffectiveSettings();
  // ONE precondition, served twice (DW-63). Both Settings surfaces write the
  // same `AppConfig` through the same `PUT`, so both need the same one —
  // `/settings` reads the top-level field through `useSettings`, the Workbench
  // canvas reads it off the `workbench` object it already seeds its draft from.
  // Two derivations here would be two expressions that agree today.
  //
  // IT IS AN OPAQUE STAMP, NOT A HASH OF THE CONFIG (DW-198). `saveConfig`
  // generates it from randomness and stores it in a sibling file; nothing in
  // `.llm-wiki-config.json` contributes to it. That is what keeps the sentence
  // below true: this response carries no secret material and no function of
  // any, where a content-derived version was a value computed over
  // `firecrawlApiKey`, `customApiKey` and `embeddingApiKey`. It also means a
  // hand-edited config re-serialized in another key order is not a conflict
  // with itself — nothing about the bytes is read at all.
  const version = read.version;
  // Read ONCE and handed to the resolver: `workers-ai` is self-transporting
  // through this binding, so off Workers the vector switch must refuse rather
  // than turn on for a deployment that would embed nothing (DW-225). The browser
  // has no way to ask, so the answer rides on the payload.
  const hasWorkersAiBinding = getWorkersAiBinding() !== null;
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
    workbench: { ...getWorkbenchSettings(hasWorkersAiBinding), version },
  });
}

// ---------------------------------------------------------------------------
// PUT /api/settings — update the config file
// ---------------------------------------------------------------------------

export async function PUT(request: Request) {
  if (!(await requireOwner())) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Optional deployment-wide kill switch. Cloud storage itself is writable;
  // credentials still remain server secrets and never pass through this API.
  if (isReadOnly()) {
    return Response.json(
      { error: "Settings are read-only in this deployment." },
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
      // `"not-a-url"`, `"/api"` or `file:///etc/passwd` landed in the config and
      // `getOllamaBaseUrl()` — which reads the stored value literally — handed it
      // to the provider SDK.
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
    // The version is the STORED STAMP read alongside the config, not a hash of
    // it (DW-198): `saveConfig` rotates it on every landed write, so a draft
    // seeded before someone else's save holds a token the store no longer has.
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

    const updated: AppConfig = { ...existing };

    if (body.provider !== undefined) {
      if (body.provider === null) {
        delete updated.provider;
      } else {
        updated.provider = body.provider as AppConfig["provider"];
      }
    }

    if (body.model !== undefined) {
      // TRIMMED, like every neighbouring text field (DW-275). `getEffectiveProvider`
      // and the LLM call sites read `cfg.model` back LITERALLY, so a padded id
      // stored here is one the provider never recognises. The whitespace-only
      // case cannot reach this branch — the non-empty check above already
      // answered 400 — but the shape stays `embeddingModel`'s so the delete is
      // decided identically wherever it does become reachable.
      const trimmed = typeof body.model === "string" ? body.model.trim() : "";
      if (body.model === null || trimmed.length === 0) {
        delete updated.model;
      } else {
        updated.model = trimmed;
      }
    }

    if (body.structuredKnowledgeProvider !== undefined) {
      if (body.structuredKnowledgeProvider === null) {
        delete updated.structuredKnowledgeProvider;
      } else {
        updated.structuredKnowledgeProvider = body.structuredKnowledgeProvider;
      }
    }

    if (body.structuredKnowledgeModel !== undefined) {
      // The delete decided on `trimmed`, like `model`, `ollamaBaseUrl` and
      // `embeddingModel` (DW-305). The literal `=== ""` arm this replaces was
      // the one field out of four that asked a different question — and an
      // unreachable one at that, since the non-empty check above already answers
      // 400 for `""` and for whitespace. Uniform now, so the day the check above
      // changes shape this branch does not become the odd behaviour out.
      //
      // The `typeof` ternary is belt-and-braces: a non-string was refused above
      // and must never be what turns a malformed body into a delete.
      const trimmed =
        typeof body.structuredKnowledgeModel === "string"
          ? body.structuredKnowledgeModel.trim()
          : "";
      if (body.structuredKnowledgeModel === null || trimmed.length === 0) {
        delete updated.structuredKnowledgeModel;
      } else {
        updated.structuredKnowledgeModel = trimmed;
      }
    }

    if (body.ollamaBaseUrl !== undefined) {
      // TRIMMED, exactly as `applyWorkbenchSettings`'s `setText` trims the other
      // endpoints (DW-275). `getOllamaBaseUrl()` reads `cfg.ollamaBaseUrl` back
      // with no trim of its own and hands it straight to `fetch`, so a padded
      // value stored here is a URL the reader takes LITERALLY. Whitespace-only
      // deletes the key, matching what `""` and `null` already do — the type
      // check above refused a non-string, so the `typeof` ternary is
      // belt-and-braces and must never be what turns a malformed body into a
      // delete.
      const trimmed =
        typeof body.ollamaBaseUrl === "string" ? body.ollamaBaseUrl.trim() : "";
      if (body.ollamaBaseUrl === null || trimmed.length === 0) {
        delete updated.ollamaBaseUrl;
      } else {
        updated.ollamaBaseUrl = trimmed;
      }
    }

    if (body.embeddingModel !== undefined) {
      // TRIMMED, exactly as `applyWorkbenchSettings`'s `setText` already trims
      // for the Workbench path (DW-221). This is the last writer that could
      // still store a padded id — one the vector gate accepts (it reads the
      // value trimmed) and the embed resolver then drops for the provider
      // default. Whitespace-only deletes the key rather than storing blanks.
      //
      // A non-string was refused with 400 above, so the `typeof` ternary is
      // belt-and-braces: it must never be the thing that turns a malformed body
      // into a delete.
      const trimmed =
        typeof body.embeddingModel === "string" ? body.embeddingModel.trim() : "";
      if (body.embeddingModel === null || trimmed.length === 0) {
        delete updated.embeddingModel;
      } else {
        updated.embeddingModel = trimmed;
      }
    }

    if (body.embeddingProvider !== undefined) {
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
    // …which is precisely why the THIRD argument is `existing` rather than
    // `updated` (DW-219). The gate now re-runs only when the request MOVES
    // something the rule reads, and that question has to be asked against what
    // the store held BEFORE this request. Handed `updated` for both, a flat
    // `embeddingModel` would already be baked into the "before" picture, compare
    // equal to itself, and skip the gate — silently undoing the promise the
    // paragraph above makes. `updated` stays the MERGE TARGET; `existing` is the
    // BASELINE the move is measured from.
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
    // …and its PRESENCE, separately, picks the switched-on FRAME (DW-329). The
    // same fact, read a fourth time: a scoped argument means the flat page
    // asked, and that page renders no vector switch, so the sentence ends by
    // naming where the switch lives rather than telling the owner to turn off
    // something they cannot see. WHICH sentence, never whether — and only for a
    // switch already stored ON, since the THIRD argument's stored flag still
    // decides that: a request turning the switch on reads "…before it can be
    // turned on" on both surfaces, one against a switch already stored ON reads
    // the switched-on frame (DW-308) in this surface's wording.
    //
    // Four readings of one fact, all written from the same expression so they
    // cannot drift into scoping a patch that was never applied, or into
    // pointing a sentence at the surface that did not send the request.
    const hasWorkbenchKey = body.workbench !== undefined;
    const validation = validateWorkbenchSettingsPatch(
      hasWorkbenchKey ? body.workbench : {},
      workbenchSettingsStored(updated, hasWorkersAiBinding),
      workbenchSettingsStored(existing, hasWorkersAiBinding),
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
    // it. `saveConfig` generates the token, writes it, then writes the config,
    // and returns what it stamped — so there is nothing to predict and nothing
    // to read back. It also re-primes the sync cache with what it wrote, so the
    // response below and any immediate LLM request use the newly selected
    // provider rather than falling back to env detection.
    const version = await saveConfig(merged);

    // Return updated effective settings
    const effective = getEffectiveProvider();
    return Response.json({
      saved: true,
      effective,
      version,
      // The fresh stored values, so a landed save re-seeds the surface's draft
      // from what the kernel actually holds rather than from what was sent.
      workbench: { ...getWorkbenchSettings(hasWorkersAiBinding), version },
    });
  } catch (err) {
    const message = getErrorMessage(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
