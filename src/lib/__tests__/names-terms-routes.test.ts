import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/names-terms", async (original) => ({
  ...(await original<typeof import("@/lib/names-terms")>()),
  createNamesTerm: vi.fn(),
  deleteNamesTerm: vi.fn(),
  listNamesTerms: vi.fn(),
  updateNamesTerm: vi.fn(),
}));

import { getPrincipal } from "@/lib/auth";
import {
  createNamesTerm,
  deleteNamesTerm,
  listNamesTerms,
  updateNamesTerm,
} from "@/lib/names-terms";
import { GET, POST } from "@/app/api/names-terms/route";
import { DELETE, PUT } from "@/app/api/names-terms/[id]/route";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedCreate = vi.mocked(createNamesTerm);
const mockedDelete = vi.mocked(deleteNamesTerm);
const mockedList = vi.mocked(listNamesTerms);
const mockedUpdate = vi.mocked(updateNamesTerm);

const ENTRY = {
  id: "entry-1",
  kind: "person" as const,
  canonical: "Christian Lee",
  aliases: ["Chris"],
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
};

function request(method: string, body: Record<string, unknown>) {
  return new Request("http://localhost/api/names-terms", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
  mockedList.mockResolvedValue([ENTRY]);
  mockedCreate.mockResolvedValue(ENTRY);
  mockedUpdate.mockResolvedValue(ENTRY);
  mockedDelete.mockResolvedValue(true);
});

describe("Names & Terms API", () => {
  it("requires a signed-in owner scope", async () => {
    mockedPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("lists and creates entries in the principal's tenant", async () => {
    expect(await (await GET()).json()).toEqual({ entries: [ENTRY] });
    const response = await POST(request("POST", {
      kind: "person",
      canonical: "Christian Lee",
      aliases: ["Chris"],
    }));
    expect(response.status).toBe(201);
    expect(mockedCreate).toHaveBeenCalledWith("alice", {
      kind: "person",
      canonical: "Christian Lee",
      aliases: ["Chris"],
    });
  });

  it("updates and deletes only by principal owner plus id", async () => {
    const context = { params: Promise.resolve({ id: "entry-1" }) };
    expect((await PUT(request("PUT", {
      kind: "person",
      canonical: "Christian Lee",
      aliases: [],
    }), context)).status).toBe(200);
    expect(mockedUpdate).toHaveBeenCalledWith("alice", "entry-1", {
      kind: "person",
      canonical: "Christian Lee",
      aliases: [],
    });
    expect((await DELETE(new Request("http://localhost"), context)).status).toBe(200);
    expect(mockedDelete).toHaveBeenCalledWith("alice", "entry-1");
  });
});
