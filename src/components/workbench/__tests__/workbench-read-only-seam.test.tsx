import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import { WIKI_READ_ONLY_COPY } from "@/lib/workbench-tree";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The seam that makes DW-37's switcher work AT ALL, mounted.
 *
 * `wiki-switcher-lifecycle.test.tsx` hands `readOnly` to `WikiSwitcher`
 * directly, and every `WorkbenchData` fixture in the repo hard-codes
 * `readOnly: false` — so deleting the prop pass-through in `Workbench.tsx`, or
 * flipping `page.tsx` to a literal `false`, left the whole suite green while
 * the feature was gone on a real read-only deployment. This suite closes that:
 * the REAL shell, the REAL provider, and one flag set on the context.
 */

// ONE stable router object: several components in this shell key effects on the
// router identity, and a fresh literal per call would rebuild them every render.
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const WIKI: WikiRecord = {
  id: "wiki-1",
  name: "Acme",
  scenario: "business",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function data(readOnly: boolean): WorkbenchData {
  return {
    wikis: [WIKI],
    currentWikiId: WIKI.id,
    registryUnavailable: false,
    knowledge: [],
    knowledgeUnavailable: false,
    files: [],
    filesUnavailable: false,
    filesTruncated: false,
    dataVersion: 0,
    readOnly,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  router.refresh.mockClear();
  // `useSidecarStatus` probes the loopback port at mount. An affirmative answer
  // keeps the probe off the network and lets the resulting setState settle
  // inside `act`, so this suite reports no act(...) warning.
  fetchMock = vi.fn(async () => ({ ok: true }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's own `cleanup()` lands after this block.
  cleanup();
  vi.unstubAllGlobals();
});

async function renderShell(readOnly: boolean) {
  const view = render(
    <WorkbenchDataProvider value={data(readOnly)}>
      <Workbench>
        <p>canvas</p>
      </Workbench>
    </WorkbenchDataProvider>,
  );
  // Flush the sidecar probe's promise chain before any assertion runs.
  await act(async () => {});
  return view;
}

describe("the read-only flag travels from WorkbenchData to the switcher", () => {
  it("refuses the Wiki controls when the context says the deployment is read-only", async () => {
    await renderShell(true);

    // Nothing below is handed the flag by this test — the shell read it off the
    // provider and passed it on, which is the whole claim.
    expect(screen.getByText(WIKI_READ_ONLY_COPY)).toBeTruthy();
    const newWiki = screen.getByRole("button", { name: "New Wiki" });
    expect(newWiki.getAttribute("aria-disabled")).toBe("true");
    expect(newWiki.hasAttribute("disabled")).toBe(false);
    expect(screen.getByLabelText("Active wiki").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Rename Wiki" }).getAttribute("aria-disabled"))
      .toBe("true");

    // …and it is a real refusal, not just an attribute.
    fireEvent.click(newWiki);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves them interactive when it says the deployment is writable", async () => {
    await renderShell(false);

    expect(screen.queryByText(WIKI_READ_ONLY_COPY)).toBeNull();
    const newWiki = screen.getByRole("button", { name: "New Wiki" });
    expect(newWiki.hasAttribute("aria-disabled")).toBe(false);

    fireEvent.click(newWiki);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("the server render supplies the flag", () => {
  it("reads it from the environment rather than hard-coding it", async () => {
    // The half no mounted test can reach: `page.tsx` is a server component, and
    // a literal `false` here would leave every assertion above green while the
    // shell was told the wrong thing on every real load.
    const page = await readFile(
      path.resolve(__dirname, "../../../app/page.tsx"),
      "utf8",
    );
    expect(page).toContain('import { isReadOnly } from "@/lib/config";');
    expect(page).toContain("readOnly: isReadOnly(),");
    expect(page).not.toMatch(/readOnly:\s*(true|false)/);

    // And the shell forwards it rather than deciding for itself.
    const shell = await readFile(
      path.resolve(__dirname, "../Workbench.tsx"),
      "utf8",
    );
    expect(shell).toContain("readOnly={readOnly}");
    expect(shell).not.toContain("isReadOnly");
  });
});
