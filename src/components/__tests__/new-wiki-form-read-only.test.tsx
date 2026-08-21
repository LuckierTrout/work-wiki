import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  CREATE_PAGE_READ_ONLY_COPY,
  NewWikiForm,
} from "@/app/wiki/new/NewWikiForm";

/**
 * `/wiki/new` on a read-only deployment, MOUNTED (DW-264).
 *
 * `POST /api/wiki` maps the kernel page writer's refusal to a 403, and this
 * form was the whole page — a `"use client"` module with nowhere to read
 * `YOPEDIA_READONLY` — so the owner picked a template, typed a title and wrote
 * an entire markdown body before meeting it. The page is a server component
 * now and hands the fact down.
 *
 * Every assertion is made on the outermost surface: what is on screen, and what
 * requests were issued. A form that kept the prop but wired it past the fetch
 * fails here.
 */

const { router } = vi.hoisted(() => ({
  router: { push: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * The calls this form itself made, i.e. the create.
 *
 * `TemplateSelector` fetches `/api/wiki/templates` on mount through the same
 * stub, so a bare `not.toHaveBeenCalled()` would fail on a request that has
 * nothing to do with the refusal — and, worse, would pass for the wrong reason
 * if the selector ever stopped fetching.
 */
function createCalls(): unknown[][] {
  return fetchMock.mock.calls.filter((call) => call[0] === "/api/wiki");
}

/** The submit control, by its accessible name. */
function submit(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Create page" }) as HTMLButtonElement;
}

/** Fill enough of the form that an UNGATED submit would reach the fetch. */
function compose(): void {
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "Transformer Architecture" },
  });
  fireEvent.change(screen.getByLabelText("Content (Markdown)"), {
    target: { value: "# Transformer Architecture\n\nBody." },
  });
}

beforeEach(() => {
  router.push.mockClear();
  fetchMock = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ owner: "yopedia" }),
      }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one and would unmount with
  // `fetch` still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("the new-page form refuses on a read-only deployment", () => {
  it("states the refusal and makes no request when submitted", async () => {
    render(<NewWikiForm readOnly />);
    compose();

    // The sentence is on screen BEFORE anything is pressed — which is the whole
    // point: the harm was composing a page first and learning afterwards.
    expect(screen.getByText(CREATE_PAGE_READ_ONLY_COPY)).toBeTruthy();

    fireEvent.click(submit());
    await Promise.resolve();

    expect(createCalls()).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("describes the submit with the sentence, and keeps it reachable", () => {
    render(<NewWikiForm readOnly />);

    const button = submit();
    // `aria-disabled`, never `disabled`: a disabled control leaves the tab
    // order carrying the only pointer some owners have to the sentence.
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);

    const noteId = button.getAttribute("aria-describedby");
    expect(noteId).toBeTruthy();
    const note = document.getElementById(noteId!);
    expect(note).not.toBeNull();
    expect(note!.textContent).toBe(CREATE_PAGE_READ_ONLY_COPY);
  });

  it("keeps the submit reachable even with an empty slug", () => {
    // The value leg (`!slug`) YIELDS to the refusal. A read-only page opens
    // with an empty title, so leaving that leg in would disable the button on
    // first paint — taking the `aria-describedby` pointer out of the tab order
    // exactly when the owner most needs it.
    render(<NewWikiForm readOnly />);

    expect(submit().hasAttribute("disabled")).toBe(false);
  });

  it("leaves the title, slug and content fields focusable and editable", () => {
    render(<NewWikiForm readOnly />);

    for (const label of ["Title", "Slug", "Content (Markdown)"]) {
      const field = screen.getByLabelText(label) as
        | HTMLInputElement
        | HTMLTextAreaElement;
      expect(field.hasAttribute("disabled"), label).toBe(false);
      expect(field.hasAttribute("readonly"), label).toBe(false);
    }

    // Composing still works — a refused SUBMIT is not a refused draft.
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Draft" },
    });
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Draft");
  });

  it("says nothing and does not refuse on a writable deployment", async () => {
    // The control case. Without it every assertion above would also pass
    // against a form that had simply stopped submitting.
    render(<NewWikiForm />);
    compose();

    expect(screen.queryByText(CREATE_PAGE_READ_ONLY_COPY)).toBeNull();
    expect(submit().hasAttribute("aria-disabled")).toBe(false);

    fireEvent.click(submit());
    await Promise.resolve();
    await Promise.resolve();

    expect(createCalls()).toHaveLength(1);
    expect((createCalls()[0][1] as RequestInit).method).toBe("POST");
  });

  it("defaults to writable, so every existing caller is unchanged", () => {
    render(<NewWikiForm />);
    expect(screen.queryByText(CREATE_PAGE_READ_ONLY_COPY)).toBeNull();
    expect(submit().getAttribute("aria-describedby")).toBeNull();
  });
});
