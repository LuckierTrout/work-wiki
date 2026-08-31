import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/config", () => ({ isReadOnly: vi.fn() }));
vi.mock("@/lib/wikis", () => ({ getCurrentWiki: vi.fn() }));
vi.mock("@/lib/workspace-profile", async (original) => ({
  ...(await original<typeof import("@/lib/workspace-profile")>()),
  getWorkspaceProfile: vi.fn(),
}));

import { GET, PUT } from "@/app/api/workspace-profile/route";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getCurrentWiki } from "@/lib/wikis";
import { getWorkspaceProfile } from "@/lib/workspace-profile";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedReadOnly = vi.mocked(isReadOnly);
const mockedCurrentWiki = vi.mocked(getCurrentWiki);
const mockedProfile = vi.mocked(getWorkspaceProfile);

describe("retired workspace-profile compatibility route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrincipal.mockResolvedValue({ handle: "alice" } as never);
    mockedReadOnly.mockReturnValue(false);
    mockedCurrentWiki.mockResolvedValue({ id: "wiki-1", name: "Hiring" } as never);
    mockedProfile.mockResolvedValue({
      version: 1,
      scenario: "custom",
      purpose: "Legacy evidence",
      keyQuestions: [],
      inScope: [],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "",
      createdAt: null,
      updatedAt: null,
    });
  });

  it("requires authentication for reads and writes", async () => {
    mockedPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await PUT(new Request("http://localhost/api/workspace-profile"))).status).toBe(401);
  });

  it("serves preserved legacy evidence as a retired read-only contract", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      profile: { purpose: "Legacy evidence" },
      readOnly: false,
      wiki: { id: "wiki-1", name: "Hiring" },
      retired: true,
    });
    expect(mockedProfile).toHaveBeenCalledWith("alice", "wiki-1");
  });

  it("returns an empty compatibility profile when there is no current Wiki", async () => {
    mockedCurrentWiki.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      profile: { purpose: "", keyQuestions: [], pageConventions: "" },
      wiki: null,
      retired: true,
    });
    expect(mockedProfile).not.toHaveBeenCalled();
  });

  it("fails closed when preserved evidence cannot be read", async () => {
    mockedProfile.mockRejectedValue(new Error("profile unreadable"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "profile unreadable" });
  });

  it("rejects every authenticated structured-profile write", async () => {
    const response = await PUT(new Request("http://localhost/api/workspace-profile", {
      method: "PUT",
      body: JSON.stringify({ purpose: "A second writer" }),
    }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(await response.json()).toEqual({
      error: "Workspace Purpose is edited from purpose.md in the Workbench Preview.",
    });
    expect(mockedProfile).not.toHaveBeenCalled();
  });
});
