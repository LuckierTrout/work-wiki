/**
 * The Sources canvas sentence follows the tree beside it.
 *
 * Sources has no canvas surface of its own — the tree in the left column IS the
 * surface, and no Preview docks there — so the canvas shows one muted sentence.
 * That sentence was the mode's empty state whatever the tree held, and an owner
 * who had just ingested a file read "No sources yet." under a tree listing it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SOURCES_LISTED_COPY, workbenchMode } from "@/lib/workbench-modes";
import { buildFileTree } from "@/lib/workbench-tree";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";

vi.mock("../ChatCanvas", () => ({ ChatCanvas: () => null }));
vi.mock("../GraphCanvas", () => ({ GraphCanvas: () => null }));
vi.mock("../LintCanvas", () => ({ LintCanvas: () => null }));
vi.mock("../ResearchCanvas", () => ({ ResearchCanvas: () => null }));
vi.mock("../ReviewCanvas", () => ({ ReviewCanvas: () => null }));
vi.mock("../SearchCanvas", () => ({ SearchCanvas: () => null }));
vi.mock("../SkillsCanvas", () => ({ SkillsCanvas: () => null }));
vi.mock("../TodosCanvas", () => ({ TodosCanvas: () => null }));

import { ModeCanvas } from "../ModeCanvas";

const EMPTY_STATE = workbenchMode("sources").emptyState!;

function data(paths: string[], filesUnavailable = false): WorkbenchData {
  return {
    wikis: [],
    currentWikiId: "wiki-1",
    registryUnavailable: false,
    knowledge: [],
    knowledgeUnavailable: false,
    files: buildFileTree(paths),
    filesUnavailable,
    filesTruncated: false,
    dataVersion: 0,
    readOnly: false,
  };
}

function renderSources(value: WorkbenchData) {
  return render(
    <WorkbenchDataProvider value={value}>
      <ModeCanvas mode="sources" sidecar="up" headingId="wb-heading">
        <div />
      </ModeCanvas>
    </WorkbenchDataProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("the Sources canvas sentence", () => {
  it("says no sources while the tree is empty", () => {
    renderSources(data(["wiki/alpha.md", "raw/", "raw/sources/"]));
    expect(screen.getByText(EMPTY_STATE)).toBeTruthy();
    expect(screen.queryByText(SOURCES_LISTED_COPY)).toBeNull();
  });

  it("stops saying no sources once the tree lists one", () => {
    renderSources(
      data(["raw/", "raw/sources/", "raw/sources/q3/", "raw/sources/q3/ab12.md"]),
    );
    expect(screen.getByText(SOURCES_LISTED_COPY)).toBeTruthy();
    expect(screen.queryByText(EMPTY_STATE)).toBeNull();
  });

  it("never says no sources when the tree could not be read", () => {
    renderSources(data([], true));
    expect(screen.queryByText(EMPTY_STATE)).toBeNull();
  });
});
