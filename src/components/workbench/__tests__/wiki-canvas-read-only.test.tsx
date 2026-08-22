import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import {
  WIKI_CREATE_READ_ONLY_COPY,
  WIKI_TEMPLATE_READ_ONLY_COPY,
} from "@/lib/workbench-tree";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The Wiki canvas card on a read-only deployment, MOUNTED (DW-189, DW-282).
 *
 * `workbench-read-only-seam.test.tsx` renders the shell with `<p>canvas</p>` in
 * place of this card, and every other `WorkbenchData` fixture in the repo
 * hard-codes `readOnly: false` — so no suite could express this case at all,
 * which is how `Change template` went on opening a destructive confirm onto a
 * route that has answered 403 since before the card existed.
 *
 * Both branches are covered because they are mutually exclusive: `Change
 * template` renders only WITH a current wiki, the create action only WITHOUT
 * one, so a single render can never see both.
 */

// ONE stable router object, matching the sibling suites: components here key
// effects on the router identity.
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const WIKI: WikiRecord = {
  id: "wiki 1/2",
  name: "Acme",
  scenario: "business",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function data(readOnly: boolean, wiki: WikiRecord | null): WorkbenchData {
  return {
    wikis: wiki ? [wiki] : [],
    currentWikiId: wiki?.id ?? null,
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

function mount(readOnly: boolean, wiki: WikiRecord | null) {
  return render(
    <WorkbenchDataProvider value={data(readOnly, wiki)}>
      <WikiWorkbench />
    </WorkbenchDataProvider>,
  );
}

/** Resolved through the DOM: an id nothing renders describes nothing. */
function describedByText(element: Element): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .join(" ");
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  router.refresh.mockClear();
  // Any request at all from this card would be the defect: the route answers
  // 403, and the point of the refusal is that the round trip never happens.
  fetchMock = vi.fn(async () => ({ ok: true }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's own `cleanup()` lands after this block.
  cleanup();
  vi.unstubAllGlobals();
});

describe("Change template refuses before the confirm rather than after it", () => {
  it("is focusable, aria-disabled and described by the reason", () => {
    mount(true, WIKI);

    const button = screen.getByRole("button", { name: "Change template" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // `disabled` would take the control — and the sentence attached to it — out
    // of the tab order, which is the whole harm this replaces.
    expect(button.hasAttribute("disabled")).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(describedByText(button)).toContain(WIKI_TEMPLATE_READ_ONLY_COPY);
    expect(screen.getByText(WIKI_TEMPLATE_READ_ONLY_COPY)).toBeTruthy();
  });

  it("opens no dialog and issues no request when activated", () => {
    mount(true, WIKI);

    fireEvent.click(screen.getByRole("button", { name: "Change template" }));

    // The dialog names an irreversible overwrite of purpose.md, the Schema and
    // the Workspace Purpose. Confirming that and THEN meeting a 403 is the shape
    // this refusal exists to remove.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Change Scenario Template")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("still opens the confirm on a writable deployment", () => {
    mount(false, WIKI);

    const button = screen.getByRole("button", { name: "Change template" });
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.queryByText(WIKI_TEMPLATE_READ_ONLY_COPY)).toBeNull();

    fireEvent.click(button);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("the empty state's Create Wiki refuses the same way", () => {
  it("is focusable, aria-disabled and described by the reason", () => {
    mount(true, null);

    const button = screen.getByRole("button", { name: "Create Wiki" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(describedByText(button)).toContain(WIKI_CREATE_READ_ONLY_COPY);
    // Its OWN sentence, not the template one: the two controls never share a
    // render, so a merged sentence would always name an unreachable action.
    expect(screen.getByText(WIKI_CREATE_READ_ONLY_COPY)).toBeTruthy();
    expect(screen.queryByText(WIKI_TEMPLATE_READ_ONLY_COPY)).toBeNull();
  });

  it("opens no dialog and issues no request when activated", () => {
    mount(true, null);

    fireEvent.click(screen.getByRole("button", { name: "Create Wiki" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("still opens the create dialog on a writable deployment", () => {
    mount(false, null);

    const button = screen.getByRole("button", { name: "Create Wiki" });
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.queryByText(WIKI_CREATE_READ_ONLY_COPY)).toBeNull();

    fireEvent.click(button);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("a registry that could not be read still owns its own panel", () => {
  it("shows the read error alone, with no read-only sentence competing", () => {
    render(
      <WorkbenchDataProvider
        value={{ ...data(true, null), registryUnavailable: true }}
      >
        <WikiWorkbench />
      </WorkbenchDataProvider>,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Your wikis couldn’t be loaded.",
    );
    expect(screen.queryByRole("button", { name: "Create Wiki" })).toBeNull();
    expect(screen.queryByText(WIKI_CREATE_READ_ONLY_COPY)).toBeNull();
    expect(screen.queryByText(WIKI_TEMPLATE_READ_ONLY_COPY)).toBeNull();
  });
});
