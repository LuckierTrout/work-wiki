import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  EMAIL_INGEST_READ_ONLY_COPY,
  EmailIngestSettings,
} from "@/components/EmailIngestSettings";

/**
 * Email ingestion on a read-only deployment, MOUNTED (DW-386).
 *
 * `PUT /api/email/settings` has refused since DW-300 and
 * `saveEmailIngestConfig` since DW-385, while this form carried no `readOnly`
 * term at all: **Save email settings** looked live over a 403.
 *
 * The second half of this suite is the one that keeps the gate honest.
 * **Copy address** writes NOTHING — no request, no stored byte — so it must
 * stay live: refusing it would be the DW-191 defect in miniature, taking away a
 * control the deployment has no reason to withhold.
 */

const SETTINGS = {
  enabled: true,
  inboundAddress: "ingest@example.com",
  allowedSenders: ["you@example.com"],
  addressConfigured: true,
  routingReady: true,
  bodyIngestEnabled: true,
  attachmentIngestEnabled: true,
  destinationVaultId: "",
  destinationAgentId: "",
  vaults: [{ id: "v1", name: "Vault one" }],
  agents: [{ id: "a1", name: "Agent one" }],
  updatedAt: null,
};

let fetchMock: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;

function stubFetch() {
  fetchMock = vi.fn(async () => {
    return { ok: true, status: 200, json: async () => SETTINGS } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Requests that were not the mount GET. */
function writeCalls(): unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    const method = (call[1] as RequestInit | undefined)?.method;
    return method !== undefined && method !== "GET";
  });
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Save email settings",
  }) as HTMLButtonElement;
}

function copyButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Copy address" }) as HTMLButtonElement;
}

function settingsForm(): HTMLFormElement {
  const form = saveButton().closest("form");
  if (!form) throw new Error("the save button is not inside a form");
  return form;
}

beforeEach(() => {
  stubFetch();
  writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one and would unmount with the
  // globals still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("Email ingestion refuses its save on a read-only deployment", () => {
  it("states the refusal and describes the save with it", async () => {
    render(<EmailIngestSettings readOnly />);

    const note = await screen.findByText(EMAIL_INGEST_READ_ONLY_COPY);
    const ids = (saveButton().getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter(Boolean);
    expect(ids).toContain(note.id);
  });

  it("keeps the save in the tab order", async () => {
    render(<EmailIngestSettings readOnly />);
    await screen.findByText(EMAIL_INGEST_READ_ONLY_COPY);

    // `aria-disabled`, never `disabled`: a disabled button is unreachable and
    // carries no description, so the sentence would never be announced.
    await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("sends no PUT when the form is submitted", async () => {
    render(<EmailIngestSettings readOnly />);
    await screen.findByText(EMAIL_INGEST_READ_ONLY_COPY);

    fireEvent.click(saveButton());
    fireEvent.submit(settingsForm());

    expect(writeCalls()).toEqual([]);
  });

  it("leaves Copy address live — it writes nothing", async () => {
    render(<EmailIngestSettings readOnly />);
    await screen.findByText(EMAIL_INGEST_READ_ONLY_COPY);

    expect(copyButton().hasAttribute("aria-disabled")).toBe(false);
    expect(copyButton().getAttribute("aria-describedby")).toBeNull();

    fireEvent.click(copyButton());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ingest@example.com"));
    expect(writeCalls()).toEqual([]);
  });

  it("leaves the stored configuration readable", async () => {
    // What a read-only deployment leaves the owner to READ. `readOnly` on the
    // boxes rather than `disabled`, so the values stay reachable.
    render(<EmailIngestSettings readOnly />);
    await screen.findByText(EMAIL_INGEST_READ_ONLY_COPY);

    const address = screen.getByLabelText(
      "work-wiki inbound email address",
    ) as HTMLInputElement;
    expect(address.value).toBe("ingest@example.com");
    expect(address.readOnly).toBe(true);
    expect(address.hasAttribute("disabled")).toBe(false);

    const senders = screen.getByLabelText("Approved senders") as HTMLTextAreaElement;
    expect(senders.value).toBe("you@example.com");
    expect(senders.readOnly).toBe(true);
  });

  it("names ITS OWN door's sentence and nothing else", async () => {
    // ONE control, ONE door, ONE sentence — see the matching case in
    // `names-terms-read-only.test.tsx`. `/settings`'s banner states what
    // `PUT /api/settings` answers, and this button meets
    // `PUT /api/email/settings`.
    render(<EmailIngestSettings readOnly />);
    const note = await screen.findByText(EMAIL_INGEST_READ_ONLY_COPY);

    expect(saveButton().getAttribute("aria-describedby")!.split(" ")).toEqual([
      note.id,
    ]);
  });

  it("refuses the destination and enable edits themselves, not just their look", async () => {
    // `aria-disabled` dims a <select> and a checkbox but does NOT stop either
    // moving. Marked-but-live is the failure this case exists for: every
    // attribute assertion above would pass without the handler guards.
    render(<EmailIngestSettings readOnly />);
    await screen.findByText(EMAIL_INGEST_READ_ONLY_COPY);

    const owner = screen.getByLabelText(/Knowledge owner/) as HTMLSelectElement;
    const vault = screen.getByLabelText(/File in vault/) as HTMLSelectElement;
    const accept = screen.getByLabelText(
      /Accept email from approved senders/,
    ) as HTMLInputElement;
    for (const control of [owner, vault, accept]) {
      expect(control.getAttribute("aria-disabled")).toBe("true");
    }

    fireEvent.change(owner, { target: { value: "a1" } });
    fireEvent.change(vault, { target: { value: "v1" } });
    fireEvent.click(accept);

    expect(owner.value).toBe("");
    expect(vault.value).toBe("");
    // The served config has ingestion ON, and it stayed on.
    expect(accept.checked).toBe(true);
    expect(writeCalls()).toEqual([]);
  });

  it("keeps the save reachable while the mount GET is still in flight", async () => {
    // `loading` is transient, but a GET that never resolves would pin it true
    // forever and `disabled` would take the ONE control carrying the sentence
    // out of the tab order — the DW-191/DW-299 shape reached by a stalled
    // request rather than a fieldset. The refusal outranks the transient state.
    fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<EmailIngestSettings readOnly />);

    await screen.findByText(EMAIL_INGEST_READ_ONLY_COPY);
    expect(saveButton().hasAttribute("disabled")).toBe(false);
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  });
});

describe("Email ingestion is unchanged on a writable deployment", () => {
  it("says nothing, refuses nothing, and still saves", async () => {
    // The control case. Without it every assertion above would also pass
    // against a form that had simply stopped working.
    render(<EmailIngestSettings />);
    await waitFor(() => expect(saveButton().hasAttribute("disabled")).toBe(false));

    expect(screen.queryByText(EMAIL_INGEST_READ_ONLY_COPY)).toBeNull();
    expect(saveButton().hasAttribute("aria-disabled")).toBe(false);
    expect(saveButton().getAttribute("aria-describedby")).toBeNull();
    expect(
      (screen.getByLabelText("work-wiki inbound email address") as HTMLInputElement)
        .readOnly,
    ).toBe(false);

    fireEvent.submit(settingsForm());
    await waitFor(() => expect(writeCalls().length).toBeGreaterThan(0));
    expect(String(writeCalls()[0][0])).toBe("/api/email/settings");
    expect((writeCalls()[0][1] as RequestInit).method).toBe("PUT");
  });
});
