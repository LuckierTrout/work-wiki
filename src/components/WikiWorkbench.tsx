"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CreateWikiDialog } from "@/components/CreateWikiDialog";
import {
  CREATABLE_SCENARIOS,
  SCENARIO_LABELS,
  WIKI_ARTIFACT_FILES,
  type CreatableScenario,
} from "@/lib/wiki-scenarios";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The Wiki surface on the owner's landing page — the Wiki-mode canvas.
 *
 * It owns the artifact receipt (`purpose.md`, `schema.md`), the wiki's name and
 * scenario heading, `Change template`, and the `No wiki yet.` empty state whose
 * `Create Wiki` action lands the owner somewhere real. It does NOT own
 * switching: the left column header's `WikiSwitcher` is the single owner of the
 * active-wiki `<select>` and of the persistent `New Wiki` control (DW-33), so
 * one viewport never offers two of either.
 *
 * The seeded file names are inert text here — opening one into a rendered
 * Preview is the shell's docked `PreviewColumn`. `Select a file to preview.` is
 * this card's undocked stand-in for that column and is mutually exclusive with
 * it: `wb-canvas-preview-note` is hidden by CSS while `.wb-shell` carries
 * `data-preview="true"` (DW-39), because the canvas reaches the shell as
 * `children` and cannot read that state as a prop.
 */

export interface WikiWorkbenchProps {
  initialWikis: WikiRecord[];
  initialCurrentId: string | null;
  /**
   * The server could not read the registry, so `initialWikis` is a degraded
   * placeholder rather than an observation. Rendering the ordinary empty state
   * here would tell the owner their wikis do not exist and invite them to
   * create a duplicate — which seeds a second wiki, makes it the active one,
   * and moves every prompt onto its template. Say the read failed instead.
   */
  unavailable?: boolean;
}

async function send<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function WikiWorkbench({
  initialWikis,
  initialCurrentId,
  unavailable = false,
}: WikiWorkbenchProps) {
  const router = useRouter();
  const [wikis, setWikis] = useState<WikiRecord[]>(initialWikis);
  const [currentId, setCurrentId] = useState<string | null>(initialCurrentId);
  const [createOpen, setCreateOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [pendingScenario, setPendingScenario] = useState<CreatableScenario>("business");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  // Confirming Create Wiki unmounts the empty state that holds the opening
  // button, so the dialogs need somewhere else to put focus on close.
  const headingRef = useRef<HTMLHeadingElement>(null);

  const current = wikis.find((wiki) => wiki.id === currentId) ?? null;

  function replace(wiki: WikiRecord) {
    setWikis((existing) => {
      const index = existing.findIndex((item) => item.id === wiki.id);
      if (index === -1) return [...existing, wiki];
      const next = [...existing];
      next[index] = wiki;
      return next;
    });
  }

  async function create(input: { name: string; scenario: CreatableScenario }) {
    setBusy(true);
    setCreateError(null);
    try {
      const { wiki } = await send<{ wiki?: WikiRecord }>("/api/wikis", {
        method: "POST",
        body: JSON.stringify(input),
      });
      // A 2xx whose body is not the documented shape must not reach state:
      // pushing `undefined` here crashes the very next render on `wiki.id`,
      // which is a blank page rather than the error message below.
      if (!wiki?.id) throw new Error("Couldn’t create the wiki.");
      setWikis((existing) => [...existing, wiki]);
      setCurrentId(wiki.id);
      setCreateOpen(false);
      // The page is force-dynamic and this seeded a new wiki — its own
      // purpose.md, Schema and Workspace Purpose — and made it active, so the
      // wiki-derived server output is stale until the tree is refetched.
      router.refresh();
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Couldn’t create the wiki.");
    } finally {
      setBusy(false);
    }
  }

  async function applyTemplate() {
    if (!current) return;
    setBusy(true);
    setTemplateError(null);
    try {
      const { wiki } = await send<{ wiki?: WikiRecord }>(
        `/api/wikis/${encodeURIComponent(current.id)}/template`,
        { method: "POST", body: JSON.stringify({ scenario: pendingScenario }) },
      );
      if (!wiki?.id) throw new Error("Couldn’t apply the template.");
      replace(wiki);
      setTemplateOpen(false);
      router.refresh();
    } catch (cause) {
      // Into the dialog, not the section: the overlay stays open on failure
      // and its backdrop covers everything this component renders behind it.
      setTemplateError(
        cause instanceof Error ? cause.message : "Couldn’t apply the template.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wb-canvas-pad" aria-labelledby="wiki-workbench-heading">
      {/* h2, not h1: the Workbench shell's product title owns the page's h1. */}
      <h2
        ref={headingRef}
        id="wiki-workbench-heading"
        tabIndex={-1}
        className="text-lg font-semibold text-foreground outline-none"
      >
        Wiki
      </h2>

      {unavailable ? (
        // NOT the empty state: "No wiki yet." would be a claim about the
        // registry that this render cannot make, and its Create Wiki button
        // would seed a duplicate wiki and move every prompt onto its template
        // on the strength of a read error.
        <div className="mt-4 rounded-xl border border-foreground/15 p-6">
          <p role="alert" className="text-sm text-foreground/60">
            Your wikis couldn’t be loaded. Reload to try again.
          </p>
        </div>
      ) : !current ? (
        <div className="mt-4 rounded-xl border border-foreground/15 p-6">
          <p className="text-sm text-foreground/60">No wiki yet.</p>
          <button
            type="button"
            className="btn primary mt-4"
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
          >
            Create Wiki
          </button>
        </div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <div className="rounded-xl border border-foreground/15 p-4">
            {/* Which Wiki this card describes, and nothing to change it with:
                the switcher and New Wiki live in the left column header, which
                is the single owner of both (DW-33). */}
            <div>
              <p className="text-sm font-semibold text-foreground">{current.name}</p>
              <p className="mt-0.5 text-xs text-foreground/50">
                {SCENARIO_LABELS[current.scenario]}
              </p>
            </div>

            <ul className="mt-4 space-y-1 text-sm text-foreground/70">
              {WIKI_ARTIFACT_FILES.map((file) => (
                <li key={file} className="receipt text-xs text-foreground/60">
                  {file}
                </li>
              ))}
            </ul>

            <button
              type="button"
              className="btn ghost mt-4 w-full justify-center"
              onClick={() => {
                setPendingScenario(current.scenario);
                setTemplateError(null);
                setTemplateOpen(true);
              }}
            >
              Change template
            </button>
          </div>

          {/* The undocked stand-in for the Preview column. `display: none` while
              the real column is docked, decided in CSS off the shell's
              `data-preview` (DW-39) — this card cannot see that state. */}
          <div className="wb-canvas-preview-note rounded-xl border border-foreground/15 p-6">
            <p className="text-sm text-foreground/50">Select a file to preview.</p>
          </div>
        </div>
      )}

      <CreateWikiDialog
        open={createOpen}
        busy={busy}
        error={createError}
        fallbackFocusRef={headingRef}
        onCancel={() => setCreateOpen(false)}
        onCreate={(input) => void create(input)}
      />

      <ConfirmDialog
        open={templateOpen}
        title="Change Scenario Template"
        confirmLabel="Overwrite"
        cancelLabel="Cancel"
        busy={busy}
        // The dialog opens on the Wiki's current scenario, so the default path
        // through a destructive confirm would rewrite this wiki's purpose,
        // Schema and Workspace Purpose to identical template bytes — discarding
        // any hand-authored purpose — and bump updatedAt for nothing.
        confirmDisabled={pendingScenario === current?.scenario}
        error={templateError}
        fallbackFocusRef={headingRef}
        onCancel={() => setTemplateOpen(false)}
        onConfirm={() => void applyTemplate()}
        body={
          <>
            <p>
              This overwrites purpose.md, Schema, and the Workspace Purpose for this
              wiki — a purpose you wrote in Settings will be replaced by the new
              template’s. Other wikis, Pages and Sources are not changed.
            </p>
            <label
              htmlFor="wiki-workbench-template"
              className="mt-4 block text-xs font-medium text-foreground/60"
            >
              Scenario Template
            </label>
            <select
              id="wiki-workbench-template"
              value={pendingScenario}
              disabled={busy}
              onChange={(event) =>
                setPendingScenario(event.target.value as CreatableScenario)
              }
              className="mt-1 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-foreground/35"
            >
              {CREATABLE_SCENARIOS.map((value) => (
                <option key={value} value={value}>
                  {SCENARIO_LABELS[value]}
                </option>
              ))}
            </select>
            {pendingScenario === current?.scenario && (
              // Without this the owner meets a dead primary button and no
              // reason for it: the dialog opens on the current template, so
              // its default state is always the disabled one.
              <p className="mt-2 text-xs text-foreground/50">
                Pick a different template to overwrite this wiki.
              </p>
            )}
          </>
        }
      />
    </section>
  );
}
