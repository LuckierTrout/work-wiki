import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { READ_ONLY_REFUSAL } from "@/lib/read-only";

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

let savedReadOnly: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedReadOnly = process.env.YOPEDIA_READONLY;
  // Cleared rather than inherited: a value exported in a developer's shell
  // would otherwise turn every writable case below into a 403.
  delete process.env.YOPEDIA_READONLY;
  mockedPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
  mockedList.mockResolvedValue([ENTRY]);
  mockedCreate.mockResolvedValue(ENTRY);
  mockedUpdate.mockResolvedValue(ENTRY);
  mockedDelete.mockResolvedValue(true);
});

afterEach(() => {
  if (savedReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
  else process.env.YOPEDIA_READONLY = savedReadOnly;
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

/**
 * The three writers on a read-only deployment (DW-300).
 *
 * The store behind them is not a kernel writer and refuses nothing of its own,
 * so before these gates the Settings panel reported a save, an edit and a
 * delete that had all happened. One sentence for all three, because they are
 * one store reached by three verbs.
 */
describe("Names & Terms writers on a read-only deployment", () => {
  const context = () => ({ params: Promise.resolve({ id: "entry-1" }) });
  const INPUT = { kind: "person", canonical: "Christian Lee", aliases: [] };

  beforeEach(() => {
    process.env.YOPEDIA_READONLY = "1";
  });

  it("403s POST without creating", async () => {
    const response = await POST(request("POST", INPUT));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.namesTerms });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("403s PUT without updating", async () => {
    const response = await PUT(request("PUT", INPUT), context());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.namesTerms });
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("403s DELETE without deleting", async () => {
    const response = await DELETE(new Request("http://localhost"), context());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.namesTerms });
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("still LISTS — the read is not refused", async () => {
    // The point of gating the writers only: a read-only deployment is a
    // readable one, and a GET that started 403ing would be a different defect
    // wearing the same flag.
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [ENTRY] });
  });

  it("still 401s an unauthenticated caller, so the gate stays behind auth", async () => {
    mockedPrincipal.mockResolvedValue(null);
    expect((await POST(request("POST", INPUT))).status).toBe(401);
    expect((await PUT(request("PUT", INPUT), context())).status).toBe(401);
    expect((await DELETE(new Request("http://localhost"), context())).status).toBe(401);
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
  });
});
