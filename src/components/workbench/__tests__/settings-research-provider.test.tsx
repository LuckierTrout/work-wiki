/**
 * Settings → External Sources, the Deep Research half.
 *
 * MOUNTED, because the claims are about a control's live state rather than about
 * a copy constant: which provider the select shows when nothing is stored, that
 * an env override wins and says so, that the hint answers "will a run start"
 * rather than "what is selected", and that a key typed but not yet saved already
 * counts as configured. `workbench-settings.test.ts` reads this component's
 * source and can see none of those.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import {
  DEFAULT_SERPAPI_ENGINE,
  SETTINGS_FIRECRAWL_COPY,
  SETTINGS_LOADING_COPY,
  SETTINGS_READ_ONLY_COPY,
  SETTINGS_RESEARCH_COPY,
  SETTINGS_RESEARCH_PROVIDER_LABEL,
  researchProviderUnconfiguredCopy,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";
import {
  announcedFor,
  installSettingsFetchMock,
  mountSettings,
  settingsPayload,
} from "./settings-harness";

/**
 * The shared fixture, unchanged: this file's claims are all about a FRESH
 * deployment, which is exactly what `settingsPayload()`'s base describes, so it
 * states no deltas of its own.
 */
const payload = settingsPayload;

const fetchMock = installSettingsFetchMock();

/** Mount the External Sources category and let the single on-mount read settle. */
function mount(stored: WorkbenchSettingsPayload) {
  return mountSettings("external-sources", stored);
}

const providerSelect = () =>
  screen.getByLabelText(SETTINGS_RESEARCH_PROVIDER_LABEL) as HTMLSelectElement;

describe("the Deep Research provider select", () => {
  it("offers the three search providers and NOT Firecrawl", async () => {
    await mount(payload());

    expect([...providerSelect().options].map((option) => option.value))
      .toEqual(["tavily", "serpapi", "searxng"]);
    // Firecrawl still has its fields, under Capture, with copy that no longer
    // claims a Deep Research role.
    expect(screen.getByText(SETTINGS_FIRECRAWL_COPY).textContent)
      .toContain("not a Deep Research search provider");
    expect(screen.getByLabelText("Firecrawl API key")).toBeTruthy();
    expect(screen.getByText(SETTINGS_RESEARCH_COPY)).toBeTruthy();
  });

  it("shows the provider that would actually run when nothing is stored", async () => {
    // An empty value renders as the first option while the draft still holds
    // `""` — a box showing Tavily that would save nothing.
    await mount(payload({ researchProvider: null }));

    expect(providerSelect().value).toBe("tavily");
    // …and the hint answers the question the owner arrived with, naming the
    // thing to supply rather than merely repeating the selection.
    expect(announcedFor(providerSelect())).toContain(
      researchProviderUnconfiguredCopy("tavily"),
    );
  });

  it("says a selected provider is configured once its key is stored", async () => {
    await mount(payload({ researchProvider: "tavily", hasTavilyApiKey: true }));

    expect(announcedFor(providerSelect()))
      .toContain("Tavily is configured and will run the next Deep Research.");
  });

  it("counts a key typed but not yet saved as configured", async () => {
    // The owner selects a provider PRECISELY so they can paste its key. A hint
    // that kept saying "no key yet" until reload would read as a refusal of the
    // edit that just fixed it.
    await mount(payload({ researchProvider: "serpapi" }));
    expect(announcedFor(providerSelect()))
      .toContain(researchProviderUnconfiguredCopy("serpapi"));

    fireEvent.change(screen.getByLabelText("SerpApi API key"), {
      target: { value: "serp-key" },
    });

    await waitFor(() => expect(announcedFor(providerSelect()))
      .toContain("SerpApi is configured"));
  });

  it("does NOT let another provider's credential make the selection configured", async () => {
    // No silent fallback, on the surface as well as in the run: a stored Tavily
    // key says nothing about a SearXNG selection.
    await mount(payload({ researchProvider: "searxng", hasTavilyApiKey: true }));

    expect(announcedFor(providerSelect()))
      .toContain(researchProviderUnconfiguredCopy("searxng"));
  });

  it("treats a SearXNG instance URL as SearXNG's credential", async () => {
    await mount(payload({ researchProvider: "searxng", searxngBaseUrl: "https://searx.example" }));

    expect(announcedFor(providerSelect())).toContain("SearXNG is configured");
  });

  it("shows the env override, says it wins, and refuses the box", async () => {
    // `RESEARCH_PROVIDER` wins at run time, so showing the stored value beside a
    // run that uses another provider is the disagreement this pair avoids.
    await mount(payload({
      researchProvider: "tavily",
      envResearchProvider: "searxng",
      envSearxngBaseUrl: "https://searx.example",
      envResearchProviders: ["searxng"],
    }));

    const select = providerSelect();
    expect(select.value).toBe("searxng");
    expect(announcedFor(select)).toContain("RESEARCH_PROVIDER is set to SearXNG");
    // `aria-disabled`, not `disabled` — the house convention, so a keyboard user
    // can still reach it and read what the deployment is running on.
    expect(select.hasAttribute("disabled")).toBe(false);
    expect(select.getAttribute("aria-disabled")).toBe("true");

    fireEvent.change(select, { target: { value: "tavily" } });

    await waitFor(() => expect(select.value).toBe("searxng"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed and explains an unsupported env override", async () => {
    await mount(payload({
      researchProvider: "tavily",
      envResearchProviderInvalid: "firecrawl",
      hasTavilyApiKey: true,
    }));

    const select = providerSelect();
    expect(select.getAttribute("aria-disabled")).toBe("true");
    expect(announcedFor(select)).toContain("unsupported value");
    expect(announcedFor(select)).toContain("firecrawl");
  });

  it("refuses the SearXNG instance URL box when the env pins it", async () => {
    // The hint said the env wins while the box still took typing, and a Save
    // stored what was typed: a value every run would ignore. The URL is
    // SearXNG's credential, so this box is exactly as env-owned as the select
    // beside it — and it shows the value that will actually be used.
    await mount(payload({
      researchProvider: "searxng",
      searxngBaseUrl: "https://stored.example",
      envSearxngBaseUrl: "https://pinned.example",
    }));

    const box = screen.getByLabelText("SearXNG instance URL") as HTMLInputElement;
    expect(box.value).toBe("https://pinned.example");
    expect(box.readOnly).toBe(true);
    expect(announcedFor(box)).toContain("SEARXNG_BASE_URL is set to https://pinned.example");

    fireEvent.change(box, { target: { value: "https://typed.example" } });

    await waitFor(() => expect(box.value).toBe("https://pinned.example"));
    // Nothing was saved, and nothing was even attempted: one call, the load.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the instance URL editable when no env pins it", async () => {
    await mount(payload({ researchProvider: "searxng", searxngBaseUrl: "https://stored.example" }));

    const box = screen.getByLabelText("SearXNG instance URL") as HTMLInputElement;
    expect(box.value).toBe("https://stored.example");
    expect(box.readOnly).toBe(false);
    fireEvent.change(box, { target: { value: "https://typed.example" } });
    await waitFor(() => expect(box.value).toBe("https://typed.example"));
  });

  it("refuses the select on a read-only deployment and says why", async () => {
    await mount(payload({ readOnly: true, researchProvider: "tavily", hasTavilyApiKey: true }));

    const select = providerSelect();
    expect(select.getAttribute("aria-disabled")).toBe("true");
    select.focus();
    expect(document.activeElement).toBe(select);
    const announced = announcedFor(select);
    expect(announced).toContain("Tavily is configured");
    expect(announced).toContain(SETTINGS_READ_ONLY_COPY);
  });

  it("offers the SerpApi engine and the SearXNG categories as editable text", async () => {
    // Both were hardcoded. The engine's placeholder names today's value so an
    // owner pointing SerpApi at Bing does not have to guess the vocabulary.
    await mount(payload({ researchProvider: "serpapi", serpApiEngine: "bing" }));

    const engine = screen.getByLabelText("SerpApi engine") as HTMLInputElement;
    expect(engine.value).toBe("bing");
    expect(engine.readOnly).toBe(false);
    expect(announcedFor(engine)).toContain(DEFAULT_SERPAPI_ENGINE);
    expect(screen.getByLabelText("SearXNG categories")).toBeTruthy();
    expect(screen.getByLabelText("SearXNG instance URL")).toBeTruthy();
  });

  it("sends the research fields it edited, and no key it did not touch", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ workbench: payload() }),
    } as unknown as Response);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ saved: true, workbench: payload({ researchProvider: "searxng" }) }),
    } as unknown as Response);
    render(<SettingsCanvas category="external-sources" headingId="wb-set-heading" />);
    await waitFor(() => expect(screen.queryByText(SETTINGS_LOADING_COPY)).toBeNull());

    fireEvent.change(providerSelect(), { target: { value: "searxng" } });
    fireEvent.change(screen.getByLabelText("SearXNG instance URL"), {
      target: { value: "https://searx.example" },
    });
    fireEvent.change(screen.getByLabelText("SearXNG categories"), {
      target: { value: "general,news" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { workbench: Record<string, unknown> };
    expect(body.workbench).toMatchObject({
      researchProvider: "searxng",
      searxngBaseUrl: "https://searx.example",
      searxngCategories: "general,news",
    });
    // AD-23: an untouched key is OMITTED, never sent as an empty string that the
    // merge would read as a deletion.
    expect(body.workbench).not.toHaveProperty("tavilyApiKey");
    expect(body.workbench).not.toHaveProperty("serpApiKey");
  });
});
