// The DISPLAY name only. Every runtime identifier (tenants, owner constants,
// MCP server name, localStorage keys, env/secret names, Cloudflare resource
// names, `X-Yopedia-*` headers) stays `yopedia` — renaming those orphans
// production data (AD-7).
export const APP_NAME = "work-wiki";
export const APP_ORIGIN = "https://workwiki.app";
export const APP_TAGLINE = "a shared second brain for humans and agents";
export const APP_TITLE = `${APP_NAME} — ${APP_TAGLINE}`;
