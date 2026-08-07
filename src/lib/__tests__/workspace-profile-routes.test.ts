import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/config", () => ({ isReadOnly: vi.fn() }));
vi.mock("@/lib/workspace-profile", async (original) => ({
  ...(await original<typeof import("@/lib/workspace-profile")>()),
  getWorkspaceProfile: vi.fn(),
  saveWorkspaceProfile: vi.fn(),
}));

import { GET, PUT } from "@/app/api/workspace-profile/route";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import {
  getWorkspaceProfile,
  saveWorkspaceProfile,
  type WorkspaceProfile,
} from "@/lib/workspace-profile";

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
const mockedGet = vi.mocked(getWorkspaceProfile);
const mockedSave = vi.mocked(saveWorkspaceProfile);

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
  mockedGet.mockResolvedValue(PROFILE);
  mockedSave.mockResolvedValue(PROFILE);
});

describe("Workspace Purpose API", () => {
  it("requires sign-in", async () => {
    mockedPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await PUT(putRequest(PROFILE))).status).toBe(401);
    expect(mockedGet).not.toHaveBeenCalled();
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("loads and saves only in the principal tenant", async () => {
    expect(await (await GET()).json()).toEqual({ profile: PROFILE, readOnly: false });
    const response = await PUT(putRequest(PROFILE));
    expect(response.status).toBe(200);
    expect(mockedGet).toHaveBeenCalledWith("alice");
    expect(mockedSave).toHaveBeenCalledWith("alice", {
      scenario: "business",
      purpose: "Track decisions.",
      keyQuestions: ["What changed?"],
      inScope: ["Decisions"],
      outOfScope: ["Rumor"],
      outputLanguage: "English",
      pageConventions: "Cite sources.",
    });
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
