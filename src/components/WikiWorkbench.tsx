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
 * The Wiki surface on the owner's landing page.
 *
 * Story 1.2's minimal honest stand-in, now mounted as Story 1.3's Wiki-mode
 * canvas: it lands the owner somewhere real after Create Wiki without building
 * Story 1.4's trees. The seeded file names are inert text on purpose — opening
 * one into a rendered Preview is Story 1.5, so the preview region always reads
 * its empty sentence here.
 */

export interface WikiWorkbenchProps {
  initialWikis: WikiRecord[];
  initialCurrentId: string | null;
  /**
   * The server could not read the registry, so `initialWikis` is a degraded
   * placeholder rather than an observation. Rendering the ordinary empty state
   * here would tell the owner their wikis do not exist and invite them to
   * create a duplicate — and creating one rewrites the tenant workspace
   * profile. Say the read failed instead.
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
  const [error, setError] = useState<string | null>(null);
  // Confirming Create Wiki unmounts the empty state that holds the opening
  // button, so the dialogs need somewhere else to put focus on close.
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Guards the active-wiki <select> against overlapping PUTs, whose responses
  // can settle out of order and roll the selection back to a stale id.
  const [switching, setSwitching] = useState(false);

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
      setError(null);
      // The page is force-dynamic and this rewrote the workspace profile, so
      // profile-derived server output is stale until the tree is refetched.
      router.refresh();
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Couldn’t create the wiki.");
    } finally {
      setBusy(false);
    }
  }

  async function switchWiki(id: string) {
    if (switching) return;
    const previous = currentId;
    setSwitching(true);
    setCurrentId(id);
    setError(null);
    try {
      await send("/api/wikis/current", { method: "PUT", body: JSON.stringify({ id }) });
      // Switching re-seeds the workspace profile too (it is tenant-global
      // while schema.md is per-Wiki), so the server tree is stale as well.
      router.refresh();
    } catch (cause) {
      setCurrentId(previous);
      setError(cause instanceof Error ? cause.message : "Couldn’t switch wiki.");
    } finally {
      setSwitching(false);
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
        // would rewrite the workspace profile on the strength of a read error.
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
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">{current.name}</p>
                <p className="mt-0.5 text-xs text-foreground/50">
                  {SCENARIO_LABELS[current.scenario]}
                </p>
              </div>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setCreateError(null);
                  setCreateOpen(true);
                }}
              >
                New wiki
              </button>
            </div>

            {wikis.length > 1 && (
              <div className="mt-4">
                <label
                  htmlFor="wiki-workbench-switcher"
                  className="text-xs font-medium text-foreground/60"
                >
                  Active wiki
                </label>
                <select
                  id="wiki-workbench-switcher"
                  value={current.id}
                  disabled={switching}
                  onChange={(event) => void switchWiki(event.target.value)}
                  className="mt-1 block w-full rounded-lg border border-foreground/15 bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-foreground/35"
                >
                  {wikis.map((wiki) => (
                    <option key={wiki.id} value={wiki.id}>
                      {wiki.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

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

          <div className="rounded-xl border border-foreground/15 p-6">
            <p className="text-sm text-foreground/50">Select a file to preview.</p>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
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
        // through a destructive confirm would rewrite purpose, Schema and the
        // profile to identical bytes and bump updatedAt for nothing.
        confirmDisabled={pendingScenario === current?.scenario}
        error={templateError}
        fallbackFocusRef={headingRef}
        onCancel={() => setTemplateOpen(false)}
        onConfirm={() => void applyTemplate()}
        body={
          <>
            <p>
              This overwrites purpose.md and Schema for this wiki. Pages and Sources are
              not changed.
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
