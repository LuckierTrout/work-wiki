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
  SKILLS_SCAN_DISABLED_COPY,
  SKILLS_SCAN_FAILED_COPY,
  SKILLS_SCAN_HINT_COPY,
  SKILLS_SCAN_UNAUTHORIZED_COPY,
  SKILL_DISABLED_NOTE_COPY,
} from "@/lib/chat-agent";
import {
  SETTINGS_LOAD_FAILED_COPY,
  SETTINGS_SAVE_ACTION,
  SETTINGS_SAVE_UNREADABLE_COPY,
} from "@/lib/workbench-settings";
import { unconfirmedWriteMessage } from "@/lib/workbench-request";
import { workbenchMode } from "@/lib/workbench-modes";
import { settingsPayload } from "@/test/settings-harness";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
// Only `send` is stubbed — `loopbackFetch` reaches the sidecar through it. The
// REST of the module is the real thing on purpose: `workbench-settings` derives
// every save verdict through `refusedWriteFailure`/`thrownWriteFailure` from
// here, and a whole-module replacement would make each verdict this file drives
// collapse into the same thrown fallback.
vi.mock("@/lib/workbench-request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workbench-request")>()),
  send,
}));

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
 * rejected and the surface would refuse the write for the wrong reason. That is
 * why this is the SHARED base (DW-228/DW-727) rather than a SIXTH verbatim copy
 * of the same ~50 fields: DW-228 folded the four mounted Settings suites,
 * DW-471 folded the fifth (`settings-page-legacy-surface-parity.test.tsx`, in
 * another directory, which is what moved the harness to `src/test/`), and this
 * is the one after those. A field added to `WorkbenchSettingsPayload` has to
 * reach every one of these fixtures or the narrowing starts refusing here for a
 * reason that has nothing to do with Skills.
 *
 * `settingsPayload` ALONE, without `installSettingsFetchMock` or
 * `mountSettings` (DW-727): this file drives `SkillsCanvas`, not the Settings
 * surface, and it keeps its own `fetch` stub because the stub has to route
 * `/api/v1/skills` at the sidecar as well as `/api/settings` — which the
 * Settings harness's single-route mock does not do — and its own `send` mock
 * because the loopback token comes through `workbench-request`.
 *
 * FOUR DELTAS from the shared base, saying TWO things:
 *   - `apiEnabled: true`, `hasLoopbackApiToken: true`,
 *     `loopbackTokenSource: "store"` — three fields, one fact: the loopback door
 *     is OPEN. The rail's scan only answers with the door on, so a fixture
 *     carrying the base's shut door would describe a machine this surface never
 *     reaches.
 *   - `hasEmbeddingApiKey: true` — a stored embedding key, which nothing here
 *     reads. It restores the value the pre-fold literal carried, so the fold
 *     changed no field these cases run against; keeping it is not a standing
 *     claim that the two stay identical as the base moves.
 */
const SETTINGS_BODY = {
  workbench: settingsPayload({
    hasEmbeddingApiKey: true,
    apiEnabled: true,
    hasLoopbackApiToken: true,
    loopbackTokenSource: "store",
  }),
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

  /**
   * A gateway status: nobody's verdict came back, and the flip MAY be stored.
   *
   * DW-625. The rail used to re-scan only on `status: "ok"`, so this verdict —
   * and `"unreadable"` below — left the pre-toggle state on screen until
   * something else triggered a scan, while the store may already have moved.
   */
  it("re-scans and still shows the sentence when the save is unconfirmed", async () => {
    // THE SECOND READ ANSWERS DIFFERENTLY, which is the whole point: the flip
    // DID land, and the rail has to show it. Counting the reads alone pins
    // nothing — a re-scan that fetches and throws the answer away counts the
    // same and reinstates the exact defect DW-625 is about.
    settingsPut = vi.fn(async () => {
      scanned = () =>
        new Response(
          JSON.stringify({ skills: [{ ...SKILLS[0], enabled: false }, SKILLS[1]] }),
          { status: 200 },
        );
      return new Response("{}", { status: 502 });
    });
    render(<SkillsCanvas active />);
    await screen.findByRole("button", { name: "Disable recap" });
    expect(scanCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Disable recap" }));

    await waitFor(() => expect(scanCount()).toBe(2));
    // The re-read landed on screen: the switch now offers to turn it back ON,
    // and the pack says what disabled means.
    expect(await screen.findByRole("button", { name: "Enable recap" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disable recap" })).toBeNull();
    expect(screen.getAllByText(SKILL_DISABLED_NOTE_COPY)).toHaveLength(2);
    // …and the re-read did NOT swallow the one sentence this click is about.
    expect(
      screen.getByText(unconfirmedWriteMessage(SETTINGS_SAVE_ACTION)),
    ).toBeTruthy();
    expect(screen.queryByText(SKILLS_SCAN_FAILED_COPY)).toBeNull();
  });

  it("re-scans and still shows the sentence when the answer had nothing in it", async () => {
    // A 2xx that yields no payload. The route may well have run, so the list on
    // screen may already be wrong for the same reason.
    settingsPut = vi.fn(async () => new Response("{}", { status: 200 }));
    render(<SkillsCanvas active />);
    await screen.findByText("recap");
    fireEvent.click(screen.getByRole("button", { name: "Disable recap" }));

    await waitFor(() => expect(scanCount()).toBe(2));
    expect(await screen.findByText(SETTINGS_SAVE_UNREADABLE_COPY)).toBeTruthy();
  });

  it("does NOT re-scan when the save was refused", async () => {
    // An arrived refusal applied nothing, so the list on screen is still true
    // and a second sidecar read would buy nothing. This is the half that makes
    // `verdictClearsHeldVersion` worth asking rather than re-scanning always.
    settingsPut = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "That Skill id is unknown." }), {
          status: 400,
        }),
    );
    render(<SkillsCanvas active />);
    await screen.findByText("recap");
    fireEvent.click(screen.getByRole("button", { name: "Disable recap" }));

    expect(await screen.findByText("That Skill id is unknown.")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scanCount()).toBe(1);
  });

  it("keeps the packs it already read when the re-scan itself fails", async () => {
    // The re-scan is QUIET: it replaces the list only when it read one, and it
    // writes no message. Otherwise a sidecar that went away between the write
    // and the re-read would blank the rail — which reads as "no Skills", the
    // wrong answer this surface exists to avoid — and would overwrite the
    // sentence about the toggle with its own.
    settingsPut = vi.fn(async () => {
      scanned = () => {
        throw new Error("ECONNREFUSED");
      };
      return new Response("{}", { status: 502 });
    });
    render(<SkillsCanvas active />);
    await screen.findByText("recap");
    fireEvent.click(screen.getByRole("button", { name: "Disable recap" }));

    await waitFor(() => expect(scanCount()).toBe(2));
    expect(
      await screen.findByText(unconfirmedWriteMessage(SETTINGS_SAVE_ACTION)),
    ).toBeTruthy();
    // The last list the rail could actually read is still on screen…
    expect(screen.getByText("recap")).toBeTruthy();
    expect(screen.getByText("offsite")).toBeTruthy();
    // …and the scan's own sentence is not shown over the toggle's.
    expect(screen.queryByText(SKILLS_SCAN_FAILED_COPY)).toBeNull();
    expect(screen.queryByText(workbenchMode("skills").emptyState!)).toBeNull();
  });

  it("keeps the packs it already read when the re-scan answers a shapeless 200", async () => {
    // The third way a re-scan comes back with no list, and the one that is not
    // an obvious failure: a 200 whose body carries no `skills` array — an error
    // envelope, a proxy page, a login body. That is not a scan that found
    // NOTHING; it is a scan that found nothing it can read, and answering it
    // with `[]` would empty a rail that was listing packs a moment ago.
    settingsPut = vi.fn(async () => {
      scanned = () => new Response(JSON.stringify({ error: "nope" }), { status: 200 });
      return new Response("{}", { status: 502 });
    });
    render(<SkillsCanvas active />);
    await screen.findByText("recap");
    fireEvent.click(screen.getByRole("button", { name: "Disable recap" }));

    await waitFor(() => expect(scanCount()).toBe(2));
    expect(
      await screen.findByText(unconfirmedWriteMessage(SETTINGS_SAVE_ACTION)),
    ).toBeTruthy();
    expect(screen.getByText("recap")).toBeTruthy();
    expect(screen.getByText("offsite")).toBeTruthy();
    expect(screen.queryByText(workbenchMode("skills").emptyState!)).toBeNull();
    expect(screen.queryByText(SKILLS_SCAN_FAILED_COPY)).toBeNull();
  });

  it("keeps the packs it already read when the re-scan answers a refusal status", async () => {
    // The non-ok half of the same rule. Three ways in — a status, a thrown
    // read, a shapeless body — and one answer: leave the last list the rail
    // could actually read on screen, and say nothing over the toggle's own
    // sentence.
    settingsPut = vi.fn(async () => {
      scanned = () => new Response("{}", { status: 503 });
      return new Response("{}", { status: 502 });
    });
    render(<SkillsCanvas active />);
    await screen.findByText("recap");
    fireEvent.click(screen.getByRole("button", { name: "Disable recap" }));

    await waitFor(() => expect(scanCount()).toBe(2));
    expect(
      await screen.findByText(unconfirmedWriteMessage(SETTINGS_SAVE_ACTION)),
    ).toBeTruthy();
    expect(screen.getByText("recap")).toBeTruthy();
    expect(screen.getByText("offsite")).toBeTruthy();
    expect(screen.queryByText(SKILLS_SCAN_FAILED_COPY)).toBeNull();
  });

  it("shows the sentence without waiting for the re-scan to come back", async () => {
    // `loopbackFetch` carries no deadline, so a sidecar that accepts the
    // connection and never answers must not hold the sentence about the click
    // hostage — nor leave `busy` set, which disables every switch on the rail.
    // The message goes on screen FIRST; the quiet re-scan writes none on any
    // path, so it cannot overwrite it afterwards.
    settingsPut = vi.fn(async () => {
      scanned = () => new Promise<Response>(() => {}) as unknown as Response;
      return new Response("{}", { status: 502 });
    });
    render(<SkillsCanvas active />);
    await screen.findByText("recap");
    fireEvent.click(screen.getByRole("button", { name: "Disable recap" }));

    expect(
      await screen.findByText(unconfirmedWriteMessage(SETTINGS_SAVE_ACTION)),
    ).toBeTruthy();
    expect(screen.getByText("recap")).toBeTruthy();
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

describe("a refused scan names the switch, not a process to start", () => {
  // A 503 `disabled` and a 401 `unauthorized` are ANSWERS — the sidecar is up
  // and said no. Telling that owner to `pnpm sidecar` sends them to start a
  // process that is already running; the fix is a switch or a token in
  // Settings → API + MCP, and Chat already says so through
  // `chatDoorRefusalCopy`. Only a thrown read means nothing answered.
  it("says the API is off when the door answers 503 disabled", async () => {
    scanned = () =>
      new Response(JSON.stringify({ error: "disabled" }), { status: 503 });
    render(<SkillsCanvas active />);
    expect(await screen.findByText(SKILLS_SCAN_DISABLED_COPY)).toBeTruthy();
    expect(screen.queryByText(SKILLS_SCAN_FAILED_COPY)).toBeNull();
    expect(document.body.textContent).not.toContain("pnpm sidecar");
  });

  it("says the token was refused when the door answers 401 unauthorized", async () => {
    scanned = () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    render(<SkillsCanvas active />);
    expect(await screen.findByText(SKILLS_SCAN_UNAUTHORIZED_COPY)).toBeTruthy();
    expect(screen.queryByText(SKILLS_SCAN_FAILED_COPY)).toBeNull();
  });

  it("keeps the did-not-answer sentence for a non-ok answer it cannot read", async () => {
    scanned = () => new Response("<html>proxy</html>", { status: 502 });
    render(<SkillsCanvas active />);
    expect(await screen.findByText(SKILLS_SCAN_FAILED_COPY)).toBeTruthy();
  });
});
