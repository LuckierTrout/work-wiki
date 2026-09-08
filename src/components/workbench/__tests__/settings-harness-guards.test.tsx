import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  SETTINGS_SAVED_COPY,
  SETTINGS_SAVE_COPY,
} from "@/lib/workbench-settings";
import {
  installSettingsFetchMock,
  mountSettings,
  mountSettingsQueue,
  patchOf,
  settingsPayload,
} from "@/test/settings-harness";

/**
 * What `settings-harness.tsx` does on its own behalf (DW-627): the REFUSALS it
 * makes, and the one queue behaviour the fold had to preserve verbatim.
 *
 * The refusals exist because the failure they replace is opaque. A queue
 * mounted with no `fetch` stub goes to the real network and dies as a `waitFor`
 * timeout pointing at the loading text; `patchOf` on a call that carried no
 * body used to reach `JSON.parse(String(undefined))` and die as
 * `Unexpected token u` at a stack frame inside the parser. Neither message
 * names the line that is wrong, and neither is reachable from any suite that
 * uses the harness correctly — so nothing else in the repo can observe that the
 * guards still fire, or that they still say what they say.
 *
 * `mountSettings`' twin of the first guard predates this file and is left where
 * it is; this is about the pair the fold introduced.
 */

/**
 * The uninstalled call, made BEFORE the install below flips the module flag.
 *
 * `installed` is module state, set once and never cleared, so "this file has no
 * `fetch` stub" is a condition that exists only until `installSettingsFetchMock`
 * runs. Making the call here and asserting on its rejection inside the case is
 * the only way one file can hold both this and the cases below, which need a
 * real mounted read to point at.
 *
 * The queue is a real one-entry queue rather than `[]`: the empty-queue refusal
 * is a SECOND guard in the same function, and passing `[]` would leave this
 * case's outcome depending on which of the two is written first. This one is
 * about the missing stub and nothing else.
 */
const UNINSTALLED_MOUNT = mountSettingsQueue("llm-models", [
  () => ({ ok: true, status: 200, json: async () => ({ workbench: settingsPayload() }) }),
]);
// Handled immediately, so the rejection is never an unhandled one in the window
// between this module evaluating and the case below awaiting it. The promise
// asserted on is still the original.
UNINSTALLED_MOUNT.catch(() => {});

const fetchMock = installSettingsFetchMock();

describe("the settings harness refuses what it cannot answer (DW-627)", () => {
  it("names the missing setup line when a queue is mounted without the stub", async () => {
    // The FUNCTION is named, not just the setup call it asks for: `mountSettings`
    // throws a message containing `installSettingsFetchMock` verbatim too, so a
    // match on that substring alone would stay green if this guard's message
    // were swapped for the other one.
    await expect(UNINSTALLED_MOUNT).rejects.toThrow(
      /mountSettingsQueue\(\) needs installSettingsFetchMock\(\)/,
    );
  });

  it("names the call index when patchOf is pointed at a body-less read", async () => {
    // Call 0 is the surface's on-mount GET, which carries no body at all — the
    // off-by-one every caller of this helper is one index away from making.
    await mountSettings("llm-models", settingsPayload());
    expect(() => patchOf(0)).toThrow(/patchOf\(0\): that fetch call carried no body/);
  });
});

describe("an exhausted queue keeps answering with its last response (DW-627)", () => {
  const SEEDED = "s1:aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb";
  const LANDED = "s1:ccccccccccccccccdddddddddddddddd";

  /**
   * The contract BOTH deleted copies of this helper wrote, and the one thing
   * about the fold that nothing else observes.
   *
   * `mountSettingsQueue` indexes its array at `Math.min(call, length - 1)`, so
   * once the entries run out the LAST one answers every further call. The two
   * consuming suites reach exhaustion — the DW-555 recovery cases make more
   * calls than they queue — but every assertion they make afterwards reads the
   * REQUEST init, never the exhausted call's RESPONSE. Replacing the clamp with
   * a plain `responses[call]` plus a throw on exhaustion leaves both of them
   * green, which is exactly the silent behaviour change this pins.
   */
  it("answers a call past the end of the queue with the final entry", async () => {
    // How many times the LAST entry was asked for an answer. Two entries, three
    // calls: the read takes the first, and the second must answer BOTH saves.
    let lastEntryAnswers = 0;
    const saved = () => {
      lastEntryAnswers += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          saved: true,
          version: LANDED,
          workbench: settingsPayload({ version: LANDED, chatModel: "gpt-4.1" }),
        }),
      };
    };
    await mountSettingsQueue("llm-models", [
      () => ({
        ok: true,
        status: 200,
        json: async () => ({ workbench: settingsPayload({ version: SEEDED }) }),
      }),
      saved,
    ]);

    const typeChatModel = (value: string) =>
      fireEvent.change(screen.getByLabelText("Chat model"), { target: { value } });
    const save = () =>
      fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));

    // Save one: call 1, the queue's last entry, still IN range.
    typeChatModel("gpt-4.1");
    save();
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastEntryAnswers).toBe(1);

    // Save two: call 2, PAST the end — and answered anyway, by that same entry.
    typeChatModel("gpt-4.1-mini");
    save();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // The exhausted call's RESPONSE, observed twice over: the factory was asked
    // a second time, and the surface reports the save it described as landed
    // rather than the unreadable answer an `undefined` entry would produce.
    expect(lastEntryAnswers).toBe(2);
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());
    // …and the call really was the owner's second save, not a re-send of the
    // first — so the repeat is the RESPONSE side alone.
    expect(patchOf(2).chatModel).toBe("gpt-4.1-mini");
  });
});
