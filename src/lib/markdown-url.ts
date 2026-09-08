/**
 * The app's one markdown URL policy, in a leaf module both render surfaces can
 * import.
 *
 * It used to live beside the article renderer, which pulls in KaTeX, math and
 * the Mermaid client boundary. The Workbench Preview needs the POLICY and none
 * of that machinery, so the function moved here and the article renderer
 * re-exports it unchanged — `src/components/__tests__/markdown-url-transform.
 * test.ts` imports it from that path and is frozen.
 */

import { defaultUrlTransform } from "react-markdown";

/**
 * react-markdown's default `urlTransform` strips `data:` URIs (an XSS guard),
 * which would blank out our baked yoyo-illustration images (stored inline as
 * `data:image/jpeg;base64,…`). Allow **raster** image data URIs through —
 * jpeg/png/gif/webp can't carry script — while still deferring everything else
 * (including the dangerous `data:image/svg+xml` and `data:text/html`) to the
 * default sanitizer.
 */
export function urlTransform(url: string): string {
  if (/^data:image\/(?:png|jpe?g|gif|webp)[;,]/i.test(url)) return url;
  return defaultUrlTransform(url);
}
