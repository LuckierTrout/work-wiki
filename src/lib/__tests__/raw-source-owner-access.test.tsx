import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Only framework identity/navigation and the unrelated wikilink-map hook are
// replaced. Authorization, owner matching, tree/path derivation, lifecycle,
// source readers and the mounted browser all execute against synthetic storage.
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(),
  getServicePrincipal: vi.fn(() => null),
}));
vi.mock("next/navigation", () => ({
  permanentRedirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));
vi.mock("@/hooks/useSlugTenants", () => ({ useSlugTenants: () => ({ slugTenants: {} }) }));

import * as wiki from "@/lib/wiki";
import { getPrincipal, type Principal } from "@/lib/auth";
import { resetAliasIndex } from "@/lib/alias-index";
import { getStorage, _resetStorage } from "@/lib/storage";
import { serializeSources } from "@/lib/sources";
import type { Frontmatter } from "@/lib/frontmatter";
import RawSourcePage from "@/app/u/[handle]/raw/[slug]/page";
import { GET } from "@/app/api/raw/[slug]/route";
import { permanentRedirect } from "next/navigation";

const OWNER_ID = "user_stable_owner";
const LEGACY = "Original legacy source bytes.\nSecond line preserved.";
const OLDER = "First captured snapshot.\nOriginal bytes.";
const NEWER = "Second captured snapshot.\nDifferent source bytes.";
const RAW_IDS = [OLDER, NEWER].map((content) => createHash("sha256").update(content).digest("hex"));
let tmpDir: string;

function session(id: string, handle: string): Principal {
  return { id, handle };
}
function page(slug: string, handle = "owner--researcher") {
  return RawSourcePage({ params: Promise.resolve({ slug, handle }) });
}
function api(slug: string, source?: string) {
  const query = source === undefined ? "" : `?source=${encodeURIComponent(source)}`;
  return GET(new Request(`http://localhost/api/raw/${encodeURIComponent(slug)}${query}`), {
    params: Promise.resolve({ slug }),
  });
}
async function seed(slug: string, fm: Frontmatter = {}) {
  await wiki.writeWikiPageWithSideEffects({
    slug,
    title: slug,
    content: wiki.serializeFrontmatter({
      owner: "owner--researcher", visibility: "public", type: "agent-knowledge",
      created: "2026-09-09", sources: [], ...fm,
    }, `# ${slug}\n\nSynthetic compiled page.`),
    summary: "Synthetic raw-source access fixture",
    logOp: "ingest", crossRefSource: null,
  });
  await wiki.saveRawSource(slug, LEGACY);
}
async function seedSnapshots() {
  await seed("agent-notes", {
    sources: serializeSources(RAW_IDS.map((raw_id, i) => ({
      type: "text", url: "text-paste", fetched: `2026-09-0${i + 1}`,
      triggered_by: "owner", raw_id,
    }))),
  });
  await wiki.saveRawSourceFor("agent-notes", RAW_IDS[0], OLDER);
  await wiki.saveRawSourceFor("agent-notes", RAW_IDS[1], NEWER);
}
async function expectDenied(slug = "agent-notes") {
  const readLegacy = vi.spyOn(wiki, "readRawSource");
  const readSnapshot = vi.spyOn(wiki, "readRawSourceById");
  await expect(page(slug)).rejects.toThrow("NOT_FOUND");
  for (const source of [undefined, RAW_IDS[0]]) {
    const response = await api(slug, source);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  }
  expect(readLegacy).not.toHaveBeenCalled();
  expect(readSnapshot).not.toHaveBeenCalled();
  expect(permanentRedirect).not.toHaveBeenCalled();
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-owner-access-"));
  vi.stubEnv("DATA_DIR", tmpDir);
  vi.stubEnv("WIKI_DIR", path.join(tmpDir, "wiki"));
  vi.stubEnv("RAW_DIR", path.join(tmpDir, "raw"));
  vi.stubEnv("STORAGE_PROVIDER", "fs");
  vi.stubEnv("YOPEDIA_OWNER_USER_ID", OWNER_ID);
  vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "owner");
  vi.stubEnv("ADMIN_HANDLES", "");
  _resetStorage();
  resetAliasIndex();
  vi.mocked(getPrincipal).mockResolvedValue(session(OWNER_ID, "renamed-owner"));
  await wiki.ensureDirectories();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetStorage();
  resetAliasIndex();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("owner raw-source view and download composition", () => {
  it.each(["renamed-owner", OWNER_ID])("serves legacy bytes to the stable-id owner with handle %s", async (handle) => {
    vi.mocked(getPrincipal).mockResolvedValue(session(OWNER_ID, handle));
    await seed("agent-notes");
    const view = await page("agent-notes");
    expect(view.props.initialContent).toBe(LEGACY);
    render(view);
    expect(screen.getByText(/Original legacy source bytes/).textContent).toBe(LEGACY);
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe("/api/raw/agent-notes");
    const response = await api("agent-notes");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(LEGACY);
  });

  it("uses the configured handle fallback when no stable owner id is configured", async () => {
    vi.stubEnv("YOPEDIA_OWNER_USER_ID", "");
    vi.mocked(getPrincipal).mockResolvedValue(session("user_handle_owner", "OwNeR"));
    await seed("agent-notes");
    expect((await page("agent-notes")).props.initialContent).toBe(LEGACY);
    const response = await api("agent-notes");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(LEGACY);
  });

  it("mounts the newest snapshot and downloads exactly the selected stored snapshot", async () => {
    await seedSnapshots();
    const fetchRaw = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      return GET(new Request(url), { params: Promise.resolve({ slug: "agent-notes" }) });
    });
    vi.stubGlobal("fetch", fetchRaw);
    const view = await page("agent-notes");
    expect(view.props.initialContent).toBe(NEWER);
    render(view);
    expect(screen.getByText(/Second captured snapshot/).textContent).toBe(NEWER);
    expect(fetchRaw).not.toHaveBeenCalled();
    const initialHref = screen.getByRole("link", { name: "Download" }).getAttribute("href")!;
    expect(initialHref).toBe(`/api/raw/agent-notes?source=${RAW_IDS[1]}`);
    expect(await (await fetchRaw(initialHref)).text()).toBe(NEWER);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: RAW_IDS[0] } });
    expect((await screen.findByText(/First captured snapshot/)).textContent).toBe(OLDER);
    const selectedHref = screen.getByRole("link", { name: "Download" }).getAttribute("href")!;
    expect(selectedHref).toBe(`/api/raw/agent-notes?source=${RAW_IDS[0]}`);
    expect(fetchRaw).toHaveBeenCalledWith(selectedHref);
    const downloaded = await fetchRaw(selectedHref);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe(OLDER);
    expect((await wiki.readRawSourceById("agent-notes", RAW_IDS[1])).content).toBe(NEWER);
  });

  it.each([
    ["anonymous", null],
    ["unrelated session", session("user_other", "other")],
    ["stale-handle impostor", session("user_impostor", "owner")],
    ["page admin", session("user_admin", "admin")],
  ] as const)("denies %s before either source reader or navigation", async (_label, principal) => {
    await seedSnapshots();
    vi.stubEnv("ADMIN_HANDLES", "user_admin");
    vi.mocked(getPrincipal).mockResolvedValue(principal);
    await expectDenied();
  });

  it("keeps anonymous ordinary-public source view and download", async () => {
    await seed("public-note", { owner: "alice", type: "concept" });
    vi.mocked(getPrincipal).mockResolvedValue(null);
    expect((await page("public-note", "alice")).props.initialContent).toBe(LEGACY);
    const response = await api("public-note");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(LEGACY);
  });

  it("keeps private source access for the permitted owner and refuses anonymous readers", async () => {
    await seed("agent-notes", { visibility: "private" });
    expect((await page("agent-notes")).props.initialContent).toBe(LEGACY);
    expect(await (await api("agent-notes")).text()).toBe(LEGACY);
    vi.mocked(getPrincipal).mockResolvedValue(null);
    await expectDenied();
  });

  it.each(["owner", "anonymous"])("strict frontmatter storage failure denies %s before raw reads", async (caller) => {
    await seed("agent-notes", { visibility: "private" });
    if (caller === "anonymous") vi.mocked(getPrincipal).mockResolvedValue(null);
    const storage = getStorage();
    const readFile = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (key) => {
      if (key.endsWith("/wiki/agent-notes.md")) throw new Error("synthetic storage outage");
      return readFile(key);
    });
    await expectDenied();
  });

  it("fails closed on non-owner gate derivation errors with sanitized API 500", async () => {
    await seed("agent-notes");
    vi.mocked(getPrincipal).mockResolvedValue(null);
    vi.spyOn(wiki, "listReadableWikiPages").mockRejectedValue(new Error("private storage details"));
    const rawRead = vi.spyOn(wiki, "readRawSource");
    await expect(page("agent-notes")).rejects.toThrow("NOT_FOUND");
    const response = await api("agent-notes");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal error" });
    expect(rawRead).not.toHaveBeenCalled();
  });

  it("canonicalizes a wrong handle only for an admitted raw page", async () => {
    await seed("agent-notes");
    await expect(page("agent-notes", "wrong")).rejects.toThrow("REDIRECT:/u/owner--researcher/raw/agent-notes");
    vi.mocked(permanentRedirect).mockClear();
    vi.mocked(getPrincipal).mockResolvedValue(null);
    await expect(page("agent-notes", "wrong")).rejects.toThrow("NOT_FOUND");
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it("keeps owner aliases and API hints while concealing private alias targets", async () => {
    await seed("agent-notes", { visibility: "private", aliases: ["old-note"] });
    await expect(page("old-note", "wrong")).rejects.toThrow("REDIRECT:/u/owner--researcher/raw/agent-notes");
    const ownerMiss = await api("old-note");
    expect(ownerMiss.status).toBe(404);
    expect((await ownerMiss.json()).canonicalSlug).toBe("agent-notes");
    vi.mocked(permanentRedirect).mockClear();
    vi.mocked(getPrincipal).mockResolvedValue(null);
    await expect(page("old-note", "yopedia")).rejects.toThrow("NOT_FOUND");
    const anonymousMiss = await api("old-note");
    expect(anonymousMiss.status).toBe(404);
    expect(await anonymousMiss.json()).not.toHaveProperty("canonicalSlug");
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it("does not redirect a non-owner alias to an agent-scoped raw target", async () => {
    await seed("agent-notes", { aliases: ["old-note"] });
    vi.mocked(getPrincipal).mockResolvedValue(null);
    await expect(page("old-note", "yopedia")).rejects.toThrow("NOT_FOUND");
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it("keeps an archived raw-only alias at its original slug", async () => {
    await seed("survivor", { owner: "alice", type: "concept", aliases: ["archived"] });
    await wiki.saveRawSource("archived", LEGACY);
    vi.mocked(getPrincipal).mockResolvedValue(null);
    expect((await page("archived", "yopedia")).props.initialContent).toBe(LEGACY);
    const response = await api("archived");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(LEGACY);
    expect(permanentRedirect).not.toHaveBeenCalled();
  });

  it.each(["../secret", "agent-notes/../../secret", "agent-notes\\secret"])("does not expose bytes for invalid slug %s", async (slug) => {
    await seed("agent-notes");
    const response = await api(slug);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(LEGACY);
    await expect(page(slug, "yopedia")).rejects.toThrow("NOT_FOUND");
  });

  it.each(["../secret", "not-a-hash", "a1b2c3d4/../../secret"])("refuses invalid selected source %s", async (source) => {
    await seedSnapshots();
    const response = await api("agent-notes", source);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(OLDER);
  });

  it("preserves missing-source behavior for an admitted owner", async () => {
    await expect(page("missing", "yopedia")).rejects.toThrow("NOT_FOUND");
    expect((await api("missing")).status).toBe(404);
    await seedSnapshots();
    expect((await api("agent-notes", "deadbeefdeadbeef")).status).toBe(404);
  });
});
