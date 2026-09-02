import { describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import {
  SETTINGS_KEY_ABSENT_COPY,
  SETTINGS_KEY_REMOVE_COPY,
  SETTINGS_KEY_STORED_COPY,
  settingsEnvKeyVariableCopy,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";
import {
  announcedFor,
  installSettingsFetchMock,
  mountSettings,
  settingsPayload,
} from "@/test/settings-harness";

/**
 * The two key rows an ENVIRONMENT variable can supply, MOUNTED (DW-66).
 *
 * `hasCustomApiKey` and `hasFirecrawlApiKey` used to be the OR of the variable
 * and the stored value, which made an env-only deployment read "A key is
 * stored." beside a `Remove` button that deletes nothing from the store,
 * cannot touch the variable, and leaves the same sentence on screen after it
 * is pressed. Whether the SURFACE now says where the key comes from, and
 * whether the button is actually gone, is not something a source scan can
 * check — `secretRow` gates `Remove` on the boolean it is handed, so the claim
 * is about what that boolean now is. So these cases are made against the
 * rendered DOM.
 *
 * The two rows live on different categories (`llm-models` and
 * `external-sources`), which is why every case here names one.
 */

// Stubs `fetch` for the file and tears each tree down while it is still stubbed.
// Nothing here inspects the calls, so the mock it returns is not held.
installSettingsFetchMock();

/**
 * The sentence has TWO second halves, and which one is right depends on the
 * row's other fact — `secretRow` appends this to "A key is stored." / "No key
 * is stored.", so "nothing needs to be stored here" contradicts the first of
 * those two. Both are asserted below, per row.
 */
const CUSTOM_ENV_ONLY_COPY = settingsEnvKeyVariableCopy("customApiKey", false);
const CUSTOM_ENV_AND_STORED_COPY = settingsEnvKeyVariableCopy("customApiKey", true);
const FIRECRAWL_ENV_ONLY_COPY = settingsEnvKeyVariableCopy("firecrawlApiKey", false);
const FIRECRAWL_ENV_AND_STORED_COPY = settingsEnvKeyVariableCopy(
  "firecrawlApiKey",
  true,
);

/** The shared fixture; every case states its own env/stored combination. */
function payload(overrides: Partial<WorkbenchSettingsPayload> = {}): WorkbenchSettingsPayload {
  return settingsPayload(overrides);
}

function removeButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: SETTINGS_KEY_REMOVE_COPY });
}

describe("a key the ENVIRONMENT supplies (DW-66)", () => {
  it("takes Remove off the Custom API key row and names LLM_CUSTOM_API_KEY", async () => {
    await mountSettings(
      "llm-models",
      payload({ hasCustomApiKey: false, envCustomApiKey: true }),
    );

    const key = screen.getByLabelText("Custom API key") as HTMLInputElement;
    // The store holds nothing, which is the honest first half — and the second
    // half says why that is fine and where the credential actually comes from.
    expect(announcedFor(key)).toBe(
      `${SETTINGS_KEY_ABSENT_COPY} ${CUSTOM_ENV_ONLY_COPY}`,
    );
    expect(announcedFor(key)).toContain("LLM_CUSTOM_API_KEY");
    // The affordance that cleared nothing is gone, not merely inert.
    expect(removeButton()).toBeNull();
  });

  it("takes Remove off the Firecrawl API key row and names FIRECRAWL_API_KEY", async () => {
    await mountSettings(
      "external-sources",
      payload({ hasFirecrawlApiKey: false, envFirecrawlApiKey: true }),
    );

    const key = screen.getByLabelText("Firecrawl API key") as HTMLInputElement;
    expect(announcedFor(key)).toBe(
      `${SETTINGS_KEY_ABSENT_COPY} ${FIRECRAWL_ENV_ONLY_COPY}`,
    );
    expect(announcedFor(key)).toContain("FIRECRAWL_API_KEY");
    expect(removeButton()).toBeNull();
  });

  it("keeps Remove and BOTH facts when a stored key sits under the variable", async () => {
    // Env wins at runtime, but there IS a stored key here and `Remove` is the
    // only way to delete it — so the button stays, and the row says both
    // things rather than picking one.
    //
    // The second half SWITCHES here. Appending "Nothing needs to be stored
    // here." to "A key is stored." is a row contradicting itself in one breath,
    // and it also misdescribes the stored key: it is not surplus, it is what
    // applies the moment the variable is unset. That is what the row now says.
    await mountSettings(
      "llm-models",
      payload({ hasCustomApiKey: true, envCustomApiKey: true }),
    );
    const custom = announcedFor(screen.getByLabelText("Custom API key"));
    expect(custom).toBe(`${SETTINGS_KEY_STORED_COPY} ${CUSTOM_ENV_AND_STORED_COPY}`);
    expect(custom).toContain("applies only once that variable is unset");
    expect(custom).not.toContain("Nothing needs to be stored here");
    expect(removeButton()).not.toBeNull();

    cleanup();
    await mountSettings(
      "external-sources",
      payload({ hasFirecrawlApiKey: true, envFirecrawlApiKey: true }),
    );
    const firecrawl = announcedFor(screen.getByLabelText("Firecrawl API key"));
    expect(firecrawl).toBe(
      `${SETTINGS_KEY_STORED_COPY} ${FIRECRAWL_ENV_AND_STORED_COPY}`,
    );
    expect(firecrawl).not.toContain("Nothing needs to be stored here");
    expect(removeButton()).not.toBeNull();
  });

  it("says nothing about the environment when no variable is set", async () => {
    // The commonest deployment, and the regression net for the sentence: a row
    // that announced the env note unconditionally would point an owner at a
    // variable nobody set.
    await mountSettings(
      "llm-models",
      payload({ hasCustomApiKey: true, envCustomApiKey: false }),
    );
    const custom = announcedFor(screen.getByLabelText("Custom API key"));
    expect(custom).toBe(SETTINGS_KEY_STORED_COPY);
    expect(custom).not.toContain("LLM_CUSTOM_API_KEY");
    expect(removeButton()).not.toBeNull();

    cleanup();
    await mountSettings(
      "external-sources",
      payload({ hasFirecrawlApiKey: true, envFirecrawlApiKey: false }),
    );
    const firecrawl = announcedFor(screen.getByLabelText("Firecrawl API key"));
    expect(firecrawl).toBe(SETTINGS_KEY_STORED_COPY);
    expect(firecrawl).not.toContain("FIRECRAWL_API_KEY");
    expect(removeButton()).not.toBeNull();
  });
});
