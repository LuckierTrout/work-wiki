import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The Wiki canvas, MOUNTED (DW-15).
 *
 * `create-wiki-ui.test.ts` reads this component's source and counts literals in
 * it, which is the right tool for "does the file still enumerate five scenarios"
 * and the wrong one for "does Cancel write nothing". Every assertion below is
 * made on the outermost surface instead: what is on screen, and what requests
 * were issued. A rewrite that keeps `applyTemplate` but wires `onConfirm` past
 * the dialog, or that drops `confirmDisabled`, leaves the source scan green and
 * fails here.
 */

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const refresh = router.refresh;

/**
 * The id is deliberately one that percent-encoding CHANGES. `applyTemplate`
 * builds its URL with `encodeURIComponent(current.id)`, and against a tidy
 * `wiki-1` that call could be deleted with every assertion still green — while
 * a real id carrying a slash would silently address a different route.
 */
const WIKI: WikiRecord = {
  id: "wiki 1/2",
  name: "Acme",
  scenario: "business",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const ENCODED_ID = "wiki%201%2F2";

/**
 * The subset of `Response` `WikiWorkbench.send` reads — `status` included,
 * because its failure fallback interpolates it and a fake without one renders
 * "Request failed (undefined)" at the owner with no test the wiser.
 */
function answer(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  refresh.mockClear();
  fetchMock = vi.fn(async () => answer({ wiki: WIKI }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmounting here tears the
  // tree down while `fetch` is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

/** `toBeDisabled` is a jest-dom matcher and this repo installs no jest-dom. */
function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function openTemplateDialog() {
  render(<WikiWorkbench initialWikis={[WIKI]} initialCurrentId={WIKI.id} />);
  fireEvent.click(screen.getByRole("button", { name: "Change template" }));
  return screen.getByRole("dialog", { name: "Change Scenario Template" });
}

describe("Change template confirm gate", () => {
  it("disables Overwrite while the dialog still shows the wiki's own scenario", () => {
    openTemplateDialog();

    expect(button("Overwrite").disabled).toBe(true);
    expect(
      screen.getByText("Pick a different template to overwrite this wiki."),
    ).toBeTruthy();
  });

  it("enables Overwrite once a different scenario is picked", () => {
    openTemplateDialog();

    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });

    expect(button("Overwrite").disabled).toBe(false);
  });

  it("writes NOTHING when the confirm is cancelled", () => {
    openTemplateDialog();
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // The claim is that no request was issued, so the observation is the spy's
    // call count — not a state flag the component happens to expose.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("posts the picked scenario to the wiki's template route on confirm", async () => {
    openTemplateDialog();
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/wikis/${ENCODED_ID}/template`);
    expect(url).not.toContain(WIKI.id);
    expect(init.method).toBe("POST");
    // The route parses the body as JSON; without this header it does not.
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ scenario: "research" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the status code when the failure body is not JSON at all", async () => {
    // The ordinary shape of a route that dies before it can answer: an HTML
    // error page. `send` reads the body with `.json().catch(() => ({}))`, and
    // without that catch this rejects with a SyntaxError that reaches nobody —
    // the dialog would sit on "Working…" with no message.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    } as unknown as Response);
    openTemplateDialog();
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "research" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Request failed (502)");
    expect(
      screen.getByRole("dialog", { name: "Change Scenario Template" }).contains(alert),
    ).toBe(true);
  });

  it("keeps the dialog open and shows the failure inside it", async () => {
    fetchMock.mockResolvedValueOnce(
      answer({ error: "Template write failed." }, { ok: false, status: 409 }),
    );
    openTemplateDialog();
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "reading" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Template write failed.");
    // Inside the overlay — the backdrop covers everything rendered behind it.
    expect(
      screen.getByRole("dialog", { name: "Change Scenario Template" }).contains(alert),
    ).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("names the status code when the failure body carries no message", async () => {
    // A route that dies before it can shape a body is the ordinary 500, and the
    // owner still has to be told something other than "undefined".
    fetchMock.mockResolvedValueOnce(answer({}, { ok: false, status: 500 }));
    openTemplateDialog();
    fireEvent.change(screen.getByLabelText("Scenario Template"), {
      target: { value: "general" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Request failed (500)");
    expect(
      screen.getByRole("dialog", { name: "Change Scenario Template" }).contains(alert),
    ).toBe(true);
  });
});

describe("Create Wiki", () => {
  it("writes NOTHING when the dialog is cancelled from the empty state", () => {
    render(<WikiWorkbench initialWikis={[]} initialCurrentId={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Create Wiki" }));
    expect(screen.getByRole("dialog", { name: "Create Wiki" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("No wiki yet.")).toBeTruthy();
  });

  it("posts the picked scenario and lands the owner on the new wiki", async () => {
    render(<WikiWorkbench initialWikis={[]} initialCurrentId={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Create Wiki" }));

    fireEvent.click(screen.getByRole("button", { name: /Research/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/wikis");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Research",
      scenario: "research",
    });
    // The seeded wiki is now the canvas's current one, not the empty state.
    expect(screen.queryByText("No wiki yet.")).toBeNull();
    expect(screen.getByText(WIKI.name)).toBeTruthy();
    // Creating rewrites the tenant workspace profile, so the server tree the
    // owner is looking at is stale until it is refetched.
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
