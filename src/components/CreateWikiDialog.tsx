"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useDialogA11y } from "@/hooks/useDialogA11y";
import {
  CREATABLE_SCENARIOS,
  MAX_WIKI_NAME_CHARS,
  SCENARIO_LABELS,
  scenarioTemplate,
  type CreatableScenario,
} from "@/lib/wiki-scenarios";

/**
 * Create Wiki (FR-38 / UX-DR19).
 *
 * Exactly five Scenario Templates, no blank option and no free-form template:
 * the picker enumerates {@link CREATABLE_SCENARIOS} and nothing else, so there
 * is no path through this dialog that produces an unseeded Wiki. Business is
 * preselected because it is the default working scenario; the name field is
 * prefilled with the selected template's label and stays in sync until the
 * owner types their own name.
 *
 * The cards are toggle buttons (`aria-pressed`), not navigation links: inside a
 * fieldset, `aria-current` would leave a screen reader hearing five plain
 * buttons with no selected state.
 *
 * Focus, Tab trapping, Esc, scroll lock, and focus restore come from the
 * shared {@link useDialogA11y} hook.
 */

export interface CreateWikiDialogProps {
  open: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onCreate: (input: { name: string; scenario: CreatableScenario }) => void;
  /** Where focus goes on close if creating replaced the opening button. */
  fallbackFocusRef?: React.RefObject<HTMLElement | null>;
}

const DEFAULT_SCENARIO: CreatableScenario = "business";

export function CreateWikiDialog({
  open,
  busy = false,
  error = null,
  onCancel,
  onCreate,
  fallbackFocusRef,
}: CreateWikiDialogProps) {
  const [scenario, setScenario] = useState<CreatableScenario>(DEFAULT_SCENARIO);
  const [name, setName] = useState(SCENARIO_LABELS[DEFAULT_SCENARIO]);
  const [renamed, setRenamed] = useState(false);
  const titleId = useId();
  const nameId = useId();

  const cancel = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);
  const { dialogRef } = useDialogA11y({
    open,
    onDismiss: cancel,
    busy,
    fallbackFocusRef,
  });

  // Reopening starts clean — a cancelled attempt must leave nothing behind.
  // Reset on CLOSE, not on open: an effect keyed to `open === true` runs after
  // the reopened dialog has already painted, flashing the abandoned attempt's
  // name and card selection for a frame before snapping back to the defaults.
  useEffect(() => {
    if (open) return;
    setScenario(DEFAULT_SCENARIO);
    setName(SCENARIO_LABELS[DEFAULT_SCENARIO]);
    setRenamed(false);
  }, [open]);

  if (!open) return null;

  function pick(next: CreatableScenario) {
    setScenario(next);
    if (!renamed) setName(SCENARIO_LABELS[next]);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    onCreate({ name: name.trim(), scenario });
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fade w-full max-w-2xl overflow-hidden rounded-xl border border-foreground/15 bg-background shadow-xl outline-none"
      >
        <form onSubmit={submit}>
          <div className="border-b border-foreground/10 px-5 py-4">
            <h2 id={titleId} className="text-base font-semibold text-foreground">
              Create Wiki
            </h2>
            <p className="mt-1 text-sm leading-6 text-foreground/60">
              Pick one Scenario Template. This writes purpose.md and Schema. There is
              no blank wiki.
            </p>
          </div>

          <div className="px-5 py-4">
            <label htmlFor={nameId} className="text-sm font-medium text-foreground/75">
              Wiki name
            </label>
            <input
              id={nameId}
              value={name}
              required
              maxLength={MAX_WIKI_NAME_CHARS}
              disabled={busy}
              onChange={(event) => {
                setName(event.target.value);
                setRenamed(true);
              }}
              className="mt-1.5 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-foreground/35"
            />

            <fieldset className="mt-5">
              <legend className="text-sm font-medium text-foreground/75">
                Scenario Template
              </legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {CREATABLE_SCENARIOS.map((value) => {
                  const template = scenarioTemplate(value);
                  const selected = value === scenario;
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={busy}
                      aria-pressed={selected}
                      onClick={() => pick(value)}
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        selected
                          ? "border-foreground/60 bg-foreground/[0.06]"
                          : "border-foreground/15 hover:border-foreground/35"
                      }`}
                    >
                      <span className="block text-sm font-semibold text-foreground">
                        {SCENARIO_LABELS[value]}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-foreground/55">
                        {template.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {error && (
              <p role="alert" className="mt-4 text-sm text-red-700">
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-foreground/10 px-5 py-4">
            <button type="button" className="btn ghost" onClick={cancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
