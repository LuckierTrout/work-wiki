"use client";

import { useId, useRef, useState } from "react";
import {
  INTAKE_ACCEPT_ATTR,
  INTAKE_BUSY_COPY,
  INTAKE_IMPORT_LABEL,
  INTAKE_READ_ONLY_COPY,
  INTAKE_URL_FIELD_LABEL,
  INTAKE_URL_PLACEHOLDER,
  INTAKE_URL_SUBMIT_LABEL,
} from "@/lib/workbench-intake";

/**
 * Intake's controls: the file picker, and — on the Sources column — the in-app
 * URL field (UX-DR5).
 *
 * `INTAKE_IMPORT_LABEL` is the only label offered, and the retired
 * folder-opening affordance's wording is banned from every source under `src/`
 * by `workbench-left-column.test.ts` — so it is named nowhere here either. There
 * is no directory picker: recursive folder import is Story 2.2, and
 * `webkitdirectory` on this input would ship half of it.
 *
 * NO STATE ABOUT THE ARRIVAL LIVES HERE. The shell owns the in-flight flag, the
 * outcomes and the status sentence, because the SAME submit path is reached from
 * the shell's own drop handler — a component that owned it would leave a drop
 * and a pick reporting themselves differently. What this component owns is the
 * hidden input's ref and the URL field's draft, neither of which anything else
 * can observe.
 *
 * Every sentence comes from `@/lib/workbench-intake`. Two copies of a label
 * that must stay identical are two definitions however close together they sit.
 */

export interface IntakeControlsProps {
  /** Store and queue these files. The shell decides what to say about them. */
  onFiles: (files: readonly File[]) => void;
  /** Store and queue this URL. Only called from the `url` variant. */
  onUrl: (url: string) => void;
  /** An arrival is in flight; the controls stand down rather than queue behind it. */
  busy: boolean;
  /**
   * Read-only deployment. The controls are withheld BEFORE the request, not
   * after the route's 403 — the same rule the Preview's Revert follows (DW-149).
   */
  readOnly?: boolean;
  /** Render the in-app URL field beside the picker (the Sources column does). */
  url?: boolean;
}

export function IntakeControls({
  onFiles,
  onUrl,
  busy,
  readOnly = false,
  url = false,
}: IntakeControlsProps) {
  const fieldId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");

  const disabled = busy || readOnly;

  return (
    <div className="wb-intake">
      <button
        type="button"
        className="wb-intake-pick"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? INTAKE_BUSY_COPY : INTAKE_IMPORT_LABEL}
      </button>
      {/* The picker itself is never the visible control: a bare file input
          cannot be labelled or styled with the rest of the chrome, and the
          button above is what carries the accessible name.

          `aria-hidden` and NOT labelled, for that reason: an `aria-label` here
          put a second node with the same name in the accessibility tree, so the
          one control read as two. It is also `disabled` in the same states as
          the button — the button's `disabled` stops the click that opens this
          dialog, but not a `.click()` from anywhere else, and an input that
          could still open its dialog while a batch was in flight would offer a
          pick the shell then silently drops. */}
      <input
        ref={inputRef}
        type="file"
        className="wb-sr-only"
        multiple
        accept={INTAKE_ACCEPT_ATTR}
        disabled={disabled}
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          // Cleared FIRST, so picking the same file twice fires `change` again:
          // the input compares against its own value, and re-adding a Source
          // whose bytes changed on disk is a real thing to want.
          event.target.value = "";
          if (picked.length > 0) onFiles(picked);
        }}
      />

      {url && (
        <form
          className="wb-intake-url"
          onSubmit={(event) => {
            event.preventDefault();
            // The draft is KEPT. Clearing it here throws away the one thing the
            // owner would need after a refusal — a typo'd host, a page that
            // answered a PDF, a fetch the kernel blocked — and the outcome is
            // not known until the shell reports it, well after this handler has
            // returned. Re-submitting a URL that did store lands on the same
            // content hash and is declined by the writer, so the cost of
            // keeping it is a duplicate that storage refuses; the cost of
            // clearing it is a URL the owner has to find and type again.
            onUrl(draft);
          }}
        >
          {/* Labelled beyond the placeholder (accessibility floor). */}
          <label className="wb-sr-only" htmlFor={fieldId}>
            {INTAKE_URL_FIELD_LABEL}
          </label>
          <input
            id={fieldId}
            type="url"
            className="wb-intake-field"
            placeholder={INTAKE_URL_PLACEHOLDER}
            value={draft}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="wb-intake-submit" disabled={disabled}>
            {INTAKE_URL_SUBMIT_LABEL}
          </button>
        </form>
      )}

      {readOnly && <p className="wb-intake-note">{INTAKE_READ_ONLY_COPY}</p>}
    </div>
  );
}
