import { beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(() => {
  vi.clearAllMocks();
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
