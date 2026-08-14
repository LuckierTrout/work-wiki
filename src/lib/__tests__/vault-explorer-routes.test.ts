import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/vault", () => ({ listVaults: vi.fn() }));

import { GET as previewDocument } from "@/app/api/vaults/[id]/pages/[slug]/route";
import { GET as openOriginal } from "@/app/api/vaults/[id]/pages/[slug]/original/route";
import { getPrincipal } from "@/lib/auth";
import { preserveDocumentSources } from "@/lib/document-sources";
import { serializeFrontmatter } from "@/lib/frontmatter";
import { _resetStorage, getStorage } from "@/lib/storage";
import { listVaults } from "@/lib/vault";
import { wikiRelPath } from "@/lib/wiki";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedVaults = vi.mocked(listVaults);
const params = {
  params: Promise.resolve({ id: "alice--work", slug: "project-plan" }),
};

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-explorer-route-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  mockedPrincipal.mockResolvedValue({ id: "user_1", handle: "alice" });
  mockedVaults.mockResolvedValue([
    {
      id: "alice--work",
      owner: "alice",
      name: "Work",
      visibility: "public",
      slugs: ["project-plan"],
      created: "2026-01-01T00:00:00.000Z",
    },
  ]);
  await getStorage().writeFile(
    wikiRelPath("project-plan.md"),
    serializeFrontmatter(
      { owner: "alice", visibility: "public", tags: ["planning"] },
      "# Project Plan\n\nThe parsed plan body.",
    ),
  );
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("vault explorer read routes", () => {
  it("returns a parsed preview only for a page in the signed-in owner's vault", async () => {
    const response = await previewDocument(
      new Request("http://localhost/api/vaults/alice--work/pages/project-plan"),
      params,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      page: { title: string; body: string; rawHref: string };
    };
    expect(payload.page.title).toBe("Project Plan");
    expect(payload.page.body).toContain("The parsed plan body.");
    expect(payload.page.rawHref).toBe("/u/alice/raw/project-plan");
  });

  it("cloaks vaults and pages outside the current owner's membership", async () => {
    mockedVaults.mockResolvedValue([]);
    const noVault = await previewDocument(
      new Request("http://localhost/api/vaults/alice--work/pages/project-plan"),
      params,
    );
    expect(noVault.status).toBe(404);

    mockedVaults.mockResolvedValue([
      {
        id: "alice--work",
        owner: "alice",
        name: "Work",
        visibility: "public",
        slugs: [],
        created: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const noMember = await previewDocument(
      new Request("http://localhost/api/vaults/alice--work/pages/project-plan"),
      params,
    );
    expect(noMember.status).toBe(404);
  });

  it("serves a preserved original through the same owner and membership gates", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]).buffer;
    const [stored] = await preserveDocumentSources("project-plan", "alice", [
      {
        bytes,
        filename: "Project Plan.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        relativePath: "Plans/Project Plan.docx",
        extracted: {
          format: "docx",
          title: "Project Plan",
          text: "Plan",
          metadata: {},
          assets: [],
        },
      },
    ]);
    const response = await openOriginal(
      new Request(
        `http://localhost/api/vaults/alice--work/pages/project-plan/original?source=${stored.sha256}`,
      ),
      params,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("Project Plan.docx");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
  });

  it("requires an authenticated owner session", async () => {
    mockedPrincipal.mockResolvedValue(null);
    const response = await previewDocument(
      new Request("http://localhost/api/vaults/alice--work/pages/project-plan"),
      params,
    );
    expect(response.status).toBe(401);
  });
});
