/**
 * @vitest-environment-options { "url": "https://app.example/" }
 */
/**
 * DW-750 — `usePageOrigin`, the one place this repo reads the page's own origin.
 *
 * Three surfaces select an honest sidecar sentence from this value — the rail
 * dot, the Chat canvas and the Settings API/MCP pane — and all three selectors
 * degrade to today's copy on `null`. That degrade is not a courtesy: it is what
 * makes the SERVER render and the FIRST CLIENT render produce the same markup,
 * so the sentence swap that follows is a normal re-render rather than a
 * hydration mismatch. Every consumer's docblock repeats that rule; nothing
 * asserted it.
 *
 * The only guard it had was a source-text regex in `workbench-chrome.test.ts`,
 * which a reformat breaks and which passes for a hook that reads `window`
 * during render — the very mistake the rule exists to prevent. So the TIMING is
 * pinned here, as behaviour: what the first render returns, and what the render
 * after the effect returns.
 *
 * A deployed URL from the docblock above rather than the jsdom default, so the
 * "after mount" value is distinguishable from a hook that hardcoded a loopback
 * origin — and `window.location` is not assignable in jsdom, which is the whole
 * reason the read happens in an effect at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { usePageOrigin } from "@/hooks/usePageOrigin";

afterEach(cleanup);

/**
 * Every value the hook returned, in render order.
 *
 * A RECORD rather than a single assertion on the final DOM, because the claim is
 * about the FIRST render specifically: a hook that read `window.location.origin`
 * during render would settle on the right answer and leave a "what does it say
 * now" test entirely green while breaking hydration.
 */
function Probe({ seen }: { seen: Array<string | null> }) {
  const origin = usePageOrigin();
  seen.push(origin);
  return <span data-testid="origin">{origin ?? "(null)"}</span>;
}

describe("usePageOrigin", () => {
  it("answers null on the first render, and the real origin after the effect", async () => {
    // The premise: the docblock's URL is what makes "the real origin" a value
    // no hardcoded loopback string could impersonate.
    expect(window.location.origin).toBe("https://app.example");

    const seen: Array<string | null> = [];
    const view = render(<Probe seen={seen} />);

    // THE HYDRATION RULE. `render` already flushes effects under RTL's `act`,
    // so the DOM below is the settled value — but the recorded first render is
    // what the server's markup has to match, and it is `null`.
    expect(seen[0]).toBeNull();
    // …and the settled answer is the browser's, read after mount.
    expect(view.getByTestId("origin").textContent).toBe("https://app.example");
    expect(seen.at(-1)).toBe("https://app.example");
    // Exactly one swap: `null`, then the origin. A read that re-fired would show
    // up as extra transitions here.
    expect(seen.filter((value) => value === null)).toHaveLength(1);
  });

  it("does not re-read the origin on later renders", async () => {
    // The effect is mount-only (`[]`). A dependency array that grew would make
    // every consumer's sentence re-decide on unrelated state changes, and a
    // `setState` in an unguarded effect would loop.
    const seen: Array<string | null> = [];
    const view = render(<Probe seen={seen} />);
    const afterMount = seen.length;

    await act(async () => {
      view.rerender(<Probe seen={seen} />);
    });

    // The re-render produced renders, but no NEW transition: the value stayed
    // the settled origin rather than dropping back to `null` or re-resolving.
    expect(seen.slice(afterMount).every((value) => value === "https://app.example")).toBe(
      true,
    );
    expect(seen.filter((value) => value === null)).toHaveLength(1);
  });

  it("gives every consumer the same answer, so their sentences cannot disagree", () => {
    // Two mounts on one page — the shell really does hold three (the rail, the
    // Chat canvas and the API/MCP pane). The hook holds per-component state, so
    // "they agree" is a property worth stating rather than assuming.
    const left: Array<string | null> = [];
    const right: Array<string | null> = [];
    render(
      <>
        <Probe seen={left} />
        <Probe seen={right} />
      </>,
    );

    expect(left.at(-1)).toBe(right.at(-1));
    expect(left.at(-1)).toBe("https://app.example");
  });
});
