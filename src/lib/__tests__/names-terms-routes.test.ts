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
import { READ_ONLY_REFUSAL, ReadOnlyError } from "@/lib/read-only";

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
 * Before these gates the store behind them refused nothing of its own, so the
 * Settings panel reported a save, an edit and a delete that had all happened.
 * DW-385 has since gated the three writers in the KERNEL too, with this same
 * sentence, for callers that never pass a route; these gates stay because they
 * answer BEFORE the body parse, so a malformed body cannot pre-empt the refusal
 * with a 400. One sentence for all three, because they are one store reached by
 * three verbs.
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

/**
 * THE MID-REQUEST FLAG FLIP (DW-526).
 *
 * `YOPEDIA_READONLY` is UNSET here — the outer `beforeEach` clears it — so every
 * route gate passes and the kernel writer is reached. It refuses anyway, which
 * is what happens when the flag moves while the handler is in flight. POST and
 * PUT used to answer that refusal 400 ("your input was wrong") and DELETE 500
 * ("the server broke"); all three are 403 with the kernel's own sentence.
 */
describe("Names & Terms writers when the flag flips mid-request", () => {
  const context = () => ({ params: Promise.resolve({ id: "entry-1" }) });
  const INPUT = { kind: "person", canonical: "Christian Lee", aliases: [] };

  it("403s POST rather than blaming the body", async () => {
    mockedCreate.mockRejectedValueOnce(
      new ReadOnlyError(READ_ONLY_REFUSAL.namesTerms),
    );
    const response = await POST(request("POST", INPUT));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.namesTerms });
    // The gate did not answer this — the writer did.
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it("403s PUT rather than blaming the body", async () => {
    mockedUpdate.mockRejectedValueOnce(
      new ReadOnlyError(READ_ONLY_REFUSAL.namesTerms),
    );
    const response = await PUT(request("PUT", INPUT), context());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.namesTerms });
  });

  it("403s DELETE rather than reporting a server fault", async () => {
    mockedDelete.mockRejectedValueOnce(
      new ReadOnlyError(READ_ONLY_REFUSAL.namesTerms),
    );
    const response = await DELETE(new Request("http://localhost"), context());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.namesTerms });
  });

  it("leaves the conflict mapping alone — a name clash is still 409", async () => {
    // The 403 branch is FIRST in each catch, so it must not have swallowed the
    // classification underneath it.
    const { NamesTermConflictError } = await import("@/lib/names-terms");
    mockedCreate.mockRejectedValueOnce(
      new NamesTermConflictError("That name is already recorded."),
    );
    expect((await POST(request("POST", INPUT))).status).toBe(409);
    mockedUpdate.mockRejectedValueOnce(
      new NamesTermConflictError("That name is already recorded."),
    );
    expect((await PUT(request("PUT", INPUT), context())).status).toBe(409);
    // …and an ordinary failure keeps the status it had.
    mockedDelete.mockRejectedValueOnce(new Error("disk on fire"));
    expect(
      (await DELETE(new Request("http://localhost"), context())).status,
    ).toBe(500);
  });
});
