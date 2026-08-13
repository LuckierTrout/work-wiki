import type { MetadataRoute } from "next";

/**
 * PWA manifest. Beyond making work-wiki installable, its real job is the **Web
 * Share Target**: once installed (Android Chrome especially), work-wiki appears in
 * the OS share sheet, and sharing a link does `GET /save?url=&title=&text=` →
 * the capture page ingests it. iOS Safari doesn't support share_target (the
 * /save guide documents an Apple Shortcut for that case).
 *
 * `share_target` is a typed field on Next's `MetadataRoute.Manifest`, and Next
 * serializes this object into `/manifest.webmanifest`. (share-target.test.ts
 * asserts the share_target shape so a refactor can't silently drop the surface.)
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "work-wiki — a shared second brain for humans and agents",
    short_name: "work-wiki",
    description: "Save any link to work-wiki for ingesting into the commons.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0b",
    theme_color: "#0a0a0b",
    icons: [
      { src: "/pwa-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    share_target: {
      action: "/save",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    },
  };
}
