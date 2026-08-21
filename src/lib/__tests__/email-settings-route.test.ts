import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/owner", () => ({ isOwnerHandle: vi.fn() }));
vi.mock("@/lib/agents", () => ({
  getAgent: vi.fn(),
  listAgentsForOwner: vi.fn(async () => []),
}));
vi.mock("@/lib/vault", () => ({
  getVault: vi.fn(),
  listVaults: vi.fn(async () => []),
  vaultOwnedBy: vi.fn(),
}));
vi.mock("@/lib/email-ingest", async (original) => ({
  ...(await original<typeof import("@/lib/email-ingest")>()),
  loadEmailIngestConfig: vi.fn(),
  saveEmailIngestConfig: vi.fn(),
}));

import { getPrincipal } from "@/lib/auth";
import { isOwnerHandle } from "@/lib/owner";
import {
  loadEmailIngestConfig,
  saveEmailIngestConfig,
} from "@/lib/email-ingest";
import { getAgent } from "@/lib/agents";
import { getVault, vaultOwnedBy } from "@/lib/vault";
import { READ_ONLY_REFUSAL } from "@/lib/read-only";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedIsOwner = vi.mocked(isOwnerHandle);
const mockedLoad = vi.mocked(loadEmailIngestConfig);
const mockedSave = vi.mocked(saveEmailIngestConfig);
const mockedGetAgent = vi.mocked(getAgent);
const mockedGetVault = vi.mocked(getVault);
const mockedVaultOwnedBy = vi.mocked(vaultOwnedBy);

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/email/settings", {
    method: "PUT",
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
  mockedPrincipal.mockResolvedValue({ id: "user_1", handle: "LuckierTrout" });
  mockedIsOwner.mockReturnValue(true);
  mockedLoad.mockResolvedValue({
    enabled: false,
    inboundAddress: "",
    allowedSenders: [],
    destinationVaultId: "",
    destinationAgentId: "",
    updatedAt: null,
  });
  mockedSave.mockImplementation(async (input) => ({
    ...input,
    destinationVaultId: input.destinationVaultId ?? "",
    destinationAgentId: input.destinationAgentId ?? "",
    updatedAt: "2026-08-01T12:00:00.000Z",
  }));
});

afterEach(() => {
  if (savedReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
  else process.env.YOPEDIA_READONLY = savedReadOnly;
});

/**
 * The settings save on a read-only deployment (DW-300).
 *
 * `saveEmailIngestConfig` reaches no kernel writer, so before this gate the
 * panel reported a save that had happened — including flipping ingestion ON for
 * a deployment that refuses every ingest behind it.
 */
describe("PUT /api/email/settings on a read-only deployment", () => {
  const VALID = {
    enabled: true,
    inboundAddress: "ingest@example.com",
    allowedSenders: ["owner@example.com"],
  };

  beforeEach(() => {
    process.env.YOPEDIA_READONLY = "1";
  });

  it("403s without saving", async () => {
    const { PUT } = await import("@/app/api/email/settings/route");
    const response = await PUT(request(VALID));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.emailSettings });
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("keeps the not-found cloak ahead of the refusal for a non-owner", async () => {
    // THE ordering assertion. The gate sits after `requireOwner()`, so a
    // non-owner still gets 404 — a 403 here would tell them this owner-only
    // door exists, which is exactly what the cloak is for.
    mockedIsOwner.mockReturnValue(false);
    const { PUT } = await import("@/app/api/email/settings/route");
    const response = await PUT(request(VALID));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("refuses BEFORE validating the body", async () => {
    // An invalid body would otherwise 400 first, blaming the owner's input for
    // a save the deployment was never going to accept.
    const { PUT } = await import("@/app/api/email/settings/route");
    const response = await PUT(request({ enabled: "yes" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.emailSettings });
  });

  it("still SERVES the configuration — the read is not refused", async () => {
    const { GET } = await import("@/app/api/email/settings/route");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mockedLoad).toHaveBeenCalled();
  });
});

describe("/api/email/settings", () => {
  it("is available only to the owner", async () => {
    mockedIsOwner.mockReturnValue(false);
    const { GET } = await import("@/app/api/email/settings/route");
    const response = await GET();
    expect(response.status).toBe(404);
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it("requires an inbound address before activation", async () => {
    const { PUT } = await import("@/app/api/email/settings/route");
    const response = await PUT(
      request({
        enabled: true,
        inboundAddress: "",
        allowedSenders: ["owner@example.com"],
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("inbound email address"),
    });
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("requires an approved sender before activation", async () => {
    const { PUT } = await import("@/app/api/email/settings/route");
    const response = await PUT(
      request({
        enabled: true,
        inboundAddress: "ingest@example.com",
        allowedSenders: [],
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("approved sender"),
    });
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("normalizes and saves a valid owner configuration", async () => {
    const { PUT } = await import("@/app/api/email/settings/route");
    const response = await PUT(
      request({
      enabled: true,
      inboundAddress: " Ingest@Example.com ",
      allowedSenders: ["Owner@Example.com", "owner@example.com"],
      destinationVaultId: "",
      destinationAgentId: "",
      }),
    );
    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      enabled: true,
      inboundAddress: " Ingest@Example.com ",
      allowedSenders: ["owner@example.com"],
      destinationVaultId: "",
      destinationAgentId: "",
    });
  });

  it("accepts only owner-controlled vault and agent destinations", async () => {
    mockedGetVault.mockResolvedValueOnce({ id: "luckiertrout--work", owner: "LuckierTrout" } as never);
    mockedVaultOwnedBy.mockReturnValueOnce(true);
    mockedGetAgent.mockResolvedValueOnce({ id: "luckiertrout--yoyo", owner: "LuckierTrout" } as never);
    const { PUT } = await import("@/app/api/email/settings/route");
    const response = await PUT(request({
      enabled: true,
      inboundAddress: "ingest@example.com",
      allowedSenders: ["owner@example.com"],
      destinationVaultId: "luckiertrout--work",
      destinationAgentId: "luckiertrout--yoyo",
    }));
    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith(expect.objectContaining({
      destinationVaultId: "luckiertrout--work",
      destinationAgentId: "luckiertrout--yoyo",
    }));
  });
});
