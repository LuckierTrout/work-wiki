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
import {
  formatIfMatch,
  IF_MATCH_HEADER,
  objectVersion,
  WRITE_CONFLICT_COPY,
  WRITE_PRECONDITION_REQUIRED_COPY,
} from "@/lib/write-precondition";
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

/** The version the route publishes for {@link PROFILE}, spelled once. */
const VERSION = objectVersion(PROFILE);

/**
 * A PUT, with whatever precondition the case is about.
 *
 * `headers` is OPTIONAL and defaults to none, so every pre-existing case still
 * describes a request with no `If-Match` — which is what keeps them assertions
 * about the refusals that come BEFORE the precondition rather than assertions
 * that happen to pass because a header was supplied.
 */
function putRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/workspace-profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** The same PUT, with bytes that are not JSON at all. */
function rawPutRequest(raw: string) {
  return new Request("http://localhost/api/workspace-profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
}

/** The header a form seeded from `version` would send. */
function ifMatch(version: string): Record<string, string> {
  return { [IF_MATCH_HEADER]: formatIfMatch(version) };
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
      version: VERSION,
    });
    // The happy path carries the wiki AND the profile the form was composed
    // against, and the response names the wiki actually written along with the
    // version of what it wrote.
    const response = await PUT(
      putRequest({ ...PROFILE, wikiId: WIKI.id }, ifMatch(VERSION)),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      profile: PROFILE,
      wiki: { id: WIKI.id, name: WIKI.name },
      version: VERSION,
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
    const response = await PUT(
      putRequest({ ...PROFILE, wikiId: WIKI.id }, ifMatch(VERSION)),
    );
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
      // Published even with no wiki: the value describes the profile in THIS
      // body, and a form that cannot save it simply never sends it back.
      version: objectVersion(emptyWorkspaceProfile()),
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
      version: VERSION,
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

describe("the write precondition on the Workspace Purpose (DW-140, DW-145)", () => {
  it("answers a body that is not JSON with a sentence a human wrote", async () => {
    // DW-140. Falling into the generic catch relayed whatever `JSON.parse`
    // threw — a message naming the parser's cursor, which is the one error this
    // route showed an owner that nobody wrote. Nothing is read and nothing is
    // written for a body that never decoded.
    const response = await PUT(rawPutRequest("{ not json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body." });
    expect(mockedGet).not.toHaveBeenCalled();
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("refuses a stale save on the SAME wiki, and keeps the draft", async () => {
    // DW-145, the whole case: two tabs on ONE wiki. Tab B saved, so the stored
    // profile is no longer the one tab A was seeded from — and the `wikiId`
    // guard sees nothing wrong, because nothing about the wiki changed.
    mockedGet.mockResolvedValue({ ...PROFILE, purpose: "Tab B got here first." });
    const response = await PUT(
      putRequest({ ...PROFILE, wikiId: WIKI.id }, ifMatch(VERSION)),
    );
    expect(response.status).toBe(412);
    // Relayed verbatim from the module that owns the wording — no sentence is
    // typed at a render site or here.
    expect(await response.json()).toEqual({ error: WRITE_CONFLICT_COPY });
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("lets a matching precondition through", async () => {
    const response = await PUT(
      putRequest({ ...PROFILE, wikiId: WIKI.id }, ifMatch(VERSION)),
    );
    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledTimes(1);
  });

  it("refuses 428 for every header `parseIfMatch` reads as absent", async () => {
    // A guard a caller opts out of by omitting or malforming one header is not a
    // guard. `*` is the wildcard for "any current representation", which IS the
    // unconditional write this refuses; the rest are the shapes a hand-rolled
    // client produces instead of `formatIfMatch`.
    const absent: Array<Record<string, string>> = [
      {},
      { [IF_MATCH_HEADER]: "*" },
      { [IF_MATCH_HEADER]: VERSION },
      { [IF_MATCH_HEADER]: `W/"${VERSION}"` },
      { [IF_MATCH_HEADER]: `"${VERSION}", "w1:0-0"` },
      { [IF_MATCH_HEADER]: '""' },
    ];
    for (const headers of absent) {
      const response = await PUT(
        putRequest({ ...PROFILE, wikiId: WIKI.id }, headers),
      );
      expect(response.status, JSON.stringify(headers)).toBe(428);
      expect(await response.json()).toEqual({
        error: WRITE_PRECONDITION_REQUIRED_COPY,
      });
    }
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("answers 400 for an invalid field before 412 for the conflict", async () => {
    // Deliberate, and recorded in `IF_MATCH_HEADER`: a request that would be
    // refused anyway must not learn a version. The save meets the conflict only
    // once the field is fixed.
    mockedGet.mockResolvedValue({ ...PROFILE, purpose: "Moved on." });
    const response = await PUT(
      putRequest({ scenario: "other", wikiId: WIKI.id }, ifMatch(VERSION)),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).not.toBe(WRITE_CONFLICT_COPY);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("refuses a drifted wiki before any version is computed", async () => {
    // The two guards are independent and both survive: a perfectly valid
    // precondition does not buy a save the right to land on a wiki the owner
    // never had on screen. `getWorkspaceProfile` is never reached, so no version
    // is derived for a request that was refused for a different reason.
    const response = await PUT(
      putRequest(
        { ...PROFILE, wikiId: "00000000-0000-4000-8000-00000000000b" },
        ifMatch(VERSION),
      ),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("The active wiki changed");
    expect(mockedGet).not.toHaveBeenCalled();
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("refuses with no wiki even when the precondition is well formed", async () => {
    mockedCurrentWiki.mockResolvedValue(null);
    const response = await PUT(putRequest(PROFILE, ifMatch(VERSION)));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Create a wiki first");
    expect(mockedGet).not.toHaveBeenCalled();
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("answers the version of what it JUST WROTE, not of what it read", async () => {
    // The form's second save in one session is conditioned on this value. If it
    // described the profile the route READ, the owner's own landed save would
    // refuse their next one.
    const written = { ...PROFILE, purpose: "Just written.", updatedAt: "2026-08-20T00:00:00.000Z" };
    mockedSave.mockResolvedValue(written);
    const response = await PUT(
      putRequest({ ...PROFILE, wikiId: WIKI.id }, ifMatch(VERSION)),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.version).toBe(objectVersion(written));
    expect(body.version).not.toBe(VERSION);
    // And it is exactly what the NEXT save must send to be let through.
    mockedGet.mockResolvedValue(written);
    expect(
      (
        await PUT(
          putRequest({ ...written, wikiId: WIKI.id }, ifMatch(body.version)),
        )
      ).status,
    ).toBe(200);
  });

  it("answers 500, not 400, when the PROFILE itself cannot be read", async () => {
    // The same rule the registry read above obeys, applied to the read this
    // change added: `readOwnProfile` rethrows every non-ENOENT read error, so a
    // directory in the file's place would otherwise be relayed as a 400 naming
    // whatever the filesystem said — telling the owner their valid edit was
    // rejected when storage was merely unreadable, in exactly the
    // machine-authored sentence class DW-140 removed from this route.
    mockedGet.mockRejectedValue(new Error("EISDIR: illegal operation"));
    const response = await PUT(
      putRequest({ ...PROFILE, wikiId: WIKI.id }, ifMatch(VERSION)),
    );
    expect(response.status).toBe(500);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("gives the never-saved profile a version of its own, which a stale draft misses", async () => {
    // There is no `null` current version to reach here: an unsaved wiki reads as
    // the EMPTY profile, not as nothing. So the "target is gone" case shows up as
    // the empty profile having its own distinct version — a draft seeded from a
    // stored purpose that has since been cleared is refused rather than silently
    // restoring it.
    const response = await PUT(
      putRequest({ ...PROFILE, wikiId: WIKI.id }, ifMatch(VERSION)),
    );
    expect(response.status).toBe(200);
    mockedGet.mockResolvedValue(emptyWorkspaceProfile());
    const second = await PUT(
      putRequest({ ...PROFILE, wikiId: WIKI.id }, ifMatch(VERSION)),
    );
    expect(second.status).toBe(412);
  });

  it("versions the profile GET seeded the form from, legacy read-through and all", async () => {
    // `getWorkspaceProfile`, not `readOwnProfile`: a wiki whose profile has only
    // ever come from the retired tenant-global file would otherwise be answered
    // 412 for the version its own form was seeded with.
    expect(await (await GET()).json()).toMatchObject({ version: VERSION });
    expect(mockedGet).toHaveBeenCalledWith("alice", WIKI.id);
    const response = await PUT(
      putRequest({ ...PROFILE, wikiId: WIKI.id }, ifMatch(VERSION)),
    );
    expect(response.status).toBe(200);
    expect(mockedGet).toHaveBeenLastCalledWith("alice", WIKI.id);
  });
});
