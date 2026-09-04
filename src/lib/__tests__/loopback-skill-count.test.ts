import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOOPBACK_HEALTH_URL } from "../v1-contract";
import {
  SETTINGS_API_SKILLS_UNKNOWN_COPY,
  loopbackSkillCountSentence,
  probeLoopbackApiPane,
} from "../workbench-loopback-health";

/**
 * What the pane is allowed to say about Skills on disk (DW-716).
 *
 * `probeLoopbackApiPane` used to swallow a failed Skills scan into `skills: []`
 * on THREE separate paths — a rejected call, a non-OK response, and a 200 whose
 * body carries no `skills` array — and the pane appended `${length} Skills on
 * disk.` to whichever health sentence it had chosen. A wiki whose sidecar is
 * not started therefore read "The sidecar is not running on 127.0.0.1:19828. 0
 * Skills on disk.", stating as counted fact something no scan ever counted.
 *
 * The mounted suite (`settings-api-mcp-pane.test.tsx`) pins what the OWNER
 * reads, and it stages the whole-sidecar-down case: both halves of the probe
 * reject. It cannot reach the other two swallow paths without a fixture knob
 * per failure shape, and those two are exactly where a well-meant `?? []` would
 * come back — the empty list would then be indistinguishable from a real zero
 * with the entire run green. So they are pinned HERE, at the seam that produced
 * them.
 *
 * `loopbackFetch` is the one door the probe goes through, so mocking it is what
 * makes each failure shape expressible. This file's suite is the `node`
 * project, which mounts nothing — the probe is a plain async function and the
 * sentence builder is pure, so neither needs a DOM.
 */

const loopbackFetch = vi.hoisted(() => vi.fn());

vi.mock("../loopback-client", () => ({
  loopbackFetch,
  readLoopbackDoorToken: async () => null,
  clearLoopbackDoorToken: () => {},
}));

/** One `SkillSummary`-shaped entry — only its presence in the list matters. */
const SKILL = {
  id: "a",
  name: "A",
  description: "",
  scope: "user",
  enabled: true,
};

/**
 * Answer `/health` as a running sidecar and hand the Skills scan whatever this
 * case is about, so every assertion below is about the SCAN half alone.
 */
function routeScan(scan: () => Promise<unknown>): void {
  loopbackFetch.mockImplementation(async (url: string) => {
    if (String(url) === LOOPBACK_HEALTH_URL) {
      return { ok: true, status: 200, json: async () => ({ status: "running" }) };
    }
    return scan();
  });
}

beforeEach(() => {
  loopbackFetch.mockReset();
});

describe("probeLoopbackApiPane's Skills half", () => {
  it("reports the list a scan that ANSWERED handed back", async () => {
    routeScan(async () => ({ ok: true, status: 200, json: async () => ({ skills: [SKILL] }) }));
    expect((await probeLoopbackApiPane()).skills).toEqual([SKILL]);
  });

  it("reports an EMPTY list as an empty list — a scan that answered zero counted", async () => {
    routeScan(async () => ({ ok: true, status: 200, json: async () => ({ skills: [] }) }));
    expect((await probeLoopbackApiPane()).skills).toEqual([]);
  });

  it("reports a REJECTED scan as unknown, not as zero", async () => {
    routeScan(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect((await probeLoopbackApiPane()).skills).toBeNull();
  });

  it("reports a NON-OK scan as unknown, not as zero", async () => {
    // The API door shut, or the sidecar refusing this route: a 503 says nothing
    // about how many Skills are on the machine. The body is deliberately a
    // VALID list, so a probe that read it anyway fails here.
    routeScan(async () => ({ ok: false, status: 503, json: async () => ({ skills: [SKILL] }) }));
    expect((await probeLoopbackApiPane()).skills).toBeNull();
  });

  it("reports a 200 with NO skills array as unknown, not as zero", async () => {
    routeScan(async () => ({ ok: true, status: 200, json: async () => ({ error: "nope" }) }));
    expect((await probeLoopbackApiPane()).skills).toBeNull();
  });

  it("reports an UNPARSEABLE body as unknown, not as zero", async () => {
    routeScan(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    }));
    expect((await probeLoopbackApiPane()).skills).toBeNull();
  });

  it("leaves the health half alone when the scan fails (DW-633 stands)", async () => {
    // The two halves are independent calls, and the point of this fix is that
    // one of them failing does not change what the other established.
    routeScan(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect((await probeLoopbackApiPane()).health).toBe("running");
  });
});

describe("loopbackSkillCountSentence", () => {
  it("says the scan did not answer for an unknown count", () => {
    expect(loopbackSkillCountSentence(null)).toBe(SETTINGS_API_SKILLS_UNKNOWN_COPY);
    // No digit anywhere in it: "unknown" must not be spelled like a count, or
    // the pane suite's own matcher — and a reader skimming the line — reads one.
    expect(SETTINGS_API_SKILLS_UNKNOWN_COPY).not.toMatch(/\d/);
  });

  it("counts a real answer, singular and plural", () => {
    expect(loopbackSkillCountSentence([])).toBe("0 Skills on disk.");
    expect(loopbackSkillCountSentence([SKILL])).toBe("1 Skill on disk.");
    expect(loopbackSkillCountSentence([SKILL, { ...SKILL, id: "b" }])).toBe("2 Skills on disk.");
  });
});
