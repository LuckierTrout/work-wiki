"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useMemo } from "react";
import { slugify } from "@/lib/slugify";
import { getErrorMessage } from "@/lib/errors";
import { Alert } from "@/components/Alert";
import { TemplateSelector } from "@/components/TemplateSelector";

/**
 * Why Create page refuses, said out loud.
 *
 * NARROWER than the sentence the door behind it answers, on purpose. `POST
 * /api/wiki` spells no refusal of its own — it maps the KERNEL page writer's,
 * `READ_ONLY_REFUSAL.pageWrite` ("Pages cannot be written…"), which covers
 * create, edit, revert and re-ingest alike. That is true here and useless
 * beside a button labelled Create page, so the surface says what the owner was
 * about to do. `read-only-copy-parity.test.ts` records the divergence
 * explicitly, the same way it records the Revert control's.
 *
 * Duplicated rather than imported because `read-only.ts` pulls `./config` (the
 * settings/storage graph, and `process.env`), which does not belong in a
 * browser bundle.
 */
export const CREATE_PAGE_READ_ONLY_COPY =
  "Pages cannot be created while this deployment is read-only.";

export interface NewWikiFormProps {
  /**
   * `YOPEDIA_READONLY=1`, read on the SERVER by the page that renders this.
   *
   * The whole reason `/wiki/new` was split: this form used to be the page, so
   * the env fact had nowhere to be read and the owner composed a title, a slug
   * and an entire markdown body before meeting the 403. The page above is a
   * server component now and passes the answer down, so the refusal is stated
   * before the first keystroke.
   *
   * The FIELDS stay live regardless — `readOnly` refuses the SUBMIT, not the
   * composing. A draft the owner can still select and copy out is worth more
   * than a locked form, and `aria-disabled` (never `disabled`) keeps the submit
   * itself in the tab order so the sentence can be announced with it.
   */
  readOnly?: boolean;
}

export function NewWikiForm({ readOnly = false }: NewWikiFormProps) {
  const router = useRouter();
  const noteId = useId();
  const [title, setTitle] = useState("");
  const [slugOverride, setSlugOverride] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const autoSlug = useMemo(() => slugify(title), [title]);
  const slug = slugOverride || autoSlug;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // BEFORE the validation and before the request. The server answers 403
    // either way, and an owner who has just composed a page deserves the reason
    // in place of "Please enter a title or slug." — a complaint about a field
    // that was never the problem.
    if (readOnly) return;
    setError(null);

    const trimmedSlug = slug.trim();
    if (!trimmedSlug) {
      setError("Please enter a title or slug.");
      return;
    }

    // Build the markdown body — prepend an H1 from the title if the user
    // didn't already start the content with one.
    let body = content.trim();
    const hasH1 = /^#\s+.+$/m.test(body);
    if (!hasH1 && title.trim()) {
      body = `# ${title.trim()}\n\n${body}`;
    }
    if (!body) {
      setError("Content must not be empty.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/wiki", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: trimmedSlug, content: body }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }
      // Navigate to the canonical owner-qualified URL (owner echoed by the API).
      const tenant =
        typeof data.owner === "string" && data.owner.trim()
          ? data.owner.trim().toLowerCase()
          : "yopedia";
      router.push(`/u/${tenant}/${trimmedSlug}`);
    } catch (err) {
      setError(getErrorMessage(err, "Network error"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-4xl space-y-5 border-t border-rule pt-7">
      {/* Identified so the submit can point at it: this is the only place the
          reason for the refusal is stated at all. Stated ABOVE the fields
          rather than beside the button, because the harm being fixed is the
          owner composing a whole page first. Not `role="alert"` — nothing
          failed; it is the deployment's standing state. */}
      {readOnly && (
        <p id={noteId} className="text-sm text-amber-700 dark:text-amber-400">
          {CREATE_PAGE_READ_ONLY_COPY}
        </p>
      )}

      {/* Title */}
      <div>
        <label htmlFor="title" className="block text-sm font-medium mb-1">
          Title
        </label>
        <input
          id="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Transformer Architecture"
          className="w-full rounded-lg border border-foreground/10 bg-transparent px-4 py-2 text-sm outline-none focus:border-foreground/30 transition-colors"
        />
      </div>

      {/* Slug */}
      <div>
        <label htmlFor="slug" className="block text-sm font-medium mb-1">
          Slug
        </label>
        <input
          id="slug"
          type="text"
          value={slugOverride || autoSlug}
          onChange={(e) => setSlugOverride(e.target.value)}
          placeholder="auto-generated-from-title"
          className="w-full rounded-lg border border-foreground/10 bg-transparent px-4 py-2 text-sm font-mono outline-none focus:border-foreground/30 transition-colors"
        />
        {slug && (
          <p className="mt-1 text-xs text-foreground/50">
            Will be created as: <code className="font-mono">{slug}.md</code>
          </p>
        )}
      </div>

      {/* Template selector */}
      <TemplateSelector onSelect={(tpl) => setContent(tpl)} />

      {/* Content */}
      <div>
        <label htmlFor="content" className="block text-sm font-medium mb-1">
          Content (Markdown)
        </label>
        <textarea
          id="content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={14}
          placeholder={`Write your wiki page content here…\n\nThe title above will be added as an H1 heading automatically.\n\n## Overview\n\nA brief summary paragraph…\n\n## Details\n\nMore in-depth information…`}
          className="w-full rounded-lg border border-foreground/10 bg-transparent px-4 py-2 text-sm font-mono outline-none focus:border-foreground/30 transition-colors resize-y"
        />
      </div>

      {/* Error */}
      {error && (
        <Alert variant="error">
          {error}
        </Alert>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          // `loading` is TRANSIENT and keeps `disabled`. `!slug` is VALUE state
          // and YIELDS to the refusal, the `WorkspacePurposeSettings` rule: a
          // read-only page opens with an empty slug, so leaving that leg in
          // would take the button out of the tab order carrying the only
          // `aria-describedby` pointer some owners have to the sentence — the
          // exact harm this change exists to remove. `handleSubmit`
          // early-returns on `readOnly`, so an editable page is unaffected.
          disabled={loading || (!readOnly && !slug)}
          aria-disabled={readOnly || undefined}
          aria-describedby={readOnly ? noteId : undefined}
          className={`btn primary disabled:opacity-50 disabled:cursor-not-allowed${
            readOnly ? " opacity-50 cursor-default" : ""
          }`}
        >
          {loading ? "Creating…" : "Create page"}
        </button>
        <button
          type="button"
          onClick={() => router.push("/")}
          className="btn ghost"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
