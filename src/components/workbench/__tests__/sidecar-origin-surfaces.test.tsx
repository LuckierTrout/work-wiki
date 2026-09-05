/**
 * @vitest-environment-options { "url": "https://app.example/" }
 */
/**
 * DW-750 — the rail dot and the API/MCP health line, MOUNTED on a deployed
 * origin.
 *
 * `workbench-modes.test.ts` and `loopback-health-sentence.test.ts` execute both
 * selectors directly and pin every row of the matrix, so nothing about the RULES
 * is re-argued here. What only a mount can show is that the two surfaces are
 * WIRED to them: each reads a real `window.location.origin` through
 * `usePageOrigin`'s mount effect rather than a value a test handed it, and each
 * hands that value to the selector that owns its sentence.
 *
 * That wiring is exactly what a pure suite cannot see. A rail that dropped the
 * `pageOrigin` prop, a shell that stopped passing it, or a pane that called
 * `loopbackHealthSentence` with one argument would leave every selector row
 * green and hand a deployed owner the sentence DW-750 exists to remove.
 *
 * The origin comes from the docblock above rather than from a stub, because
 * `window.location` is not assignable in jsdom and the hook reads it directly —
 * the whole point of reading it after mount is that it is the browser's answer.
 * The default jsdom URL is `http://localhost:3000`, a LOOPBACK origin, so the
 * sibling suites that mount these same surfaces are also the proof that the
 * loopback sentences are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import {
  RAIL_SIDECAR_DOWN_LABEL,
  RAIL_SIDECAR_REFUSED_LABEL,
} from "@/lib/workbench-modes";
import {
  SETTINGS_API_HEALTH_UNREACHABLE_COPY,
  SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY,
  SETTINGS_API_SKILLS_UNKNOWN_COPY,
} from "@/lib/workbench-loopback-health";
import { SETTINGS_LOADING_COPY, SETTINGS_ROUTE } from "@/lib/workbench-settings";
import { clearLoopbackDoorToken } from "@/lib/loopback-client";
import { installSettingsFetchMock, settingsPayload } from "@/test/settings-harness";

// ONE stable router object: several components in this shell key effects on the
// router identity, and a fresh literal per call would rebuild them.
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

/**
 * The sidecar probe answers `down`, chosen at the HOOK rather than at the fetch.
 *
 * `@/lib/sidecar` cannot be mocked wholesale here — `railSidecarDownLabel` reads
 * `isSidecarDefaultAdmittedOrigin` out of that same module, and replacing it
 * would replace the very rule under test. The hook is the seam that carries only
 * the probe's verdict, so stubbing it stages `down` and leaves every origin
 * predicate real.
 */
vi.mock("@/hooks/useSidecarStatus", () => ({
  useSidecarStatus: () => "down",
}));

const fetchMock = installSettingsFetchMock();

const DATA: WorkbenchData = {
  wikis: [],
  currentWikiId: null,
  registryUnavailable: false,
  knowledge: [],
  knowledgeUnavailable: false,
  files: [],
  filesUnavailable: false,
  filesTruncated: false,
  dataVersion: 0,
  readOnly: false,
};

beforeEach(() => {
  clearLoopbackDoorToken();
  // Every loopback call REJECTS, which is `unreachable` — the one health arm the
  // origin qualifies. The settings read itself answers normally, so the pane
  // renders at all.
  fetchMock.mockImplementation(async (url: string) => {
    const target = String(url);
    if (target.includes("/api/v1/")) throw new TypeError("Failed to fetch");
    return {
      ok: true,
      status: 200,
      json: async () => ({ workbench: settingsPayload({ apiEnabled: true }) }),
    } as unknown as Response;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * THE PREMISE, asserted rather than assumed — the same guard
 * `sidecar-down-copy.test.tsx` carries.
 *
 * Everything below is about a DEPLOYED origin, and the only thing that makes
 * this one deployed is the `@vitest-environment-options` docblock at the top of
 * the file. A docblock that is moved, reformatted past the parser, or dropped by
 * a merge silently hands every case the default `http://localhost:3000` — a
 * LOOPBACK origin — where both surfaces are supposed to answer the old
 * sentences. The suite would then invert into a loopback test that fails with
 * two confusing copy mismatches instead of one legible line.
 */
describe("the deployed-origin premise", () => {
  it("really is running on a deployed origin", () => {
    expect(window.location.origin).toBe("https://app.example");
  });
});

describe("the rail dot on a deployed origin", () => {
  it("says the sidecar is not reachable, never that it is not running", async () => {
    render(
      <WorkbenchDataProvider value={DATA}>
        <Workbench>
          <p>canvas</p>
        </Workbench>
      </WorkbenchDataProvider>,
    );
    // The origin lands in a mount effect, so the first render is still the
    // server's answer — the swap is a normal re-render, which is what keeps
    // hydration stable and is exactly what has to be flushed before asserting.
    await act(async () => {});

    const dot = await waitFor(() => {
      const status = screen
        .queryAllByRole("status")
        .find((node) => (node.textContent ?? "").startsWith("Sidecar"));
      expect(status).toBeDefined();
      return status!;
    });

    expect(dot.textContent).toBe(RAIL_SIDECAR_REFUSED_LABEL);
    expect(dot.getAttribute("title")).toBe(RAIL_SIDECAR_REFUSED_LABEL);
    // THE claim this entry removes: on this page the probe cannot tell a dead
    // process from a refused origin, and the rail was asserting the first.
    expect(dot.textContent).not.toBe(RAIL_SIDECAR_DOWN_LABEL);
  });
});

describe("the API + MCP health line on a deployed origin", () => {
  it("names both causes and the origins knob instead of asserting a dead sidecar", async () => {
    render(<SettingsCanvas category="api-mcp" headingId="wb-set-heading" />);
    await waitFor(() => expect(screen.queryByText(SETTINGS_LOADING_COPY)).toBeNull());

    // Found by its Skills half, the convention `settings-api-mcp-pane.test.tsx`
    // established: the health sentences are prose full of `.` and `:`, and more
    // than one note on this pane carries `role="status"`.
    const note = await waitFor(() => {
      const found = screen
        .queryAllByRole("status")
        .find((node) => (node.textContent ?? "").includes(SETTINGS_API_SKILLS_UNKNOWN_COPY));
      expect(found).toBeDefined();
      return found!;
    });

    expect(note.textContent).toContain(SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY);
    expect(note.textContent).not.toContain(SETTINGS_API_HEALTH_UNREACHABLE_COPY);
    // The remedy for the half the owner cannot otherwise guess.
    expect(note.textContent).toContain("WORKWIKI_SIDECAR_ALLOWED_ORIGINS");
    // The settings read is what the mock let through; the loopback calls are
    // what rejected. Stated so the case cannot pass on a pane that never probed.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/v1/health")),
    ).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(SETTINGS_ROUTE))).toBe(
      true,
    );
  });
});
