import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import {
  SETTINGS_LOADING_COPY,
  SETTINGS_READ_ONLY_COPY,
  SETTINGS_ROUTE,
  SETTINGS_SAVED_COPY,
  SETTINGS_SAVING_NOTE_COPY,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";
import {
  SETTINGS_API_COPIED_COPY,
  SETTINGS_API_COPY,
  SETTINGS_API_ENABLED_COPY,
  SETTINGS_API_ENABLE_COPY,
  SETTINGS_API_ENABLE_LABEL,
  SETTINGS_API_MCP_COPY,
  SETTINGS_API_MCP_COPY_COPY,
  SETTINGS_API_MCP_HEADING,
  SETTINGS_API_SKILL_COPY_COPY,
  SETTINGS_API_SKILL_HEADING,
  SETTINGS_API_TOKEN_ABSENT_COPY,
  SETTINGS_API_TOKEN_COPY_COPY,
  SETTINGS_API_TOKEN_ENV_COPY,
  SETTINGS_API_TOKEN_GENERATE_COPY,
  SETTINGS_API_TOKEN_HIDE_COPY,
  SETTINGS_API_TOKEN_LABEL,
  SETTINGS_API_TOKEN_NEW_COPY,
  SETTINGS_API_TOKEN_NO_WAY_IN_COPY,
  SETTINGS_API_TOKEN_SHOW_COPY,
  SETTINGS_API_TOKEN_STORED_COPY,
  SETTINGS_API_UNAUTH_LABEL,
  SETTINGS_API_UNAUTH_OFF_COPY,
  SETTINGS_API_UNAUTH_WARNING_COPY,
  brandedSkillInstallCommand,
  loopbackMcpConfig,
  maskToken,
} from "@/lib/workbench-api-mcp-settings";
import {
  SETTINGS_API_HEALTH_PORT_CONFLICT_COPY,
  SETTINGS_API_HEALTH_RUNNING_COPY,
  SETTINGS_API_HEALTH_STARTING_COPY,
  SETTINGS_API_HEALTH_UNREACHABLE_COPY,
  SETTINGS_API_SKILLS_UNKNOWN_COPY,
} from "@/lib/workbench-loopback-health";
import { LOOPBACK_BASE_URL } from "@/lib/v1-contract";
import { clearLoopbackDoorToken } from "@/lib/loopback-client";
import {
  announcedFor,
  installSettingsFetchMock,
  settingsPayload,
} from "@/test/settings-harness";

/**
 * The API + MCP pane, MOUNTED — the first DOM-level coverage it has ever had.
 *
 * Until DW-445 the pane was 230 lines of JSX inline in `SettingsCanvas`, and the
 * only end-to-end guard on it was one Playwright case that visits a fresh wiki
 * with the door SHUT. So the two switches, the Generate/Show/Copy buttons and
 * the health line — everything behind `values.apiEnabled` — had never been
 * rendered by a suite at all. They are rendered here.
 *
 * `mountSettings` cannot serve this pane: it calls `fetchMock.mockResolvedValue`,
 * one answer for every URL, and the pane's probe asks THREE — the door-token
 * read, the sidecar's `/health` and its Skills scan — each of which has to
 * answer differently. So the canvas is rendered directly behind a URL-routing
 * `mockImplementation`, the same shape `settings-read-only.test.tsx` already
 * uses for its one-response-per-call cases.
 */

const fetchMock = installSettingsFetchMock();

/** The fresh-deployment payload with the door OPEN — the state the pane is about. */
function payload(overrides: Partial<WorkbenchSettingsPayload> = {}): WorkbenchSettingsPayload {
  return settingsPayload({ apiEnabled: true, ...overrides });
}

type Live = {
  /** What `/api/v1/health` answers, or `null` for a sidecar that is not there. */
  health?: unknown;
  /**
   * What the Skills scan answers, or `undefined` for a scan that DOES NOT
   * ANSWER — the same convention `health` uses one field up.
   *
   * The two have to be separately expressible (DW-716): a scan that answered
   * `[]` is a real zero, and a scan that never answered is not a count at all.
   * The route used to hand back `{ skills: [] }` for both, so the case below
   * that stages a dead sidecar was asserting a Skills count the fixture itself
   * had invented.
   */
  skills?: Array<{ id: string }>;
  /**
   * Hold `/health` OPEN until the test releases it.
   *
   * The pre-probe state is otherwise not observable. `mountPane` waits on the
   * SETTINGS read, and the probe's three awaited fetches routinely flush inside
   * that same `waitFor` tick — so "the health line is absent" was true or false
   * depending on microtask ordering, which made the case that asserts it fail
   * about three runs in five. Gating the response makes the two states two
   * separate, ordered facts instead of a race.
   */
  hold?: boolean;
  /**
   * Hold the SAVE (`PUT /api/settings`) open until the test releases it.
   *
   * The same trick as `hold` above, one request along: the canvas's standing
   * refusal (DW-67/DW-626) lasts only as long as the PUT is out, and a mock
   * that answers on its own settles inside the click's own tick. Gating it is
   * what makes "refused, and saying so" a state assertions can stand in.
   */
  holdSave?: boolean;
};

/**
 * Route the four URLs this surface touches, by URL rather than by call order.
 *
 * Order is not a usable key here: the settings read and the pane's probe are
 * started by different effects in the same commit, and the probe's own two calls
 * are sequential only because `loopbackFetch` awaits the door token first.
 *
 * Returns the releases for `hold` and `holdSave` — each a no-op when the case
 * did not ask for one.
 */
function routeFetch(
  stored: WorkbenchSettingsPayload,
  live: Live = {},
): { releaseHealth: () => void; releaseSave: () => void } {
  let release = () => {};
  const gate = live.hold
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  let releaseSave = () => {};
  const saveGate = live.holdSave
    ? new Promise<void>((resolve) => {
        releaseSave = resolve;
      })
    : Promise.resolve();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const target = String(url);
    // The door token, cached module-wide by `loopback-client` — cleared per test
    // below, or the second test in this file would run against the first's.
    if (target.includes("/api/v1/loopback-settings")) {
      return { ok: true, status: 200, json: async () => ({ token: null }) } as Response;
    }
    if (target.includes("/api/v1/health")) {
      await gate;
      if (live.health === undefined) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, json: async () => live.health } as Response;
    }
    if (target.includes("/api/v1/skills")) {
      // No `skills` in the fixture means nothing is serving the scan either —
      // which is the state a dead sidecar actually produces, both of its calls
      // rejected. A case that wants a counted zero says `skills: []`.
      if (live.skills === undefined) throw new TypeError("Failed to fetch");
      return {
        ok: true,
        status: 200,
        json: async () => ({ skills: live.skills }),
      } as Response;
    }
    // The SAVE, held when the case asked for it — the mount read is a GET and
    // goes straight through, so one gate cannot stall the other. Keyed on the
    // ROUTE as well as the verb: a gate that catches every PUT would stall the
    // first unrelated one some later surface sends through this same mock.
    if (init?.method === "PUT" && target.includes(SETTINGS_ROUTE)) await saveGate;
    return {
      ok: true,
      status: 200,
      json: async () => ({ workbench: stored }),
    } as unknown as Response;
  });
  return { releaseHealth: release, releaseSave };
}

/** Mount the API + MCP category and let the settings read settle. */
async function mountPane(stored: WorkbenchSettingsPayload, live: Live = {}) {
  const { releaseHealth, releaseSave } = routeFetch(stored, live);
  const view = render(<SettingsCanvas category="api-mcp" headingId="wb-set-heading" />);
  await waitFor(() => expect(screen.queryByText(SETTINGS_LOADING_COPY)).toBeNull());
  return { view, releaseHealth, releaseSave };
}

/**
 * The live health line if the probe has landed, `undefined` while it is out.
 *
 * Found by the Skill count rather than by the sentence: the health sentences are
 * prose full of `.` and `:`, so a regex built from one silently matches things
 * it was never meant to, and the token-absent note carries `role="status"` too.
 */
function healthNote(): HTMLElement | undefined {
  return screen
    .queryAllByRole("status")
    .find((element) => skillClaim(element.textContent ?? "") !== null);
}

/**
 * What the note says about Skills on disk: the counted sentence, the
 * did-not-answer sentence, or `null` for a node that is not the health line.
 *
 * Widened from the count regex alone (DW-716). The line is still found by its
 * Skills half rather than by its health half — the health sentences are prose
 * full of `.` and `:`, and the token-absent note carries `role="status"` too —
 * but "N Skills on disk." is no longer the ONLY thing that half can say, and a
 * matcher that still insisted on a digit would simply stop finding the line in
 * exactly the case this fix is about.
 */
function skillClaim(text: string): "counted" | "unknown" | null {
  if (/\d Skills? on disk\./.test(text)) return "counted";
  if (text.includes(SETTINGS_API_SKILLS_UNKNOWN_COPY)) return "unknown";
  return null;
}

function healthLine(): Promise<HTMLElement> {
  return waitFor(() => {
    const note = healthNote();
    expect(note).toBeDefined();
    return note!;
  });
}

/** How many times the pane has probed `/health`. */
function probeCount(): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/v1/health"))
    .length;
}

/**
 * Let every pending effect and the probe's awaited fetches land.
 *
 * `waitFor` cannot check that something did NOT happen: it returns the instant
 * its callback passes, which for "the count is still 1" is the first tick —
 * before a re-fired probe has even reached `fetch`, since `loopbackFetch` awaits
 * the door token first. A count asserted that way passes against an effect that
 * probes on every keystroke, which is exactly what it is meant to catch.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 4; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

const enableSwitch = () => screen.getByLabelText(SETTINGS_API_ENABLE_LABEL);
const unauthSwitch = () => screen.getByLabelText(SETTINGS_API_UNAUTH_LABEL);

beforeEach(() => {
  // `readLoopbackDoorToken` caches for the life of the MODULE, so without this
  // every test after the first would reuse the first one's answer — and a test
  // that never routed the door read would still get a token.
  clearLoopbackDoorToken();
});

describe("the pane probes once and says what it found", () => {
  it("shows nothing until the probe lands, then the sentence and the Skill count", async () => {
    const { releaseHealth } = await mountPane(
      payload(),
      { health: { status: "running" }, skills: [{ id: "a" }, { id: "b" }], hold: true },
    );
    // The health line is ABSENT while the probe is still out: a pane that
    // guessed would be claiming something about a process it has not reached.
    expect(healthNote()).toBeUndefined();
    expect(document.body.textContent).not.toContain(SETTINGS_API_HEALTH_RUNNING_COPY);

    releaseHealth();
    const note = await healthLine();
    expect(note.textContent).toContain(SETTINGS_API_HEALTH_RUNNING_COPY);
    expect(note.textContent).toContain("2 Skills on disk.");
  });

  it("probes exactly ONCE per visit, however often the canvas re-renders", async () => {
    // The empty dependency array is the whole point of moving the effect here:
    // it used to hang off `category` on a canvas that re-renders on every
    // keystroke elsewhere in the surface. A dependency that re-fires it would
    // hammer the sidecar from a pane the owner is only looking at.
    const { view } = await mountPane(payload(), { health: { status: "running" } });
    await healthLine();
    expect(probeCount()).toBe(1);
    // A bare re-render, which catches a missing dependency array outright.
    view.rerender(<SettingsCanvas category="api-mcp" headingId="wb-set-heading" />);
    // …then a move on EACH prop the effect could plausibly be given as a
    // dependency. Both switches are ticked, so `[values]`, `[values.apiEnabled]`
    // and `[values.allowUnauthenticated]` each re-fire and each fail here.
    fireEvent.click(unauthSwitch());
    fireEvent.click(enableSwitch());
    expect((enableSwitch() as HTMLInputElement).checked).toBe(false);
    fireEvent.click(enableSwitch());
    // Generate moves the draft a third way, for `[values.loopbackApiToken]`.
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY }));
    await settle();
    expect(probeCount()).toBe(1);
  });

  it("counts one Skill in the singular", async () => {
    await mountPane(payload(), { health: { status: "running" }, skills: [{ id: "a" }] });
    expect((await healthLine()).textContent).toContain("1 Skill on disk.");
  });

  it("says a STARTING sidecar is coming up, never that it is running (DW-633)", async () => {
    // `starting` is a listener that has not bound yet, and it used to fall
    // through the pane's ternary chain onto the running sentence — so the pane
    // told the owner the door was open at the one moment their first call was
    // guaranteed a refused connection.
    await mountPane(payload(), { health: { status: "starting" }, skills: [{ id: "a" }] });
    const note = await healthLine();
    expect(note.textContent).toContain(SETTINGS_API_HEALTH_STARTING_COPY);
    expect(note.textContent).not.toContain(SETTINGS_API_HEALTH_RUNNING_COPY);
    // The Skill count still rides along: the sentence changed, not the line.
    expect(note.textContent).toContain("1 Skill on disk.");
  });

  it("names a foreign process on the port rather than calling it this wiki", async () => {
    // A payload with no recognised `status` is SOMETHING ELSE answering on
    // 19828, which is a different fact from "the sidecar is down".
    await mountPane(payload(), { health: { hello: "not the wiki" } });
    expect((await healthLine()).textContent).toContain(
      SETTINGS_API_HEALTH_PORT_CONFLICT_COPY,
    );
  });

  it("reads a listener that DIED as unreachable, the same as one that never was", async () => {
    // `error` and a refused connection are one fact to the owner — nothing is
    // serving on 19828 — so they deliberately share a sentence. Pinned because
    // the exhaustive selector now has to name `error` explicitly, and naming it
    // is exactly where a well-meant "the sidecar reported an error" could
    // arrive and quietly split a state that was always one.
    await mountPane(payload(), { health: { status: "error" } });
    expect((await healthLine()).textContent).toContain(
      SETTINGS_API_HEALTH_UNREACHABLE_COPY,
    );
  });

  it("reads a rejected probe as unreachable and COUNTS NOTHING (DW-716)", async () => {
    // Nothing on 19828: both halves of the probe reject. The pane used to
    // append "0 Skills on disk." here, because the probe swallowed the failed
    // scan into an empty list — telling an owner with a folder full of Skills
    // that they had none, on the evidence of a call that never landed.
    await mountPane(payload());
    const note = await healthLine();
    expect(note.textContent).toContain(SETTINGS_API_HEALTH_UNREACHABLE_COPY);
    expect(note.textContent).toContain(SETTINGS_API_SKILLS_UNKNOWN_COPY);
    // The claim's ABSENCE is what fails: any digit followed by the count
    // phrase, not just the "0" this case used to assert.
    expect(note.textContent).not.toMatch(/\d Skills? on disk\./);
    // …and nowhere else on the surface either, so a second copy of the count
    // cannot satisfy the line above by living in another node.
    expect(document.body.textContent).not.toMatch(/\d Skills? on disk\./);
  });

  it("still states a REAL zero when the scan answers with an empty list", async () => {
    // The other side of the same fix, and the reason it cannot be applied as
    // "never count": a running sidecar that scanned and found nothing has
    // established a fact, and "0 Skills on disk." is that fact stated.
    await mountPane(payload(), { health: { status: "running" }, skills: [] });
    const note = await healthLine();
    expect(note.textContent).toContain(SETTINGS_API_HEALTH_RUNNING_COPY);
    expect(note.textContent).toContain("0 Skills on disk.");
    expect(note.textContent).not.toContain(SETTINGS_API_SKILLS_UNKNOWN_COPY);
  });

  it("re-probes on a return visit and shows the token masked again", async () => {
    const { view } = await mountPane(payload(), { health: { status: "running" } });
    await healthLine();
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY }));
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_TOKEN_SHOW_COPY }));
    const revealed = screen.getByText(/^[0-9a-f]{48}$/).textContent!;
    expect(
      screen.getByRole("button", { name: SETTINGS_API_TOKEN_HIDE_COPY }),
    ).toBeTruthy();

    const before = probeCount();
    view.rerender(<SettingsCanvas category="embeddings" headingId="wb-set-heading" />);
    view.rerender(<SettingsCanvas category="api-mcp" headingId="wb-set-heading" />);

    // The DRAFT token survived the trip — leaving a category discards nothing.
    // The REVEAL did not: "shown once" is what the pane's own copy promises, and
    // Show brings it straight back.
    expect(screen.queryByText(revealed)).toBeNull();
    expect(
      screen.getByRole("button", { name: SETTINGS_API_TOKEN_SHOW_COPY }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_TOKEN_SHOW_COPY }));
    expect(screen.getByText(revealed)).toBeTruthy();
    await settle();
    expect(probeCount()).toBe(before + 1);
  });
});

describe("the door, shut", () => {
  it("renders the standing note, the Base URL, the switch and BOTH snippets", async () => {
    // The pin behind `e2e/workbench-owner.spec.ts`, which runs on a FRESH wiki:
    // everything outside the `values.apiEnabled &&` guard is visible with the
    // door shut, and that includes both `<h3>`/`<pre>` blocks.
    await mountPane(settingsPayload(), { health: { status: "running" } });
    expect(screen.getByText(SETTINGS_API_COPY)).toBeTruthy();
    expect(screen.getByText(LOOPBACK_BASE_URL)).toBeTruthy();
    expect((enableSwitch() as HTMLInputElement).checked).toBe(false);
    expect(announcedFor(enableSwitch())).toContain(SETTINGS_API_ENABLE_COPY);
    await healthLine();
    expect(
      screen.getByRole("heading", { name: SETTINGS_API_MCP_HEADING }),
    ).toBeTruthy();
    expect(screen.getByText(SETTINGS_API_MCP_COPY)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: SETTINGS_API_SKILL_HEADING }),
    ).toBeTruthy();
    expect(screen.getByText(brandedSkillInstallCommand())).toBeTruthy();
    expect(document.querySelectorAll("pre.wb-set-pre")).toHaveLength(2);

    // …and nothing BEHIND the guard is.
    expect(screen.queryByLabelText(SETTINGS_API_UNAUTH_LABEL)).toBeNull();
    expect(
      screen.queryByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY }),
    ).toBeNull();
    expect(screen.queryByText(SETTINGS_API_TOKEN_ABSENT_COPY)).toBeNull();
    expect(screen.queryByText(SETTINGS_API_TOKEN_NO_WAY_IN_COPY)).toBeNull();
  });
});

describe("the two switches", () => {
  it("clears unauthenticated access — and its warning — when the door is shut", async () => {
    await mountPane(settingsPayload(), { health: { status: "running" } });
    fireEvent.click(enableSwitch());
    fireEvent.click(unauthSwitch());
    expect((unauthSwitch() as HTMLInputElement).checked).toBe(true);
    expect(announcedFor(unauthSwitch())).toContain(SETTINGS_API_UNAUTH_WARNING_COPY);

    fireEvent.click(enableSwitch());
    expect((enableSwitch() as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText(SETTINGS_API_UNAUTH_WARNING_COPY)).toBeNull();
    // Re-opening cannot silently reopen an UNAUTHENTICATED door.
    fireEvent.click(enableSwitch());
    expect((unauthSwitch() as HTMLInputElement).checked).toBe(false);
    expect(announcedFor(unauthSwitch())).toContain(SETTINGS_API_UNAUTH_OFF_COPY);
  });

  it("flips the enable hint to the ON sentence", async () => {
    await mountPane(settingsPayload(), { health: { status: "running" } });
    expect(announcedFor(enableSwitch())).toContain(SETTINGS_API_ENABLE_COPY);
    fireEvent.click(enableSwitch());
    expect(announcedFor(enableSwitch())).toContain(SETTINGS_API_ENABLED_COPY);
  });

  it("marks the unauthenticated hint orange only while it is ticked", async () => {
    await mountPane(payload(), { health: { status: "running" } });
    const hint = () =>
      document.getElementById(
        unauthSwitch().getAttribute("aria-describedby")!.split(" ")[0],
      )!;
    expect(hint().className).toBe("wb-set-hint");
    fireEvent.click(unauthSwitch());
    expect(hint().className).toBe("wb-set-hint wb-set-warn");
  });

  it("refuses the enable switch on a read-only deployment, and says why", async () => {
    // Mounted with the door SHUT so a leaked click would visibly TICK the box.
    // Against a payload that already has it on, "still checked" would hold
    // whether or not the `if (stored.readOnly) return;` guard ever fired.
    await mountPane(settingsPayload({ readOnly: true }), { health: { status: "running" } });
    const control = enableSwitch() as HTMLInputElement;
    expect(control.getAttribute("aria-disabled")).toBe("true");
    // `disabled` would take the control out of the tab order, so a keyboard
    // user could not reach it to READ the state at all.
    expect(control.disabled).toBe(false);
    control.focus();
    expect(document.activeElement).toBe(control);
    // The refusal is ANNOUNCED, which is the entire reason `describedBy` is
    // passed down from the canvas rather than the pane building ids itself:
    // `aria-describedby` takes a list, so the read-only sentence is APPENDED to
    // this control's own hint instead of replacing it.
    const announced = announcedFor(control);
    expect(announced).toContain(SETTINGS_API_ENABLE_COPY);
    expect(announced).toContain(SETTINGS_READ_ONLY_COPY);

    fireEvent.click(control);
    expect(control.checked).toBe(false);
  });

  it("refuses the unauthenticated switch too, and offers no Generate", async () => {
    await mountPane(payload({ readOnly: true }), { health: { status: "running" } });
    const control = unauthSwitch() as HTMLInputElement;
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.disabled).toBe(false);
    control.focus();
    expect(document.activeElement).toBe(control);
    const announced = announcedFor(control);
    expect(announced).toContain(SETTINGS_API_UNAUTH_OFF_COPY);
    expect(announced).toContain(SETTINGS_READ_ONLY_COPY);

    // Unticked to start, and a click leaves it that way.
    expect(control.checked).toBe(false);
    fireEvent.click(control);
    expect(control.checked).toBe(false);
    // No Generate either: there is nothing this deployment could store.
    expect(
      screen.queryByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY }),
    ).toBeNull();
  });
});

describe("the token", () => {
  it("mints one, masks it, reveals it and substitutes it into the MCP config", async () => {
    // Start SHUT and open the door, so the draft is dirty and Save is live —
    // which is the half of "Save is not blocked" that a pristine mount cannot
    // show, since Save is disabled for want of an edit either way.
    await mountPane(settingsPayload(), { health: { status: "running" } });
    fireEvent.click(enableSwitch());
    // The door is now open with no way in, so the pane says so — in a
    // `role="status"` note, and WITHOUT blocking Save.
    //
    // Reached by its TEXT rather than by hunting the `role="status"` list for a
    // node whose content happens to equal the hint's (DW-635). Both sentences
    // were the same string, so `getByText` threw on the duplicate and the only
    // way through was a `find` that could not say which of the two it had. Two
    // sentences, one node each, is what makes a plain query honest here.
    expect(screen.getAllByText(SETTINGS_API_TOKEN_NO_WAY_IN_COPY)).toHaveLength(1);
    expect(screen.getAllByText(SETTINGS_API_TOKEN_ABSENT_COPY)).toHaveLength(1);
    // …and they say DIFFERENT things: the hint describes the FIELD, the note
    // describes what happens to CALLERS. One string in two places was an
    // announcement repeated to a screen reader for no added fact.
    expect(SETTINGS_API_TOKEN_NO_WAY_IN_COPY).not.toBe(SETTINGS_API_TOKEN_ABSENT_COPY);
    expect(screen.getByText(SETTINGS_API_TOKEN_NO_WAY_IN_COPY).className).toContain(
      "wb-set-warn",
    );
    expect(
      (screen.getByRole("button", { name: /^Save/ }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY }));
    // MASKED by default: this pane can be open on a shared screen. Read as a
    // STRING rather than held as a node: React re-uses the same `<code>` for
    // the revealed value, so a captured element would compare against itself.
    const masked = document.querySelector("code.wb-set-static")!.textContent!;
    expect(masked).toMatch(/^•{24}[0-9a-f]{4}$/);
    expect(screen.getByText(SETTINGS_API_TOKEN_NEW_COPY)).toBeTruthy();
    // …and both absent sentences are gone, because there is now a way in.
    expect(screen.queryByText(SETTINGS_API_TOKEN_NO_WAY_IN_COPY)).toBeNull();
    expect(screen.queryByText(SETTINGS_API_TOKEN_ABSENT_COPY)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_TOKEN_SHOW_COPY }));
    const token = document.querySelector("code.wb-set-static")!.textContent!;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(maskToken(token)).toBe(masked);
    // The snippet on screen carries the real token the moment it exists —
    // which is the one moment the config is useful.
    expect(document.querySelectorAll("pre.wb-set-pre")[0].textContent).toBe(
      loopbackMcpConfig(token),
    );
  });

  it("says the field is empty without warning about 401 when the door is open to all", async () => {
    // Unauthenticated access ON is the other half of DW-635's split. There is
    // still no token, so the HINT says so — but no caller is going to get a
    // 401, so the note that says they will must not be here. One sentence,
    // because only one of the two questions has an answer worth giving.
    await mountPane(payload(), { health: { status: "running" } });
    fireEvent.click(unauthSwitch());
    expect((unauthSwitch() as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByText(SETTINGS_API_TOKEN_ABSENT_COPY)).toHaveLength(1);
    expect(screen.queryByText(SETTINGS_API_TOKEN_NO_WAY_IN_COPY)).toBeNull();
    // …and it is the HINT that survived, announced by the Generate button
    // rather than merely printed beside it.
    expect(
      announcedFor(screen.getByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY })),
    ).toContain(SETTINGS_API_TOKEN_ABSENT_COPY);
  });

  it("removes Generate and explains itself when the environment supplies the token", async () => {
    await mountPane(payload({ loopbackTokenSource: "env" }), {
      health: { status: "running" },
    });
    expect(
      screen.queryByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY }),
    ).toBeNull();
    expect(screen.getByText(SETTINGS_API_TOKEN_ENV_COPY)).toBeTruthy();
    // An env token IS a token, so nothing warns about a door with no way in.
    expect(screen.queryByText(SETTINGS_API_TOKEN_NO_WAY_IN_COPY)).toBeNull();
    expect(screen.queryByText(SETTINGS_API_TOKEN_ABSENT_COPY)).toBeNull();
  });

  it("says a token is stored without offering to show one", async () => {
    // The fourth branch of the hint, and the ordinary state of a door that was
    // configured on some earlier visit: the server answers a presence boolean
    // and never the value, so there is nothing here to reveal or copy.
    await mountPane(payload({ hasLoopbackApiToken: true }), {
      health: { status: "running" },
    });
    expect(screen.getByText(SETTINGS_API_TOKEN_STORED_COPY)).toBeTruthy();
    expect(screen.queryByText(SETTINGS_API_TOKEN_NO_WAY_IN_COPY)).toBeNull();
    expect(screen.queryByText(SETTINGS_API_TOKEN_ABSENT_COPY)).toBeNull();
    expect(document.querySelector("code.wb-set-static")).toBeNull();
    expect(
      screen.queryByRole("button", { name: SETTINGS_API_TOKEN_SHOW_COPY }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: SETTINGS_API_TOKEN_COPY_COPY }),
    ).toBeNull();
    // Generate is still offered: replacing a stored token is the one edit here.
    expect(
      screen.getByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY }),
    ).toBeTruthy();
    // The snippet cannot carry a token the server never served back.
    expect(document.querySelectorAll("pre.wb-set-pre")[0].textContent).toContain(
      "PASTE_YOUR_TOKEN",
    );
  });

  it("shows the placeholder in the snippet while no token is in hand", async () => {
    await mountPane(payload(), { health: { status: "running" } });
    const snippet = document.querySelectorAll("pre.wb-set-pre")[0].textContent!;
    expect(snippet).toContain("PASTE_YOUR_TOKEN");
    expect(snippet).toContain('"yopedia"');
    expect(snippet).toContain('"command": "node"');
    expect(snippet).not.toMatch(/token=/);
  });
});

/**
 * What a screen reader hears from `Generate`, `Show` and `Copy` (DW-634).
 *
 * All three have a one-word accessible name, so on their own they announce a
 * verb and nothing about WHICH token or what state it is in. The row label was
 * already wired; the HINT — the sentence carrying `LLM_WIKI_API_TOKEN` is set,
 * or copy this now because it is never shown again — sat in a span with an id
 * no control referenced, which is the accessibility equivalent of not rendering
 * it for anyone who cannot see the row.
 */
describe("the token controls announce the row", () => {
  /** The three controls, by the accessible name each one actually has. */
  function tokenControls(): HTMLElement[] {
    return [
      SETTINGS_API_TOKEN_GENERATE_COPY,
      SETTINGS_API_TOKEN_SHOW_COPY,
      SETTINGS_API_TOKEN_COPY_COPY,
    ].map((name) => screen.getByRole("button", { name }));
  }

  it("reads the label AND the hint from Generate, Show and Copy", async () => {
    await mountPane(payload(), { health: { status: "running" } });
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY }));
    for (const control of tokenControls()) {
      const announced = announcedFor(control);
      // WHICH token — the label is the only thing that says so.
      expect(announced).toContain(SETTINGS_API_TOKEN_LABEL);
      // …and what state it is in: shown once, never again. The single most
      // consequential sentence on this pane, and it was announced to nobody.
      expect(announced).toContain(SETTINGS_API_TOKEN_NEW_COPY);
    }
  });

  it("follows the hint through its branches rather than pinning one sentence", async () => {
    // Generate is the only control on screen when a token is merely STORED,
    // and the hint it announces is that branch's sentence, not the mint one.
    await mountPane(payload({ hasLoopbackApiToken: true }), {
      health: { status: "running" },
    });
    const announced = announcedFor(
      screen.getByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY }),
    );
    expect(announced).toContain(SETTINGS_API_TOKEN_LABEL);
    expect(announced).toContain(SETTINGS_API_TOKEN_STORED_COPY);
    expect(announced).not.toContain(SETTINGS_API_TOKEN_NEW_COPY);
  });

  it("keeps the bar's refusal sentence alongside both while a save is out", async () => {
    // `aria-describedby` takes a LIST, and `describedBy` is plain concatenation
    // — so adding the hint must APPEND to the label rather than take the slot
    // the canvas's refusal sentence lands in. This is the case that would fail
    // if the hint had been swapped in for the label, or the pair for the note.
    const { releaseSave } = await mountPane(payload(), {
      health: { status: "running" },
      holdSave: true,
    });
    // Generate both dirties the draft — so Save is reachable — and puts the
    // freshly minted token in it, which is the state the hint is about.
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY }));
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));

    // In a `finally`, so a failed assertion leaves the PUT settled rather than
    // a pending promise and a component unmounted mid-save.
    try {
      const generate = screen.getByRole("button", {
        name: SETTINGS_API_TOKEN_GENERATE_COPY,
      });
      expect(generate.getAttribute("aria-disabled")).toBe("true");
      const announced = announcedFor(generate);
      expect(announced).toContain(SETTINGS_API_TOKEN_LABEL);
      expect(announced).toContain(SETTINGS_API_TOKEN_NEW_COPY);
      expect(announced).toContain(SETTINGS_SAVING_NOTE_COPY);
    } finally {
      releaseSave();
    }
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());
  });
});

describe("the clipboard", () => {
  it("copies the token in the CLEAR, not the masked form on screen", async () => {
    // The whole point of the button. Copying what the `<code>` shows would put
    // twenty-four bullets on the clipboard, and the owner would only find out
    // when their agent got a 401 — after the one moment this value is available.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await mountPane(payload(), { health: { status: "running" } });
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY }));
    // Copied while still MASKED — the reveal is not a precondition, because the
    // one interaction that has to succeed must not need a second click first.
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_TOKEN_COPY_COPY }));
    await waitFor(() => expect(screen.getByText(SETTINGS_API_COPIED_COPY)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_TOKEN_SHOW_COPY }));
    const token = document.querySelector("code.wb-set-static")!.textContent!;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(writeText).toHaveBeenCalledWith(token);
    expect(writeText).not.toHaveBeenCalledWith(maskToken(token));
    expect(writeText).not.toHaveBeenCalledWith("");
  });

  it("copies the MCP config and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await mountPane(payload(), { health: { status: "running" } });
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_MCP_COPY_COPY }));
    await waitFor(() => expect(screen.getByText(SETTINGS_API_COPIED_COPY)).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(loopbackMcpConfig(null));
  });

  it("copies the Skill install command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await mountPane(payload(), { health: { status: "running" } });
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_SKILL_COPY_COPY }));
    await waitFor(() => expect(screen.getByText(SETTINGS_API_COPIED_COPY)).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(brandedSkillInstallCommand());
  });

  it("stays silent when the clipboard refuses, and leaves the snippet on screen", async () => {
    // A refused permission and an insecure origin both land here. Claiming a
    // copy over an empty clipboard would send the owner to paste nothing.
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await mountPane(payload(), { health: { status: "running" } });
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_API_MCP_COPY_COPY }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByText(SETTINGS_API_COPIED_COPY)).toBeNull();
    // The fallback is selecting it by hand, so it must still be there.
    expect(document.querySelectorAll("pre.wb-set-pre")[0].textContent).toContain(
      "PASTE_YOUR_TOKEN",
    );
  });
});
