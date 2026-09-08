import { describe, expect, it } from "vitest";
import {
  SETTINGS_API_HEALTH_PORT_CONFLICT_COPY,
  SETTINGS_API_HEALTH_RUNNING_COPY,
  SETTINGS_API_HEALTH_STARTING_COPY,
  SETTINGS_API_HEALTH_UNREACHABLE_COPY,
  SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY,
  classifyLoopbackHealth,
  loopbackHealthSentence,
  type ClassifiedLoopbackHealth,
} from "../workbench-loopback-health";

/**
 * What the API + MCP pane is allowed to say about the loopback door (DW-750).
 *
 * The pane's `unreachable` sentence — "The sidecar is not running on
 * 127.0.0.1:19828." — was decided by a browser fetch that only REJECTED. DW-607
 * already conceded such a rejection cannot report why: a refused connection and
 * a CORS refusal reach the page as the same opaque failure. So on a deployed,
 * unconfigured origin the pane flatly asserted a dead process while the Chat
 * canvas, from the same probe on the same screen, correctly said it may be
 * running and refusing.
 *
 * The rule is executed here rather than argued from a mount, because it is a
 * pure function of two values; `settings-api-mcp-pane.test.tsx` is what shows
 * the pane is wired to it at all.
 */
describe("the loopback health sentence", () => {
  const LOOPBACK = "http://localhost:3000";
  const DEPLOYED = "https://app.example";

  it("keeps every non-`unreachable` state byte-identical, on any origin", () => {
    // The other three are the LISTENER'S OWN report of itself: a payload
    // arrived, so the door admitted this page and the origin adds nothing.
    const FIXED: ReadonlyArray<[ClassifiedLoopbackHealth, string]> = [
      ["starting", SETTINGS_API_HEALTH_STARTING_COPY],
      ["running", SETTINGS_API_HEALTH_RUNNING_COPY],
      ["port_conflict", SETTINGS_API_HEALTH_PORT_CONFLICT_COPY],
    ];
    for (const [health, sentence] of FIXED) {
      for (const origin of [undefined, null, LOOPBACK, DEPLOYED]) {
        expect(loopbackHealthSentence(health, origin), `${health} @ ${origin}`).toBe(
          sentence,
        );
      }
    }
  });

  it("leaves `error` origin-blind — its payload ARRIVED", () => {
    // The one deliberate asymmetry. `error` is what `classifyLoopbackHealth`
    // answers for a body that came back and is not a status it knows, so CORS
    // admitted the page: calling that an ambiguous refusal would describe an
    // ANSWERED probe as an unanswered one. It keeps the shared sentence with a
    // genuinely dead listener, which is the same fact and the same remedy.
    expect(classifyLoopbackHealth({ status: "error" })).toBe("error");
    for (const origin of [undefined, null, "", LOOPBACK, DEPLOYED]) {
      expect(loopbackHealthSentence("error", origin), String(origin)).toBe(
        SETTINGS_API_HEALTH_UNREACHABLE_COPY,
      );
    }
  });

  it("names both causes and the knob when `unreachable` lands on a deployed page", () => {
    for (const origin of [
      DEPLOYED,
      "http://app.example:8080",
      // A hostname that merely CONTAINS "localhost" is not one — the door's own
      // predicate refuses it, and so must the sentence.
      "https://localhost.evil.test",
    ]) {
      expect(loopbackHealthSentence("unreachable", origin), origin).toBe(
        SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY,
      );
    }
    // The sentence itself: both causes, the port, and the knob that fixes the
    // half the owner cannot otherwise guess. It must not assert the process is
    // dead — that is the whole claim this entry removes.
    expect(SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY).toContain("127.0.0.1:19828");
    expect(SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY).toContain(
      "WORKWIKI_SIDECAR_ALLOWED_ORIGINS",
    );
    expect(SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY).toContain("refused");
    expect(SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY).not.toBe(
      SETTINGS_API_HEALTH_UNREACHABLE_COPY,
    );
    expect(SETTINGS_API_HEALTH_UNREACHABLE_ORIGIN_COPY).not.toMatch(
      /\p{Extended_Pictographic}/u,
    );
  });

  it("says today's sentence on a loopback page, byte for byte", () => {
    // The door admits these without any configuration, so a failed probe there
    // really does mean nothing is listening. The value is UNCHANGED.
    expect(SETTINGS_API_HEALTH_UNREACHABLE_COPY).toBe(
      "The sidecar is not running on 127.0.0.1:19828.",
    );
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:19828",
      "http://[::1]:3000",
      "https://localhost",
    ]) {
      expect(loopbackHealthSentence("unreachable", origin), origin).toBe(
        SETTINGS_API_HEALTH_UNREACHABLE_COPY,
      );
    }
  });

  it("degrades to today's sentence whenever the origin is unknown", () => {
    // The server render, the first client render and everything that is not an
    // origin at all. Degrading to the SHORTER claim is what keeps the server's
    // markup equal to the first client render — the argument is optional, and a
    // caller that never passes it renders exactly as it did before it existed.
    for (const origin of [
      undefined,
      null,
      "",
      "   ",
      "null",
      "not a url",
      "http://[::1].evil.test",
      "file:///Users/owner/page.html",
    ]) {
      expect(loopbackHealthSentence("unreachable", origin), String(origin)).toBe(
        SETTINGS_API_HEALTH_UNREACHABLE_COPY,
      );
    }
    expect(loopbackHealthSentence("unreachable")).toBe(
      SETTINGS_API_HEALTH_UNREACHABLE_COPY,
    );
  });
});
