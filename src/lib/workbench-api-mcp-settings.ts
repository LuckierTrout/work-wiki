/**
 * The API + MCP category's own vocabulary, snippet builders and draft rules.
 *
 * Split out of `workbench-settings.ts` (DW-445) on the line "the category's own
 * rules and pixels" vs "the surface every category shares". The generic pair
 * keeps anything that describes the whole settings document — the category
 * vocabulary, the payload and patch types, the draft shape, the patch
 * validator, the save body — even where it mentions this door, because those
 * are single functions over a single object.
 *
 * The dependency is ONE-WAY: this module imports from `workbench-settings.ts`,
 * never the reverse. That is why the API patch-validation constants stayed
 * there — `validateWorkbenchSettingsPatch` uses them alongside the generic
 * secret copy, so moving them here would force `workbench-settings.ts` to
 * import FROM this module, and this module already reads `secretPatchValue` out
 * of it. That pair of edges is the cycle the split exists to avoid.
 *
 * Pure and client-safe, the same posture as the module it came from: no Node
 * built-in, no storage, no config. `SettingsApiMcpPane` imports it in the
 * browser and the node suite EXECUTES it.
 */

import { LOOPBACK_BASE_URL, LOOPBACK_TOKEN_ENV } from "./v1-contract";
import { secretPatchValue } from "./workbench-settings";
import type { SettingsDraft, WorkbenchSettingsValues } from "./workbench-settings";

// ---------------------------------------------------------------------------
// API + MCP (Stories 8.1 / 8.3 / 8.4 / 8.6)
// ---------------------------------------------------------------------------

/**
 * The pane's standing sentence. It names the BIND, because that is the fact an
 * owner is entitled to before they turn a network door on: loopback only, this
 * machine only, nothing on the LAN.
 */
export const SETTINGS_API_COPY = `Agents on this machine reach the wiki at ${LOOPBACK_BASE_URL}. The door binds loopback only — never the LAN — and stays shut until you open it.`;

export const SETTINGS_API_ENABLE_LABEL = "Enable the local API";
export const SETTINGS_API_ENABLE_COPY =
  "Off, every data route answers 503 and only /health responds.";
export const SETTINGS_API_ENABLED_COPY =
  "On, agents may read this wiki over the loopback port.";

export const SETTINGS_API_UNAUTH_LABEL = "Allow unauthenticated local access";

/**
 * The ORANGE one. Unauthenticated access is a real option — a machine with one
 * human on it is the deployment this product is for — but it is not the default
 * and it is not silent: anything that can open a socket to loopback can then
 * read the whole wiki, and on a shared machine that includes other people's
 * processes and every browser page's `fetch`.
 *
 * Shown on the DRAFT, before Save, for the same reason MinerU's Cloud warning
 * in the generic settings module is: a warning that arrives only once the
 * setting has applied is a warning about something that already happened.
 */
export const SETTINGS_API_UNAUTH_WARNING_COPY =
  "Any process on this machine could then read the whole wiki without a token. Leave this off unless you are the only user of this computer.";

export const SETTINGS_API_UNAUTH_OFF_COPY =
  "Callers must send the token. This is the recommended setting.";

export const SETTINGS_API_BASE_URL_LABEL = "Base URL";
export const SETTINGS_API_OPEN_HEALTH_COPY = "Open /health";
export const SETTINGS_API_TOKEN_LABEL = "API token";
export const SETTINGS_API_TOKEN_GENERATE_COPY = "Generate";
export const SETTINGS_API_TOKEN_SHOW_COPY = "Show";
export const SETTINGS_API_TOKEN_HIDE_COPY = "Hide";
export const SETTINGS_API_TOKEN_COPY_COPY = "Copy";
export const SETTINGS_API_COPIED_COPY = "Copied.";

/**
 * A token, masked.
 *
 * Shown by DEFAULT rather than revealed by default: this pane can be open on a
 * shared screen or in a screen recording, and the one interaction that must
 * work — Copy — does not need the characters visible. The last four ride so the
 * owner can tell a freshly generated token from one they already pasted
 * somewhere, which is the only thing eyes are useful for here.
 */
export function maskToken(token: string): string {
  if (token.length <= 4) return "•".repeat(token.length);
  return `${"•".repeat(Math.min(24, token.length - 4))}${token.slice(-4)}`;
}

/**
 * A generated token is shown ONCE, in the draft, and then never again.
 *
 * `GET /api/settings` answers a presence boolean — the same AD-23 rule the three
 * provider credentials follow — so after Save there is nothing on the server
 * this surface could render. Saying so is the difference between an owner
 * copying the token now and an owner discovering next week that they cannot.
 */
export const SETTINGS_API_TOKEN_NEW_COPY =
  "Copy this token now — it is stored on save and never shown again.";
/**
 * The token row's HINT answers one question: what is in this field?
 *
 * These two are siblings and read as a pair — "A token is stored." / "No token
 * is stored." — which is why the absent one no longer carries the remedies it
 * used to (DW-635). It was the same string the `wb-set-warn` note renders, so
 * one screen showed the identical sentence twice and a suite could not tell the
 * two nodes apart. The remedies moved to the note below, where the consequence
 * that makes them worth acting on is stated.
 */
export const SETTINGS_API_TOKEN_STORED_COPY = "A token is stored.";
export const SETTINGS_API_TOKEN_ABSENT_COPY = "No token is stored.";

/**
 * The `wb-set-warn` note answers a DIFFERENT question: what happens to callers?
 *
 * Rendered only when `draftApiTokenMissing` holds — the door on, the token
 * required, and none from the environment, the store or a Generate press. It
 * names the consequence first, because "401" is the symptom the owner is
 * actually holding when they come looking, and then both ways out. Not an
 * error and not a block on Save: it is a real, safe state.
 */
export const SETTINGS_API_TOKEN_NO_WAY_IN_COPY =
  "The API is on with no way in: every caller gets 401. Generate a token, or allow unauthenticated access.";

/**
 * `LLM_WIKI_API_TOKEN` is set, so Generate cannot change what callers send.
 *
 * The same env-wins convention as the generic settings module's env-override
 * sentence, named separately because this pane has no editable box for the
 * value: there is nothing here the variable is "winning over" except the
 * Generate button, and the sentence has to say that or the button looks broken.
 */
export const SETTINGS_API_TOKEN_ENV_COPY = `${LOOPBACK_TOKEN_ENV} is set and is the token callers must send. Generating one here stores a value nothing will check until that variable is unset.`;

export const SETTINGS_API_MCP_HEADING = "MCP";
export const SETTINGS_API_MCP_COPY =
  "Paste this into an MCP client on this machine. The token travels in the environment, never in the URL.";
export const SETTINGS_API_MCP_COPY_COPY = "Copy MCP config";

export const SETTINGS_API_SKILL_HEADING = "Agent Skill";
export const SETTINGS_API_SKILL_COPY =
  "Install the branded pack so an agent probes health first, defaults to the current Wiki, and cites the paths it read.";
export const SETTINGS_API_SKILL_COPY_COPY = "Copy install command";

/** The MCP server name is a FROZEN identifier — see `AGENTS.md`. */
export const LOOPBACK_MCP_SERVER_NAME = "yopedia";

/** Where the stock loopback wrap lives, relative to the repo root. */
export const LOOPBACK_MCP_ENTRY = "sidecar/mcp.mjs";

/** The in-repo branded Agent Skill pack (Story 8.4). */
export const WORK_WIKI_SKILL_DIR = "skills/work-wiki";

/**
 * The copyable MCP client config.
 *
 * A local **stdio** client spawning {@link LOOPBACK_MCP_ENTRY}, not an HTTP URL
 * with a token in it: this pane is the one place the owner ever sees the
 * credential, and a config that inlined it into a URL would put it into shell
 * history, into a screenshot, and into whatever file the client writes. The
 * token rides in `env` instead, under the one variable name the door reads.
 *
 * `PASTE_YOUR_TOKEN` is a PLACEHOLDER whenever the caller has no plaintext
 * token in hand, because the server never serves the stored value back — see
 * {@link SETTINGS_API_TOKEN_NEW_COPY}. The one moment it IS substituted is
 * right after Generate, which is exactly the moment the config is useful.
 */
export function resolveLoopbackMcpEntry(explicit?: string | null): string {
  if (
    typeof explicit === "string" &&
    (explicit.startsWith("/") || /^[A-Za-z]:[\\/]/.test(explicit))
  ) {
    return explicit;
  }
  const cwd =
    typeof process !== "undefined" && typeof process.cwd === "function"
      ? process.cwd()
      : "";
  if (!cwd) return LOOPBACK_MCP_ENTRY;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${LOOPBACK_MCP_ENTRY.split("/").join(sep)}`;
}

export function loopbackMcpConfig(
  token: string | null,
  entry?: string | null,
): string {
  const value = token !== null && token.length > 0 ? token : "PASTE_YOUR_TOKEN";
  return JSON.stringify(
    {
      mcpServers: {
        [LOOPBACK_MCP_SERVER_NAME]: {
          command: "node",
          args: [resolveLoopbackMcpEntry(entry)],
          env: { [LOOPBACK_TOKEN_ENV]: value },
        },
      },
    },
    null,
    2,
  );
}

/**
 * The install command for the branded pack.
 *
 * A COPY, not a fetch: the pack is in this repo, so installing it is putting
 * the directory where the agent looks. Anything that downloaded it would be a
 * second source of truth for the same files.
 */
export function brandedSkillInstallCommand(): string {
  return `cp -R ${WORK_WIKI_SKILL_DIR} ~/.claude/skills/work-wiki`;
}

/**
 * The draft after the owner presses Generate.
 *
 * A pure rule, not a `set()` in the component, for the reason every other
 * decision on this surface is one: the suite runs in `environment: "node"`, so a
 * rule inside a click handler could only be grepped for. And this one has a
 * consequence — the token is shown ONCE — that a rewrite would happily keep the
 * wording of while dropping.
 *
 * The token arrives as an argument rather than being minted here so the caller
 * owns the entropy source and the suite can pin a value.
 */
export function settingsDraftAfterTokenGenerated(
  draft: SettingsDraft,
  token: string,
): SettingsDraft {
  return { ...draft, loopbackApiToken: token };
}

/**
 * The draft after the owner ticks or unticks the local API.
 *
 * Unticking clears `allowUnauthenticated` TOO. The two are not independent: an
 * owner who shuts the door has not thereby decided that the next time they open
 * it, it should be open to everything — and leaving the second switch set would
 * mean a later tick of the first one silently reopened an UNAUTHENTICATED door.
 * The stored token is left alone, on the same argument the generic settings
 * module's MinerU enable rule leaves the MinerU key alone: pausing a feature
 * should not turn re-enabling it into a credential hunt.
 */
export function settingsDraftAfterApiEnabled(
  draft: SettingsDraft,
  enabled: boolean,
): SettingsDraft {
  if (enabled) return { ...draft, apiEnabled: true };
  return { ...draft, apiEnabled: false, allowUnauthenticated: false };
}

/**
 * Will the door this DRAFT describes let an untokened caller in?
 *
 * Read off the draft rather than the payload, on exactly the argument the
 * generic settings module's MinerU leaves-the-machine predicate is read off the
 * draft for: the orange warning has to appear when the owner TICKS the box, not
 * after the save that opened the door.
 */
export function draftApiUnauthenticated(draft: SettingsDraft): boolean {
  return draft.apiEnabled && draft.allowUnauthenticated;
}

/**
 * Would this draft leave the API on with NO way for a caller to authenticate?
 *
 * On, unauth off, and no token — from the environment, from the store or from a
 * Generate press. It is not an error and does not block Save: the door is
 * simply shut to everyone, which is a safe state and an honest one. It is a
 * SENTENCE, so the owner is not left wondering why their agent gets 401.
 */
export function draftApiTokenMissing(
  draft: SettingsDraft,
  payload: WorkbenchSettingsValues,
): boolean {
  if (!draft.apiEnabled || draft.allowUnauthenticated) return false;
  if (payload.loopbackTokenSource === "env") return false;
  const pending = secretPatchValue(draft.loopbackApiToken);
  if (pending === null) return true;
  if (pending !== undefined) return false;
  return !payload.hasLoopbackApiToken;
}
