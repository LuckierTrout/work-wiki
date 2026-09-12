/**
 * The tool-using Chat Agent, as the BROWSER sees it (Stories 8.5–8.9).
 *
 * Client-safe and pure, the same posture as `v1-contract.ts`. Everything the
 * Chat surface has to decide — what a tool row is called, what `/skill` means,
 * which form fields are answerable, what an approval modal says, where an output
 * chip points — lives here and is executed by the node suite. A `ChatCanvas`
 * that spelled these inline would leave "does Cancel run the pending tool?" as a
 * question only a human clicking the button could answer.
 *
 * IT MIRRORS `sidecar/agent.mjs` WITHOUT IMPORTING IT. The sidecar may not
 * import `src/lib` (AD-6) and the browser cannot import the sidecar, so the two
 * halves of the vocabulary are pinned against each other by
 * `workbench-epic8.test.ts` — the same arrangement `loopback.mjs` and
 * `v1-contract.ts` already have. A tool added on one side and not the other
 * fails that test rather than silently rendering as `unknown`.
 */

import { SIDECAR_ORIGIN } from "./sidecar";
import { SETTINGS_LABEL, settingsPointer } from "./workbench-settings";

/**
 * Where the three sentences below send an owner: the Settings surface, arrow,
 * and the `api-mcp` category's own nav label (DW-504).
 *
 * ONE value, DERIVED. Three constants in this file used to spell that
 * destination out as a literal, so renaming the category in
 * `SETTINGS_CATEGORIES` — which owns that label for the whole of `src/lib` —
 * would have left three rendered sentences naming a nav row the Settings
 * surface no longer shows. The literal is deliberately absent from this file
 * now, including from this comment.
 *
 * ONE hand-typed copy survives outside `src/lib`, and it is architecturally
 * forced rather than missed: `sidecar/mcp.mjs`'s `MCP_INSTRUCTIONS` names the
 * same destination for every MCP client that reads it, and the sidecar may not
 * import `src/lib` (AD-6), so that sentence cannot be derived from here. A
 * rename therefore still has exactly one other place to visit, by design — and
 * it will be TOLD to visit it: `epic8-chat-agent.test.ts` imports
 * `MCP_INSTRUCTIONS` and asserts it contains the same derived pointer, so a
 * rename that skips the sidecar fails a named row rather than shipping quietly.
 *
 * The SHORT surface label is passed rather than defaulted because these three
 * render INSIDE the Workbench: there the unprefixed "Settings" already names
 * the surface the owner is standing on, while the "Workbench" prefix exists to
 * point a sentence on the legacy flat `/settings` page at the OTHER surface, so
 * here it would only be noise. That rule belongs to {@link settingsPointer} —
 * see its doc block in `./workbench-settings`.
 *
 * The import keeps this module's client-safe, pure posture: `workbench-settings`
 * is browser-importable (`SettingsCanvas` imports it), pulls in no Node built-in,
 * and does not import back into this file.
 */
const API_MCP_POINTER = settingsPointer("api-mcp", SETTINGS_LABEL);

// ---------------------------------------------------------------------------
// Tool rows
// ---------------------------------------------------------------------------

/**
 * Every tool the Agent may call, in the order `AGENT_TOOLS` declares them.
 *
 * The list is here so the surface can LABEL a row it did not invent. A row's
 * `tool` arrives over SSE from the sidecar, and a surface that fell back to the
 * raw name would show the owner `workspace_write` where the rest of the product
 * says "Wrote a file".
 */
export const AGENT_TOOL_NAMES = [
  "wiki_search",
  "wiki_read",
  "source_search",
  "graph",
  "web_search",
  "skill_read",
  "workspace_write",
  "shell",
  "skill_form",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** What the owner reads on the row. English, and a verb where there is one. */
const TOOL_LABELS: Record<AgentToolName, string> = {
  wiki_search: "Searched the wiki",
  wiki_read: "Read a page",
  source_search: "Searched Sources",
  graph: "Read the graph",
  web_search: "Searched the web",
  skill_read: "Read a Skill",
  workspace_write: "Wrote a file",
  shell: "Ran a command",
  skill_form: "Asked you for input",
};

export function isAgentToolName(value: unknown): value is AgentToolName {
  return (
    typeof value === "string" &&
    (AGENT_TOOL_NAMES as readonly string[]).includes(value)
  );
}

/**
 * A row's label, falling back to the raw name for a tool this build does not
 * know.
 *
 * THE FALLBACK IS DELIBERATE rather than an assertion: the sidecar is a separate
 * process the owner can update on its own schedule, so a newer sidecar calling a
 * tool this browser build has never heard of is a real state. Showing its name
 * is honest; throwing would take the whole transcript down over a label.
 */
export function toolRowLabel(tool: string): string {
  return isAgentToolName(tool) ? TOOL_LABELS[tool] : tool;
}

/** The states a row can be in. `pending` is waiting on the owner. */
export const TOOL_ROW_STATES = [
  "running",
  "done",
  "pending",
  "denied",
  "cancelled",
  "error",
] as const;

export type ToolRowState = (typeof TOOL_ROW_STATES)[number];

export interface ChatToolRow {
  id: string;
  tool: string;
  state: ToolRowState;
  detail: string;
}

export function isChatToolRow(value: unknown): value is ChatToolRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.tool === "string" &&
    typeof row.state === "string" &&
    (TOOL_ROW_STATES as readonly string[]).includes(row.state)
  );
}

/**
 * Fold an arriving row into the rows already on screen.
 *
 * BY ID, replacing rather than appending, because the sidecar announces a call
 * before it runs and reports it again when it finishes. Appending would show the
 * owner every search twice — once as "running" forever.
 */
export function mergeToolRow(
  rows: readonly ChatToolRow[],
  row: ChatToolRow,
): ChatToolRow[] {
  const index = rows.findIndex((existing) => existing.id === row.id);
  if (index === -1) return [...rows, row];
  const next = [...rows];
  next[index] = row;
  return next;
}

// ---------------------------------------------------------------------------
// Pauses: the Skill form and the shell approval
// ---------------------------------------------------------------------------

export const FORM_FIELD_KINDS = ["single", "multiple", "text"] as const;
export type FormFieldKind = (typeof FORM_FIELD_KINDS)[number];

export interface ChatFormField {
  name: string;
  label: string;
  kind: FormFieldKind;
  options?: string[];
  required?: boolean;
}

export interface ChatPendingForm {
  kind: "skill_form";
  title: string;
  fields: ChatFormField[];
  rowId: string;
  capabilityId: string;
  [extra: string]: unknown;
}

export interface ChatPendingShell {
  kind: "shell_approval";
  /** `outside_workspace` or `new_executable` — why the owner is being asked. */
  reason: string;
  command: string;
  args: string[];
  cwd: string;
  rowId: string;
  capabilityId: string;
  [extra: string]: unknown;
}

export type ChatPending = ChatPendingForm | ChatPendingShell;

/**
 * Is this `done` payload's `pending` a pause the surface can render?
 *
 * VALIDATED, not cast. The payload crosses a process boundary, and a `pending`
 * the surface half-understood would either render a modal with no buttons or —
 * worse — send a resume that the sidecar reads as an approval. The unknown-shape
 * answer is "no pause", which ends the turn normally.
 */
export function isChatPending(value: unknown): value is ChatPending {
  if (!value || typeof value !== "object") return false;
  const pending = value as Record<string, unknown>;
  if (typeof pending.capabilityId !== "string" || !pending.capabilityId) {
    return false;
  }
  if (typeof pending.rowId !== "string") return false;
  if (pending.kind === "skill_form") {
    return Array.isArray(pending.fields) && pending.fields.length > 0;
  }
  if (pending.kind === "shell_approval") {
    return typeof pending.command === "string" && pending.command.length > 0;
  }
  return false;
}

/** The form's starting values: empty text, nothing chosen. */
export function initialFormValues(
  fields: readonly ChatFormField[],
): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  for (const field of fields) {
    values[field.name] = field.kind === "multiple" ? [] : "";
  }
  return values;
}

/**
 * May Submit be pressed?
 *
 * Only `required` fields block it. A form that demanded every answer would make
 * "I don't know, use your judgement" impossible to express, and the owner's
 * escape hatch from a form they cannot answer is Cancel — which must stay a
 * deliberate act, not the only way out of a validation dead end.
 */
export function formIsSubmittable(
  fields: readonly ChatFormField[],
  values: Record<string, string | string[]>,
): boolean {
  return fields.every((field) => {
    if (!field.required) return true;
    const value = values[field.name];
    return Array.isArray(value) ? value.length > 0 : Boolean(value?.trim());
  });
}

export const FORM_SUBMIT_LABEL = "Submit";
export const FORM_CANCEL_LABEL = "Cancel";

/** The approval modal's title, body and buttons. Per command, every time. */
export const SHELL_APPROVAL_TITLE = "Run this command?";
export const SHELL_APPROVE_LABEL = "Approve";
export const SHELL_DENY_LABEL = "Deny";

/**
 * Why this command needs an answer, in a sentence the owner can act on.
 *
 * NAMES THE REASON rather than saying "approval required": "outside the
 * workspace" and "a program it has not run before" are different risks, and an
 * owner who cannot tell them apart will either approve everything or nothing.
 */
export function shellApprovalReasonCopy(reason: string): string {
  if (reason === "external_cwd") {
    return "This runs outside the Agent's workspace.";
  }
  if (reason === "external_path") {
    return "This touches a file outside the Agent's workspace.";
  }
  if (reason === "new_executable") {
    return "The Agent has not run this program in this conversation before.";
  }
  return "This command needs your approval.";
}

/** The three reasons `shellApprovalReason` can give. Pinned against the sidecar. */
export const SHELL_APPROVAL_REASONS = [
  "external_cwd",
  "external_path",
  "new_executable",
] as const;

/** The command as one copyable line, so the owner approves what they read. */
export function shellCommandLine(pending: ChatPendingShell): string {
  return [pending.command, ...(pending.args ?? [])].join(" ");
}

// ---------------------------------------------------------------------------
// `/skill`
// ---------------------------------------------------------------------------

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  scope: string;
  enabled: boolean;
}

export type SkillCommand =
  | { kind: "none" }
  /** `/skill` with nothing after it — clear the selection. */
  | { kind: "clear" }
  /** `/skill fo` — complete against enabled names. */
  | { kind: "query"; term: string };

/**
 * Read the composer as a `/skill` command.
 *
 * ONLY AT THE START of the composer, and only as the whole first word: a message
 * that happens to mention `/skill` mid-sentence is a message, not a command. The
 * bare form clears rather than erroring, because "run without a Skill" needs a
 * way to be said and re-picking is the only alternative.
 */
export function parseSkillCommand(text: string): SkillCommand {
  if (typeof text !== "string") return { kind: "none" };
  const match = /^\/skill(?:\s+([\s\S]*))?$/.exec(text.trimStart());
  if (!match) return { kind: "none" };
  const term = (match[1] ?? "").trim();
  return term ? { kind: "query", term } : { kind: "clear" };
}

/**
 * Which Skills complete for this term.
 *
 * ENABLED ONLY, and that is the acceptance criterion rather than a nicety: a
 * disabled Skill offered in completion would be selectable, stored on the
 * Conversation, and then refused by `readSkill` on every turn — a switch that
 * appears to do nothing until the Agent behaves as if the Skill were missing.
 */
export function matchSkills(
  skills: readonly SkillSummary[],
  term: string,
): SkillSummary[] {
  const needle = term.trim().toLowerCase();
  return skills
    .filter((skill) => skill.enabled)
    .filter(
      (skill) =>
        needle === "" ||
        skill.name.toLowerCase().includes(needle) ||
        skill.id.toLowerCase().includes(needle),
    );
}

/** The selected Skill, or `null` when it was disabled or deleted since. */
export function selectedSkillSummary(
  skills: readonly SkillSummary[],
  selectedSkill: string | undefined,
): SkillSummary | null {
  if (!selectedSkill) return null;
  const found = skills.find((skill) => skill.id === selectedSkill);
  return found && found.enabled ? found : null;
}

/**
 * What to say when the Conversation names a Skill that is no longer usable.
 *
 * NAMED, not silent. A conversation carrying a stale id would otherwise keep
 * running as if it had a Skill while the Agent read nothing — the owner would be
 * comparing answers against instructions that were never loaded.
 */
export function staleSkillCopy(selectedSkill: string): string {
  return `Skill ${selectedSkill} is disabled or missing, so this conversation is running without it.`;
}

export const SKILL_CLEARED_COPY = "Running without a Skill.";

/**
 * Where the Skills list comes from: the sidecar's scan, not a stored inventory.
 *
 * BOTH SURFACES CALL THE SAME URL — Chat's `/skill` picker and the Skills rail —
 * because "scanned without reinstall" has to mean the same thing in both places.
 * A second reader with its own caching would let the rail show a pack the picker
 * refuses.
 */
export const SKILL_SCAN_URL = `${SIDECAR_ORIGIN}/api/v1/skills`;

/** `project` and `user`, as the two roots are named to an owner. */
export function skillScopeLabel(scope: string): string {
  if (scope === "project") return "Project";
  if (scope === "user") return "User";
  return scope;
}

/**
 * Where a pack has to live to be found, named so an empty list is actionable.
 *
 * The two roots are `skillRoots()` in `sidecar/skills.mjs`. Naming them is the
 * difference between "no Skills" and "no Skills, and here is where one goes" —
 * there is no install step to discover, so the paths are the whole instruction.
 */
export const SKILLS_SCAN_HINT_COPY =
  "Skills are scanned from skills/ in this project and ~/.workwiki/skills.";

/**
 * The scan could not be read at all.
 *
 * SEPARATE FROM "no Skills", because the two call for opposite actions: an empty
 * scan means write a `SKILL.md`, and this one means start the sidecar or switch
 * the API on. One sentence for both would send half the owners to the wrong fix.
 */
export const SKILLS_SCAN_FAILED_COPY =
  `Skills are scanned by the local sidecar, and it did not answer. Start it with \`pnpm sidecar\`, and check ${API_MCP_POINTER}.`;

/** The toggle's label, which names what the click will do. */
export function skillToggleLabel(skill: SkillSummary): string {
  return `${skill.enabled ? "Disable" : "Enable"} ${skill.name}`;
}

/**
 * What a disabled pack is, said once.
 *
 * DISABLED IS EVERYWHERE, not just here: hidden from `/skill`, from injection
 * and from the Agent's Skill reads (`readSkill` refuses by id). Saying so on the
 * row is what stops the switch reading as a display filter.
 */
export const SKILL_DISABLED_NOTE_COPY =
  "Disabled: hidden from /skill and never read by the Agent.";

export function skillSelectedCopy(name: string): string {
  return `Running as ${name}.`;
}

// ---------------------------------------------------------------------------
// Composer tools
// ---------------------------------------------------------------------------

/**
 * The five controls the composer offers (Story 8.5).
 *
 * A TABLE rather than five hand-written buttons, so the acceptance criterion
 * ("Attach · Web search · AnyTXT · Skills · Smart retrieval are available") is
 * one executable list. Four of them are HINTS: pressing them writes an
 * instruction into the composer, because the Agent picks its own tools and a
 * button that forced a tool call would be the "me picking the tool" the story
 * exists to remove. Attach and Smart retrieval are real controls.
 */
export const COMPOSER_TOOLS = [
  {
    id: "attach",
    label: "Attach",
    kind: "control",
    hint: "",
    title: "Attach a file to this conversation",
  },
  {
    id: "web",
    label: "Web search",
    kind: "hint",
    hint: "Search the web for this if the wiki does not cover it: ",
    title: "Ask the Agent to search the web this turn",
  },
  {
    id: "anytxt",
    label: "AnyTXT",
    kind: "hint",
    hint: "Search my Sources full-text for: ",
    title: "Ask the Agent to search raw/sources/ full-text",
  },
  {
    id: "skills",
    label: "Skills",
    kind: "control",
    hint: "/skill ",
    title: "Pick a Skill for this conversation",
  },
  {
    id: "retrieval",
    label: "Smart retrieval",
    kind: "control",
    hint: "",
    title: "Wiki or Sources-only evidence",
  },
] as const;

export type ComposerToolId = (typeof COMPOSER_TOOLS)[number]["id"];

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * Where the Preview reads an `agent-workspace/` file.
 *
 * THE SIDECAR, not the kernel: the file is on the owner's local disk and the
 * Worker has never seen it. `path` is workspace-relative — see `ChatOutput.path`
 * — so the query string is exactly what the sidecar's read takes.
 */
export function workspaceFileUrl(path: string): string {
  return `${SIDECAR_ORIGIN}/api/v1/workspace/file?${new URLSearchParams({ path })}`;
}

/** `report.md · 4 kB`. Bytes, because the read route refuses at a byte cap. */
export function outputChipLabel(output: { name: string; bytes: number }): string {
  const kb = output.bytes / 1024;
  const size =
    output.bytes < 1024
      ? `${output.bytes} B`
      : kb < 1024
        ? `${Math.round(kb)} kB`
        : `${(kb / 1024).toFixed(1)} MB`;
  return `${output.name} · ${size}`;
}

// ---------------------------------------------------------------------------
// Copy the Chat surface needs and nowhere else has
// ---------------------------------------------------------------------------

/**
 * The local API is switched off, so the Agent cannot be reached.
 *
 * NAMES THE SWITCH. The sidecar answers 503 `disabled` for every data route
 * while the API is off, and Chat is a data route — so the owner who has not
 * enabled it needs to be told where the switch is, not that Chat failed.
 */
export const CHAT_API_DISABLED_COPY =
  `The local API is off. Turn it on in ${API_MCP_POINTER} to use Chat.`;

/** The door refused the browser's token. Same place, different fix. */
export const CHAT_API_UNAUTHORIZED_COPY =
  `The local API refused this token. Generate one in ${API_MCP_POINTER}.`;

/** Turn the door's one-word refusal into the sentence that names the fix. */
export function chatDoorRefusalCopy(error: string | undefined): string | null {
  if (error === "disabled") return CHAT_API_DISABLED_COPY;
  if (error === "unauthorized") return CHAT_API_UNAUTHORIZED_COPY;
  return null;
}

/**
 * The scan was ANSWERED, and the answer was no.
 *
 * A 503 `disabled` and a 401 `unauthorized` mean the sidecar is up and refused
 * the read — the two doors `authorizeLoopback` closes. {@link SKILLS_SCAN_FAILED_COPY}
 * told that owner to start a process that was already running; the fix is the
 * switch or the token in Settings, exactly as {@link chatDoorRefusalCopy} says
 * for Chat. Anything else non-ok (a proxy page, an unreadable body) still gets
 * the did-not-answer sentence, because nothing readable did.
 */
export const SKILLS_SCAN_DISABLED_COPY =
  `Skills are scanned by the local sidecar, and its API is off. Turn it on in ${API_MCP_POINTER}.`;

export const SKILLS_SCAN_UNAUTHORIZED_COPY =
  `Skills are scanned by the local sidecar, and it refused this page’s token. Generate one in ${API_MCP_POINTER}.`;

/** Turn the door's one-word refusal into the Skills sentence that names the fix. */
export function skillsScanRefusalCopy(error: string | undefined): string {
  if (error === "disabled") return SKILLS_SCAN_DISABLED_COPY;
  if (error === "unauthorized") return SKILLS_SCAN_UNAUTHORIZED_COPY;
  return SKILLS_SCAN_FAILED_COPY;
}
