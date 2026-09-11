import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SurfacePresentation, SurfaceVisibilityProvider, useSurfaceVisible } from "../useSurfaceVisibility";

afterEach(cleanup);
function Probe() { return <output>{String(useSurfaceVisible())}</output>; }
describe("effective surface visibility", () => {
  it("defaults to visible without a provider", () => {
    render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe("true");
  });
  it("does not let a visible descendant override a hidden ancestor", () => {
    const tree = (visible: boolean) => <SurfaceVisibilityProvider visible={visible}><SurfaceVisibilityProvider visible><Probe /></SurfaceVisibilityProvider></SurfaceVisibilityProvider>;
    const view = render(tree(false));
    expect(screen.getByRole("status").textContent).toBe("false");
    view.rerender(tree(true));
    expect(screen.getByRole("status").textContent).toBe("true");
  });
  it("keeps the same live-region DOM while hidden and presents the latest result on return", () => {
    const tree = (visible: boolean, text: string) => <SurfaceVisibilityProvider visible={visible}><SurfacePresentation><p role="status">{text}</p></SurfacePresentation></SurfaceVisibilityProvider>;
    const view = render(tree(true, "before"));
    const region = screen.getByRole("status");
    view.rerender(tree(false, "intermediate"));
    view.rerender(tree(false, "latest"));
    expect(region.textContent).toBe("before");
    view.rerender(tree(true, "latest"));
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("latest");
  });
});
