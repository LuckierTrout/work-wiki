/**
 * The Skills rail (Story 8.6): a scan on screen, and the switch that hides one.
 *
 * THE WRITE IS THE PART WORTH TESTING. Listing packs is a `map`; the switch has
 * to reach the KERNEL — with an `If-Match` and with only the id it touched —
 * because that map is what the sidecar polls and what `/skill` completion reads.
 * A toggle that wrote the whole scanned map would silently re-enable a pack the
 * owner switched off from the Settings pane, and one that wrote without a
 * version would be answered 428 in production and pass here forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  SKILLS_SCAN_FAILED_COPY,
  SKILLS_SCAN_HINT_COPY,
  SKILL_DISABLED_NOTE_COPY,
} from "@/lib/chat-agent";
import { SETTINGS_LOAD_FAILED_COPY } from "@/lib/workbench-settings";
import { workbenchMode } from "@/lib/workbench-modes";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", () => ({ send }));

import { SkillsCanvas } from "@/components/workbench/SkillsCanvas";

const SKILLS = [
  {
    id: "project:recap",
    name: "recap",
    description: "Write a meeting recap",
    scope: "project",
    enabled: true,
  },
  {
    id: "user:offsite",
    name: "offsite",
    description: "Plan an offsite",
    scope: "user",
    enabled: false,
  },
];

/**
 * The GET the version comes from, whole.
 *
 * Only `version` is read here, but `workbenchSettingsFrom` narrows the WHOLE
 * payload before handing any of it back — so a fixture with three fields is
 * rejected and the surface would refuse the write for the wrong reason.
 */
const SETTINGS_BODY = {
  workbench: {
    version: "s1:00000000000000000000000000000000",
    chatProvider: "openai",
    chatModel: "gpt-4o",
    ingestProvider: "anthropic",
    ingestModel: "claude-sonnet-4-20250514",
    customBaseUrl: null,
    hasCustomApiKey: false,
    envCustomApiKey: false,
    llmTimeoutSeconds: null,
    vectorSearchEnabled: false,
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    embeddingBaseUrl: null,
    hasEmbeddingApiKey: true,
    embeddingModelInEffect: null,
    embeddingModelOverridden: false,
    envEmbeddingProvider: null,
    envEmbeddingModel: null,
    envCustomBaseUrl: null,
    envEmbeddingApiKeyProviders: [],
    hasWorkersAiBinding: false,
    firecrawlBaseUrl: null,
    hasFirecrawlApiKey: false,
    envFirecrawlApiKey: false,
    researchProvider: null,
    envResearchProvider: null,
    hasTavilyApiKey: false,
    hasSerpApiKey: false,
    serpApiEngine: null,
    searxngBaseUrl: null,
    envSearxngBaseUrl: null,
    searxngCategories: null,
    envResearchProviders: [],
    inboundEmailAddress: null,
    inboundEmailEnabled: false,
    intakeKeepParsed: false,
    mineruMode: "off",
    mineruLocalBaseUrl: null,
    hasMinerUApiKey: false,
    // The door is ON here: the rail's scan only answers when it is, so a
    // fixture with it shut would describe a machine this surface never reaches.
    apiEnabled: true,
    allowUnauthenticated: false,
    hasLoopbackApiToken: true,
    loopbackTokenSource: "store",
    language: "English",
    readOnly: false,
  },
};

let scanned: () => Response;
let settingsPut: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

/** How many times the sidecar scan was read. */
const scanCount = () =>
  fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/api/v1/skills"))
    .length;

beforeEach(() => {
  send.mockImplementation(async (url: string) => {
    if (url === "/api/v1/loopback-settings") return { token: "tok-door" };
    return {};
  });
  scanned = () => new Response(JSON.stringify({ skills: SKILLS }), { status: 200 });
  settingsPut = vi.fn(
    async () =>
      new Response(JSON.stringify(SETTINGS_BODY), { status: 200 }),
  );
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/skills")) return scanned();
    if (url === "/api/settings" && init?.method === "PUT") return settingsPut(url, init);
    if (url === "/api/settings") {
      return new Response(JSON.stringify(SETTINGS_BODY), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the Skills rail lists what is on disk", () => {
  it("names both scopes, the disabled pack, and where a pack goes", async () => {
    render(<SkillsCanvas active />);
    await screen.findByText("recap");

    expect(screen.getByText(SKILLS_SCAN_HINT_COPY)).toBeTruthy();
    expect(screen.getByText("Project")).toBeTruthy();
    expect(screen.getByText("User")).toBeTruthy();
    // A disabled pack is still LISTED here — this is the surface that turns it
    // back on — and says what disabled means.
    expect(screen.getByText("offsite")).toBeTruthy();
    expect(screen.getByText(SKILL_DISABLED_NOTE_COPY)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable recap" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable offsite" })).toBeTruthy();
  });

  it("does not scan while the rail is hidden", async () => {
    render(<SkillsCanvas active={false} />);
    await waitFor(() => expect(send).not.toHaveBeenCalled());
    expect(screen.queryByText("recap")).toBeNull();
  });

  it("says the sidecar did not answer instead of showing an empty list", async () => {
    scanned = () => {
      throw new Error("ECONNREFUSED");
    };
    render(<SkillsCanvas active />);
    expect(await screen.findByText(SKILLS_SCAN_FAILED_COPY)).toBeTruthy();
    // …and NOT the "no Skills yet" sentence, which would send the owner to
    // write a `SKILL.md` they already have.
    expect(screen.queryByText(workbenchMode("skills").emptyState!)).toBeNull();
  });

  it("shows the empty sentence when the scan found nothing", async () => {
    scanned = () => new Response(JSON.stringify({ skills: [] }), { status: 200 });
    render(<SkillsCanvas active />);
    expect(
      await screen.findByText(workbenchMode("skills").emptyState!),
    ).toBeTruthy();
  });
});

describe("the switch writes one decision to the kernel", () => {
  it("sends only the touched id, with the version as If-Match, then re-scans", async () => {
    render(<SkillsCanvas active />);
    await screen.findByText("recap");
    fireEvent.click(screen.getByRole("button", { name: "Disable recap" }));

    await waitFor(() => expect(settingsPut).toHaveBeenCalledTimes(1));
    const init = settingsPut.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      // ONE ID. `updateConfig` merges key-by-key, so the decision about
      // `user:offsite` — which this scan happens to know — is not resent and
      // cannot be clobbered by a stale read.
      workbench: { skillEnablement: { "project:recap": false } },
    });
    expect((init.headers as Record<string, string>)["If-Match"]).toContain(
      SETTINGS_BODY.workbench.version,
    );

    // The scan is the source of truth for the list, so it is RE-READ rather
    // than patched in place: one on mount, one after the write. A local flip
     // would show an enablement the sidecar has not polled yet.
    await waitFor(() => expect(scanCount()).toBe(2));
  });

  it("refuses the write when the version cannot be read", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      if (url.endsWith("/api/v1/skills")) return scanned();
      // A settings GET the surface cannot use: no `workbench`, so no version.
      return new Response("{}", { status: 200 });
    });
    render(<SkillsCanvas active />);
    await screen.findByText("recap");
    fireEvent.click(screen.getByRole("button", { name: "Disable recap" }));
    expect(await screen.findByText(SETTINGS_LOAD_FAILED_COPY)).toBeTruthy();
  });

  it("read-only disables the switch and writes nothing", async () => {
    render(<SkillsCanvas active readOnly />);
    await screen.findByText("recap");
    const toggle = screen.getByRole("button", { name: "Disable recap" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    expect(settingsPut).not.toHaveBeenCalled();
  });
});
