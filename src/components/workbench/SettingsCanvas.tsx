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
import { INTAKE_FORMAT_GROUPS } from "@/lib/workbench-intake";
import {
  DEFAULT_SERPAPI_ENGINE,
  MINERU_CLOUD_WARNING_COPY,
  MINERU_DEFAULT_LOCAL_BASE_URL,
  MINERU_ENABLED_MODES,
  RESEARCH_PROVIDERS,
  SETTINGS_API_BASE_URL_LABEL,
  SETTINGS_API_COPIED_COPY,
  SETTINGS_API_COPY,
  SETTINGS_API_ENABLED_COPY,
  SETTINGS_API_ENABLE_COPY,
  SETTINGS_API_ENABLE_LABEL,
  SETTINGS_API_MCP_COPY,
  SETTINGS_API_MCP_COPY_COPY,
  SETTINGS_API_MCP_HEADING,
  SETTINGS_API_OPEN_HEALTH_COPY,
  SETTINGS_API_SKILL_COPY,
  SETTINGS_API_SKILL_COPY_COPY,
  SETTINGS_API_SKILL_HEADING,
  SETTINGS_API_TOKEN_ABSENT_COPY,
  SETTINGS_API_TOKEN_COPY_COPY,
  SETTINGS_API_TOKEN_ENV_COPY,
  SETTINGS_API_TOKEN_GENERATE_COPY,
  SETTINGS_API_TOKEN_HIDE_COPY,
  SETTINGS_API_TOKEN_LABEL,
  SETTINGS_API_TOKEN_NEW_COPY,
  SETTINGS_API_TOKEN_SHOW_COPY,
  SETTINGS_API_TOKEN_STORED_COPY,
  SETTINGS_API_UNAUTH_LABEL,
  SETTINGS_API_UNAUTH_OFF_COPY,
  SETTINGS_API_UNAUTH_WARNING_COPY,
  draftApiTokenMissing,
  draftApiUnauthenticated,
  loopbackMcpConfig,
  maskToken,
  settingsDraftAfterApiEnabled,
  settingsDraftAfterTokenGenerated,
  brandedSkillInstallCommand,
  SETTINGS_INTAKE_COPIED_COPY,
  SETTINGS_INTAKE_COPY_ADDRESS,
  SETTINGS_INTAKE_EMAIL_COPY,
  SETTINGS_INTAKE_EMAIL_DISABLED_COPY,
  SETTINGS_INTAKE_EMAIL_LABEL,
  SETTINGS_INTAKE_EMAIL_UNSET_COPY,
  SETTINGS_INTAKE_FORMATS_COPY,
  SETTINGS_INTAKE_FORMATS_HEADING,
  SETTINGS_INTAKE_KEEP_PARSED_COPY,
  SETTINGS_INTAKE_KEEP_PARSED_LABEL,
  SETTINGS_INTAKE_PLAUD_COPY,
  SETTINGS_MINERU_BASE_URL_LABEL,
  SETTINGS_MINERU_COPY,
  SETTINGS_MINERU_ENABLE_LABEL,
  SETTINGS_MINERU_KEY_COPY,
  SETTINGS_MINERU_KEY_LABEL,
  SETTINGS_MINERU_LOCAL_COPY,
  SETTINGS_MINERU_MODE_LABEL,
  SETTINGS_MINERU_OFF_COPY,
  draftMinerULeavesMachine,
  mineruModeLabel,
  settingsDraftAfterMinerUEnabled,
  type MinerUMode,
  SETTINGS_CUSTOM_ENDPOINT_COPY,
  SETTINGS_FIRECRAWL_COPY,
  SETTINGS_GENERAL_SCHEMA_COPY,
  SETTINGS_RESEARCH_COPY,
  SETTINGS_RESEARCH_PROVIDER_LABEL,
  draftResearchProvider,
  draftResearchProviderConfigured,
  researchProviderLabel,
  researchProviderUnconfiguredCopy,
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
  draftEmbeddingKeyStored,
  draftVectorInputs,
  fetchWorkbenchSettings,
  saveWorkbenchSettings,
  settingsCategory,
  settingsDirty,
  settingsDraftAfterEmbeddingProvider,
  settingsDraftFromPayload,
  settingsEnvKeyCopy,
  settingsEnvOverrideCopy,
  settingsModelSubstitutedCopy,
  settingsSaveBody,
  vectorSearchFieldIssue,
  vectorSearchInactiveCopy,
  vectorSearchMissingCopy,
  type SettingsCategoryId,
  type SettingsDraft,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";
import {
  LOOPBACK_BASE_URL,
  LOOPBACK_HEALTH_URL,
  newLoopbackApiToken,
} from "@/lib/v1-contract";
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
 * It takes {@link CANVAS_ID}, `tabIndex={-1}` and `headingId` from `ModeCanvas`
 * while it is open, so the skip link keeps exactly one target and both ids stay
 * unique. The mode canvas is still MOUNTED beside it (DW-373), hidden and
 * id-less — opening Settings must not destroy an open Create Wiki dialog and
 * the name typed into it, which is what unmounting that canvas used to do.
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
  /**
   * Whether the last click on Intake's Copy button put the address on the
   * clipboard.
   *
   * NOT reset on a timer: the confirmation is the only feedback the clipboard
   * gives, and a sentence that vanishes on its own is one an owner who looked
   * away has no way to get back without clicking again. It is cleared when the
   * canvas unmounts, which is when the surface is gone anyway.
   */
  const [copied, setCopied] = useState(false);
  /**
   * Is the freshly generated loopback token shown in the clear?
   *
   * Masked by default and NOT persisted anywhere: this is a view state over a
   * value that only exists inside the current draft, so leaving the surface
   * discards both together.
   */
  const [revealToken, setRevealToken] = useState(false);
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

  /**
   * Put the inbound address on the clipboard, and say whether that worked.
   *
   * `navigator.clipboard` is absent on an insecure origin and rejects when the
   * permission is refused, and BOTH cases must leave the confirmation off: a
   * pane that said "Address copied." over an empty clipboard would send the
   * owner to paste nothing into their mail client. The address itself stays on
   * screen either way, so the fallback is simply selecting it by hand.
   */
  const copyToClipboard = useCallback(async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
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
      if (result.unconfirmed) {
        // NOTHING came back, so the patch may already be stored (DW-376). The
        // sentence above says so; this is the part the owner cannot do for
        // themselves.
        //
        // The held version is the only thing on this surface that can now be a
        // LIE: if the save landed, the stored config has moved past it. Clearing
        // it is the same argument the landed-save branch makes above, arriving
        // from the other side — what this surface knows is "the current version
        // is unknown", and the next save saying so (428, "this could not be
        // checked") is truthful, where the kept one would be refused as 412's
        // "somebody else changed this while you were editing", a sentence about
        // an actor that does not exist. Neither can clobber; the tie is broken
        // on which refusal tells the owner the truth.
        //
        // The draft and the payload's VALUES are left exactly as they are: this
        // surface has no re-read that does not throw away every unsaved edit,
        // and re-seeding from a server that never answered is not a thing it
        // could do anyway.
        setPayload((current) =>
          current ? { ...current, version: undefined } : current,
        );
      }
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
    apply((current) => ({ ...current, [key]: value }));
  };

  /**
   * The same edit gesture as {@link set}, for a rule that moves MORE THAN ONE
   * field at once (DW-69/DW-72).
   *
   * `set` is the one-key case of this; both clear the status and the refusal for
   * the same reason. Written as one function so a multi-field rule cannot
   * quietly skip the resets `set` performs — a stale "needs an API key" sitting
   * beside a Save after the control that caused it has moved.
   */
  function apply(rule: (current: SettingsDraft) => SettingsDraft) {
    setDraft((current) => (current ? rule(current) : current));
    setStatus("");
    // The refusal described the values that were SENT, so it stops being true
    // the moment the owner starts fixing the field it named — leaving it beside
    // Save would have them reading "needs an API key" while typing one.
    setSaveError(null);
  }

  const dirty = settingsDirty(draft, payload);
  const vectorInputs = draftVectorInputs(draft, payload);
  const vectorAllowed = draftCanEnableVectorSearch(draft, payload);
  const vectorBlocked = vectorSearchMissingCopy(vectorInputs);
  // What the embedding-model INPUT has to say about itself (DW-223). The
  // refusal used to be announced only as the checkbox's description, while the
  // box holding the wrong value carried nothing — and the ordinary way into that
  // state is changing the provider select, which touches neither control.
  const vectorModelIssue = vectorSearchFieldIssue(vectorInputs, "model");
  // …and the same question asked of the PROVIDER select (DW-277). The binding
  // leg has no control of its own, so it lands here: this select is the only
  // thing on the surface that can move it.
  const vectorProviderIssue = vectorSearchFieldIssue(vectorInputs, "provider");
  // The third state of the switch's hint (DW-279). A switch that is on — stored
  // on, or switched on in this draft — renders CHECKED, and `vectorBlocked`
  // would describe it as something that cannot be turned on, which is not the
  // state the box is visibly in. Like every other term here this reads the
  // DRAFT, so the sentence it selects speaks about the settings as they now
  // stand rather than about what the deployment is doing; the save bar's
  // standing sentence is what qualifies unsaved edits, and it is announced on
  // this control too.
  const vectorInactive = vectorSearchInactiveCopy(vectorInputs);
  // The vector switch's WHOLE refusal predicate, named once so the attribute
  // that announces it and the handler that enforces it cannot drift into
  // disagreeing about when the toggle is refused. Turning it OFF is always
  // allowed — an owner must be able to undo a switch whose legs have since
  // gone missing — which is what the `!values.vectorSearchEnabled` term says.
  const vectorRefused =
    stored.readOnly || (!vectorAllowed && !values.vectorSearchEnabled);
  // What this deployment is EMBEDDING with right now (DW-312), which unlike
  // every other term here is read off the PAYLOAD rather than off the draft.
  // It has to be: the substitution is the resolver applying
  // `embeddingModelMatchesProvider` over the env and the store together, which
  // only the server can evaluate — and it describes what is running, not what
  // the owner is currently typing. It refreshes on save, because `PUT` re-seeds
  // this payload from a cache `saveConfig` has just re-primed.
  //
  // Guarded on BOTH fields, exactly as `EmbeddingSettings.tsx` guards the same
  // note on the flat page: a half-wired payload would otherwise render a
  // sentence with a hole where the model name goes, which is worse than no
  // sentence.
  const modelSubstitution =
    stored.embeddingModelOverridden && stored.embeddingModelInEffect !== null
      ? settingsModelSubstitutedCopy(stored.embeddingModelInEffect)
      : null;
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
   *
   * A row with NO hint of its own is answered too (DW-280): the read-only
   * sentence is then the WHOLE description rather than an append, which is what
   * lets the hintless text rows — Chat model, Embedding endpoint, the rest —
   * carry the refusal at all. `undefined` in and a writable deployment gives
   * `undefined` back, so a control with nothing to say still emits no attribute.
   */
  function describedBy(hintId: string | undefined): string | undefined {
    if (!stored.readOnly) return hintId;
    return hintId ? `${hintId} ${readOnlyNoteId}` : readOnlyNoteId;
  }

  /**
   * @param invalid Marks the control `aria-invalid` — reserved for a box whose
   *   OWN value is the thing being complained about. A complaint the owner
   *   cannot fix from this box (an `EMBEDDING_MODEL` override, say) is described
   *   without being marked, because marking it is a dead end.
   */
  function textRow(
    key:
      | "chatModel"
      | "ingestModel"
      | "customBaseUrl"
      | "embeddingModel"
      | "embeddingBaseUrl"
      | "firecrawlBaseUrl"
      | "serpApiEngine"
      | "searxngBaseUrl"
      | "searxngCategories"
      | "mineruLocalBaseUrl"
      | "llmTimeoutSeconds",
    label: string,
    hint?: string,
    invalid?: boolean,
    /**
     * The env value that OWNS this field, when one does.
     *
     * Present means the box is showing something it does not control: the
     * environment wins at run time, so the box shows the env value and refuses
     * edits — `readOnly` rather than `disabled`, the same choice the whole
     * surface makes, so the value stays reachable and readable. Editable-looking
     * boxes whose contents a run ignores are the disagreement `providerRow`'s
     * env note exists to prevent, and a text row is no different for being a
     * text row.
     */
    envPin?: string | null,
  ) {
    const id = field(key);
    const hintId = `${id}-hint`;
    const pinned = typeof envPin === "string" && envPin.length > 0;
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
          value={pinned ? envPin : values[key]}
          onChange={(event) => {
            if (pinned) return;
            set(key, event.target.value);
          }}
          spellCheck={false}
          readOnly={stored.readOnly || pinned}
          // A range printed beside a box is invisible to a screen reader; the
          // accepted values have to be part of the control's own description —
          // and on a read-only deployment so is the reason the box will not
          // move, which `describedBy` appends (or supplies outright, for a row
          // that has no hint of its own).
          aria-describedby={describedBy(hint ? hintId : undefined)}
          // Only when this box holds the wrong value — see the parameter's note.
          // NEVER on a read-only deployment: the same rule that leaves an
          // env-owned mismatch described-but-unmarked applies whole here, since
          // `YOPEDIA_READONLY` makes every box unfixable. The DESCRIPTION still
          // rides, so the reason is announced; only the "this field is wrong,
          // fix it" mark is withheld, because there is nothing to fix it with.
          // An env pin is the same dead end for the same reason.
          aria-invalid={(invalid && !stored.readOnly && !pinned) || undefined}
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
    key:
      | "customApiKey"
      | "embeddingApiKey"
      | "firecrawlApiKey"
      | "tavilyApiKey"
      | "serpApiKey"
      | "mineruApiKey",
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
          // stored" is the only thing distinguishing it from an empty one — so
          // the read-only sentence is APPENDED to it here, never substituted for
          // it (DW-307). The row was left out of DW-280 on the reasoning that a
          // `readOnly` box has no refusal to announce, which was never true:
          // `readOnly` announces "read-only" as a property of the box and says
          // nothing about the deployment, and the row's only other affordance —
          // the Remove button — is REMOVED under `stored.readOnly` rather than
          // refused in place. What a screen reader perceives on a read-only
          // deployment is a box that will not take a keystroke beside a button
          // that has vanished, described only as "A key is stored."
          aria-describedby={describedBy(hintId)}
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

  /**
   * The Deep Research provider select.
   *
   * `aria-disabled` rather than `disabled` and the env-override note are the
   * two conventions `providerRow` above already follows, and this row follows
   * them for the same reasons — the long explanation lives there.
   *
   * WHAT IS DIFFERENT is the hint. It answers "will a run start", not "what is
   * selected": the selection is visible in the control, and the fact the owner
   * cannot see is whether the provider they just picked has a credential. So a
   * configured selection gets the standing sentence and an unconfigured one gets
   * {@link researchProviderUnconfiguredCopy}, which names the provider and the
   * thing to supply.
   */
  function researchProviderRow() {
    const id = field("researchProvider");
    const hintId = `${id}-hint`;
    const invalidEnv = stored.envResearchProviderInvalid ?? null;
    const envPinned = stored.envResearchProvider !== null || invalidEnv !== null;
    const selected = draftResearchProvider(values, stored);
    const configured = draftResearchProviderConfigured(values, stored);
    return (
      <p className="wb-set-row">
        <label className="wb-set-label" htmlFor={id}>
          {SETTINGS_RESEARCH_PROVIDER_LABEL}
        </label>
        <select
          id={id}
          className="wb-set-select"
          // The ENV override wins at run time, so it is what the box shows when
          // it is set — the same reading the embedding provider select applies.
          // Showing the stored value beside a run that uses another provider is
          // the disagreement this whole pair of fields exists to avoid.
          //
          // `selected` rather than the raw draft field, so a store with NOTHING
          // chosen shows Tavily — the provider that would actually run — rather
          // than an empty value with no matching option, which a browser
          // renders as the first row while the draft still holds `""`. There is
          // no "inherit" rung here for the same reason: one provider always
          // runs, and the default is a real answer rather than a deferral.
          value={selected}
          aria-disabled={stored.readOnly || envPinned || undefined}
          onChange={(event) => {
            if (stored.readOnly || envPinned) return;
            set("researchProvider", event.target.value);
          }}
          aria-describedby={describedBy(hintId)}
        >
          {RESEARCH_PROVIDERS.map((option) => (
            <option key={option} value={option}>
              {researchProviderLabel(option)}
            </option>
          ))}
        </select>
        <span className="wb-set-hint" id={hintId}>
          {invalidEnv
            ? `RESEARCH_PROVIDER is set to unsupported value “${invalidEnv}”. No Deep Research run will start until the environment is corrected.`
            : envPinned
            ? `RESEARCH_PROVIDER is set to ${researchProviderLabel(selected)} and wins over this box.`
            : configured
              ? `${researchProviderLabel(selected)} is configured and will run the next Deep Research.`
              : researchProviderUnconfiguredCopy(selected)}
        </span>
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
            {/* An env override is SAID rather than shown in the box, exactly
                as it is on the embedding model row (DW-71). `LLM_CUSTOM_BASE_URL`
                wins at runtime and a save cannot move it, but the box edits the
                STORE — which is what applies the moment the variable is unset —
                so the field stays editable, undisabled and unmarked, and the
                sentence carries the whole explanation. Without it this reads as
                a box an owner can type an endpoint into, save successfully, and
                change nothing. */}
            {textRow(
              "customBaseUrl",
              "Custom base URL",
              stored.envCustomBaseUrl
                ? settingsEnvOverrideCopy("customBaseUrl", stored.envCustomBaseUrl)
                : undefined,
            )}
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
                  // NOT a plain `set` (DW-69/DW-72). Moving this select moves
                  // THREE fields: the endpoint and the key belong to the vendor
                  // being left behind, and the store deletes both on the save
                  // this select is about to produce. The rule that decides that
                  // is the pure one the suite executes — the component applies
                  // it, it does not restate it.
                  apply((current) =>
                    settingsDraftAfterEmbeddingProvider(
                      current,
                      event.target.value,
                      // What the STORE holds — the rule needs it to tell "moved
                      // to another vendor" (blank the boxes) from "moved back to
                      // the stored one" (restore them, because the stored pair
                      // is that vendor's own and the save must not delete it).
                      stored,
                    ),
                  );
                }}
                aria-describedby={describedBy(field("embeddingProvider-hint"))}
                // Only when THIS select holds the wrong value — a provider the
                // gate does not recognise, or `workers-ai` on a deployment with
                // no `AI` binding (DW-277). Withheld for an env-owned selection
                // and on a read-only deployment for the same reason `textRow`
                // withholds it: "this field is wrong, fix it" about a control
                // that cannot be fixed from here is a dead end. The DESCRIPTION
                // still rides in both cases.
                aria-invalid={(vectorProviderIssue?.invalid && !stored.readOnly) || undefined}
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
                {/* Where the value comes from (or what the field is for), then
                    the gate's complaint about it — the same order the model row
                    uses, and both as this control's OWN description so a screen
                    reader reads them here rather than on a checkbox three rows
                    down. The complaint carries the leg's NOTE, because on this
                    control the note names exactly what the control can do. */}
                {[
                  stored.envEmbeddingProvider
                    ? settingsEnvOverrideCopy("provider", stored.envEmbeddingProvider)
                    : SETTINGS_VECTOR_PROVIDER_COPY,
                  vectorProviderIssue?.copy ?? null,
                ]
                  .filter((part): part is string => part !== null)
                  .join(" ")}
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
              // THREE parts, in the order an owner needs them: where the value
              // comes from (the env sentence), what is wrong with it (the
              // gate's complaint), and what is embedding instead right now (the
              // substitution note, DW-312). Each answers a different question
              // and any subset may be absent — the substitution note in
              // particular is the only one that appears when NO provider is
              // selected, where the gate returns the provider leg early and
              // produces no model complaint at all. All three are the control's
              // OWN description, so a screen reader reads them on the field
              // rather than leaving them on a checkbox three rows down.
              //
              // The substitution is DESCRIBED, never MARKED: `invalid` below
              // stays the gate's answer alone. A substitution is not a wrong
              // value in this box — the box may be empty while `EMBEDDING_MODEL`
              // owns the value, and even a stored id that the provider cannot
              // serve is still what applies the moment the provider changes —
              // so no `aria-invalid`, nothing disabled, and the save is not
              // blocked.
              [
                stored.envEmbeddingModel
                  ? settingsEnvOverrideCopy("model", stored.envEmbeddingModel)
                  : null,
                vectorModelIssue?.copy ?? null,
                modelSubstitution,
              ]
                .filter((part): part is string => part !== null)
                .join(" ") || undefined,
              vectorModelIssue?.invalid,
            )}
            {textRow("embeddingBaseUrl", "Embedding endpoint")}
            {secretRow(
              "embeddingApiKey",
              "Embedding API key",
              // "A key is stored FOR THE VENDOR THIS DRAFT SELECTS", not
              // "the store holds a key" (DW-69/DW-72). The bare stored boolean
              // kept the hint reading "A key is stored." and kept `Remove` on
              // screen for a credential the next save deletes — the misreport
              // DW-69 names. Same predicate the browser's vector half reads, so
              // the row and the switch cannot describe one draft differently.
              draftEmbeddingKeyStored(values, stored),
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
                {/* Three states, not two. Names the legs the SELECTED provider
                    is missing — Ollama and Workers AI carry their own transport,
                    so demanding a key from either would send the owner after a
                    credential that does not exist — and says them as an ON-BUT-
                    INACTIVE state whenever the box is checked, because "before
                    it can be turned on" beside a ticked box describes a state
                    the surface is visibly not in (DW-279). The split is the same
                    term `vectorRefused` uses, so what is announced and what is
                    refused cannot disagree. */}
                {vectorAllowed
                  ? SETTINGS_VECTOR_HINT_COPY
                  : values.vectorSearchEnabled
                    ? vectorInactive
                    : vectorBlocked}
              </span>
            </p>
          </>
        );
      case "intake":
        return (
          <>
            <h3 className="wb-set-heading">Inbound email</h3>
            <p className="wb-set-note">{SETTINGS_INTAKE_EMAIL_COPY}</p>
            <p className="wb-set-row">
              <span className="wb-set-label" id={field("inboundEmail-label")}>
                {SETTINGS_INTAKE_EMAIL_LABEL}
              </span>
              {/* STATIC, not an input. The address is owned by the door's own
                  settings API and by the Cloudflare route in front of it; an
                  editable box here would be a second writer for one value, and
                  a save on this pane would silently disagree with the Worker
                  that actually receives the mail. */}
              <span className="wb-set-static">
                {stored.inboundEmailAddress ?? SETTINGS_INTAKE_EMAIL_UNSET_COPY}
              </span>
              {stored.inboundEmailAddress && (
                <button
                  type="button"
                  className="wb-set-action"
                  aria-describedby={field("inboundEmail-label")}
                  onClick={() => void copyToClipboard(stored.inboundEmailAddress ?? "")}
                >
                  {SETTINGS_INTAKE_COPY_ADDRESS}
                </button>
              )}
            </p>
            {/* Polite and visible: the clipboard gives no feedback of its own,
                and a Copy button that appears to do nothing is the same dead
                end a silent save would be. */}
            <p className="wb-set-note" aria-live="polite">
              {copied
                ? SETTINGS_INTAKE_COPIED_COPY
                : stored.inboundEmailAddress && !stored.inboundEmailEnabled
                  ? SETTINGS_INTAKE_EMAIL_DISABLED_COPY
                  : ""}
            </p>

            <h3 className="wb-set-heading">Plaud</h3>
            <p className="wb-set-note">{SETTINGS_INTAKE_PLAUD_COPY}</p>

            <h3 className="wb-set-heading">{SETTINGS_INTAKE_FORMATS_HEADING}</h3>
            <p className="wb-set-note">{SETTINGS_INTAKE_FORMATS_COPY}</p>
            {/* DERIVED from the door's own vocabulary, never typed here. A
                hand-written grid beside a programmatic accept list is the
                prose/inventory drift the parity suite exists to catch, and it
                would show an owner a format the door refuses. */}
            <dl className="wb-set-formats">
              {INTAKE_FORMAT_GROUPS.map((group) => (
                <div key={group.label} className="wb-set-format-group">
                  <dt>{group.label}</dt>
                  <dd>{group.extensions.map((ext) => `.${ext}`).join(" ")}</dd>
                </div>
              ))}
            </dl>

            <h3 className="wb-set-heading">Extracted text</h3>
            <p className="wb-set-row">
              <label className="wb-set-check" htmlFor={field("intakeKeepParsed")}>
                <input
                  id={field("intakeKeepParsed")}
                  type="checkbox"
                  checked={values.intakeKeepParsed}
                  aria-disabled={stored.readOnly || undefined}
                  onChange={(event) => {
                    if (stored.readOnly) return;
                    set("intakeKeepParsed", event.target.checked);
                  }}
                  aria-describedby={describedBy(field("intakeKeepParsed-hint"))}
                />
                {SETTINGS_INTAKE_KEEP_PARSED_LABEL}
              </label>
              <span className="wb-set-hint" id={field("intakeKeepParsed-hint")}>
                {SETTINGS_INTAKE_KEEP_PARSED_COPY}
              </span>
            </p>
          </>
        );
      case "mineru":
        return (
          <>
            <p className="wb-set-note">{SETTINGS_MINERU_COPY}</p>
            <p className="wb-set-row">
              <label className="wb-set-check" htmlFor={field("mineruEnabled")}>
                <input
                  id={field("mineruEnabled")}
                  type="checkbox"
                  checked={values.mineruMode !== "off"}
                  aria-disabled={stored.readOnly || undefined}
                  onChange={(event) => {
                    if (stored.readOnly) return;
                    // NOT a plain `set`. Which mode a first enablement lands on
                    // is a decision — Local API, the mode that keeps documents
                    // on this machine — and it is the pure rule the node suite
                    // executes, not a branch typed into this JSX.
                    apply((current) =>
                      settingsDraftAfterMinerUEnabled(current, event.target.checked),
                    );
                  }}
                  aria-describedby={describedBy(field("mineruEnabled-hint"))}
                />
                {SETTINGS_MINERU_ENABLE_LABEL}
              </label>
              <span className="wb-set-hint" id={field("mineruEnabled-hint")}>
                {values.mineruMode === "off"
                  ? SETTINGS_MINERU_OFF_COPY
                  : SETTINGS_MINERU_LOCAL_COPY}
              </span>
            </p>
            {values.mineruMode !== "off" && (
              <>
                <p className="wb-set-row">
                  <label className="wb-set-label" htmlFor={field("mineruMode")}>
                    {SETTINGS_MINERU_MODE_LABEL}
                  </label>
                  <select
                    id={field("mineruMode")}
                    className="wb-set-select"
                    value={values.mineruMode}
                    aria-disabled={stored.readOnly || undefined}
                    onChange={(event) => {
                      if (stored.readOnly) return;
                      set("mineruMode", event.target.value as MinerUMode);
                    }}
                    aria-describedby={describedBy(field("mineruMode-hint"))}
                  >
                    {MINERU_ENABLED_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {mineruModeLabel(mode)}
                      </option>
                    ))}
                  </select>
                  {/* The warning is this control's OWN description, and it is
                      read off the DRAFT: it has to appear the moment Cloud is
                      picked, BEFORE Save applies it. A note rendered beside the
                      select would never be announced, and one derived from the
                      stored mode would arrive after the upload it warns about
                      was already possible. */}
                  <span
                    className={
                      draftMinerULeavesMachine(values)
                        ? "wb-set-hint wb-set-warn"
                        : "wb-set-hint"
                    }
                    id={field("mineruMode-hint")}
                  >
                    {draftMinerULeavesMachine(values)
                      ? MINERU_CLOUD_WARNING_COPY
                      : SETTINGS_MINERU_LOCAL_COPY}
                  </span>
                </p>
                {/* Pipeline needs this row as much as Local API does: both post
                    to the SAME `/file_parse` on the owner's own server and
                    differ only in the backend they ask it for. Shown for Local
                    alone, an owner who picked Pipeline had no way to say where
                    their server listens. */}
                {(values.mineruMode === "local" ||
                  values.mineruMode === "pipeline") &&
                  textRow(
                    "mineruLocalBaseUrl",
                    SETTINGS_MINERU_BASE_URL_LABEL,
                    `Leave blank for ${MINERU_DEFAULT_LOCAL_BASE_URL}.`,
                  )}
                {draftMinerULeavesMachine(values) &&
                  secretRow(
                    "mineruApiKey",
                    SETTINGS_MINERU_KEY_LABEL,
                    stored.hasMinerUApiKey,
                    SETTINGS_MINERU_KEY_COPY,
                  )}
              </>
            )}
          </>
        );
      case "external-sources":
        return (
          <>
            {/* DEEP RESEARCH FIRST, Firecrawl second. The order is the reading
                order of the question an owner arrives here with — "why will
                Deep Research not start" — and putting the Firecrawl pair on top
                is what let the old copy be read as the answer to it. */}
            <h3 className="wb-set-heading">Deep Research</h3>
            <p className="wb-set-note">{SETTINGS_RESEARCH_COPY}</p>
            {researchProviderRow()}
            {secretRow("tavilyApiKey", "Tavily API key", stored.hasTavilyApiKey)}
            {secretRow("serpApiKey", "SerpApi API key", stored.hasSerpApiKey)}
            {textRow(
              "serpApiEngine",
              "SerpApi engine",
              `Leave blank for ${DEFAULT_SERPAPI_ENGINE}.`,
            )}
            {/* The instance URL is SearXNG's credential — it needs no key — so
                it rides as a text row with an env note rather than as a
                secret: there is nothing to hide, and `Remove` on a value the
                env may own would be a button that cannot work. */}
            {textRow(
              "searxngBaseUrl",
              "SearXNG instance URL",
              stored.envSearxngBaseUrl
                ? `SEARXNG_BASE_URL is set to ${stored.envSearxngBaseUrl} and wins over this box.`
                : "The instance Deep Research queries when SearXNG is selected.",
              undefined,
              // Pinned when the env owns it, exactly as the provider select is.
              // The note above said the env wins while the box still accepted
              // typing and a Save still stored what was typed — a value the next
              // run would ignore.
              stored.envSearxngBaseUrl,
            )}
            {textRow(
              "searxngCategories",
              "SearXNG categories",
              "Comma-separated. Leave blank for the instance default.",
            )}
            <h3 className="wb-set-heading">Capture</h3>
            <p className="wb-set-note">{SETTINGS_FIRECRAWL_COPY}</p>
            {textRow("firecrawlBaseUrl", "Firecrawl base URL")}
            {secretRow(
              "firecrawlApiKey",
              "Firecrawl API key",
              stored.hasFirecrawlApiKey,
            )}
          </>
        );
      case "api-mcp":
        return (
          <>
            <p className="wb-set-note">{SETTINGS_API_COPY}</p>
            <p className="wb-set-row">
              <span className="wb-set-label">{SETTINGS_API_BASE_URL_LABEL}</span>
              <span className="wb-set-static">{LOOPBACK_BASE_URL}</span>
              {/* A LINK, not a probe. This pane must not tell the owner the
                  sidecar is up or down: it runs in the browser, the answer
                  changes the moment they start the process, and a stale "not
                  reachable" beside a running sidecar is worse than no claim at
                  all. Opening `/health` shows them the live payload, which is
                  the honest answer and the one the branded skill reads. */}
              <a
                className="wb-set-action"
                href={LOOPBACK_HEALTH_URL}
                target="_blank"
                rel="noreferrer"
              >
                {SETTINGS_API_OPEN_HEALTH_COPY}
              </a>
            </p>

            <p className="wb-set-row">
              <label className="wb-set-check" htmlFor={field("apiEnabled")}>
                <input
                  id={field("apiEnabled")}
                  type="checkbox"
                  checked={values.apiEnabled}
                  aria-disabled={stored.readOnly || undefined}
                  onChange={(event) => {
                    if (stored.readOnly) return;
                    // NOT a plain `set`. Shutting the door also clears the
                    // unauthenticated switch, so a later re-open cannot silently
                    // re-open it unauthenticated — the pure rule the node suite
                    // executes, not a branch typed into this JSX.
                    apply((current) =>
                      settingsDraftAfterApiEnabled(current, event.target.checked),
                    );
                  }}
                  aria-describedby={describedBy(field("apiEnabled-hint"))}
                />
                {SETTINGS_API_ENABLE_LABEL}
              </label>
              <span className="wb-set-hint" id={field("apiEnabled-hint")}>
                {values.apiEnabled
                  ? SETTINGS_API_ENABLED_COPY
                  : SETTINGS_API_ENABLE_COPY}
              </span>
            </p>

            {values.apiEnabled && (
              <>
                <p className="wb-set-row">
                  <label
                    className="wb-set-check"
                    htmlFor={field("allowUnauthenticated")}
                  >
                    <input
                      id={field("allowUnauthenticated")}
                      type="checkbox"
                      checked={values.allowUnauthenticated}
                      aria-disabled={stored.readOnly || undefined}
                      onChange={(event) => {
                        if (stored.readOnly) return;
                        set("allowUnauthenticated", event.target.checked);
                      }}
                      aria-describedby={describedBy(
                        field("allowUnauthenticated-hint"),
                      )}
                    />
                    {SETTINGS_API_UNAUTH_LABEL}
                  </label>
                  {/* The warning is this control's OWN description, read off the
                      DRAFT — the same shape and the same reason as the MinerU
                      Cloud warning above: it has to appear when the owner TICKS
                      the box, before the Save that opens the door. A note
                      rendered merely beside the control would never be
                      announced. */}
                  <span
                    className={
                      draftApiUnauthenticated(values)
                        ? "wb-set-hint wb-set-warn"
                        : "wb-set-hint"
                    }
                    id={field("allowUnauthenticated-hint")}
                  >
                    {draftApiUnauthenticated(values)
                      ? SETTINGS_API_UNAUTH_WARNING_COPY
                      : SETTINGS_API_UNAUTH_OFF_COPY}
                  </span>
                </p>

                <p className="wb-set-row">
                  <span className="wb-set-label" id={field("apiToken-label")}>
                    {SETTINGS_API_TOKEN_LABEL}
                  </span>
                  {/* SHOWN, once, in plaintext — and only while the draft holds
                      a token this pane just minted. Nothing serves it back after
                      Save, so this is the single moment it can be copied, and
                      hiding it behind a reveal toggle would add a click to the
                      one interaction that has to succeed. */}
                  {values.loopbackApiToken ? (
                    <code className="wb-set-static">
                      {revealToken
                        ? values.loopbackApiToken
                        : maskToken(values.loopbackApiToken)}
                    </code>
                  ) : null}
                  {stored.loopbackTokenSource !== "env" && !stored.readOnly && (
                    <button
                      type="button"
                      className="wb-set-action"
                      aria-describedby={field("apiToken-label")}
                      onClick={() =>
                        apply((current) =>
                          settingsDraftAfterTokenGenerated(
                            current,
                            newLoopbackApiToken(),
                          ),
                        )
                      }
                    >
                      {SETTINGS_API_TOKEN_GENERATE_COPY}
                    </button>
                  )}
                  {values.loopbackApiToken && (
                    <>
                      <button
                        type="button"
                        className="wb-set-action"
                        aria-describedby={field("apiToken-label")}
                        aria-pressed={revealToken}
                        onClick={() => setRevealToken((current) => !current)}
                      >
                        {revealToken
                          ? SETTINGS_API_TOKEN_HIDE_COPY
                          : SETTINGS_API_TOKEN_SHOW_COPY}
                      </button>
                      <button
                        type="button"
                        className="wb-set-action"
                        aria-describedby={field("apiToken-label")}
                        onClick={() =>
                          void copyToClipboard(values.loopbackApiToken ?? "")
                        }
                      >
                        {SETTINGS_API_TOKEN_COPY_COPY}
                      </button>
                    </>
                  )}
                  <span className="wb-set-hint" id={field("apiToken-hint")}>
                    {stored.loopbackTokenSource === "env"
                      ? SETTINGS_API_TOKEN_ENV_COPY
                      : values.loopbackApiToken
                        ? SETTINGS_API_TOKEN_NEW_COPY
                        : stored.hasLoopbackApiToken
                          ? SETTINGS_API_TOKEN_STORED_COPY
                          : SETTINGS_API_TOKEN_ABSENT_COPY}
                  </span>
                </p>

                {/* The door is on, the token is required, and there is none —
                    so every caller gets 401. Not an error and not a block on
                    Save: it is a real, safe state, and saying so is the
                    difference between an owner understanding their agent's 401
                    and hunting it. */}
                {draftApiTokenMissing(values, stored) && (
                  <p className="wb-set-note wb-set-warn" role="status">
                    {SETTINGS_API_TOKEN_ABSENT_COPY}
                  </p>
                )}
              </>
            )}

            <h3 className="wb-set-heading">{SETTINGS_API_MCP_HEADING}</h3>
            <p className="wb-set-note">{SETTINGS_API_MCP_COPY}</p>
            {/* The token is SUBSTITUTED only when the draft is holding a freshly
                generated one; otherwise the config carries the placeholder,
                because the server never serves the stored value back. */}
            <pre className="wb-set-pre">{loopbackMcpConfig(values.loopbackApiToken)}</pre>
            <p className="wb-set-row">
              <button
                type="button"
                className="wb-set-action"
                onClick={() =>
                  void copyToClipboard(loopbackMcpConfig(values.loopbackApiToken))
                }
              >
                {SETTINGS_API_MCP_COPY_COPY}
              </button>
            </p>

            <h3 className="wb-set-heading">{SETTINGS_API_SKILL_HEADING}</h3>
            <p className="wb-set-note">{SETTINGS_API_SKILL_COPY}</p>
            <pre className="wb-set-pre">{brandedSkillInstallCommand()}</pre>
            <p className="wb-set-row">
              <button
                type="button"
                className="wb-set-action"
                onClick={() => void copyToClipboard(brandedSkillInstallCommand())}
              >
                {SETTINGS_API_SKILL_COPY_COPY}
              </button>
            </p>

            {/* Polite and visible, exactly as the Intake copy confirmation is:
                the clipboard gives no feedback of its own. */}
            <p className="wb-set-note" aria-live="polite">
              {copied ? SETTINGS_API_COPIED_COPY : ""}
            </p>
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
 * It carries {@link CANVAS_ID} and `tabIndex={-1}` because `ModeCanvas` gives
 * both up while the Settings surface is showing — the skip link points at one
 * id, and two elements answering to it would be a duplicate id and an ambiguous
 * bypass. The mode canvas has not gone anywhere: it is mounted beside this one
 * behind `hidden`, holding whatever draft was on it (DW-373).
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
