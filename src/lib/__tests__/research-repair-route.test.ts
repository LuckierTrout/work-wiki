/**
 * `POST /api/research/repair` — how the store's repair verdict becomes a status
 * (DW-477).
 *
 * A `tenants/<t>/research-projects.json` that `parseRegistry` refuses 500s
 * every research door for its owner, the DELETEs that could have shrunk the
 * file included, and those 500 bodies now end by naming this route. What is
 * pinned here is the MAPPING alone — the handler is imported directly with
 * `@/lib/auth` and the store mocked (the `research-route.test.ts` recipe), so
 * the bytes-level behaviour stays in `research-projects.test.ts`.
 *
 * The classification is by the store's discriminated union and by TYPE, never
 * by message: DW-296 deleted message matching from these doors after a storage
 * fault whose sentence happened to carry the right words came back as the
 * caller's own 4xx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/research-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/research-projects")>();
  return { ...actual, repairResearchRegistry: vi.fn() };
});

import { POST } from "@/app/api/research/repair/route";
import { getPrincipal } from "@/lib/auth";
import { StoreFaultError } from "@/lib/errors";
import { READ_ONLY_REFUSAL, ReadOnlyError } from "@/lib/read-only";
import {
  ResearchProjectBusyError,
  repairResearchRegistry,
} from "@/lib/research-projects";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedRepair = vi.mocked(repairResearchRegistry);

const QUARANTINE = "tenants/alice/research-projects.json.corrupt-1756600000000";

const request = () =>
  new Request("http://localhost/api/research/repair", { method: "POST" });

describe("POST /api/research/repair", () => {
  let savedReadOnly: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedReadOnly = process.env.YOPEDIA_READONLY;
    // Cleared rather than inherited: a value exported in a developer's shell
    // would otherwise turn every case below into a 403.
    delete process.env.YOPEDIA_READONLY;
    mockedPrincipal.mockResolvedValue({ handle: "alice" } as Awaited<
      ReturnType<typeof getPrincipal>
    >);
  });

  afterEach(() => {
    if (savedReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
    else process.env.YOPEDIA_READONLY = savedReadOnly;
  });

  it("200s a repair that quarantined the unreadable bytes, naming the key", async () => {
    mockedRepair.mockResolvedValue({ quarantined: true, path: QUARANTINE });

    const response = await POST(request());

    expect(response.status).toBe(200);
    // The key rides in the body because it is the ONLY handle on the bytes
    // that were moved aside — nothing reaps them and no door reads them back.
    expect(await response.json()).toEqual({
      repaired: true,
      quarantinedPath: QUARANTINE,
    });
    // The tenant comes from the PRINCIPAL alone: no request field names a
    // registry, so no caller can aim this at someone else's file.
    expect(mockedRepair).toHaveBeenCalledTimes(1);
    expect(mockedRepair).toHaveBeenCalledWith("alice");
  });

  it("409s a registry that reads fine, as a refusal rather than a fault", async () => {
    // A healthy file, an empty one and a fully tombstoned one all arrive here
    // as the same verdict — the store already decided none of them has bytes
    // worth moving aside.
    mockedRepair.mockResolvedValue({ quarantined: false });

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The research projects file reads fine; there is nothing to repair.",
    });
  });

  it("503s a repair that lost the compare-and-swap", async () => {
    // The `POST /api/research/[id]/run` precedent: contention is a retry
    // signal, not a permanent server fault, and the sentence already says
    // "retry".
    mockedRepair.mockRejectedValue(
      new ResearchProjectBusyError("Research projects were busy; retry the request."),
    );

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Research projects were busy; retry the request.",
    });
  });

  it("500s a storage fault and keeps the store's own message", async () => {
    const fault = Object.assign(
      new Error("EACCES: permission denied, open 'research-projects.json'"),
      { code: "EACCES" },
    );
    mockedRepair.mockRejectedValue(fault);

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: fault.message });
  });

  it("500s a StoreFaultError by type, not by its sentence", async () => {
    mockedRepair.mockRejectedValue(new StoreFaultError("Research projects file is not a list."));

    expect((await POST(request())).status).toBe(500);
  });

  it("401s an unauthenticated caller without reaching the store", async () => {
    mockedPrincipal.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in required." });
    expect(mockedRepair).not.toHaveBeenCalled();
  });

  it("403s on a read-only deployment, after the 401 and before the store", async () => {
    process.env.YOPEDIA_READONLY = "1";

    const response = await POST(request());

    expect(response.status).toBe(403);
    // The `researchMutate` sentence, not a fourth wording: repairing IS
    // "change my research" from where the owner stands.
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.researchMutate });
    expect(mockedRepair).not.toHaveBeenCalled();
  });

  it("still 401s an unauthenticated caller on a read-only deployment", async () => {
    // Gate ORDER: 401 first, so an unauthenticated caller still learns it is
    // unauthenticated rather than being told about the deployment.
    process.env.YOPEDIA_READONLY = "1";
    mockedPrincipal.mockResolvedValue(null);

    expect((await POST(request())).status).toBe(401);
    expect(mockedRepair).not.toHaveBeenCalled();
  });

  it("403s a repair the KERNEL refuses after the flag flipped mid-request", async () => {
    // `YOPEDIA_READONLY` is unset, so the gate above passed; reaching here
    // means `assertWritable` inside the store refused. A refusal is neither a
    // server fault nor contention.
    mockedRepair.mockRejectedValue(new ReadOnlyError(READ_ONLY_REFUSAL.researchMutate));

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.researchMutate });
  });
});
