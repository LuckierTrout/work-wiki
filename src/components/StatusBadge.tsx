"use client";

import { useEffect, useState } from "react";
import { providerLabel } from "@/lib/providers";

interface ProviderInfo {
  configured: boolean;
  provider: string | null;
  model: string | null;
  embeddingSupport: boolean;
  /**
   * Why `OLLAMA_BASE_URL` was thrown away, as `/api/status` serves it (DW-402).
   *
   * The panel below lists that variable as a remedy. On a deployment that SET
   * it and had it refused, the list was advice the owner had already followed:
   * "no provider configured" is what the absence and the rejection both look
   * like from here, and only the rejection has a fix.
   */
  ollamaBaseUrlIssue: string | null;
  /**
   * Whether the stored settings could not be READ, as `/api/status` serves it
   * (DW-622).
   *
   * A store that exists and could not be parsed degrades every field above this
   * one to what the environment alone resolves — so `configured: false` reads
   * the same for "nothing was ever saved" and for "what you saved could not be
   * read", and only the second is a file to go and fix. It is a caveat on the
   * whole reading, which is why it renders in BOTH states below.
   *
   * A BOOLEAN, deliberately. The route serves no parser text and no bytes: the
   * config file holds API keys and a `JSON.parse` message quotes the offending
   * bytes back. The detail is warn-logged server-side and printed by the CLI's
   * `status` command, where the reader is already on the machine.
   *
   * WHERE THIS ACTUALLY RENDERS TODAY: nowhere. Nothing in the repo imports this
   * component — `src/app/settings/page.tsx` hand-duplicates its verdict UI and
   * says so — so the live reader of `configUnreadable` is the `/api/status` body
   * itself, and the JSX below is where the sentence lands the moment anything
   * mounts this. That is not a gap left open on the mounted surface: an
   * unreadable store takes `GET /api/settings` to its 503, which short-circuits
   * the settings page into its load-error branch, so the page never reaches the
   * state where a reassuring verdict could be rendered over a store nobody could
   * read. Which is also why the flag stops here and is NOT added to
   * `useSettings`'s `ProviderStatus` or to that page — there is no conflation
   * there to fix, and a second copy of this fact would be one more thing to
   * keep true.
   */
  configUnreadable: boolean;
}

/**
 * The one sentence the `configUnreadable` flag renders, in both states.
 *
 * ONE constant rather than two literals: the connected and the not-configured
 * branches are saying the identical thing about the identical fact, and two
 * copies are two chances to drift apart. It names no file, no error and no
 * value — everything it could name is either a secret or something the browser
 * operator cannot act on from here; "reload and try again" is the settings
 * page's advice on `PUT`, not this badge's, since nothing here was being saved.
 *
 * "MAY NOT REFLECT THEM", NOT "REFLECTS THE ENVIRONMENT ONLY" — and the weaker
 * claim is the only TRUE one on this surface. `readStoredConfig` does not
 * re-prime the sync cache on its unreadable branch, so the PREVIOUS generation
 * of the config can still be warm behind `loadConfigSync()` for up to the 5 s
 * TTL and `getProviderInfo()` may be answering from the STORED settings after
 * all (`src/lib/llm.ts` documents that window, and leans on it deliberately, so
 * a transient read failure does not knock a working store-only deployment
 * offline). The CLI says the stronger sentence safely because a CLI process
 * always starts cold and there is nothing warm for it to be reading. A long-
 * lived web server has no such guarantee, and a badge that asserted "environment
 * only" would be plainly wrong for the whole of that window. Do not restore it.
 */
export const CONFIG_UNREADABLE_BADGE_COPY =
  "Saved settings could not be read, so what is shown here may not reflect them.";

export function StatusBadge() {
  const [info, setInfo] = useState<ProviderInfo | null>(null);
  const [error, setError] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => {
        if (!r.ok) throw new Error("status fetch failed");
        return r.json();
      })
      .then((data: ProviderInfo) => setInfo(data))
      .catch(() => setError(true));
  }, []);

  if (error) {
    return (
      <div className="mt-4 flex items-center justify-center gap-2 text-sm text-red-500/60">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-400" />
        Unable to check provider status
      </div>
    );
  }
  if (!info) {
    // Loading shimmer
    return (
      <div className="mt-4 flex items-center justify-center gap-2 text-sm text-foreground/40">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-gray-300 dark:bg-gray-600 animate-pulse" />
        Checking provider…
      </div>
    );
  }

  if (info.configured) {
    return (
      <div className="mt-4">
        <div className="flex items-center justify-center gap-2 text-sm text-foreground/60">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" />
          Connected: {providerLabel(info.provider!)} ({info.model})
          {info.embeddingSupport && (
            <span className="ml-1 text-foreground/40">• embeddings ✓</span>
          )}
        </div>
        {/*
          RENDERED HERE TOO, not only on the unconfigured branch. A provider that
          resolved from the ENVIRONMENT reads as a complete success, and the
          stored half of the settings being unreadable is invisible behind it —
          a saved model or endpoint the owner expects to be in force is simply
          not.
        */}
        {info.configUnreadable && (
          <p className="mt-1 text-center text-xs text-amber-600 dark:text-amber-400">
            {CONFIG_UNREADABLE_BADGE_COPY}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 text-center">
      <div className="flex items-center justify-center gap-2 text-sm text-amber-600 dark:text-amber-400">
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" />
        No LLM provider configured
      </div>
      {/*
        ABOVE the disclosure, not inside the panel. The panel is a list of
        environment variables to set, and this is not one more remedy to try:
        the environment may be perfectly fine and the STORE unreadable. It also
        has to be legible without opening anything, since an owner who reads
        "no provider configured" and goes to set a variable would otherwise
        never learn the saved one was there all along.
      */}
      {info.configUnreadable && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          {CONFIG_UNREADABLE_BADGE_COPY}
        </p>
      )}
      <button
        onClick={() => setShowHelp((v) => !v)}
        className="mt-1 text-xs text-foreground/40 hover:text-foreground/60 underline"
      >
        {showHelp ? "Hide setup instructions" : "How to configure"}
      </button>
      {showHelp && (
        <div className="mt-3 mx-auto max-w-md rounded-lg border border-amber-200 bg-amber-50 p-4 text-left text-xs dark:border-amber-800/50 dark:bg-amber-900/20">
          <p className="mb-2 font-medium text-amber-800 dark:text-amber-300">
            Set one of these environment variables:
          </p>
          <ul className="space-y-1 font-mono text-amber-700 dark:text-amber-400">
            <li>ANTHROPIC_API_KEY</li>
            <li>OPENAI_API_KEY</li>
            <li>GOOGLE_GENERATIVE_AI_API_KEY</li>
            <li>DEEPSEEK_API_KEY</li>
            <li>OLLAMA_API_KEY</li>
            <li>OLLAMA_BASE_URL / OLLAMA_MODEL</li>
          </ul>
          {/*
            BENEATH THE LIST, so it reads as a correction to the row above it
            rather than as a separate complaint. Describing copy only — the
            panel offers no input and blocks nothing.
          */}
          {info.ollamaBaseUrlIssue && (
            <p className="mt-2 text-amber-800 dark:text-amber-300">
              {info.ollamaBaseUrlIssue}
            </p>
          )}
          <p className="mt-2 text-foreground/50">
            Optional: <span className="font-mono">LLM_MODEL</span> to override
            the default model,{" "}
            <span className="font-mono">EMBEDDING_MODEL</span> for custom
            embeddings.
          </p>
        </div>
      )}
    </div>
  );
}
