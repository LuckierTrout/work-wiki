import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RecentIngests } from "@/components/RecentIngests";

/**
 * The bulk delete's PARTIAL result, mounted (DW-393).
 *
 * The route no longer answers one all-or-nothing 404 when a selection cannot be
 * made: it deletes everything it can and reports the rest per entry in
 * `failed[]`, at 200. That means the list is now the only place the owner
 * learns which half of their selection survived — so what it says, and what it
 * keeps selected, is the outermost surface of the fix.
 *
 * Every assertion is on screen text and checkbox state, never on component
 * internals.
 */

vi.mock("@/hooks/useSlugTenants", () => ({
  useSlugTenants: () => ({ hrefForSlug: (slug: string) => `/u/yopedia/${slug}` }),
}));
vi.mock("@/lib/recent-ingests", () => ({
  getRecentJobIds: () => [],
  forgetRecentJobs: vi.fn(),
}));

const entry = (id: string, slug: string) => ({
  ingest_id: id,
  source_url: `https://example.com/${slug}`,
  primary_slug: slug,
  finished_at: "2026-08-20T12:00:00.000Z",
  status: "completed",
  source_type: "url",
});

const ENTRIES = [entry("ing-ok", "page-ok"), entry("ing-orphan", "page-orphan")];

/** The route's one selection sentence, as the client receives it. */
const SELECTION_NOT_FOUND = "One or more selected ingests were not found.";

let fetchMock: ReturnType<typeof vi.fn>;

/** Answers the mount polls, then hands `deleteBody` to the DELETE. */
function stubFetch(deleteBody: Record<string, unknown>) {
  fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    if (init?.method === "DELETE") {
      return { ok: true, status: 200, json: async () => deleteBody } as unknown as Response;
    }
    const body = href.startsWith("/api/ingest/history")
      ? { entries: ENTRIES, readOnly: false }
      : { jobs: [] };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

function checkboxFor(slug: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name: `Select ingest ${slug}` }) as HTMLInputElement;
}

/** Open selection mode and tick every named row. */
async function selectRows(slugs: string[]) {
  render(<RecentIngests />);
  await screen.findByText("Recent ingests");
  fireEvent.click(screen.getByRole("button", { name: "Bulk delete" }));
  for (const slug of slugs) fireEvent.click(await screen.findByRole("checkbox", { name: `Select ingest ${slug}` }));
  fireEvent.click(screen.getByRole("button", { name: `Delete selected (${slugs.length})` }));
}

beforeEach(() => {
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one and would unmount with the
  // globals still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("a partly-refused bulk delete", () => {
  it("drops the deleted row, keeps the refused one selected, and reports both halves", async () => {
    stubFetch({
      deletedIngestIds: ["ing-ok"],
      deletedJobIds: [],
      deletedPageSlugs: ["page-ok"],
      failed: [{ id: "ing-orphan", kind: "ingest", error: SELECTION_NOT_FOUND }],
      rawSourcesRetained: true,
    });

    await selectRows(["page-ok", "page-orphan"]);

    // The refusal is stated, naming the count and the reason the route gave.
    const message = await screen.findByText(
      `1 selected item could not be deleted. ${SELECTION_NOT_FOUND}`,
    );
    expect(message).toBeTruthy();
    // ...ALONGSIDE the cleared count, not instead of it. Both halves of one
    // outcome: the message region renders the refusal AND the confirmation, so
    // an owner who cleared nine rows with one refused still learns the nine are
    // gone rather than only that something failed.
    expect(
      screen.getByText(
        "1 ingest record cleared \u00b7 1 wiki page deleted. Raw sources were retained.",
      ),
    ).toBeTruthy();
    // The deleted row is gone from the list; the refused one is still there,
    // and still ticked, so the owner can see exactly what survived.
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Select ingest page-ok" })).toBeNull(),
    );
    expect(checkboxFor("page-orphan").checked).toBe(true);
    // Selection mode stays OPEN — there is still something selected.
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("keys the retained selection off `kind`, not off what the client submitted", async () => {
    // The discriminator for the `kind` field. If the client still guessed from
    // `ingestIds.includes(id)`, an id the server labels `job` would be keyed
    // `ingest:` and the row below would come back ticked by accident.
    stubFetch({
      deletedIngestIds: ["ing-ok"],
      deletedJobIds: [],
      deletedPageSlugs: ["page-ok"],
      failed: [{ id: "ing-orphan", kind: "job", error: SELECTION_NOT_FOUND }],
      rawSourcesRetained: true,
    });

    await selectRows(["page-ok", "page-orphan"]);

    await screen.findByText(`1 selected item could not be deleted. ${SELECTION_NOT_FOUND}`);
    // Keyed `job:ing-orphan`, which matches no ledger row — so the ingest row
    // is NOT re-ticked.
    expect(checkboxFor("page-orphan").checked).toBe(false);
  });

  it("states every distinct reason, not just the first", async () => {
    stubFetch({
      deletedIngestIds: [],
      deletedJobIds: [],
      deletedPageSlugs: [],
      failed: [
        { id: "ing-ok", kind: "ingest", error: SELECTION_NOT_FOUND },
        { id: "ing-orphan", kind: "ingest", error: "disk write failed" },
      ],
      rawSourcesRetained: true,
    });

    await selectRows(["page-ok", "page-orphan"]);

    const message = await screen.findByText(
      `2 selected items could not be deleted. ${SELECTION_NOT_FOUND} disk write failed`,
    );
    expect(message).toBeTruthy();
  });
});

describe("a wholly-refused bulk delete", () => {
  it("says only that it failed — no '0 ingest records cleared' beside it", async () => {
    stubFetch({
      deletedIngestIds: [],
      deletedJobIds: [],
      deletedPageSlugs: [],
      failed: [{ id: "ing-orphan", kind: "ingest", error: SELECTION_NOT_FOUND }],
      rawSourcesRetained: true,
    });

    await selectRows(["page-orphan"]);

    await screen.findByText(`1 selected item could not be deleted. ${SELECTION_NOT_FOUND}`);
    // The route answers 200 with nothing cleared, and a "cleared" line beside
    // the error would read as a second, contradictory outcome.
    expect(screen.queryByText(/records? cleared/)).toBeNull();
    expect(screen.queryByText(/Raw sources were retained/)).toBeNull();
    // Nothing left the list either.
    expect(checkboxFor("page-orphan").checked).toBe(true);
  });

  it("still reports the cleared count when the whole batch succeeds", async () => {
    // The bound on the case above: suppressing the notice must not suppress it
    // for the happy path it was written for.
    stubFetch({
      deletedIngestIds: ["ing-ok"],
      deletedJobIds: [],
      deletedPageSlugs: ["page-ok"],
      failed: [],
      rawSourcesRetained: true,
    });

    await selectRows(["page-ok"]);

    await screen.findByText(
      "1 ingest record cleared · 1 wiki page deleted. Raw sources were retained.",
    );
  });
});
