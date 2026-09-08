import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspacePurposeSettings } from "@/components/WorkspacePurposeSettings";

describe("WorkspacePurposeSettings compatibility callout", () => {
  it("points to the one canonical Purpose editor and owns no profile form", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<WorkspacePurposeSettings />);

    expect(screen.getByRole("heading", { name: "Workspace Purpose" })).toBeTruthy();
    expect(screen.getByText(/Purpose is canonical Markdown stored as purpose\.md/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open Workbench Settings" }).getAttribute("href"),
    ).toBe("/?mode=wiki&settings=1");
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
