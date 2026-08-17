import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/config", () => ({ isReadOnly: vi.fn() }));
vi.mock("@/lib/wikis", () => ({ getCurrentWiki: vi.fn() }));
vi.mock("@/lib/workspace-profile", async (original) => ({
  ...(await original<typeof import("@/lib/workspace-profile")>()),
  getWorkspaceProfile: vi.fn(),
  saveWorkspaceProfile: vi.fn(),
  readLegacyTenantProfile: vi.fn(),
}));

import { GET, PUT } from "@/app/api/workspace-profile/route";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getCurrentWiki } from "@/lib/wikis";
import {
  emptyWorkspaceProfile,
  getWorkspaceProfile,
  readLegacyTenantProfile,
  saveWorkspaceProfile,
  type WorkspaceProfile,
} from "@/lib/workspace-profile";

const WIKI = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Ops",
  scenario: "business" as const,
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
};

const PROFILE: WorkspaceProfile = {
  version: 1,
  scenario: "business",
  purpose: "Track decisions.",
  keyQuestions: ["What changed?"],
  inScope: ["Decisions"],
  outOfScope: ["Rumor"],
  outputLanguage: "English",
  pageConventions: "Cite sources.",
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
};

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedReadOnly = vi.mocked(isReadOnly);
const mockedCurrentWiki = vi.mocked(getCurrentWiki);
const mockedGet = vi.mocked(getWorkspaceProfile);
const mockedSave = vi.mocked(saveWorkspaceProfile);
const mockedLegacy = vi.mocked(readLegacyTenantProfile);

function putRequest(body: unknown) {
  return new Request("http://localhost/api/workspace-profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
  mockedReadOnly.mockReturnValue(false);
  mockedCurrentWiki.mockResolvedValue(WIKI);
  mockedGet.mockResolvedValue(PROFILE);
  mockedSave.mockResolvedValue(PROFILE);
  mockedLegacy.mockResolvedValue(null);
});

describe("Workspace Purpose API", () => {
  it("requires sign-in", async () => {
    mockedPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await PUT(putRequest(PROFILE))).status).toBe(401);
    expect(mockedGet).not.toHaveBeenCalled();
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("loads and saves the ACTIVE wiki's profile, in the principal tenant", async () => {
    expect(await (await GET()).json()).toEqual({
      profile: PROFILE,
      readOnly: false,
      wiki: { id: WIKI.id, name: WIKI.name },
    });
    // The happy path carries the wiki the form was composed against, and the
    // response names the wiki actually written.
    const response = await PUT(putRequest({ ...PROFILE, wikiId: WIKI.id }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      profile: PROFILE,
      wiki: { id: WIKI.id, name: WIKI.name },
    });
    expect(mockedGet).toHaveBeenCalledWith("alice", WIKI.id);
    // `wikiId` is routing, not profile content — it must not reach storage.
    expect(mockedSave).toHaveBeenCalledWith("alice", WIKI.id, {
      scenario: "business",
      purpose: "Track decisions.",
      keyQuestions: ["What changed?"],
      inScope: ["Decisions"],
      outOfScope: ["Rumor"],
      outputLanguage: "English",
      pageConventions: "Cite sources.",
    });
  });

  it("refuses a save composed against a wiki that is no longer active", async () => {
    // The form resolves the active wiki once at mount and this route resolves
    // it per request. A switch in another tab in between would otherwise write
    // wiki A's on-screen bytes over wiki B's stored purpose.
    const response = await PUT(
      putRequest({ ...PROFILE, wikiId: "00000000-0000-4000-8000-00000000000b" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("The active wiki changed");
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("refuses a save whose wikiId is present but not a matching string", async () => {
    // Gating the guard on `typeof claimed === "string"` would let `null` — or a
    // number, or an object — past it and write the body to whatever wiki is
    // active now, which is the silent cross-wiki overwrite this route exists to
    // refuse. Absent stays tolerated; present-but-wrong never is.
    for (const wikiId of [null, 42, { id: WIKI.id }]) {
      const response = await PUT(putRequest({ ...PROFILE, wikiId }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("The active wiki changed");
    }
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("answers 500, not 400, when the registry itself cannot be read", async () => {
    // An unreadable `wikis.json` is not the caller's input being wrong, and GET
    // answers 500 for the identical condition. A 400 tells the owner their edit
    // was rejected when storage was simply unavailable.
    mockedCurrentWiki.mockRejectedValue(new Error("EISDIR: illegal operation"));
    const response = await PUT(putRequest({ ...PROFILE, wikiId: WIKI.id }));
    expect(response.status).toBe(500);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("answers an empty profile and a null wiki when the registry is empty", async () => {
    mockedCurrentWiki.mockResolvedValue(null);
    const body = await (await GET()).json();
    expect(body).toEqual({
      profile: emptyWorkspaceProfile(),
      readOnly: false,
      wiki: null,
    });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("shows a legacy tenant-global purpose when there is no wiki yet", async () => {
    // Read-only and bounded to the migration window: the owner can SEE what
    // they wrote instead of an empty form, `wiki` stays null so the form stays
    // disabled, and nothing writes the legacy file.
    mockedCurrentWiki.mockResolvedValue(null);
    mockedLegacy.mockResolvedValue(PROFILE);
    expect(await (await GET()).json()).toEqual({
      profile: PROFILE,
      readOnly: false,
      wiki: null,
    });
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("refuses a save when there is no wiki to own the profile, and writes nothing", async () => {
    mockedCurrentWiki.mockResolvedValue(null);
    const response = await PUT(putRequest(PROFILE));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Create a wiki first");
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("rejects writes in explicit read-only mode", async () => {
    mockedReadOnly.mockReturnValue(true);
    const response = await PUT(putRequest(PROFILE));
    expect(response.status).toBe(403);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("rejects invalid scenarios", async () => {
    const response = await PUT(putRequest({ scenario: "other" }));
    expect(response.status).toBe(400);
    expect(mockedSave).not.toHaveBeenCalled();
  });
});
