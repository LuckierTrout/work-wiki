"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { WorkspaceProfile } from "@/lib/workspace-profile";
import { SCENARIO_LABELS } from "@/lib/wiki-scenarios";
import { formatIfMatch, IF_MATCH_HEADER } from "@/lib/write-precondition";
import {
  EMPTY_WORKSPACE_PROFILE,
  WORKSPACE_SCENARIO_TEMPLATES,
  type WorkspaceProfileInput,
  type WorkspaceScenario,
} from "@/lib/workspace-profile-schema";

type Feedback = { ok: boolean; message: string } | null;

/**
 * Why every control on this form refuses on a read-only deployment (DW-191).
 *
 * Exported because it is the sentence the refused controls POINT AT through
 * `aria-describedby`, and because `read-only-copy-parity.test.ts` pins it
 * against what `PUT /api/workspace-profile` answers. It NARROWS that sentence
 * on purpose: the route says "Settings are read-only in this deployment.",
 * which is true of every field the Settings surface owns and useless beside a
 * form that edits one thing. The parity suite records the divergence rather
 * than letting it look like the drift it is otherwise indistinguishable from.
 *
 * Copy says work-wiki; the runtime identifier stays `YOPEDIA_READONLY`.
 */
export const WORKSPACE_PURPOSE_READ_ONLY_COPY =
  "Workspace Purpose cannot be changed while this deployment is read-only.";

/** The Wiki this purpose belongs to, as the route names it. */
type ActiveWiki = { id: string; name: string };

/**
 * Why this form reads `/api/workspace-profile` more than once (DW-136).
 *
 * `initial` is the mount, `retry` is the owner pressing **Try again** after one
 * that failed, and `recheck` is the tab coming back to the foreground. All three
 * go through ONE function because they read one answer: three call sites would
 * be three descriptions of the same body, and the profile, the wiki, the
 * read-only flag and the version have to be adopted together or not at all.
 *
 * They differ in exactly two places, both stated in `load`: only `initial` and
 * `retry` own the loading and failure surface, and only `recheck` compares the
 * answer against what is already on screen before touching any of it.
 */
type LoadMode = "initial" | "retry" | "recheck";

function listText(values: readonly string[]): string {
  return values.join("\n");
}

/**
 * The seven editable values, flattened so two of them can be compared.
 *
 * This is what "the owner has unsaved edits" is measured against: the form's
 * fields as the last SERVER answer seeded them. Flattened rather than diffed
 * against the `WorkspaceProfileInput` itself because three of the fields live
 * on screen as text and in the profile as arrays — comparing those two shapes
 * would report every load as an edit.
 */
type FieldSnapshot = {
  scenario: string;
  purpose: string;
  outputLanguage: string;
  pageConventions: string;
  keyQuestions: string;
  inScope: string;
  outOfScope: string;
};

function snapshotOf(value: WorkspaceProfileInput): FieldSnapshot {
  return {
    scenario: value.scenario,
    purpose: value.purpose,
    outputLanguage: value.outputLanguage,
    pageConventions: value.pageConventions,
    keyQuestions: listText(value.keyQuestions),
    inScope: listText(value.inScope),
    outOfScope: listText(value.outOfScope),
  };
}

function sameFields(a: FieldSnapshot, b: FieldSnapshot): boolean {
  return (Object.keys(a) as (keyof FieldSnapshot)[]).every((key) => a[key] === b[key]);
}

function parseList(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean);
}

/**
 * The version a response published, or `null` when it published none.
 *
 * One expression for both the GET and the PUT, because "unknown" has to mean
 * the same thing on both: an empty string is as unusable as a missing key —
 * `formatIfMatch("")` produces `""`, which `parseIfMatch` reads as ABSENT
 * anyway — so it is normalised to `null` here rather than sent and refused
 * there.
 */
function readVersion(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function WorkspacePurposeSettings() {
  const [profile, setProfile] = useState<WorkspaceProfileInput>({
    ...EMPTY_WORKSPACE_PROFILE,
    keyQuestions: [],
    inScope: [],
    outOfScope: [],
  });
  const [keyQuestions, setKeyQuestions] = useState("");
  const [inScope, setInScope] = useState("");
  const [outOfScope, setOutOfScope] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // The Workspace Purpose is stored per Wiki, so the form is editing ONE
  // wiki's profile — the active one. Null means the owner has no wiki yet and
  // there is nothing for these bytes to belong to.
  const [wiki, setWiki] = useState<ActiveWiki | null>(null);
  // A failed GET also leaves `wiki` null, and "create a wiki first" would then
  // be a claim about the registry this render never got to make (the same
  // distinction WikiWorkbench draws with `unavailable`). The error banner below
  // says what actually happened; this keeps the intro from contradicting it.
  //
  // Owned by the `initial` and `retry` paths ALONE, and cleared at the start of
  // each of their attempts as well as on success — a Try again that left
  // `unavailable` standing over a request already in flight would be the same
  // dead end with a button on it (DW-142). A recheck never sets it and never
  // clears it: it stands down while it is true.
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * A **Try again** attempt is in flight.
   *
   * Only reason it exists: `loadFailed` is cleared the moment the attempt
   * starts, so a button rendered on `loadFailed` alone would UNMOUNT UNDER THE
   * FINGER THAT PRESSED IT — dropping keyboard focus to `<body>` for the length
   * of the request, on the one change whose subject is reachability. This keeps
   * it on screen, saying what it is doing, until its own request settles.
   */
  const [retrying, setRetrying] = useState(false);
  /**
   * The version of the profile this form was seeded from, as the route
   * published it (DW-145).
   *
   * NEVER DERIVED HERE. The route computes it over the profile it just read and
   * this form only carries it back in `If-Match`, so the two sides can never
   * describe two different values — the `/api/settings` convention, which
   * `useSettings` follows for the same reason.
   *
   * `null` means "unknown", and the two ways to reach it are a load that failed
   * and a save that answered no version. Both must send NO precondition, so the
   * route answers the truthful 428 rather than a 412 blaming the owner for a
   * change nobody made.
   */
  const [version, setVersion] = useState<string | null>(null);
  /**
   * The read-only sentence's id, so every control refused for that reason can
   * resolve it through `aria-describedby`.
   *
   * `aria-disabled` on its own announces "dimmed" and nothing about why, and a
   * `readOnly` textarea announces "read only" and nothing about why either —
   * the sentence below the form is the only place the reason is stated at all.
   * Rendered only while `readOnly`, so the attribute is only ever set when
   * there is a node with this id to point at.
   */
  const readOnlyNoteId = useId();
  /**
   * The intro paragraph's id, which is the sentence a control refused for
   * having no wiki points at (DW-301).
   *
   * It covers BOTH wiki-less states — no wiki yet, and a load that failed —
   * because both leave `wiki` null and both refuse the same controls for the
   * same reason. Which of the two is on the owner's screen is exactly what that
   * paragraph says, and it is the only thing that tells them apart; a second
   * sentence written for the refusal would be a second owner of that
   * distinction, free to claim the registry is empty over a GET that was merely
   * rejected. Rendered in every state, so the attribute always resolves to a
   * node.
   */
  const noWikiNoteId = useId();
  /**
   * With no wiki, every control refuses — but READS, and stays reachable.
   *
   * True in both wiki-less states (see `noWikiNoteId`): "no wiki yet" and "the
   * load failed" refuse identically, and the intro paragraph they point at is
   * what states which one happened.
   *
   * `!loading` is part of the condition because a form still waiting for its
   * first answer knows nothing yet: the fieldset is shut for the length of the
   * load, and announcing a refusal underneath it would state a reason that may
   * not be true a tick later.
   */
  const refusedForNoWiki = !loading && !wiki;
  /**
   * `aria-describedby` for a control this form may refuse.
   *
   * Every control here already has its meaning in its own `<label>`, so unlike
   * `SettingsCanvas.describedBy` there is no hint id to append to — but the
   * shape is the same, and it COMPOSES: read-only and wiki-less are both
   * reachable at once, and a control that stated only one of the two reasons
   * would be describing half of why it will not run.
   */
  const describedBy =
    [readOnly ? readOnlyNoteId : null, refusedForNoWiki ? noWikiNoteId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  /**
   * The fields as the last SERVER answer left them, for the dirty comparison.
   *
   * `null` until the first answer lands: before that there is no baseline, so
   * nothing can be called an unsaved edit.
   */
  const seededRef = useRef<FieldSnapshot | null>(null);
  // Stable, so `load` can be too — see the visibility effect, which registers
  // its listener once and would otherwise re-register on every keystroke.
  const placeProfile = useCallback(
    (
      value: WorkspaceProfileInput,
      updatedAt?: string | null,
      // Where these bytes came from. ONLY a server answer re-baselines
      // "unchanged": a scenario template is exactly the unsaved work a wiki
      // switch would discard, so writing it into `seededRef` would make the
      // form report itself clean while a draft nobody has saved sits on screen.
      origin: "server" | "draft" = "server",
    ) => {
      setProfile({
        ...value,
        keyQuestions: [...value.keyQuestions],
        inScope: [...value.inScope],
        outOfScope: [...value.outOfScope],
      });
      setKeyQuestions(listText(value.keyQuestions));
      setInScope(listText(value.inScope));
      setOutOfScope(listText(value.outOfScope));
      setSavedAt(updatedAt ?? null);
      if (origin === "server") seededRef.current = snapshotOf(value);
    },
    [],
  );

  /**
   * What the visibility recheck has to know about the render on screen.
   *
   * Mirrored into a ref, and written from the state itself in ONE effect: the
   * listener below is registered once, so reading these from a closure would
   * mean tearing it down and rebuilding it on every keystroke — and a second
   * place that maintained them beside a `setWiki` call is how the mirror and
   * the state start describing different renders.
   */
  const screenRef = useRef<{ wikiId: string | null; standDown: boolean; dirty: boolean }>({
    wikiId: null,
    standDown: true,
    dirty: false,
  });
  useEffect(() => {
    const seeded = seededRef.current;
    screenRef.current = {
      wikiId: wiki?.id ?? null,
      // The recheck stands down whenever something else owns the answer: while
      // a load is in flight (its own answer is about to arrive, and comparing
      // against a wiki id no render has been seeded with yet would announce a
      // change nobody made), while the failure surface is up (Try again owns
      // recovery — see `loadFailed`), and while a save is in flight (the PUT's
      // own response adopts the wiki it actually wrote).
      //
      // THIS IS THE GUARD AT THE START. It cannot be the whole guard: every one
      // of these becomes true DURING a recheck's own round trip, which is the
      // window the run token in `load` closes.
      standDown: loading || loadFailed || saving,
      // Whether anything on screen differs from what the last server answer
      // seeded — the only thing that makes a wiki switch destructive, and so
      // the only thing that licenses the banner to say work was discarded.
      dirty:
        seeded !== null &&
        !sameFields(seeded, {
          scenario: profile.scenario,
          purpose: profile.purpose,
          outputLanguage: profile.outputLanguage,
          pageConventions: profile.pageConventions,
          keyQuestions,
          inScope,
          outOfScope,
        }),
    };
  }, [wiki, loading, loadFailed, saving, profile, keyQuestions, inScope, outOfScope]);
  /** Set when this component unmounts; see `load`'s cancelled guard. */
  const cancelledRef = useRef(false);
  /**
   * How many answers this form has committed to adopting.
   *
   * Bumped by every `load` and by every save, and captured by each run at
   * entry. A run whose token no longer matches has been SUPERSEDED — something
   * newer is already going to seed this form — and must abandon its answer
   * rather than write it over the newer one. The two defects this closes, both
   * of which the pre-await `standDown` check cannot see because they begin
   * after it:
   *
   *   - a recheck in flight when the owner saves. The PUT lands, seeds the
   *     form and confirms; the GET then arrives with another wiki's bytes,
   *     overwrites the just-saved state and replaces the confirmation with an
   *     alert about a switch the owner never made.
   *   - two rechecks in flight at once, both comparing the same pre-adopt
   *     snapshot, so both adopt and both announce. (`recheckInFlightRef` is
   *     what stops the second from starting at all; the token is what makes
   *     the outcome safe if one ever does.)
   */
  const answerSeqRef = useRef(0);
  /** One background recheck at a time — see `answerSeqRef`. */
  const recheckInFlightRef = useRef(false);

  /**
   * Read the active wiki's profile, in whichever of the three modes asked.
   *
   * ONE function for the mount, the retry and the recheck so the answer cannot
   * be described three ways. The mode changes exactly two things, both flagged
   * below: who owns `loading` and the failure surface, and whether the answer
   * is adopted unconditionally or only when the active wiki actually moved.
   */
  const load = useCallback(
    async (mode: LoadMode) => {
      const owned = mode !== "recheck";
      if (!owned && (screenRef.current.standDown || recheckInFlightRef.current)) return;
      // Claimed BEFORE the first await, so anything that starts later can see
      // that this run has been superseded.
      const seq = ++answerSeqRef.current;
      if (!owned) recheckInFlightRef.current = true;
      if (owned) {
        setLoading(true);
        setLoadFailed(false);
        if (mode === "retry") setRetrying(true);
        // The banner belongs to the attempt that produced it. Leaving the old
        // failure up while a retry is in flight is the state DW-142 calls a
        // dead end; the catch below re-arms it if this attempt fails too.
        setFeedback(null);
      }
      try {
        const data = await request<{
          profile: WorkspaceProfile;
          readOnly: boolean;
          wiki: ActiveWiki | null;
          version?: unknown;
        }>("/api/workspace-profile");
        // EVERY guard is re-checked after the await, because every one of them
        // can become true during the round trip — see `answerSeqRef`.
        if (cancelledRef.current || seq !== answerSeqRef.current) return;
        if (!owned && screenRef.current.standDown) return;
        const answered = data.wiki ?? null;
        // THE ID COMPARISON IS WHAT PROTECTS THE DRAFT (DW-136). A recheck runs
        // unasked, behind a form the owner may have been typing into for
        // minutes, so a same-wiki answer must touch NO state: re-seeding the
        // fields would wipe those minutes, and re-seeding `version` would
        // re-point them at a read the owner never saw.
        if (mode === "recheck" && (answered?.id ?? null) === screenRef.current.wikiId) {
          return;
        }
        // Read BEFORE the state is replaced: both describe the screen the owner
        // is about to lose, and both are what the announcement below is about.
        const previousWikiId = screenRef.current.wikiId;
        const hadEdits = screenRef.current.dirty;
        // No wiki means these bytes belong to no wiki: with a retired
        // tenant-global profile still on disk the route answers its fields so
        // the owner can SEE them, but "Last saved …" would then date a save
        // this form cannot repeat and no wiki owns. Show the values, not the
        // receipt.
        placeProfile(data.profile, answered ? data.profile.updatedAt : null);
        setReadOnly(data.readOnly);
        setWiki(answered);
        setVersion(readVersion(data.version));
        if (mode === "recheck") {
          // STATED, NOT SILENT — but stated ACCURATELY. A form that swapped
          // every field under a new name without saying so is the mislabelling
          // DW-136 is about; a red alert claiming discarded work over a
          // background switch that discarded nothing is the same defect with
          // the sign flipped, and it trains the owner to ignore the banner that
          // will one day be telling the truth.
          //
          // So the sentence says what actually happened, and `ok` reports
          // whether anything was LOST: assertive only when there were edits to
          // lose. The three shapes are three different events — a wiki
          // appearing where there was none is not a wiki "changing", and a wiki
          // going away is not a wiki being replaced.
          const changed = answered
            ? previousWikiId === null
              ? `This workspace now has an active wiki, “${answered.name}”, so the form is showing its Workspace Purpose.`
              : `The active wiki changed to “${answered.name}”, so this form now shows that wiki’s Workspace Purpose.`
            : "The active wiki is gone, so there is nothing to edit here now.";
          setFeedback({
            ok: !hadEdits,
            message: hadEdits
              ? `${changed} Your unsaved edits to the previous wiki were discarded.`
              : changed,
          });
        }
      } catch (error) {
        // A FAILED RECHECK CHANGES NOTHING. It asked a question nobody was
        // waiting for, and answering it with `unavailable` over a form that is
        // loaded and editable would take working state away from the owner on
        // the strength of one background read. The mount and the retry own the
        // failure surface; this path simply leaves the last good answer up.
        if (cancelledRef.current || mode === "recheck") return;
        if (seq !== answerSeqRef.current) return;
        // The version goes with the read that failed — see the state's own
        // note, and `useSettings.fetchSettings` for the identical clear.
        setVersion(null);
        setLoadFailed(true);
        setFeedback({
          ok: false,
          message: error instanceof Error ? error.message : "Couldn’t load Workspace Purpose.",
        });
      } finally {
        if (!owned) recheckInFlightRef.current = false;
        // Not `setLoading(false)` from a run something newer has superseded:
        // that newer run owns the flag now, and clearing it here would lift the
        // gate over a request still in flight.
        if (!cancelledRef.current && owned && seq === answerSeqRef.current) {
          setLoading(false);
          setRetrying(false);
        }
      }
    },
    [placeProfile],
  );

  useEffect(() => {
    // Reset on every mount, not just at declaration: an effect that runs twice
    // on one instance (StrictMode) has already set this through its cleanup.
    cancelledRef.current = false;
    void load("initial");
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  useEffect(() => {
    // The Wiki switcher lives only in the Workbench and this form only on
    // /settings and /studio, so the two are never mounted together and a client
    // pub/sub between them would never fire. The switch that strands this form
    // is made in ANOTHER TAB, and `visibilitychange` is the signal this repo
    // already uses for exactly that — see `DataVersionWatcher` and
    // `useSidecarStatus`, whose listener shape this follows. Deliberately not
    // `subscribeDataVersionCheck`: a Wiki switch moves no `dataVersion` at all.
    function onVisibility() {
      if (document.visibilityState === "visible") void load("recheck");
    }
    // AND `focus`, for the case `visibilitychange` does not cover: two browser
    // WINDOWS side by side, the Workbench in one and this form in the other,
    // both on screen the whole time. Neither document is ever hidden, so no
    // visibility event fires — and that arrangement is precisely the "stale
    // until a full reload" the fix is for. Moving between windows fires `focus`
    // on the one being entered.
    //
    // Not polling, and not a second refetch path: both listeners call the SAME
    // recheck, which stands down while anything else owns the answer and
    // adopts nothing unless the wiki id actually moved. A tab switch that fires
    // both is one GET, because the second call finds the first still in flight.
    function onFocus() {
      void load("recheck");
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const selectedTemplate =
    profile.scenario === "custom"
      ? null
      : WORKSPACE_SCENARIO_TEMPLATES[profile.scenario];

  function applyTemplate() {
    // THE EARLY RETURN IS THE WHOLE REFUSAL — `WikiSwitcherProps.readOnly` owns
    // the rationale for this convention. Here it also protects what the owner
    // came to read: this handler overwrites every field with template bytes, so
    // without the guard an `aria-disabled` button they can still activate would
    // paint a draft over the stored purpose they can no longer save back.
    if (readOnly) return;
    // Same refusal, the other reason (DW-301). The button is `aria-disabled`
    // rather than `disabled` so the owner can still reach it and hear WHY —
    // and an `aria-disabled` control is still activatable, so this early return
    // is the whole refusal. Without it a wiki-less form would paint template
    // bytes over the values the route answered for reading.
    //
    // BARE `!wiki`, NOT `refusedForNoWiki`: the rendered refusal waits for the
    // load to settle before it announces a reason, and this must not. A handler
    // fired mid-load has no wiki either, and the two must never be "unified"
    // onto the looser value — the guard has to be the stricter of the two.
    if (!wiki) return;
    if (!selectedTemplate) return;
    placeProfile(selectedTemplate, savedAt, "draft");
    setFeedback({
      ok: true,
      // The shared label map, not the template's own `name` — otherwise the
      // <select> and this message show two different names for one scenario.
      message: `${SCENARIO_LABELS[selectedTemplate.scenario]} template loaded as a draft. Review it, then save when it reflects your workspace.`,
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    // Before the `setSaving`, so a refused deployment never flashes "Saving…"
    // over a request it will not make. The route answers 403 either way; this is
    // what keeps the submit button from being a control that says it refuses and
    // then behaves as though it did not.
    if (readOnly) return;
    // And with no wiki there is nowhere for these bytes to go: the route
    // answers its own "create a wiki first" refusal, and the submit button is
    // `aria-disabled` — reachable, therefore activatable — so the request has
    // to be refused here rather than sent and rejected (DW-301). Bare `!wiki`
    // rather than `refusedForNoWiki`, for the reason `applyTemplate` states.
    if (!wiki) return;
    // This write supersedes any background recheck already in flight: its
    // answer describes a moment before this PUT, and adopting it afterwards
    // would overwrite what was just saved. See `answerSeqRef`.
    answerSeqRef.current += 1;
    setSaving(true);
    setFeedback(null);
    const input: WorkspaceProfileInput = {
      ...profile,
      keyQuestions: parseList(keyQuestions),
      inScope: parseList(inScope),
      outOfScope: parseList(outOfScope),
    };
    try {
      const data = await request<{
        profile: WorkspaceProfile;
        wiki: ActiveWiki | null;
        version?: unknown;
      }>("/api/workspace-profile", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          // The PROFILE these edits were composed against, as the route named
          // it (DW-145). Omitted when the version is unknown so the route
          // answers 428 — "could not be checked" — instead of 412, which would
          // claim a change nobody made. Sent through `formatIfMatch` because a
          // header this form spelled itself is one `parseIfMatch` would read as
          // absent, which is the guard being skipped by malforming it.
          ...(version ? { [IF_MATCH_HEADER]: formatIfMatch(version) } : {}),
        },
        // The wiki these edits were composed against travels WITH them. The
        // route re-resolves the active wiki per request, so without this a
        // switch in another tab between load and save would write what is on
        // screen over a different wiki's stored purpose.
        body: JSON.stringify({ ...input, wikiId: wiki?.id }),
      });
      placeProfile(data.profile, data.profile.updatedAt);
      // Adopt the version of what the save actually WROTE. Without this the
      // second save of a session is still conditioned on the profile this form
      // loaded, and is refused 412 for the change the owner just made
      // themselves.
      //
      // A REFUSED SAVE NEVER REACHES THIS LINE — `request` throws and the catch
      // below takes over — so the seeded version simply stays put. That is not a
      // claim that it is still current: after a 412 it is stale BY DEFINITION,
      // because the store holds bytes this form has never seen. Re-seeding it
      // from a response that refused would silently re-point the draft at
      // someone else's save, which is the lost update itself. The recovery is
      // the one `WRITE_CONFLICT_COPY` states — copy the text, reload — and the
      // reload is what re-seeds this state, exactly as it does for `useSettings`
      // and `WikiEditor`.
      setVersion(readVersion(data.version));
      // Adopt the wiki the server says it wrote, so the confirmation names the
      // wiki actually written rather than the one this form last believed in.
      const written = data.wiki ?? wiki;
      setWiki(written);
      setFeedback({
        ok: true,
        message: written
          ? `Workspace Purpose saved for “${written.name}”. New ingest, chat, monitoring, extraction, and agent runs on this wiki will use it.`
          : "Workspace Purpose saved. New ingest, chat, monitoring, extraction, and agent runs will use it.",
      });
    } catch (error) {
      setFeedback({
        ok: false,
        message: error instanceof Error ? error.message : "Couldn’t save Workspace Purpose.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="mt-12 border-t border-foreground/10 pt-10"
      aria-labelledby="workspace-purpose-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="fmark mb-2">Knowledge direction</p>
          <h2
            id="workspace-purpose-heading"
            className="text-xl font-semibold tracking-tight text-foreground"
          >
            Workspace Purpose
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-foreground/60">
            Tell work-wiki what this memory is for, which questions matter, and what
            belongs outside its scope. The profile guides generated work; source
            evidence and citations still win.
          </p>
          {/* Each wiki keeps its own Workspace Purpose beside its own Schema, so
              the form has to say WHOSE purpose it is showing — otherwise editing
              here after switching wikis is editing something unnamed. */}
          <p
            id={noWikiNoteId}
            className="mt-2 max-w-2xl text-sm leading-6 text-foreground/60"
          >
            {loading
              ? "Loading the active wiki’s purpose…"
              : wiki
                ? `This purpose belongs to “${wiki.name}”. Every wiki keeps its own, and switching the active wiki switches which one guides new runs.`
                : loadFailed
                  ? "The active wiki couldn’t be loaded, so there is nothing to edit here yet."
                  : "Create a wiki first — the Workspace Purpose belongs to a wiki, so there is nothing to edit yet."}
          </p>
          {/* Both degraded states get a way OUT of themselves (DW-142). They
              are mutually exclusive by construction — `loadFailed` is cleared
              at the start of every attempt — so the two affordances can never
              offer the owner a retry and a create at once, which would be the
              form guessing at which of the two happened. */}
          {(loadFailed || retrying) && (
            <button
              type="button"
              className={`btn ghost mt-3${retrying ? " opacity-60" : ""}`}
              // `aria-disabled`, never `disabled`, and for once it is not only
              // the convention: disabling the element that currently has focus
              // moves focus to `<body>`, which is the exact harm keeping the
              // button mounted exists to avoid. The early return is the refusal,
              // as everywhere else on this form.
              aria-disabled={retrying || undefined}
              onClick={() => {
                if (retrying) return;
                void load("retry");
              }}
            >
              {retrying ? "Trying again…" : "Try again"}
            </button>
          )}
          {!loading && !loadFailed && !wiki && !readOnly && (
            // `/` is where a wiki is created; this form is never co-mounted
            // with the switcher, so a second creation control here would be a
            // second owner of the same flow. The link is the whole affordance.
            //
            // Suppressed on a read-only deployment: `POST /api/wikis` refuses
            // there, so this would be a call to action for something the whole
            // surface has already said it will not do. The amber sentence below
            // the form states why, which is the answer the owner actually needs.
            <Link href="/" className="btn ghost mt-3 inline-flex">
              Create a wiki
            </Link>
          )}
        </div>
        <div className="rounded-full border border-foreground/15 bg-foreground/[0.025] px-3 py-1.5">
          <span className="receipt text-[10px] text-foreground/55">
            {loading
              ? "loading…"
              : loadFailed
                ? "unavailable"
                : !wiki
                  ? "no wiki"
                  : savedAt
                    ? "active"
                    : "not configured"}
          </span>
        </div>
      </div>

      <form
        onSubmit={save}
        className="mt-6 overflow-hidden rounded-2xl border border-foreground/15 bg-foreground/[0.018]"
      >
        {/* `loading` and `saving` are the only legs left here, and both are
            TRANSIENT: a form mid-request has no state worth reaching, and the
            gate lifts on its own within the tick.

            Neither `readOnly` (DW-191) nor `!wiki` (DW-301) is one of them any
            more, and both were removed for one reason: `disabled` on a fieldset
            takes every descendant out of the tab order, so the whole stored
            Workspace Purpose — text the owner is entitled to READ — became
            unreachable by keyboard and by screen reader. Refused means refused,
            not hidden; each control below states its own refusal instead,
            following the convention `WikiSwitcherProps.readOnly` documents.

            DW-191 left `!wiki` on the gate as a separate defect with the same
            shape — a populated wiki-less body, which the route still answers so
            the owner can read it, displayed and unreachable. DW-301 is that
            defect: the leg is gone, the controls refuse per control, and the
            sentence they point at is the intro paragraph above, which is
            already the one place "no wiki yet" and "the load failed" are told
            apart.

            And NOT dimmed as a whole either. A read-only `opacity-60` here would
            fade the stored purpose, key questions and scope lists — the exact
            text this change exists to keep readable — so it would be the sighted
            half of the same defect, trading one group of owners for another. The
            visible affordance is the refusal stated where it applies: the amber
            sentence below the form, and `opacity-60` on the three CONTROLS that
            refuse, which carry no content of their own. (A field-chrome cue
            without a contrast loss is available if one is ever wanted — see
            `.wb-set-input[readonly]` in `globals.css`, which recolours the box
            rather than the value.) */}
        <fieldset disabled={loading || saving} className="disabled:opacity-60">
          <div className="grid gap-5 border-b border-foreground/10 p-5 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div>
              <label className="text-sm font-medium text-foreground/75">
                Starting scenario
                <select
                  value={profile.scenario}
                  // `aria-disabled`, never `disabled`: a <select> has no
                  // `readonly`, and `disabled` would take the picker out of the
                  // tab order along with the scenario this wiki is running on —
                  // see `SettingsCanvas.providerRow`, which refuses the same way
                  // for the same reason. Wiki-less refuses identically (DW-301):
                  // the answered scenario is state the owner is entitled to
                  // read, and the handler is what actually refuses.
                  aria-disabled={readOnly || refusedForNoWiki || undefined}
                  onChange={(event) => {
                    if (readOnly || !wiki) return;
                    setProfile({ ...profile, scenario: event.target.value as WorkspaceScenario });
                    setFeedback(null);
                  }}
                  aria-describedby={describedBy}
                  className="mt-1.5 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-foreground/35"
                >
                  {Object.entries(SCENARIO_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={`btn ghost mt-3 w-full justify-center${
                  readOnly || refusedForNoWiki ? " opacity-60" : ""
                }`}
                // `!selectedTemplate` is VALUE state (the custom scenario has
                // no template to load), so it keeps `disabled` — but it YIELDS
                // to both refusal states, exactly as it yields to `readOnly`.
                // Either at once is reachable (read-only or wiki-less with
                // `custom` selected), and `disabled` would win: the button would
                // leave the tab order carrying the only `aria-describedby`
                // pointer some owners have to the refusal, which is the exact
                // harm this change exists to remove. `applyTemplate()` guards
                // all three conditions, so an editable form is unaffected.
                disabled={!readOnly && !refusedForNoWiki && !selectedTemplate}
                aria-disabled={readOnly || refusedForNoWiki || undefined}
                aria-describedby={describedBy}
                onClick={applyTemplate}
              >
                Load scenario draft
              </button>
              <p className="mt-2 text-xs leading-5 text-foreground/40">
                Loading a scenario changes only this unsaved form. It never replaces
                pages or settings until you save.
              </p>
            </div>

            <label className="text-sm font-medium text-foreground/75">
              Purpose
              <textarea
                value={profile.purpose}
                maxLength={8_000}
                rows={6}
                onChange={(event) => setProfile({ ...profile, purpose: event.target.value })}
                placeholder="What should this workspace help you understand, remember, or accomplish?"
                readOnly={readOnly || refusedForNoWiki}
                aria-describedby={describedBy}
                className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
          </div>

          <div className="grid gap-5 p-5 lg:grid-cols-3">
            <label className="text-sm font-medium text-foreground/75">
              Key questions
              <textarea
                value={keyQuestions}
                rows={6}
                onChange={(event) => setKeyQuestions(event.target.value)}
                placeholder="One question per line"
                readOnly={readOnly || refusedForNoWiki}
                aria-describedby={describedBy}
                className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
            <label className="text-sm font-medium text-foreground/75">
              In scope
              <textarea
                value={inScope}
                rows={6}
                onChange={(event) => setInScope(event.target.value)}
                placeholder="One boundary per line"
                readOnly={readOnly || refusedForNoWiki}
                aria-describedby={describedBy}
                className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
            <label className="text-sm font-medium text-foreground/75">
              Out of scope
              <textarea
                value={outOfScope}
                rows={6}
                onChange={(event) => setOutOfScope(event.target.value)}
                placeholder="One exclusion per line"
                readOnly={readOnly || refusedForNoWiki}
                aria-describedby={describedBy}
                className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
          </div>

          <div className="grid gap-5 border-t border-foreground/10 p-5 md:grid-cols-[220px_minmax(0,1fr)]">
            <label className="text-sm font-medium text-foreground/75">
              Output language
              <input
                value={profile.outputLanguage}
                maxLength={80}
                onChange={(event) => setProfile({ ...profile, outputLanguage: event.target.value })}
                placeholder="English"
                readOnly={readOnly || refusedForNoWiki}
                aria-describedby={describedBy}
                className="mt-1.5 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
            <label className="text-sm font-medium text-foreground/75">
              Page conventions
              <textarea
                value={profile.pageConventions}
                maxLength={8_000}
                rows={4}
                onChange={(event) => setProfile({ ...profile, pageConventions: event.target.value })}
                placeholder="How should work-wiki organize, qualify, and connect generated knowledge?"
                readOnly={readOnly || refusedForNoWiki}
                aria-describedby={describedBy}
                className="mt-1.5 block w-full resize-y rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground/30 focus:border-foreground/35"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-foreground/10 px-5 py-4">
            <button
              type="submit"
              className={`btn primary${readOnly || refusedForNoWiki ? " opacity-60" : ""}`}
              // `saving` keeps `disabled` — it is transient, and there is no
              // reason to announce for a request already in flight. Both
              // refusals take `aria-disabled` so the owner can still reach the
              // button and hear why it will not run; `save()` early-returns on
              // each of them, which is what actually refuses.
              disabled={saving}
              aria-disabled={readOnly || refusedForNoWiki || undefined}
              aria-describedby={describedBy}
            >
              {saving ? "Saving…" : "Save Workspace Purpose"}
            </button>
            {savedAt && (
              <span className="text-xs text-foreground/40">
                Last saved {new Date(savedAt).toLocaleString()}
              </span>
            )}
          </div>
        </fieldset>
      </form>

      {/* Identified so every refused control above can point at it: this is the
          only place the reason for their refusal is stated at all. Not
          `role="alert"` — nothing failed; it is the deployment's standing
          state. */}
      {readOnly && (
        <p
          id={readOnlyNoteId}
          className="mt-3 text-sm text-amber-700 dark:text-amber-400"
        >
          {WORKSPACE_PURPOSE_READ_ONLY_COPY}
        </p>
      )}
      {feedback && (
        <div
          // A live region, because every sentence this banner carries is the
          // OUTCOME of something the owner did or something that changed
          // underneath them — a save, a refusal, a failed load, a wiki that
          // moved — and none of it is announced anywhere else (DW-142).
          // `status` is polite for a confirmation; anything that failed or took
          // work away is assertive.
          role={feedback.ok ? "status" : "alert"}
          className={`mt-4 rounded-lg border p-3 text-sm ${
            feedback.ok
              ? "border-green-500/20 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
              : "border-red-500/20 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
          }`}
        >
          {feedback.message}
        </div>
      )}
    </section>
  );
}
