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
  NamesTermConflictError,
  updateNamesTerm,
} from "@/lib/names-terms";
import { GET, POST } from "@/app/api/names-terms/route";
import { DELETE, PUT } from "@/app/api/names-terms/[id]/route";
import { ClientInputError } from "@/lib/errors";
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

/**
 * ONE STORE, ONE VERDICT ABOUT ONE FAULT (DW-641).
 *
 * POST and PUT used to end their catch at `NamesTermConflictError ? 409 : 400`,
 * so an EACCES, a full disk or a lock timeout inside `createNamesTerm` /
 * `updateNamesTerm` was reported as the owner's bad input — a body they would
 * retype forever — while the sibling `DELETE /api/names-terms/[id]` answered
 * 500 for that same class. The store now throws `ClientInputError` for what is
 * genuinely the caller's fault, so the two doors classify by TYPE and default
 * to the DELETE's 500. Every row below is a class, never a message.
 */
describe("Names & Terms writers classify a failure by type", () => {
  const context = () => ({ params: Promise.resolve({ id: "entry-1" }) });
  const INPUT = { kind: "person", canonical: "Christian Lee", aliases: [] };

  it.each([
    ["a storage fault is 500, not the caller's input", new Error("EACCES: permission denied, open '/data/names-terms.json'"), 500],
    ["a typed input fault is 400", new ClientInputError("Enter a valid email address"), 400],
    ["a name clash is 409", new NamesTermConflictError("That name is already recorded."), 409],
    ["a mid-request refusal is 403", new ReadOnlyError(READ_ONLY_REFUSAL.namesTerms), 403],
  ])("POST: %s", async (_label, fault, status) => {
    mockedCreate.mockRejectedValueOnce(fault);
    const response = await POST(request("POST", INPUT));
    expect(response.status).toBe(status);
    // The store's own sentence rides on every one of them, verbatim.
    expect(await response.json()).toEqual({ error: fault.message });
  });

  it.each([
    ["a storage fault is 500, not the caller's input", new Error("EACCES: permission denied, open '/data/names-terms.json'"), 500],
    ["a typed input fault is 400", new ClientInputError("Enter a valid email address"), 400],
    ["a name clash is 409", new NamesTermConflictError("That name is already recorded."), 409],
    ["a mid-request refusal is 403", new ReadOnlyError(READ_ONLY_REFUSAL.namesTerms), 403],
  ])("PUT: %s", async (_label, fault, status) => {
    mockedUpdate.mockRejectedValueOnce(fault);
    const response = await PUT(request("PUT", INPUT), context());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: fault.message });
  });

  it("500s a storage fault at all three verbs — the mapping no longer splits", async () => {
    // The whole point of DW-641: the SAME class at the SAME store gets the same
    // verdict whichever verb reached it. DELETE was already right; it is here as
    // the control the other two now match.
    const fault = () => new Error("EACCES: permission denied, open '/data/names-terms.json'");
    mockedCreate.mockRejectedValueOnce(fault());
    mockedUpdate.mockRejectedValueOnce(fault());
    mockedDelete.mockRejectedValueOnce(fault());
    expect((await POST(request("POST", INPUT))).status).toBe(500);
    expect((await PUT(request("PUT", INPUT), context())).status).toBe(500);
    expect((await DELETE(new Request("http://localhost"), context())).status).toBe(500);
  });

  it("500s an untyped error whose message merely reads like a refusal", async () => {
    // Type-only classification: no regex over the sentence was added, so words
    // that look like the caller's fault do not buy a 400.
    mockedCreate.mockRejectedValueOnce(new Error("Preferred name or term is required"));
    expect((await POST(request("POST", INPUT))).status).toBe(500);
    mockedUpdate.mockRejectedValueOnce(new Error("Preferred name or term is required"));
    expect((await PUT(request("PUT", INPUT), context())).status).toBe(500);
  });

  /**
   * The 400 the doors must NOT lose. A body that is not JSON, or is `null` or an
   * array, used to reach `parseNamesTermInput` and leave through the catch's
   * blanket 400 — right by accident. With a 500 default that accident becomes a
   * server fault for a request the server read perfectly well, so both doors now
   * guard the body explicitly.
   */
  it.each([
    ["a body that is not JSON", "{ not json", "Request body must be JSON."],
    ["a null body", "null", "Request body must be a JSON object."],
    ["an array body", "[]", "Request body must be a JSON object."],
  ])("400s %s at both writing doors", async (_label, body, error) => {
    const raw = (method: string) =>
      new Request("http://localhost/api/names-terms", {
        method,
        headers: { "Content-Type": "application/json" },
        body,
      });

    const posted = await POST(raw("POST"));
    expect(posted.status).toBe(400);
    expect(await posted.json()).toEqual({ error });

    const put = await PUT(raw("PUT"), context());
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error });

    // Refused before the store was ever asked to write.
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  /**
   * THE 400 THAT DOES NOT PASS THROUGH THE MOCK. Every row above injects a
   * `ClientInputError` at the mocked writer, which pins the CATCH but takes the
   * real `parseNamesTermInput` on faith — this suite's `@/lib/names-terms` mock
   * spreads the original, so the parse is LIVE at both doors. Here the body is
   * well-formed JSON that the real parse refuses: it throws BEFORE the store is
   * reached, and the door must still say 400 rather than fall to its new 500
   * default. Without this, the end-to-end 400 held only by transitivity across
   * two files.
   */
  it.each([
    ["a kind that is not one of the five", { kind: "spaceship", canonical: "Christian Lee" }, "Invalid names and terms type"],
    ["a canonical that is missing", { kind: "person" }, "Preferred name or term is required"],
    ["aliases that are not a list", { kind: "person", canonical: "Christian Lee", aliases: "Chris" }, "Aliases must be a list of text values"],
    ["a non-text field", { kind: "person", canonical: "Christian Lee", role: 7 }, "role must be text"],
  ])("400s %s at both writing doors, without asking the store", async (_label, body, error) => {
    const posted = await POST(request("POST", body));
    expect(posted.status).toBe(400);
    expect(await posted.json()).toEqual({ error });

    const put = await PUT(request("PUT", body), context());
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error });

    // The parse answered, not the writer — so this 400 is the real one the
    // owner gets, not a mocked stand-in for it.
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("still 404s a PUT for an id that is not there", async () => {
    // The control for the ladder above: a `null`-returning writer is not a
    // thrown fault, so none of the new branches may swallow its 404.
    mockedUpdate.mockResolvedValueOnce(null);
    expect((await PUT(request("PUT", INPUT), context())).status).toBe(404);
  });
});
