import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../authz", () => ({ canReadSlug: vi.fn() }));
vi.mock("../action-items", () => ({ listActionItems: vi.fn() }));
vi.mock("../document-sources", () => ({ listDocumentSources: vi.fn() }));
vi.mock("../knowledge-compilation", () => ({ getKnowledgeCompilation: vi.fn() }));
vi.mock("../memory-proposals", () => ({ getMemoryChangeProposal: vi.fn() }));
vi.mock("../structured-knowledge", () => ({ getStructuredKnowledge: vi.fn() }));
vi.mock("../wiki", () => ({
  listReadableWikiPages: vi.fn(),
  readWikiPageWithFrontmatter: vi.fn(),
  tenantForOwner: vi.fn((owner?: string) => (owner ?? "system").toLowerCase()),
}));

import { listActionItems } from "../action-items";
import { canReadSlug } from "../authz";
import { listDocumentSources } from "../document-sources";
import { getDocumentLineage } from "../document-lineage";
import { getKnowledgeCompilation } from "../knowledge-compilation";
import { getMemoryChangeProposal } from "../memory-proposals";
import { serializeSources } from "../sources";
import { getStructuredKnowledge } from "../structured-knowledge";
import { listReadableWikiPages, readWikiPageWithFrontmatter } from "../wiki";

const principal = { id: "user_owner", handle: "Christian" };

const mockedCanReadSlug = vi.mocked(canReadSlug);
const mockedListActionItems = vi.mocked(listActionItems);
const mockedListDocumentSources = vi.mocked(listDocumentSources);
const mockedGetCompilation = vi.mocked(getKnowledgeCompilation);
const mockedGetProposal = vi.mocked(getMemoryChangeProposal);
const mockedGetKnowledge = vi.mocked(getStructuredKnowledge);
const mockedListReadablePages = vi.mocked(listReadableWikiPages);
const mockedReadPage = vi.mocked(readWikiPageWithFrontmatter);

describe("document lineage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCanReadSlug.mockResolvedValue(true);
    mockedListDocumentSources.mockResolvedValue([]);
    mockedListReadablePages.mockResolvedValue([]);
    mockedGetProposal.mockResolvedValue(null);
  });

  it("fails closed before opening owner stores for an unreadable slug", async () => {
    mockedCanReadSlug.mockResolvedValue(false);

    await expect(getDocumentLineage(principal, "private-notes")).resolves.toBeNull();

    expect(mockedReadPage).not.toHaveBeenCalled();
    expect(mockedListActionItems).not.toHaveBeenCalled();
    expect(mockedGetKnowledge).not.toHaveBeenCalled();
  });

  it("returns only outputs derived from the selected document", async () => {
    const sourcePage = {
      slug: "meeting-notes",
      title: "Meeting notes",
      body: "# Meeting notes",
      content: "# Meeting notes",
      frontmatter: {
        owner: "Christian",
        source_count: "2",
        sources: serializeSources([
          {
            type: "docx",
            url: "upload",
            fetched: "2026-08-07",
            triggered_by: "Christian",
            raw_id: "raw_docx",
          },
          {
            type: "email",
            url: "email",
            fetched: "2026-08-07",
            triggered_by: "Christian",
            raw_id: "raw_email",
          },
        ]),
      },
    };
    const citedArtifact = {
      slug: "meeting-brief",
      title: "Meeting brief",
      body: "<h1>Brief</h1>",
      content: "<h1>Brief</h1>",
      frontmatter: {
        owner: "Christian",
        type: "html",
        sources: serializeSources([
          {
            type: "wiki-ref",
            url: "meeting-notes",
            fetched: "2026-08-07",
            triggered_by: "Christian",
          },
        ]),
      },
    };
    const unrelatedArtifact = {
      ...citedArtifact,
      slug: "other-brief",
      title: "Other brief",
      frontmatter: {
        ...citedArtifact.frontmatter,
        sources: serializeSources([
          {
            type: "wiki-ref",
            url: "other-page",
            fetched: "2026-08-07",
            triggered_by: "Christian",
          },
        ]),
      },
    };

    mockedReadPage.mockImplementation(async (slug) => {
      if (slug === "meeting-notes") return sourcePage as never;
      if (slug === "meeting-brief") return citedArtifact as never;
      if (slug === "other-brief") return unrelatedArtifact as never;
      return null;
    });
    mockedListDocumentSources.mockResolvedValue([
      {
        sha256: "abc",
        filename: "Meeting notes.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        format: "docx",
        size: 1200,
        originalKey: "raw/original.docx",
        storedAt: "2026-08-07T12:00:00.000Z",
        assets: [],
      },
    ]);
    mockedGetKnowledge.mockResolvedValue({
      version: 1,
      owner: "Christian",
      records: [
        {
          id: "kr_one",
          owner: "Christian",
          kind: "decision",
          name: "Launch decision",
          summary: "Launch was approved.",
          sourceSlugs: ["meeting-notes"],
          evidenceIds: ["ev_one"],
          createdAt: "2026-08-07T12:00:00.000Z",
          updatedAt: "2026-08-07T12:00:00.000Z",
        },
        {
          id: "kr_other",
          owner: "Christian",
          kind: "project",
          name: "Other",
          summary: "Unrelated.",
          sourceSlugs: ["other-page"],
          evidenceIds: ["ev_other"],
          createdAt: "2026-08-07T12:00:00.000Z",
          updatedAt: "2026-08-07T12:00:00.000Z",
        },
      ],
      relations: [
        {
          id: "rel_one",
          owner: "Christian",
          fromId: "kr_one",
          toId: "kr_one",
          type: "supports",
          sourceSlugs: ["meeting-notes"],
          evidenceIds: ["ev_one"],
          createdAt: "2026-08-07T12:00:00.000Z",
          updatedAt: "2026-08-07T12:00:00.000Z",
        },
      ],
      updatedAt: "2026-08-07T12:00:00.000Z",
    });
    mockedGetCompilation.mockResolvedValue({
      version: 1,
      id: "kcr_one",
      owner: "Christian",
      pageSlug: "meeting-notes",
      inputHash: "hash",
      status: "complete",
      pass1: { contributionIds: [], recordIds: ["kr_one"], relationIds: ["rel_one"] },
      pass2: {
        relatedSlugs: [],
        proposalId: "mp_one",
        proposalIds: ["mp_one"],
        changed: true,
      },
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z",
    });
    mockedGetProposal.mockResolvedValue({
      version: 1,
      id: "mp_one",
      owner: "Christian",
      targetSlug: "launch-decision",
      kind: "create",
      title: "Create decision: Launch decision",
      summary: "A decision page.",
      reason: "Structured knowledge found a decision.",
      proposedContent: "# Launch decision",
      proposedContentHash: "proposed",
      baseContentHash: null,
      evidenceIds: ["ev_one"],
      actor: "knowledge-compiler",
      risk: "medium",
      status: "pending",
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z",
    });
    mockedListActionItems.mockResolvedValue([
      {
        id: "task_one",
        title: "Send the launch brief",
        sourceSlug: "meeting-notes",
        priority: "high",
        status: "inbox",
        createdAt: "2026-08-07T12:00:00.000Z",
        updatedAt: "2026-08-07T12:00:00.000Z",
      },
      {
        id: "task_other",
        title: "Unrelated task",
        sourceSlug: "other-page",
        priority: "medium",
        status: "accepted",
        createdAt: "2026-08-07T12:00:00.000Z",
        updatedAt: "2026-08-07T12:00:00.000Z",
      },
    ]);
    mockedListReadablePages.mockResolvedValue([
      {
        slug: "meeting-brief",
        title: "Meeting brief",
        summary: "Generated brief",
        owner: "Christian",
        type: "html",
        visibility: "private",
      },
      {
        slug: "other-brief",
        title: "Other brief",
        summary: "Generated brief",
        owner: "Christian",
        type: "html",
        visibility: "private",
      },
    ]);

    const lineage = await getDocumentLineage(principal, "meeting-notes");

    expect(lineage).toMatchObject({
      slug: "meeting-notes",
      isArtifact: false,
      sources: {
        count: 2,
        originalFiles: ["Meeting notes.docx"],
        href: "/u/christian/raw/meeting-notes",
      },
      knowledge: { records: 1, relations: 1, compilationStatus: "complete" },
      proposals: { total: 1, pending: 1, accepted: 0 },
      tasks: { total: 1, proposed: 1, accepted: 0, done: 0 },
    });
    expect(lineage?.artifacts).toEqual([
      {
        slug: "meeting-brief",
        title: "Meeting brief",
        type: "html",
        href: "/u/christian/meeting-brief",
      },
    ]);
  });
});
