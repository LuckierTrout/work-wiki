"use client";

import { useState } from "react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { useSlugTenants } from "@/hooks/useSlugTenants";

interface SlidePreviewProps {
  content: string; // raw Marp markdown from LLM
}

/**
 * Strip the Marp frontmatter block and split on `---` slide separators.
 * Returns an array of slide markdown strings.
 */
function parseSlides(content: string): string[] {
  // Strip leading frontmatter (---\n...\n---\n)
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n?\n?/, "");
  // Split on slide separator lines
  return stripped
    .split(/\n---\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * There is deliberately NO `slugTenants` prop.
 *
 * In-content `[x](slug.md)` links inside the slides need a slug→tenant map, and
 * taking one from the parent looked like the cheap fix — but one parent is
 * `ArticleView`, an async SERVER component holding the map from the UNGATED
 * `buildSlugTenantMap()`. This component is `"use client"`, so any prop it
 * accepts is serialized into the RSC payload: a map prop would have shipped
 * every private page's slug→owner pairing to whoever opened a legacy Marp deck.
 * (`MarkdownRenderer` has no `"use client"` directive, which is why
 * `ArticleView` may keep handing ITS renderer the same map — that one never
 * crosses the boundary.)
 *
 * So the map is fetched HERE, from the readability-gated `/api/wiki/routes`,
 * where a viewer can only ever be handed their own readable pages. The hook's
 * session cache means this costs no extra request when a sibling already
 * loaded it.
 */
export function SlidePreview({ content }: SlidePreviewProps) {
  const { slugTenants } = useSlugTenants();
  const slides = parseSlides(content);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);

  const total = slides.length;

  if (total === 0) {
    return (
      <div className="prose prose-neutral dark:prose-invert max-w-none">
        <p className="text-foreground/60 italic">No slides found.</p>
      </div>
    );
  }

  if (showAll) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground/60">
            All {total} slide{total !== 1 ? "s" : ""}
          </span>
          <button
            onClick={() => setShowAll(false)}
            className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm font-medium hover:bg-foreground/5 transition-colors"
          >
            Single view
          </button>
        </div>
        {slides.map((slide, i) => (
          <div
            key={i}
            className="slide-content relative flex min-h-[20rem] flex-col justify-center rounded-lg border border-foreground/10 bg-foreground/[0.02] p-8"
          >
            <span className="absolute top-3 right-3 text-xs font-medium text-foreground/40 bg-foreground/5 rounded-full px-2 py-0.5">
              {i + 1}
            </span>
            <MarkdownRenderer content={slide} slugTenants={slugTenants} />
          </div>
        ))}
      </div>
    );
  }

  const safeIndex = Math.min(currentIndex, total - 1);

  return (
    <div className="space-y-4">
      {/* Slide card */}
      <div className="slide-content relative flex min-h-[24rem] flex-col justify-center rounded-lg border border-foreground/10 bg-foreground/[0.02] p-8">
        <span className="absolute top-3 right-3 text-xs font-medium text-foreground/40 bg-foreground/5 rounded-full px-2 py-0.5">
          {safeIndex + 1}
        </span>
        <MarkdownRenderer content={slides[safeIndex]} slugTenants={slugTenants} />
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
          disabled={safeIndex === 0}
          aria-label="Previous slide"
          className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm font-medium hover:bg-foreground/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ← Prev
        </button>

        <span
          className="text-sm text-foreground/60"
          aria-live="polite"
          aria-atomic="true"
        >
          Slide {safeIndex + 1} of {total}
        </span>

        <button
          onClick={() => setCurrentIndex((i) => Math.min(total - 1, i + 1))}
          disabled={safeIndex === total - 1}
          aria-label="Next slide"
          className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm font-medium hover:bg-foreground/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Next →
        </button>
      </div>

      {/* Show all toggle */}
      {total > 1 && (
        <div className="text-center">
          <button
            onClick={() => setShowAll(true)}
            className="text-sm text-foreground/50 hover:text-foreground/80 underline transition-colors"
          >
            Show all slides
          </button>
        </div>
      )}
    </div>
  );
}
