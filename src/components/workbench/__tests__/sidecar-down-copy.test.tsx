/**
 * @vitest-environment-options { "url": "https://app.example/" }
 */
/**
 * DW-607 — the fail-closed Chat sentence, MOUNTED on a deployed origin.
 *
 * `workbench-modes.test.ts` executes the selector directly and pins every row
 * of the matrix, so nothing about the RULE is re-argued here. What only a mount
 * can show is that the component is wired to that rule at all: this file runs
 * with jsdom's document URL set to a deployed origin, so `ModeCanvas` reads a
 * REAL `window.location.origin` in its mount effect rather than a value a test
 * handed it. A component that went back to rendering `CHAT_SIDECAR_DOWN_COPY`
 * would still pass every pure assertion in the sibling suite and fail here.
 *
 * The origin comes from the docblock above rather than from a stub, because
 * `window.location` is not assignable in jsdom and the effect reads it directly
 * — the whole point of reading it after mount is that it is the browser's
 * answer, not the component's.
 *
 * The sibling canvases are stubbed out. They are not the subject, and mounting
 * the real ones drags in Sigma, the request layer and seven surfaces' worth of
 * effects for a sentence rendered by a branch none of them are in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  CHAT_SIDECAR_DOWN_COPY,
  CHAT_SIDECAR_UNREACHABLE_COPY,
} from "@/lib/workbench-modes";

vi.mock("../ChatCanvas", () => ({ ChatCanvas: () => null }));
vi.mock("../GraphCanvas", () => ({ GraphCanvas: () => null }));
vi.mock("../LintCanvas", () => ({ LintCanvas: () => null }));
vi.mock("../ResearchCanvas", () => ({ ResearchCanvas: () => null }));
vi.mock("../ReviewCanvas", () => ({ ReviewCanvas: () => null }));
vi.mock("../SearchCanvas", () => ({ SearchCanvas: () => null }));
vi.mock("../SkillsCanvas", () => ({ SkillsCanvas: () => null }));
vi.mock("../TodosCanvas", () => ({ TodosCanvas: () => null }));

import { SIDECAR_PAIRING_COPY } from "@/lib/sidecar-pairing";
import { ModeCanvas } from "../ModeCanvas";

afterEach(() => {
  cleanup();
});

describe("Chat's fail-closed sentence on a deployed page (DW-607)", () => {
  it("is served from an origin the sidecar does not admit by default", () => {
    // The premise of every assertion below. If jsdom ever stopped honouring the
    // docblock, the suite would silently become a loopback test that proves the
    // opposite of what it says.
    expect(window.location.origin).toBe("https://app.example");
  });

  it("names both causes instead of telling the owner to start a running process", () => {
    render(
      <ModeCanvas mode="chat" sidecar="down" headingId="wb-heading">
        <div />
      </ModeCanvas>,
    );
    expect(screen.getByText(CHAT_SIDECAR_UNREACHABLE_COPY)).toBeTruthy();
    // The whole defect: an owner whose sidecar is already running was told to
    // start it. That sentence must not be on screen here.
    expect(screen.queryByText(CHAT_SIDECAR_DOWN_COPY)).toBeNull();
    expect(document.body.textContent).not.toContain("Start the local sidecar");
  });

  it("says the same thing while the probe has not answered yet", () => {
    // `unknown` is the rail's pre-probe state and is not `up`, so Chat is
    // already failing closed — on this origin, for the same ambiguous reason.
    render(
      <ModeCanvas mode="chat" sidecar="unknown" headingId="wb-heading">
        <div />
      </ModeCanvas>,
    );
    expect(screen.getByText(CHAT_SIDECAR_UNREACHABLE_COPY)).toBeTruthy();
  });

  it("renders no sentence at all once the sidecar answers up", () => {
    render(
      <ModeCanvas mode="chat" sidecar="up" headingId="wb-heading">
        <div />
      </ModeCanvas>,
    );
    expect(screen.queryByText(CHAT_SIDECAR_UNREACHABLE_COPY)).toBeNull();
    expect(screen.queryByText(CHAT_SIDECAR_DOWN_COPY)).toBeNull();
  });
});

it("explains a mismatched pair and does not mount the chat controls", () => {
  render(<ModeCanvas mode="chat" sidecar="mismatch" headingId="wb-heading"><div /></ModeCanvas>);
  expect(screen.getByText(SIDECAR_PAIRING_COPY)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
});
