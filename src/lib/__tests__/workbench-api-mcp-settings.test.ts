import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  brandedSkillInstallCommand,
  draftApiTokenMissing,
  draftApiUnauthenticated,
  loopbackMcpConfig,
  LOOPBACK_MCP_ENTRY,
  LOOPBACK_MCP_SERVER_NAME,
  maskToken,
  resolveLoopbackMcpEntry,
  SETTINGS_API_TOKEN_ENV_COPY,
  SETTINGS_API_UNAUTH_OFF_COPY,
  SETTINGS_API_UNAUTH_WARNING_COPY,
  settingsDraftAfterApiEnabled,
  settingsDraftAfterTokenGenerated,
  WORK_WIKI_SKILL_DIR,
} from "../workbench-api-mcp-settings";
import { LOOPBACK_TOKEN_ENV, newLoopbackApiToken } from "../v1-contract";
import type { SettingsDraft, WorkbenchSettingsValues } from "../workbench-settings";

/**
 * The API + MCP category's own rules, executed.
 *
 * The category got its own module (DW-445) and this is its suite. Everything
 * here is a pure function over a draft or a token, which is exactly why the
 * rules live in a module rather than inside the pane's click handlers: a
 * `node` project mounts nothing, so a decision typed into JSX could only ever
 * be grepped for. The pane's own DOM is pinned separately, by
 * `src/components/workbench/__tests__/settings-api-mcp-pane.test.tsx`.
 */

const SRC = path.resolve(__dirname, "..", "..");

/**
 * A draft with only the fields these rules read.
 *
 * The real draft carries every provider credential too; spelling all of them
 * here would make each test about the fixture rather than about the two
 * booleans and the one token the rules turn on.
 */
function draft(over: Partial<SettingsDraft> = {}): SettingsDraft {
  return {
    apiEnabled: false,
    allowUnauthenticated: false,
    loopbackApiToken: "",
    ...over,
  } as SettingsDraft;
}

/** The stored fields `draftApiTokenMissing` reads, and nothing else. */
function stored(over: Partial<WorkbenchSettingsValues> = {}): WorkbenchSettingsValues {
  return {
    loopbackTokenSource: "none",
    hasLoopbackApiToken: false,
    ...over,
  } as WorkbenchSettingsValues;
}

describe("a token, masked", () => {
  it("keeps the last four characters of a real token and hides the rest", () => {
    // The one thing eyes are useful for here: telling a freshly generated token
    // from one already pasted somewhere. Everything else is the clipboard's job,
    // so the pane can sit open on a shared screen or in a recording.
    const token = newLoopbackApiToken();
    expect(token).toHaveLength(48);
    const masked = maskToken(token);
    expect(masked.endsWith(token.slice(-4))).toBe(true);
    // Not one character of the SECRET part survives.
    expect(masked).not.toContain(token.slice(0, 44));
    expect(masked.slice(0, -4)).toMatch(/^•+$/);
    expect(masked.slice(0, -4)).toHaveLength(24);
  });

  it("shows nothing at all of a token four characters or shorter", () => {
    // The tail rule would otherwise reveal the WHOLE value: a 4-character token
    // is entirely "the last four". Short tokens are not what this pane mints,
    // but `maskToken` is also handed whatever a draft is holding.
    expect(maskToken("abcd")).toBe("••••");
    expect(maskToken("a")).toBe("•");
    expect(maskToken("")).toBe("");
    expect(maskToken("abcde")).toBe("•bcde");
  });
});

describe("the copyable MCP config", () => {
  type McpConfig = {
    mcpServers: Record<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    >;
  };

  function parse(config: string): McpConfig["mcpServers"][string] {
    const parsed = JSON.parse(config) as McpConfig;
    return parsed.mcpServers[LOOPBACK_MCP_SERVER_NAME];
  }

  it("names the frozen server and points a stdio client at the stock wrap", () => {
    // A rename orphans every client config an owner has already saved.
    expect(LOOPBACK_MCP_SERVER_NAME).toBe("yopedia");
    const entry = parse(loopbackMcpConfig(null));
    expect(entry.command).toBe("node");
    expect(entry.args).toHaveLength(1);
    expect(entry.args[0].endsWith(`${path.sep}sidecar${path.sep}mcp.mjs`)).toBe(true);
  });

  it("carries the placeholder when no plaintext token is in hand", () => {
    // The ORDINARY case: the server answers a presence boolean, never the
    // stored value, so a config built outside the one moment after Generate has
    // nothing to substitute. It still has to be a valid config that says where
    // to paste.
    expect(parse(loopbackMcpConfig(null)).env[LOOPBACK_TOKEN_ENV]).toBe(
      "PASTE_YOUR_TOKEN",
    );
    expect(parse(loopbackMcpConfig("")).env[LOOPBACK_TOKEN_ENV]).toBe(
      "PASTE_YOUR_TOKEN",
    );
  });

  it("puts the token in env and never in a URL", () => {
    const config = loopbackMcpConfig("shown-token");
    expect(parse(config).env[LOOPBACK_TOKEN_ENV]).toBe("shown-token");
    // A URL is the thing an owner screenshots and a proxy logs.
    expect(config).not.toMatch(/token=/);
    expect(config).not.toMatch(/https?:\/\//);
  });

  it("takes an absolute entry from the server and resolves a relative one itself", () => {
    // The server knows the deployment's own root; the browser does not. An
    // absolute path served beside the payload therefore wins outright.
    expect(parse(loopbackMcpConfig(null, "/opt/wiki/sidecar/mcp.mjs")).args[0]).toBe(
      "/opt/wiki/sidecar/mcp.mjs",
    );
    expect(resolveLoopbackMcpEntry("C:\\wiki\\sidecar\\mcp.mjs")).toBe(
      "C:\\wiki\\sidecar\\mcp.mjs",
    );
    // Anything RELATIVE is not a path the client could spawn from its own cwd,
    // so it is discarded in favour of this process's own resolution.
    expect(resolveLoopbackMcpEntry("sidecar/mcp.mjs")).toBe(
      path.join(process.cwd(), LOOPBACK_MCP_ENTRY),
    );
    expect(resolveLoopbackMcpEntry(null)).toBe(
      path.join(process.cwd(), LOOPBACK_MCP_ENTRY),
    );
  });

  it("installs the branded pack from this repo rather than fetching it", () => {
    // A COPY, not a download: the pack is in this repo, so anything that
    // fetched it would be a second source of truth for the same files.
    expect(brandedSkillInstallCommand()).toContain(WORK_WIKI_SKILL_DIR);
    expect(brandedSkillInstallCommand()).not.toMatch(/curl|wget|npx|git clone/);
  });
});

describe("the four draft rules", () => {
  it("puts a freshly minted token in the draft and leaves everything else", () => {
    const before = draft({ apiEnabled: true });
    const after = settingsDraftAfterTokenGenerated(before, "a".repeat(48));
    expect(after.loopbackApiToken).toBe("a".repeat(48));
    expect(after.apiEnabled).toBe(true);
    // A new object, so the canvas's `setDraft` sees a change.
    expect(after).not.toBe(before);
  });

  it("clears unauthenticated access when the door is shut", () => {
    const shut = settingsDraftAfterApiEnabled(
      draft({ apiEnabled: true, allowUnauthenticated: true }),
      false,
    );
    expect(shut).toMatchObject({ apiEnabled: false, allowUnauthenticated: false });
    // So a later re-open cannot silently reopen an UNAUTHENTICATED door.
    expect(settingsDraftAfterApiEnabled(shut, true).allowUnauthenticated).toBe(false);
    // Shutting leaves the token alone: pausing a feature must not turn
    // re-enabling it into a credential hunt.
    expect(
      settingsDraftAfterApiEnabled(
        draft({ apiEnabled: true, loopbackApiToken: "kept" }),
        false,
      ).loopbackApiToken,
    ).toBe("kept");
  });

  it("warns only while the draft would admit an untokened caller", () => {
    expect(
      draftApiUnauthenticated(draft({ apiEnabled: true, allowUnauthenticated: true })),
    ).toBe(true);
    // Both legs are required: an unauthenticated flag under a shut door admits
    // nobody, and there is nothing to warn about.
    expect(
      draftApiUnauthenticated(draft({ apiEnabled: false, allowUnauthenticated: true })),
    ).toBe(false);
    expect(
      draftApiUnauthenticated(draft({ apiEnabled: true, allowUnauthenticated: false })),
    ).toBe(false);
    expect(SETTINGS_API_UNAUTH_WARNING_COPY).not.toBe(SETTINGS_API_UNAUTH_OFF_COPY);
  });

  it("says the door is shut to everyone rather than blocking Save", () => {
    const on = draft({ apiEnabled: true });
    // On, unauth off, no token anywhere: a real, safe state — and a SENTENCE, so
    // the owner is not left hunting their agent's 401.
    expect(draftApiTokenMissing(on, stored())).toBe(true);
    // Every way there IS in answers false.
    expect(draftApiTokenMissing(on, stored({ loopbackTokenSource: "env" }))).toBe(false);
    expect(draftApiTokenMissing(on, stored({ hasLoopbackApiToken: true }))).toBe(false);
    expect(
      draftApiTokenMissing(settingsDraftAfterTokenGenerated(on, "a".repeat(48)), stored()),
    ).toBe(false);
    // A draft that REMOVES the stored token is missing one even though the store
    // still holds it — the save is what the sentence describes, not the store.
    expect(
      draftApiTokenMissing(draft({ apiEnabled: true, loopbackApiToken: null }), stored({ hasLoopbackApiToken: true })),
    ).toBe(true);
    // Whitespace is UNTOUCHED, not a value, so it falls through to the store.
    expect(
      draftApiTokenMissing(
        draft({ apiEnabled: true, loopbackApiToken: "   " }),
        stored({ hasLoopbackApiToken: true }),
      ),
    ).toBe(false);
    // A shut door and an open-to-everyone door both have nothing to say.
    expect(draftApiTokenMissing(draft(), stored())).toBe(false);
    expect(
      draftApiTokenMissing(
        draft({ apiEnabled: true, allowUnauthenticated: true }),
        stored(),
      ),
    ).toBe(false);
  });

  it("names the env variable in the sentence that explains the missing button", () => {
    // Generate is REMOVED under an env-supplied token, so the hint has to say
    // why or the button merely looks broken.
    expect(SETTINGS_API_TOKEN_ENV_COPY).toContain(LOOPBACK_TOKEN_ENV);
  });
});

describe("the module stays client-safe", () => {
  it("reaches no Node built-in, no storage and no config", async () => {
    // The same posture `workbench-settings.ts` holds, and for the same reason:
    // `SettingsApiMcpPane` imports this in the BROWSER while this suite executes
    // it in node. One `node:` import and the bundle breaks.
    const module_ = await readFile(
      path.join(SRC, "lib/workbench-api-mcp-settings.ts"),
      "utf8",
    );
    expect(module_).not.toMatch(/from "node:/);
    expect(module_).not.toMatch(/from "(fs|path|os)"/);
    expect(module_).not.toContain("./storage");
    expect(module_).not.toContain("./config");
  });

  it("keeps the dependency one-way", async () => {
    // The split exists to avoid a cycle. The generic module owns the patch
    // validator — including this category's four patch-validation constants —
    // and must never import back from here.
    const generic = await readFile(path.join(SRC, "lib/workbench-settings.ts"), "utf8");
    expect(generic).not.toContain("workbench-api-mcp-settings");
    // …and the generic module kept none of what moved.
    expect(generic).not.toMatch(/SETTINGS_API_[A-Z_]+ =/);
    expect(generic).not.toContain("function maskToken");
    expect(generic).not.toContain("loopbackMcpConfig");
    expect(generic).not.toContain("brandedSkillInstallCommand");
    expect(generic).not.toMatch(/function (draftApi|settingsDraftAfterApi)/);
  });
});
