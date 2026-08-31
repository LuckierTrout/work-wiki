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
  SETTINGS_GENERAL_PURPOSE_COPY,
  SETTINGS_GENERAL_NO_WIKI_COPY,
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
  settingsDraftAfterEmbeddingPinRefusal,
  settingsDraftAfterEmbeddingProvider,
  settingsDraftFromPayload,
  settingsEnvKeyCopy,
  settingsEnvKeyVariableCopy,
  settingsEnvOverrideCopy,
  settingsEnvProviderInvalidCopy,
  settingsEnvProviderPinCopy,
  settingsModelSubstitutedCopy,
  settingsRefusalPinsEmbeddingProvider,
  settingsSaveBody,
  verdictClearsHeldVersion,
  vectorSearchFieldIssue,
  vectorSearchInactiveCopy,
  vectorSearchMissingCopy,
  type SettingsCategoryId,
  type SettingsDraft,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";
import { CANVAS_ID } from "./ModeCanvas";
import { SettingsApiMcpPane } from "./SettingsApiMcpPane";
import type { EditableArtifactFile } from "@/lib/wiki-scenarios";

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
 * builder and the vector predicate. `workbench-settings.test.ts` runs in
 * vitest's `node` project (`environment: "node"`, `*.test.ts`), which mounts
 * nothing, so a rule typed into the JSX below could only ever be grepped for
 * there — and "what does Save actually send" is exactly the kind of rule a
 * rewrite keeps the wording of while changing the behaviour. This file makes no
 * request of its own at all: both the read and the write live in that module,
 * where a stubbed `fetchImpl` drives them without a socket.
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
  hasWiki?: boolean;
  onOpenArtifact?: (file: EditableArtifactFile) => void;
}

export function SettingsCanvas({
  category,
  headingId,
  hasWiki = true,
  onOpenArtifact = () => {},
}: SettingsCanvasProps) {
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
    // THE RECOVERY READ (DW-555). A clearing verdict — and a versionless 200,
    // and a load that carried none — leaves this surface holding no version,
    // and nothing else on it ever puts one back: every later save then goes out
    // with no `If-Match` and is refused 428, escapable only by a reload that
    // destroys the draft. So the version, and ONLY the version, is re-read at
    // the one moment it matters.
    //
    // FALSINESS, NOT `=== undefined`, on BOTH the trigger and the adoption.
    // The static type says `version?: string`, but `isWorkbenchSettingsPayload`
    // deliberately accepts `null` and `""` as spellings of absence and
    // `workbenchSettingsFrom` hands the candidate back verbatim, so all three
    // reach this ref at runtime. `saveWorkbenchSettings` gates the header on
    // TRUTHINESS (`options.version ? …`), and this has to gate on the SAME rule
    // or the two disagree: an `=== undefined` trigger would let a held `null`
    // walk straight past the recovery into the headerless 428 this exists to
    // remove, and an `!== undefined` adoption would write that `null` back into
    // the held payload and switch the recovery off for the life of the tab.
    // `SkillsCanvas.toggle` tests the same way, for the same reason.
    //
    // LAZY, NEVER EAGER. A HELD version is the description of the config this
    // draft was seeded from, which is the whole point of the precondition;
    // refreshing one behind the owner's back would silently turn every conflict
    // into a clobber. Only the absent case has nothing left to lose.
    //
    // AND THE TRADE IT MAKES, stated rather than left to be discovered: reading
    // the precondition immediately before the PUT means this retry can no
    // longer be refused as a conflict, so a third party's edit landing between
    // the cleared save and the retry is OVERWRITTEN rather than caught. That is
    // accepted here, and only here, because the version was cleared precisely
    // because it could no longer detect anything — the choice is not between
    // conflict detection and none, it is between a save that can happen and a
    // surface that can never save again without a reload that destroys every
    // unsaved edit on it. A HELD version still buys the real 412, which is
    // exactly why this never refreshes one.
    //
    // THE DRAFT IS NOT TOUCHED. This is a read for one field, not the re-seed
    // the surface deliberately does not have — every unsaved edit stays exactly
    // where the owner left it, and the answered payload's other values are
    // discarded. Close to `SkillsCanvas.toggle`'s shape, and different in the
    // two ways that matter: that one re-reads on EVERY write, because the
    // Settings pane writes the same file underneath it, and REFUSES when the
    // read yields no version. This one reads only when NONE is held, and never
    // refuses — swallowing the save would strand a draft the owner can neither
    // save nor reload away from. It goes out with no `If-Match` at all, exactly
    // as it does today, and the route answers 428 — the sentence this surface
    // already shows.
    let version = payloadRef.current?.version;
    if (!version) {
      const seeded = await fetchWorkbenchSettings({
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const answered = seeded.status === "ok" ? seeded.payload.version : undefined;
      if (answered) {
        version = answered;
        setPayload((held) => (held ? { ...held, version: answered } : held));
      }
    }
    // The body is built by a pure function the suite executes, so "an untouched
    // key field is omitted entirely" is a property something can run rather than
    // a condition typed here.
    const result = await saveWorkbenchSettings(settingsSaveBody(current), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      version,
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
      // save definitively superseded: it can only ever be refused, and the 412
      // it would be refused with states outright that the save was not applied
      // and puts the change down to somewhere else — when the change is this
      // owner's own save, one moment earlier. Neither answer can clobber, so
      // the tie is broken on which refusal tells the owner the truth.
      setPayload(result.payload);
      setDraft(settingsDraftFromPayload(result.payload));
      setStatus(SETTINGS_SAVED_COPY);
    } else {
      // Every edit stays on screen — a refused save must never be the thing
      // that loses it — and the SERVER's sentence is shown, never a transport's.
      setSaveError(result.message);
      // THE ENV-PIN RECOVERY (DW-553). The route refuses a MOVE of the
      // embedding provider under `EMBEDDING_PROVIDER`, and the draft that made
      // that move has already had its endpoint blanked and its key un-touched
      // by `settingsDraftAfterEmbeddingProvider` — so a retry would re-send the
      // identical refused move, forever. Putting the three embedding legs back
      // to the values this surface is HOLDING makes the very next Save a
      // request the pin does not refuse, without costing the owner any other
      // edit on the surface.
      //
      // RECOGNISED BY THE SENTENCE, because the route sends no code for it and
      // adding one would be a wire-contract change. The rule that decides is
      // pure and lives beside the copy it matches, where the node suite runs it
      // against every member of the closed set the route can mint from.
      //
      // The sentence above and the version handling below are untouched: the
      // owner still reads the SERVER's words, and an arrived refusal applied
      // nothing, so the held version is still current.
      if (settingsRefusalPinsEmbeddingProvider(result.message)) {
        const held = payloadRef.current;
        if (held) {
          setDraft((shown) =>
            shown ? settingsDraftAfterEmbeddingPinRefusal(shown, held) : shown,
          );
        }
      }
      if (verdictClearsHeldVersion(result.verdict)) {
        // TWO different facts, one action (DW-427). `"unconfirmed"`: nobody
        // answered, so the patch may already be stored (DW-376). `"unreadable"`:
        // the route answered a 2xx and its body yielded nothing we could read —
        // which is why the two get DIFFERENT sentences above, one saying the
        // outcome is unknown and one not claiming that over a status line that
        // arrived.
        //
        // ASKED, not re-derived (DW-558). The rule lives beside
        // `SettingsSaveVerdict`, written as an exhaustive switch, so a fourth
        // verdict added later fails to COMPILE until it states its own answer.
        // Naming the two here would have looked equivalent and was not: a new
        // verdict would have fallen to the `else` and silently inherited
        // `"refused"`'s answer — keep the held version — which is the more
        // dangerous of the two to be wrong about, for the reason set out
        // below.
        //
        // They end at the same action because the held version is the one thing
        // on this surface that can now be a LIE either way: a save that landed
        // has moved the stored config past it, and a 2xx from an intermediary is
        // no proof the route did not run. Clearing it is the same argument the
        // landed-save branch makes above, arriving from the other side — what
        // this surface knows is "the current version is unknown", and the next
        // save saying so (428, "this could not be checked") is truthful either
        // way. The kept version buys a 412 instead, which declares the save was
        // not applied and blames a change made somewhere else — a description
        // of the owner's own save, handed back to them as an outsider's edit,
        // on the strength of a version this surface has no business trusting.
        // Neither can clobber; the tie is broken on which refusal tells the
        // owner the truth.
        //
        // The draft and the payload's VALUES are left exactly as they are: this
        // surface has no re-read that does not throw away every unsaved edit,
        // and there is nothing to re-seed FROM on either branch — no answer at
        // all on one, no readable payload on the other.
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
          // it is set. Showing the stored value beside a run that uses another
          // provider is the disagreement this whole pair of fields exists to
          // avoid.
          //
          // The embedding provider select does the OPPOSITE and shows the
          // STORED value (DW-281, pinned by "renders the STORED selection while
          // describing the env one"): there the box edits the store, the store
          // is what applies the moment `EMBEDDING_PROVIDER` is unset, and the
          // hint carries the env value in words. Only the pin is shared between
          // the two rows, not the reading.
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
        return (
          <>
            {!hasWiki && (
              <p className="wb-set-note">{SETTINGS_GENERAL_NO_WIKI_COPY}</p>
            )}
            <h3 className="wb-set-heading">Purpose</h3>
            <p className="wb-set-note">{SETTINGS_GENERAL_PURPOSE_COPY}</p>
            <button
              type="button"
              className="wb-set-action"
              disabled={!hasWiki}
              onClick={() => onOpenArtifact("purpose.md")}
            >
              Open Purpose
            </button>
            <h3 className="wb-set-heading">Schema</h3>
            <p className="wb-set-note">{SETTINGS_GENERAL_SCHEMA_COPY}</p>
            <button
              type="button"
              className="wb-set-action"
              disabled={!hasWiki}
              onClick={() => onOpenArtifact("schema.md")}
            >
              Open Schema
            </button>
          </>
        );
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
            {/* The STORED boolean, with the env fact said beside it (DW-66).
                `secretRow` gates `Remove` on the boolean it is handed, so a
                stored-only flag takes the button off an env-only row by
                construction — it used to be offered for a credential this route
                cannot delete, and pressing it cleared nothing and left the same
                sentence on screen. The variable is NAMED because there is only
                one it can be. */}
            {secretRow(
              "customApiKey",
              "Custom API key",
              stored.hasCustomApiKey,
              stored.envCustomApiKey
                ? settingsEnvKeyVariableCopy("customApiKey", stored.hasCustomApiKey)
                : undefined,
            )}
            <h3 className="wb-set-heading">Timeout</h3>
            {textRow("llmTimeoutSeconds", "LLM timeout (seconds)", SETTINGS_TIMEOUT_HINT_COPY)}
          </>
        );
      case "embeddings": {
        // DW-398. `EMBEDDING_PROVIDER` wins over this select in every feeder,
        // so moving it changes nothing about which vendor embeds — but the move
        // is NOT inert: `settingsDraftAfterEmbeddingProvider` blanks the
        // endpoint and the key, and the save deletes both, which is the
        // credential the env-selected vendor is using. So the row takes the pin
        // `researchProviderRow` already applies.
        //
        // A JUNK `EMBEDDING_PROVIDER` is deliberately NOT pinned here:
        // `envEmbeddingProvider()` filters through `isEmbeddingProvider`, so it
        // arrives as `null` and this stays `false`.
        //
        // What discriminates the two is whether the variable names a REAL
        // SELECTION. A supported value does — including one this runtime cannot
        // serve, like `workers-ai` with no `AI` binding: it is still the vendor
        // every embedding feeder resolves to, still the vendor
        // `embeddingApiKeyFor` would read the stored credential for, and the
        // owner's remedy is to fix the deployment, not to let this box quietly
        // delete that credential first. An UNSUPPORTED value names no vendor at
        // all — resolution refuses it outright — so there is no selection for
        // this box to sabotage, and the store is precisely what applies again
        // the moment the variable is corrected. Pinning there would lock the
        // owner out of the only field that will matter next.
        const envPinned = stored.envEmbeddingProvider !== null;
        // …and the value that pinning refused, which the row now SAYS (DW-508).
        // Before this the junk case produced no owner-visible signal anywhere:
        // the payload's filtered field read `null`, so the row rendered exactly
        // as it does with no variable set, while `resolveEmbeddingProvider`
        // refused the override and nothing embedded. `researchProviderRow`'s
        // hint is the three-way precedent — invalid, then pinned, then the
        // standing sentence — and the only difference here is that the invalid
        // arm DESCRIBES without pinning, per the paragraph above.
        //
        // GUARDED ON THE PIN, not read bare. The two fields are exclusive as
        // `getWorkbenchSettings` builds them — the invalid string is exactly
        // what the `isEmbeddingProvider` filter threw away, so it is non-null
        // only where the filtered field is `null` — but this is a WIRE type,
        // and a payload carrying both would otherwise announce "Nothing will
        // embed" beside a select the line above has just disabled: the one
        // combination that is both wrong and unactionable. Where they disagree
        // the PIN wins, because the pin is what the controls below are already
        // rendering.
        const envInvalid =
          stored.envEmbeddingProvider === null
            ? stored.envEmbeddingProviderInvalid ?? null
            : null;
        return (
          <>
            <p className="wb-set-row">
              <label className="wb-set-label" htmlFor={field("embeddingProvider")}>
                Embedding provider
              </label>
              <select
                id={field("embeddingProvider")}
                className="wb-set-select"
                // Still the STORED value under a pin, not the env one: this box
                // edits the store, and the store is what applies the moment the
                // variable is unset. The hint below says which provider the
                // environment forces.
                value={values.embeddingProvider}
                // Same convention as `providerRow`, same reason: focusable and
                // readable on a read-only deployment — and now on an env-pinned
                // one.
                aria-disabled={stored.readOnly || envPinned || undefined}
                onChange={(event) => {
                  if (stored.readOnly || envPinned) return;
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
                  envInvalid
                    ? settingsEnvProviderInvalidCopy(envInvalid)
                    : stored.envEmbeddingProvider
                      ? settingsEnvProviderPinCopy(stored.envEmbeddingProvider)
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
      }
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
            {/* Same split as the Custom API key row above (DW-66). */}
            {secretRow(
              "firecrawlApiKey",
              "Firecrawl API key",
              stored.hasFirecrawlApiKey,
              stored.envFirecrawlApiKey
                ? settingsEnvKeyVariableCopy(
                    "firecrawlApiKey",
                    stored.hasFirecrawlApiKey,
                  )
                : undefined,
            )}
          </>
        );
      case "api-mcp":
        return (
          <SettingsApiMcpPane
            values={values}
            stored={stored}
            field={field}
            describedBy={describedBy}
            apply={apply}
            copied={copied}
            onCopy={copyToClipboard}
          />
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
