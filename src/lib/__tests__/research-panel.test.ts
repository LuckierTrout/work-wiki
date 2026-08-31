/**
 * The Research Panel's vocabulary.
 *
 * Pure functions, asserted without mounting: these are the sentences the
 * acceptance criteria are written about, and a status word composed inline in
 * JSX is a string only a render test can see.
 */
import { describe, expect, it } from "vitest";
import {
  RESEARCH_ACTIVE_STATUSES,
  RESEARCH_POLL_MS,
  parseResearchQueries,
  researchIsPolling,
  researchOffersCancel,
  researchOffersRun,
  researchSourceUrlNote,
  researchSourceUrlTotal,
  researchStatusLabel,
  researchTaskLine,
} from "../research-panel";
import { URL_MAX_CHARS } from "../research-projects";
import type { ResearchProject, ResearchProjectStatus } from "../research-projects";

const project = (extra: Partial<ResearchProject>): ResearchProject => ({
  id: "p1",
  title: "Launch evidence",
  question: "What supports the launch date?",
  queries: ["launch evidence"],
  sourceUrls: [],
  pageSlugs: [],
  status: "draft",
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
  ...extra,
} as ResearchProject);

describe("research panel vocabulary", () => {
  it("polls while a run is queued, collecting or synthesizing", () => {
    // `queued` is the one that matters: the fourth start is queued, and a panel
    // that polled only while `collecting` would show it frozen at "waiting"
    // until the owner reloaded.
    expect([...RESEARCH_ACTIVE_STATUSES].sort())
      .toEqual(["collecting", "queued", "ready"]);
    expect(RESEARCH_ACTIVE_STATUSES).not.toContain("draft");
    expect(RESEARCH_ACTIVE_STATUSES).not.toContain("complete");
    expect(RESEARCH_POLL_MS).toBeGreaterThan(0);
    expect(researchIsPolling(project({
      status: "complete",
      completion: { phase: "sources", pageSlug: "research-x", sources: [] },
    }))).toBe(true);
    expect(researchIsPolling(project({
      status: "complete",
      completion: { phase: "done", pageSlug: "research-x", sources: [] },
    }))).toBe(false);
  });

  it("never shows the store's own state-machine words to an owner", () => {
    // `ready` reads to an owner as "the result is ready" when it means the
    // opposite — the search finished and the writing has not.
    expect(researchStatusLabel("ready")).toBe("Synthesizing");
    expect(researchStatusLabel("queued")).toBe("Waiting");
    expect(researchStatusLabel("collecting")).toBe("Searching");
    const statuses: ResearchProjectStatus[] = [
      "draft", "queued", "collecting", "ready", "complete", "failed", "cancelled",
    ];
    for (const status of statuses) {
      expect(researchStatusLabel(status)).toMatch(/^[A-Z]/);
    }
  });

  it("prefers the runtime's own sentence and appends the counters", () => {
    // The runtime writes the sentence that knows what it is doing; re-deriving
    // one here would produce a second, vaguer account of the same moment.
    expect(researchTaskLine(project({
      status: "collecting",
      progress: { completedQueries: 1, totalQueries: 3, message: "Reading source 3 of 8." },
    }))).toBe("Reading source 3 of 8. (1 of 3)");
  });

  it("says what a waiting run is waiting behind", () => {
    expect(researchTaskLine(project({
      status: "queued",
      progress: {
        completedQueries: 0,
        totalQueries: 1,
        message: "Waiting for a free research slot (3 of 3 running).",
      },
    }))).toContain("3 of 3 running");
  });

  it("never renders an empty line for a project with no progress record", () => {
    expect(researchTaskLine(project({ status: "draft" }))).toMatch(/Not started/);
    expect(researchTaskLine(project({ status: "failed" }))).toMatch(/Nothing was written/);
    expect(researchTaskLine(project({ status: "cancelled" }))).toBe("Cancelled.");
    expect(researchTaskLine(project({ status: "complete" }))).toMatch(/0 sources cited/);
    expect(researchTaskLine(project({ status: "collecting" }))).toMatch(/In progress/);
  });

  it("offers Cancel exactly while the run is going somewhere", () => {
    // DW-644. The canvas's Cancel row control AND the read-only note that
    // describes it read this one rule, so the note cannot appear beside a
    // control that is not there.
    //
    // LITERAL LISTS, not `RESEARCH_ACTIVE_STATUSES.includes(status)` — that is
    // the function's own body restated, and a reword of the constant would
    // carry this row along with it rather than failing here.
    const offered: ResearchProjectStatus[] = ["queued", "collecting", "ready"];
    const withheld: ResearchProjectStatus[] = ["draft", "complete", "failed", "cancelled"];
    for (const status of offered) {
      expect(researchOffersCancel(project({ status })), status).toBe(true);
    }
    for (const status of withheld) {
      expect(researchOffersCancel(project({ status })), status).toBe(false);
    }
    // A cancellable row is never also restartable: the two controls partition.
    for (const status of [...offered, ...withheld]) {
      const row = project({ status });
      expect(researchOffersCancel(row) && researchOffersRun(row), status).toBe(false);
    }
  });

  it("offers Start/Retry only where there is a run left to make", () => {
    const offered: ResearchProjectStatus[] = ["draft", "failed", "cancelled"];
    const withheld: ResearchProjectStatus[] = ["queued", "collecting", "ready", "complete"];
    for (const status of offered) {
      expect(researchOffersRun(project({ status })), status).toBe(true);
    }
    for (const status of withheld) {
      expect(researchOffersRun(project({ status })), status).toBe(false);
    }
  });

  it("withholds Retry from a row whose completion was DELIVERED, and keeps it for one that was blocked", () => {
    // The split that decides Retry. A delivered completion means the Page is
    // written and there is nothing to re-run; a `deliveryBlocked` one means the
    // delivery never landed, which is precisely what a retry is for.
    const completion = { phase: "done" as const, pageSlug: "research-x", sources: [] };
    expect(researchOffersRun(project({ status: "failed", completion }))).toBe(false);
    expect(researchOffersRun(project({
      status: "failed",
      completion,
      deliveryBlocked: true,
    }))).toBe(true);
    expect(researchOffersRun(project({
      status: "failed",
      completion,
      deliveryBlocked: false,
    }))).toBe(false);
    // No completion at all is the ordinary draft/failed row.
    expect(researchOffersRun(project({ status: "draft" }))).toBe(true);
  });

  it("withholds Retry from a row whose completion is still DRAINING", () => {
    // The branch a polling row actually sits in, and the one every other
    // completion fixture here misses by using `phase: "done"`. A completion
    // mid-delivery is still a completion — `!project.completion` is false —
    // so the row is offered nothing while the outbox drains, and `researchIsPolling`
    // keeps re-reading it rather than the owner re-running it by hand.
    const draining = { phase: "sources" as const, pageSlug: "research-x", sources: [] };
    expect(researchIsPolling(project({ status: "complete", completion: draining }))).toBe(true);
    expect(researchOffersRun(project({ status: "failed", completion: draining }))).toBe(false);
    // …until that delivery is declared blocked, which is exactly what a retry
    // is for.
    expect(researchOffersRun(project({
      status: "failed",
      completion: draining,
      deliveryBlocked: true,
    }))).toBe(true);
  });

  /**
   * DW-655. The store keeps 40 URLs of at most 2,000 characters, and until
   * now discarded the rest in silence while `Collect N URLs` reported the
   * survivors as if they were everything. These rows pin the sentence that
   * says otherwise; the bounds themselves are unchanged.
   */
  describe("the run's source-URL loss", () => {
    it("says nothing for a run that lost nothing", () => {
      expect(researchSourceUrlNote(project({ sourceUrls: ["https://a.example"] })))
        .toBeNull();
      // A `{0,0}` pair is not something the store writes — it deletes the key —
      // but a row from an older build must not render an empty note either.
      expect(researchSourceUrlNote(project({
        sourceUrls: ["https://a.example"],
        sourceUrlLoss: { dropped: 0, truncated: 0 },
      }))).toBeNull();
    });

    it("names the total the owner collected, not the count that survived", () => {
      // The whole point: the button says 40, and 45 were found.
      expect(researchSourceUrlNote(project({
        sourceUrls: Array.from({ length: 40 }, (_, i) => `https://example.com/${i}`),
        sourceUrlLoss: { dropped: 5, truncated: 0 },
      }))).toBe("5 of the 45 URLs this run collected were not stored.");
      expect(researchSourceUrlNote(project({
        sourceUrls: ["https://a.example"],
        sourceUrlLoss: { dropped: 1, truncated: 0 },
      }))).toBe("1 of the 2 URLs this run collected was not stored.");
    });

    it("warns separately that a stored URL may no longer resolve", () => {
      // The more dangerous half: a truncated URL IS stored, looks like a
      // source, and points somewhere else.
      expect(researchSourceUrlNote(project({
        sourceUrls: ["https://a.example"],
        sourceUrlLoss: { dropped: 0, truncated: 1 },
      }))).toBe(
        "1 stored URL was shortened to 2,000 characters and may no longer resolve.",
      );
      expect(researchSourceUrlNote(project({
        sourceUrls: ["https://a.example", "https://b.example"],
        sourceUrlLoss: { dropped: 0, truncated: 2 },
      }))).toBe(
        "2 stored URLs were shortened to 2,000 characters and may no longer resolve.",
      );
    });

    it("says nothing about a count the stored row got wrong", () => {
      // `isResearchProject` is structural by policy and validates no optional
      // field, so a row written by a broken build reaches the panel intact.
      // `"5"` would have string-concatenated into "5 of the 405 URLs…" — a
      // wrong number stated with total confidence — and `NaN` into "NaN of
      // the NaN URLs…". The clause is dropped instead.
      const bad = (loss: unknown) =>
        researchSourceUrlNote(project({
          sourceUrls: Array.from({ length: 40 }, (_, i) => `https://example.com/${i}`),
          sourceUrlLoss: loss,
        } as unknown as Partial<ResearchProject>));

      expect(bad({ dropped: "5", truncated: 0 })).toBeNull();
      expect(bad({ dropped: Number.NaN, truncated: 0 })).toBeNull();
      expect(bad({ dropped: Number.POSITIVE_INFINITY, truncated: 0 })).toBeNull();
      expect(bad({ dropped: 2.5, truncated: 0 })).toBeNull();
      expect(bad({ dropped: -3, truncated: 0 })).toBeNull();
      expect(bad({ dropped: null, truncated: 0 })).toBeNull();

      // …and one bad count does not silence the OTHER clause, which is still
      // true and still worth saying.
      expect(bad({ dropped: "5", truncated: 1 })).toBe(
        "1 stored URL was shortened to 2,000 characters and may no longer resolve.",
      );
      expect(bad({ dropped: 5, truncated: "2" })).toBe(
        "5 of the 45 URLs this run collected were not stored.",
      );
    });

    it("derives one total for every surface on the card", () => {
      // The Studio's evidence drawer reads this same helper, so the drawer and
      // the note beside it cannot state two different totals.
      expect(researchSourceUrlTotal(project({
        sourceUrls: Array.from({ length: 40 }, (_, i) => `https://example.com/${i}`),
        sourceUrlLoss: { dropped: 5, truncated: 0 },
      }))).toBe(45);
      // Same discipline: no loss, or an unusable count, means no total and the
      // caller keeps its plain wording.
      expect(researchSourceUrlTotal(project({ sourceUrls: ["https://a.example"] }))).toBeNull();
      expect(researchSourceUrlTotal(project({
        sourceUrls: ["https://a.example"],
        sourceUrlLoss: { dropped: 0, truncated: 3 },
      }))).toBeNull();
      // Through `unknown`: the field's TYPE forbids this, which is exactly why
      // the runtime check has to exist — the registry guard is structural and
      // never sees the type.
      expect(researchSourceUrlTotal(project(
        { sourceUrls: ["https://a.example"], sourceUrlLoss: { dropped: "4" } } as unknown as Partial<ResearchProject>,
      ))).toBeNull();
    });

    it("names the store's cap rather than re-typing it", () => {
      // The sentence is the STORE's number shown to an owner. Pinned against
      // the exported constant so a changed cap cannot leave the panel telling
      // the owner something false.
      expect(researchSourceUrlNote(project({
        sourceUrls: ["https://a.example"],
        sourceUrlLoss: { dropped: 0, truncated: 1 },
      }))).toContain(`${URL_MAX_CHARS.toLocaleString("en-US")} characters`);
      expect(URL_MAX_CHARS).toBe(2_000);
    });

    it("states both losses when a run suffered both", () => {
      expect(researchSourceUrlNote(project({
        sourceUrls: ["https://a.example"],
        sourceUrlLoss: { dropped: 1, truncated: 1 },
      }))).toBe(
        "1 of the 2 URLs this run collected was not stored. " +
        "1 stored URL was shortened to 2,000 characters and may no longer resolve.",
      );
    });
  });

  it("counts the queries a Start button is about to send, not the textarea's lines", () => {
    // A Start enabled by three blank lines is the disagreement this prevents.
    expect(parseResearchQueries("\n\n   \n")).toEqual([]);
    expect(parseResearchQueries("one\n  two  \none\n")).toEqual(["one", "two"]);
    expect(parseResearchQueries("a\t\tb")).toEqual(["a b"]);
  });
});
