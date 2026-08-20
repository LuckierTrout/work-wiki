"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";
import { EMBEDDING_PROVIDERS, PROVIDER_INFO, embeddingProviderLabel } from "@/lib/providers";
import {
  SETTINGS_CUSTOM_ENDPOINT_COPY,
  SETTINGS_FIRECRAWL_COPY,
  SETTINGS_GENERAL_SCHEMA_COPY,
  SETTINGS_KEY_ABSENT_COPY,
  SETTINGS_KEY_PLACEHOLDER,
  SETTINGS_KEY_REMOVE_COPY,
  SETTINGS_KEY_REMOVE_PENDING_COPY,
  SETTINGS_KEY_STORED_COPY,
  SETTINGS_KEY_UNDO_COPY,
  SETTINGS_LANGUAGE_COPY,
  SETTINGS_LANGUAGE_LABEL,
  SETTINGS_LOADING_COPY,
  SETTINGS_LOAD_FAILED_COPY,
  SETTINGS_MODEL_INHERIT_COPY,
  SETTINGS_READ_ONLY_COPY,
  SETTINGS_SAVED_COPY,
  SETTINGS_SAVE_BAR_COPY,
  SETTINGS_SAVE_COPY,
  SETTINGS_SAVING_COPY,
  SETTINGS_TIMEOUT_HINT_COPY,
  SETTINGS_VECTOR_HINT_COPY,
  SETTINGS_VECTOR_PROVIDER_COPY,
  SETTINGS_TIMEOUT_REASON,
  SECRET_UNTOUCHED,
  draftCanEnableVectorSearch,
  draftVectorInputs,
  fetchWorkbenchSettings,
  saveWorkbenchSettings,
  settingsCategory,
  settingsDirty,
  settingsDraftFromPayload,
  settingsEnvKeyCopy,
  settingsEnvOverrideCopy,
  settingsSaveBody,
  vectorSearchMissingCopy,
  vectorSearchModelIssue,
  type SettingsCategoryId,
  type SettingsDraft,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";
import { CANVAS_ID } from "./ModeCanvas";

/**
 * The Settings detail column — the canvas while the Settings surface is open.
 *
 * It owns the READ, the DRAFT and the ONE save, and nothing else does. That is
 * the whole shape of "unsaved edits do not apply and are discarded on leave"
 * (`epic-1-context.md:53`): the draft lives in this component, so leaving the
 * surface UNMOUNTS it and the edits are gone without a diff, a prompt or a
 * second store. Nothing here writes to durable browser storage either — a
 * reload must not land the owner in Settings, and `workbench-state.ts`'s durable
 * set is mode, tab, selection, collapse and widths.
 *
 * Every decision it makes is a pure function in `@/lib/workbench-settings`: the
 * category vocabulary, every sentence, the draft/dirty rules, the save-body
 * builder and the vector predicate. `vitest.config.ts` is `environment: "node"`,
 * so a rule typed into the JSX below could only ever be grepped for — and "what
 * does Save actually send" is exactly the kind of rule a rewrite keeps the
 * wording of while changing the behaviour. This file makes no request of its
 * own at all: both the read and the write live in that module, where a stubbed
 * `fetchImpl` drives them without a socket.
 *
 * It takes {@link CANVAS_ID} and `tabIndex={-1}` from `ModeCanvas` while it is
 * open, so the skip link keeps exactly one target and the id stays unique — the
 * shell renders one canvas or the other, never both.
 *
 * The surface is owner-gated by the same route that stores the bytes: this
 * component never decides who may save, it relays a 403/404 as copy.
 */

/**
 * A request that never settles would leave a busy flag true for the rest of the
 * session with no error to explain it. `finally` cannot rescue a promise that
 * never resolves, so the deadline is the rescue — the idiom `PreviewColumn` and
 * `WikiSwitcher` already use for the same reason.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export interface SettingsCanvasProps {
  category: SettingsCategoryId;
  /** The shell's id for the surface heading, so `aria-labelledby` has a target. */
  headingId: string;
}

export function SettingsCanvas({ category, headingId }: SettingsCanvasProps) {
  const [payload, setPayload] = useState<WorkbenchSettingsPayload | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  // Read from the save callback without taking a dependency on it — the
  // `useDialogA11y` idiom the Preview column already follows. Synced in an
  // EFFECT, not during render: a render that React discards (StrictMode's
  // double invocation, or a concurrent render that never commits) would
  // otherwise leave the ref holding a draft the screen never showed. `save`
  // runs from a click, which is always after the commit that set this.
  const draftRef = useRef<SettingsDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  // The STORED payload the draft was seeded from, readable from `save` for the
  // one field the draft does not carry: the write precondition (DW-63). Mirrored
  // the same way and for the same reason as `draftRef` above — `save` must not
  // take a dependency on the payload, and a render React discards must not leave
  // a version behind that the screen never showed.
  //
  // Re-derived at Save it would be worthless: the point of the precondition is
  // that it describes the config the owner's draft was seeded from, and the
  // existing `setPayload(result.payload)` re-seed is what carries the NEXT one
  // forward after a landed save.
  const payloadRef = useRef<WorkbenchSettingsPayload | null>(null);
  useEffect(() => {
    payloadRef.current = payload;
  }, [payload]);
  const fieldId = useId();

  // ONE read, on mount. The surface is not refetched on a category change: the
  // categories are views over the same one payload, and refetching would throw
  // away the owner's unsaved edits every time they looked at another section.
  useEffect(() => {
    const controller = new AbortController();
    // The deadline is armed with its own REASON so one controller can carry both
    // ways to stop: the surface unmounting, and the request taking too long.
    // They are NOT the same outcome — an unmount has nobody to tell, while a
    // deadline means nothing else is coming, so it must clear `loading` and say
    // so. Aborting without a reason made every abort read as "superseded", which
    // left a hung read showing `Loading…` for the rest of the session: exactly
    // the state the deadline exists to prevent. `fetchWorkbenchSettings` tells
    // them apart by the reason passed here.
    const deadline = setTimeout(
      () => controller.abort(SETTINGS_TIMEOUT_REASON),
      REQUEST_TIMEOUT_MS,
    );
    void fetchWorkbenchSettings({ signal: controller.signal }).then((result) => {
      if (result.status === "stale") return;
      if (result.status === "ok") {
        setPayload(result.payload);
        setDraft(settingsDraftFromPayload(result.payload));
        setFailed(false);
      } else {
        setFailed(true);
      }
      setLoading(false);
    });
    return () => {
      clearTimeout(deadline);
      controller.abort();
    };
  }, []);

  const save = useCallback(async () => {
    const current = draftRef.current;
    if (!current || saving) return;
    setSaving(true);
    setSaveError(null);
    setStatus("");
    // The body is built by a pure function the suite executes, so "an untouched
    // key field is omitted entirely" is a property something can run rather than
    // a condition typed here.
    const result = await saveWorkbenchSettings(settingsSaveBody(current), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      version: payloadRef.current?.version,
    });
    setSaving(false);
    if (result.status === "ok") {
      // Re-seeded from the STORED values the route answered with, not from what
      // was sent: a trimmed URL or a rejected-then-defaulted field must show
      // what the kernel actually holds. This is also what clears `dirty`.
      //
      // …INCLUDING the version, which the answered payload may now legitimately
      // omit (DW-199). A save that answered NO version CLEARS it rather than
      // keeping the old one — the convention `PreviewColumn` already spells for
      // the same seam. What this surface knows at that point is "the current
      // version is unknown", and the next save saying so (428, "could not be
      // checked") is truthful, where the kept one would be a version this very
      // save definitively superseded: it can only ever be refused, and it would
      // be refused with 412's "somebody else changed this while you were
      // editing" — a sentence about an actor that does not exist. Neither
      // answer can clobber, so the tie is broken on which refusal tells the
      // owner the truth.
      setPayload(result.payload);
      setDraft(settingsDraftFromPayload(result.payload));
      setStatus(SETTINGS_SAVED_COPY);
    } else {
      // Every edit stays on screen — a refused save must never be the thing
      // that loses it — and the SERVER's sentence is shown, never a transport's.
      setSaveError(result.message);
    }
  }, [saving]);

  const surface = settingsCategory(category);

  if (loading) {
    return (
      <Frame headingId={headingId} title={surface.label}>
        <p className="wb-empty">{SETTINGS_LOADING_COPY}</p>
      </Frame>
    );
  }

  if (failed || !payload || !draft) {
    return (
      <Frame headingId={headingId} title={surface.label}>
        <p className="wb-empty" role="alert">
          {SETTINGS_LOAD_FAILED_COPY}
        </p>
      </Frame>
    );
  }

  // Locals captured AFTER the guards above, so the nested builders below read a
  // value TypeScript has already narrowed rather than re-asserting it at every
  // field.
  const values: SettingsDraft = draft;
  const stored: WorkbenchSettingsPayload = payload;

  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setStatus("");
    // The refusal described the values that were SENT, so it stops being true
    // the moment the owner starts fixing the field it named — leaving it beside
    // Save would have them reading "needs an API key" while typing one.
    setSaveError(null);
  };

  const dirty = settingsDirty(draft, payload);
  const vectorInputs = draftVectorInputs(draft, payload);
  const vectorAllowed = draftCanEnableVectorSearch(draft, payload);
  const vectorBlocked = vectorSearchMissingCopy(vectorInputs);
  // What the embedding-model INPUT has to say about itself (DW-223). The
  // refusal used to be announced only as the checkbox's description, while the
  // box holding the wrong value carried nothing — and the ordinary way into that
  // state is changing the provider select, which touches neither control.
  const vectorModelIssue = vectorSearchModelIssue(vectorInputs);
  // The vector switch's WHOLE refusal predicate, named once so the attribute
  // that announces it and the handler that enforces it cannot drift into
  // disagreeing about when the toggle is refused. Turning it OFF is always
  // allowed — an owner must be able to undo a switch whose legs have since
  // gone missing — which is what the `!values.vectorSearchEnabled` term says.
  const vectorRefused =
    stored.readOnly || (!vectorAllowed && !values.vectorSearchEnabled);
  // Named only when the SELECTED provider is one the environment already
  // carries a key for — an `OPENAI_API_KEY` says nothing about a Google
  // selection, which is exactly the confusion a flat "a key is present" caused.
  const envKeyProvider =
    vectorInputs.provider &&
    stored.envEmbeddingApiKeyProviders.includes(vectorInputs.provider)
      ? embeddingProviderLabel(vectorInputs.provider)
      : null;

  function field(suffix: string): string {
    return `${fieldId}-${suffix}`;
  }

  /** The save bar's standing sentence, which on a read-only deployment IS the
   *  refusal — see `describedBy`. */
  const readOnlyNoteId = field("bar-note");

  /**
   * `aria-describedby` for a control this deployment may refuse. The attribute
   * takes a space-separated LIST, so the save bar's read-only sentence is
   * APPENDED to the control's own hint rather than replacing it: the hint still
   * says what the field means, and the appended sentence is the only place the
   * refusal is stated at all. Without it `SETTINGS_READ_ONLY_COPY` sits
   * unassociated in the save bar and the picker announces as "dimmed" with no
   * reason — the same gap `aria-disabled` was adopted to close.
   */
  function describedBy(hintId: string): string {
    return stored.readOnly ? `${hintId} ${readOnlyNoteId}` : hintId;
  }

  /**
   * @param invalid Marks the control `aria-invalid` — reserved for a box whose
   *   OWN value is the thing being complained about. A complaint the owner
   *   cannot fix from this box (an `EMBEDDING_MODEL` override, say) is described
   *   without being marked, because marking it is a dead end.
   */
  function textRow(
    key: "chatModel" | "ingestModel" | "customBaseUrl" | "embeddingModel" | "embeddingBaseUrl" | "firecrawlBaseUrl" | "llmTimeoutSeconds",
    label: string,
    hint?: string,
    invalid?: boolean,
  ) {
    const id = field(key);
    const hintId = `${id}-hint`;
    return (
      <p className="wb-set-row">
        {/* Labelled beyond the placeholder — the accessibility floor's own rule. */}
        <label className="wb-set-label" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          className="wb-set-input"
          type="text"
          value={values[key]}
          onChange={(event) => set(key, event.target.value)}
          spellCheck={false}
          readOnly={stored.readOnly}
          // A range printed beside a box is invisible to a screen reader; the
          // accepted values have to be part of the control's own description.
          aria-describedby={hint ? hintId : undefined}
          // Only when this box holds the wrong value — see the parameter's note.
          // NEVER on a read-only deployment: the same rule that leaves an
          // env-owned mismatch described-but-unmarked applies whole here, since
          // `YOPEDIA_READONLY` makes every box unfixable. The DESCRIPTION still
          // rides, so the reason is announced; only the "this field is wrong,
          // fix it" mark is withheld, because there is nothing to fix it with.
          aria-invalid={(invalid && !stored.readOnly) || undefined}
        />
        {hint && (
          <span className="wb-set-hint" id={hintId}>
            {hint}
          </span>
        )}
      </p>
    );
  }

  function providerRow(
    key: "chatProvider" | "ingestProvider",
    label: string,
  ) {
    const id = field(key);
    const hintId = `${id}-hint`;
    return (
      <p className="wb-set-row">
        <label className="wb-set-label" htmlFor={id}>
          {label}
        </label>
        <select
          id={id}
          className="wb-set-select"
          value={values[key]}
          // `aria-disabled`, never `disabled`: a disabled <select> leaves the
          // tab order, so a keyboard user cannot reach it and cannot read which
          // provider this deployment is running on. Read-only means read-only,
          // not hidden — the same rule the text rows already follow with
          // `readOnly` (which <select> has no equivalent of). Committing
          // nothing is the whole refusal, and React re-applies the controlled
          // value to the DOM by itself — `WikiSwitcherProps.readOnly` owns the
          // full explanation of the convention these three controls share.
          aria-disabled={stored.readOnly || undefined}
          onChange={(event) => {
            if (stored.readOnly) return;
            set(key, event.target.value);
          }}
          // What the empty option MEANS is not in the label; a hint sitting
          // beside the control is invisible to a screen reader.
          aria-describedby={describedBy(hintId)}
        >
          {/* The empty option is the inheritance rung, not a blank provider. */}
          <option value="">Inherit the primary provider</option>
          {PROVIDER_INFO.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="wb-set-hint" id={hintId}>
          {SETTINGS_MODEL_INHERIT_COPY}
        </span>
      </p>
    );
  }

  function secretRow(
    key: "customApiKey" | "embeddingApiKey" | "firecrawlApiKey",
    label: string,
    hasStoredKey: boolean,
    extraHint?: string,
  ) {
    const id = field(key);
    const hintId = `${id}-hint`;
    const value = values[key];
    const removing = value === null;
    return (
      <p className="wb-set-row">
        <label className="wb-set-label" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          className="wb-set-input"
          type="password"
          // NEVER a stored key: `GET` answers a presence boolean and nothing
          // else, so there is no stored value in this component to render.
          value={removing ? "" : value}
          placeholder={SETTINGS_KEY_PLACEHOLDER}
          onChange={(event) => set(key, event.target.value)}
          autoComplete="off"
          spellCheck={false}
          readOnly={stored.readOnly || removing}
          // For a field that shows nothing, the hint IS the state: "a key is
          // stored" is the only thing distinguishing it from an empty one.
          aria-describedby={hintId}
        />
        <span className="wb-set-hint" id={hintId}>
          {removing
            ? SETTINGS_KEY_REMOVE_PENDING_COPY
            : hasStoredKey
              ? SETTINGS_KEY_STORED_COPY
              : SETTINGS_KEY_ABSENT_COPY}
          {extraHint ? ` ${extraHint}` : ""}
        </span>
        {hasStoredKey && !stored.readOnly && (
          // The third state. A password field that shows nothing cannot tell
          // "leave it alone" from "delete it", so removal is its own decision.
          <button
            type="button"
            className="wb-set-action"
            onClick={() => set(key, removing ? SECRET_UNTOUCHED : null)}
          >
            {removing ? SETTINGS_KEY_UNDO_COPY : SETTINGS_KEY_REMOVE_COPY}
          </button>
        )}
      </p>
    );
  }

  function detail() {
    if (surface.pending) {
      // Listed, not required to function: one muted sentence, no controls.
      return <p className="wb-empty">{surface.pending}</p>;
    }
    switch (category) {
      case "general":
        // Points at the Schema editor and writes nothing (Story 1.8 shipped the
        // ONE confirm-gated editor; `purpose.md` stays shut per DW-58).
        return <p className="wb-set-note">{SETTINGS_GENERAL_SCHEMA_COPY}</p>;
      case "llm-models":
        return (
          <>
            <h3 className="wb-set-heading">Chat</h3>
            {providerRow("chatProvider", "Chat provider")}
            {textRow("chatModel", "Chat model")}
            <h3 className="wb-set-heading">Ingest</h3>
            {providerRow("ingestProvider", "Ingest provider")}
            {textRow("ingestModel", "Ingest model")}
            <h3 className="wb-set-heading">Custom endpoint</h3>
            <p className="wb-set-note">{SETTINGS_CUSTOM_ENDPOINT_COPY}</p>
            {textRow("customBaseUrl", "Custom base URL")}
            {secretRow("customApiKey", "Custom API key", stored.hasCustomApiKey)}
            <h3 className="wb-set-heading">Timeout</h3>
            {textRow("llmTimeoutSeconds", "LLM timeout (seconds)", SETTINGS_TIMEOUT_HINT_COPY)}
          </>
        );
      case "embeddings":
        return (
          <>
            <p className="wb-set-row">
              <label className="wb-set-label" htmlFor={field("embeddingProvider")}>
                Embedding provider
              </label>
              <select
                id={field("embeddingProvider")}
                className="wb-set-select"
                value={values.embeddingProvider}
                // Same convention as `providerRow`, same reason: focusable and
                // readable on a read-only deployment.
                aria-disabled={stored.readOnly || undefined}
                onChange={(event) => {
                  if (stored.readOnly) return;
                  set("embeddingProvider", event.target.value);
                }}
                aria-describedby={describedBy(field("embeddingProvider-hint"))}
              >
                <option value="">Auto-detect</option>
                {EMBEDDING_PROVIDERS.map((option) => (
                  <option key={option} value={option}>
                    {embeddingProviderLabel(option)}
                  </option>
                ))}
              </select>
              {/* Auto-detect is fine for embeddings themselves; it is not enough
                  for the vector switch, which needs to know WHICH provider it is
                  turning on. */}
              <span className="wb-set-hint" id={field("embeddingProvider-hint")}>
                {stored.envEmbeddingProvider
                  ? settingsEnvOverrideCopy("provider", stored.envEmbeddingProvider)
                  : SETTINGS_VECTOR_PROVIDER_COPY}
              </span>
            </p>
            {/* ONE embedding model, writing the EXISTING config key. A second
                embedding-model field anywhere is the fork this rule prevents.
                An env override is SAID rather than shown in the box: the box
                edits the store, and the store is what applies once the variable
                is unset. Without the sentence this reads as an empty field
                beside a vector switch that is somehow already satisfied. */}
            {textRow(
              "embeddingModel",
              "Embedding model",
              // The env sentence first (where the value comes from), then the
              // gate's complaint about it (what is wrong with it). Both are the
              // control's OWN description, so a screen reader reads them on the
              // field rather than leaving the complaint on a checkbox three rows
              // down.
              [
                stored.envEmbeddingModel
                  ? settingsEnvOverrideCopy("model", stored.envEmbeddingModel)
                  : null,
                vectorModelIssue?.copy ?? null,
              ]
                .filter((part): part is string => part !== null)
                .join(" ") || undefined,
              vectorModelIssue?.invalid,
            )}
            {textRow("embeddingBaseUrl", "Embedding endpoint")}
            {secretRow(
              "embeddingApiKey",
              "Embedding API key",
              stored.hasEmbeddingApiKey,
              envKeyProvider ? settingsEnvKeyCopy(envKeyProvider) : undefined,
            )}
            <p className="wb-set-row">
              <label className="wb-set-check" htmlFor={field("vectorSearchEnabled")}>
                <input
                  id={field("vectorSearchEnabled")}
                  type="checkbox"
                  checked={values.vectorSearchEnabled}
                  // The SAME predicate the route re-runs over the merged config.
                  // Two callers, one rule — the control is not the rule.
                  //
                  // `aria-disabled` over BOTH halves of that predicate, not just
                  // the read-only one: the hint below is wired as this control's
                  // `aria-describedby` precisely so the reason travels with it,
                  // and a `disabled` control is not focusable, so that
                  // description was never announced. The attribute is what makes
                  // the comment below true rather than aspirational.
                  aria-disabled={vectorRefused || undefined}
                  onChange={(event) => {
                    if (vectorRefused) return;
                    set("vectorSearchEnabled", event.target.checked);
                  }}
                  // A refused control with the reason sitting beside it tells a
                  // screen-reader user nothing; the reason has to BE the
                  // description.
                  aria-describedby={describedBy(field("vectorSearchEnabled-hint"))}
                />
                Enable vector search
              </label>
              <span className="wb-set-hint" id={field("vectorSearchEnabled-hint")}>
                {/* Names the legs the SELECTED provider is missing — Ollama and
                    Workers AI carry their own transport, so demanding a key from
                    either would send the owner after a credential that does not
                    exist. */}
                {vectorAllowed ? SETTINGS_VECTOR_HINT_COPY : vectorBlocked}
              </span>
            </p>
          </>
        );
      case "external-sources":
        return (
          <>
            <p className="wb-set-note">{SETTINGS_FIRECRAWL_COPY}</p>
            {textRow("firecrawlBaseUrl", "Firecrawl base URL")}
            {secretRow(
              "firecrawlApiKey",
              "Firecrawl API key",
              stored.hasFirecrawlApiKey,
            )}
          </>
        );
      case "interface":
        // Language reads English with NO picker, and no other locale is offered
        // anywhere in this surface (`epic-1-context.md:29`).
        return (
          <>
            <p className="wb-set-row">
              <span className="wb-set-label">{SETTINGS_LANGUAGE_LABEL}</span>
              <span className="wb-set-static">{stored.language}</span>
            </p>
            <p className="wb-set-note">{SETTINGS_LANGUAGE_COPY}</p>
          </>
        );
      case "about":
        return (
          <>
            <p className="wb-set-row">
              <span className="wb-set-label">Product</span>
              <span className="wb-set-static">{APP_NAME}</span>
            </p>
            <p className="wb-set-note">{APP_TAGLINE}</p>
          </>
        );
      default:
        return null;
    }
  }

  return (
    <Frame headingId={headingId} title={surface.label}>
      <div className="wb-set-detail">{detail()}</div>

      {/* The sticky save bar (UX-DR14). Its standing sentence is what makes
          "unsaved edits do not apply" a promise the surface keeps rather than a
          behaviour the owner has to discover. */}
      <div className="wb-set-bar">
        {/* Identified so the refused controls above can point at it: on a
            read-only deployment this sentence is the reason they refuse, and an
            `aria-disabled` control with no description announces only "dimmed". */}
        <span className="wb-set-bar-note" id={readOnlyNoteId}>
          {payload.readOnly ? SETTINGS_READ_ONLY_COPY : SETTINGS_SAVE_BAR_COPY}
        </span>
        {saveError && (
          <span role="alert" className="wb-set-error">
            {saveError}
          </span>
        )}
        {/* Polite, so a landed save never interrupts an in-progress
            announcement — and VISIBLE, because "the save landed" is a sighted
            owner's confirmation too. A disabled Save button is an absence, not
            a sentence. */}
        <span className="wb-set-status" aria-live="polite">
          {status}
        </span>
        <button
          type="button"
          className="wb-set-save"
          onClick={() => void save()}
          disabled={saving || payload.readOnly || !dirty}
        >
          {saving ? SETTINGS_SAVING_COPY : SETTINGS_SAVE_COPY}
        </button>
      </div>
    </Frame>
  );
}

/**
 * The canvas element itself, shared by all three states.
 *
 * It carries {@link CANVAS_ID} and `tabIndex={-1}` because the Settings surface
 * REPLACES `ModeCanvas` while it is open — the skip link points at one id, and
 * two elements answering to it would be a duplicate id and an ambiguous bypass.
 */
function Frame({
  headingId,
  title,
  children,
}: {
  headingId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      className="wb-canvas"
      id={CANVAS_ID}
      tabIndex={-1}
      aria-labelledby={headingId}
    >
      <div className="wb-canvas-pad wb-set-pad">
        <h2 id={headingId} className="wb-surface-title">
          {title}
        </h2>
        {children}
      </div>
    </section>
  );
}
