// Capture surfaces — the shared logic behind the three no-extension ways to send
// a URL to work-wiki: a desktop bookmarklet, the PWA Web Share Target
// (Android), and an iOS Shortcut. All three land on `/save`, which files
// through Workbench Intake (`POST /api/workbench/intake`). These helpers are
// pure so they're testable in isolation (the surfaces themselves are a page +
// a manifest).

const URL_RE = /https?:\/\/[^\s<>"']+/i;

/**
 * Resolve the URL to ingest from a capture request's params. Prefers an explicit
 * `url`, but falls back to the FIRST http(s) link found in `text` — the Web Share
 * Target spec lets a sharing app drop the link into `text` instead of `url` (many
 * Android apps do), so we recover it. Returns null when neither yields a URL.
 */
export function resolveSharedUrl(
  url?: string | null,
  text?: string | null,
): string | null {
  const direct = (url ?? "").trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  const fromText = (text ?? "").match(URL_RE)?.[0];
  return fromText ?? null;
}

/**
 * Leftover share or selection text after the resolved URL is removed.
 *
 * A share often puts the same link in `text` as in `url`; stripping it leaves
 * the leftover sentence. A bookmarklet selection usually does not contain the
 * page URL, so the whole selection is the clip. Empty after the strip means
 * there was no clip — Intake fetches the page.
 */
export function isolateCaptureClip(
  text?: string | null,
  resolvedUrl?: string | null,
): string {
  const raw = (text ?? "").trim();
  if (!raw) return "";
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (!resolvedUrl) return tokens.join(" ");
  const url = resolvedUrl.replace(/\/+$/, "");
  const leftover = tokens.filter((token) => {
    const stripped = token.replace(/[.,;:?!)]+$/g, "").replace(/\/+$/, "");
    return stripped !== url && stripped !== resolvedUrl;
  });
  return leftover.join(" ");
}

/**
 * What `/save` should render: a Capture attempt (bookmarklet / share /
 * Shortcut) versus the how-to guide.
 *
 * A present `url` or `text` query is a capture even when neither resolves to
 * a URL — a clipless non-URL must show Capture with the empty sentence, not
 * silently open only the guide.
 */
export function captureFromQuery(
  url?: string | null,
  text?: string | null,
): { url: string; clip: string; attempted: boolean } {
  const resolved = resolveSharedUrl(url, text);
  return {
    url: resolved ?? "",
    clip: isolateCaptureClip(text, resolved),
    attempted: url != null || text != null,
  };
}

/**
 * Build the desktop bookmarklet for a given site origin. Clicking it on any page
 * opens work-wiki's `/save` in a small popup, passing the current tab's URL,
 * title, and any text selection.
 * The popup loads on work-wiki's OWN origin, so the user's existing session cookie
 * authenticates the save — no token, no CORS. Generated from the live origin so it
 * always points at wherever work-wiki is served (e.g. yopedia.yolog.dev).
 */
/**
 * Display host for a URL — the hostname without a leading `www.`, or the raw
 * input unchanged if it doesn't parse. Used by the capture UI to show
 * "example.com" instead of a long URL.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function buildBookmarklet(origin: string): string {
  const base = origin.replace(/\/+$/, "");
  return (
    "javascript:(function(){window.open('" +
    base +
    "/save?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)+'&text='+encodeURIComponent(String(getSelection()||''))," +
    "'work-wiki-save','width=440,height=620,noopener=no');})();"
  );
}
