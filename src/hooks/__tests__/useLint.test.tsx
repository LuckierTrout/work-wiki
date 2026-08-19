import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLint } from "@/hooks/useLint";
import {
  LintFilterControls,
  checkTypeLabels,
} from "@/components/LintFilterControls";
import { ALL_CHECK_TYPES } from "@/lib/lint-types";
import type { LintIssue } from "@/lib/types";

/**
 * `useLint` — the module that decides WHAT GETS SENT, MOUNTED.
 *
 * `lint-check-parity.test.tsx` pins that the panel renders one toggle per
 * `ALL_CHECK_TYPES` entry. That is only half of DW-75. The other half lives
 * here: this hook owns the initial `enabledChecks` state, `selectAllChecks`,
 * and the `checks.length > 0 && checks.length < ALL_CHECK_TYPES.length` gate
 * that decides whether `checks` is omitted from the POST body at all. Until
 * now nothing tested it — `grep -rn "useLint" src` found only `LintClient.tsx`
 * and a `fixKey`-only helper test.
 *
 * The gap that leaves is the ORIGINAL BUG, one seam over and invisible to every
 * other suite: re-seeding this hook's state with a literal 11-entry list — the
 * exact DW-75 shape, and type-legal, since a subset of the union is a valid
 * `Set<LintIssue["type"]>` — renders all fifteen toggles (so the parity suite
 * stays green) while posting a `checks` array that omits four of them. The
 * server would then run eleven checks and the UI would look correct doing it.
 *
 * So the assertions here are on the two things that tie the default and the
 * length gate back to the single list: the enabled set at mount, and the body
 * of the request the panel actually issues.
 *
 * Driven through the real `LintFilterControls` rather than through the hook's
 * callbacks directly — a toggle a user cannot reach is not a toggle, and the
 * wiring between the two modules is part of what this is pinning.
 */

/** Every `/api/lint` request body the harness issued, in order. */
function lintBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url]) => url === "/api/lint")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

function Harness() {
  const lint = useLint();
  return (
    <>
      <LintFilterControls
        enabledChecks={lint.enabledChecks}
        onToggleCheck={lint.toggleCheck}
        onSelectAll={lint.selectAllChecks}
        onClearAll={lint.clearAllChecks}
        severityFilter={lint.severityFilter}
        onSeverityChange={lint.setSeverityFilter}
        onRunLint={lint.runLint}
        loading={lint.loading}
      />
      {/* The enabled set, rendered so it can be asserted directly rather than
          inferred from which toggles happen to look pressed. */}
      <output data-testid="enabled">
        {Array.from(lint.enabledChecks).join(",")}
      </output>
    </>
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ issues: [], summary: "", checkedAt: "2026-08-19" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The enabled set as the harness currently reports it. */
function enabledSet(): Set<string> {
  const text = screen.getByTestId("enabled").textContent ?? "";
  return new Set(text === "" ? [] : text.split(","));
}

function toggle(type: LintIssue["type"]) {
  fireEvent.click(
    screen.getByRole("button", {
      name: `Toggle ${checkTypeLabels[type]} check`,
    }),
  );
}

async function runLint() {
  fireEvent.click(screen.getByRole("button", { name: "Run Lint" }));
  await waitFor(() => expect(lintBodies().length).toBeGreaterThan(0));
}

describe("useLint enabled-check state", () => {
  it("starts with every check in ALL_CHECK_TYPES enabled", () => {
    render(<Harness />);

    // Set equality against the ONE list, not a count and not a hand-written
    // roster: an 11-entry re-seed and a 15-entry one differ only here.
    expect(enabledSet()).toEqual(new Set<string>(ALL_CHECK_TYPES));
  });

  it("restores the full list after clearing and selecting all", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Clear all lint checks" }));
    expect(enabledSet()).toEqual(new Set());

    fireEvent.click(screen.getByRole("button", { name: "Select all lint checks" }));
    // `selectAllChecks` re-seeds from `ALL_CHECK_TYPES` independently of the
    // initial state, so it is its own chance to reintroduce a short list.
    expect(enabledSet()).toEqual(new Set<string>(ALL_CHECK_TYPES));
  });
});

describe("useLint request body", () => {
  it("omits `checks` entirely when everything is enabled", async () => {
    render(<Harness />);
    await runLint();

    // The length gate: `checks.length < ALL_CHECK_TYPES.length` is false, so
    // the key is left off and the server applies its own default of all checks.
    // A short enabled set would instead post an explicit 11-entry array here.
    expect(lintBodies()[0]).not.toHaveProperty("checks");
  });

  it("posts ALL_CHECK_TYPES minus the one check that was deselected", async () => {
    render(<Harness />);

    toggle("disputed-page");
    await runLint();

    const sent = lintBodies()[0].checks as string[];
    expect([...sent].sort()).toEqual(
      ALL_CHECK_TYPES.filter((t) => t !== "disputed-page")
        .map(String)
        .sort(),
    );
    expect(sent).not.toContain("disputed-page");
    // One deselection, one omission — the array is derived from the full list,
    // not from a parallel copy that merely happens to be one shorter.
    expect(sent).toHaveLength(ALL_CHECK_TYPES.length - 1);
  });

  it("posts an explicit empty array when nothing is enabled", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Clear all lint checks" }));
    await runLint();

    // `[]` and a missing key mean OPPOSITE things to `lint()` (run nothing vs.
    // run everything), so "no checks selected" must not fall into the omit
    // branch. `lint.test.ts` pins the server side of that same distinction.
    expect(lintBodies()[0].checks).toEqual([]);
  });

  it("posts a single check when only one is enabled", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Clear all lint checks" }));
    toggle("disputed-page");
    await runLint();

    expect(lintBodies()[0].checks).toEqual(["disputed-page"]);
  });
});
