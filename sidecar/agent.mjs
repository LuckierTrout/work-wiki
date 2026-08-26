/**
 * The tool-using Chat Agent (Stories 8.5 / 8.7 / 8.8 / 8.9).
 *
 * WHY A LOOP AND NOT A TOOL PICKER IN THE UI: the acceptance criterion is that
 * the Agent "can call wiki search WITHOUT me picking the tool". So the model is
 * given a tool vocabulary and asked for one call at a time; the sidecar runs it,
 * feeds the result back, and asks again — bounded, because a loop with no bound
 * is a way to spend the owner's provider budget on a model that has decided to
 * search forever.
 *
 * NO SIXTH SSE EVENT. Tool-call rows, Skill forms and shell approvals all travel
 * as JSON inside `meta` / `agent` / `done`. The five event names are locked, and
 * a sixth would break every client that filters on the list — including the
 * Workbench's own `SIDECAR_SSE_EVENTS` filter.
 *
 * A TOOL CALL IS ANNOUNCED BEFORE IT RUNS and its outcome after, as two payloads
 * on the same row id. A row that appeared only on completion would leave a
 * fifteen-second search looking like a hung turn.
 *
 * PAUSES ARE FIRST-CLASS. A Skill form and a shell approval both suspend the
 * turn: the loop returns a `pending` result, the surface renders the modal, and
 * a later request resumes with the owner's answer. Cancel and Deny are TERMINAL
 * for that tool call — the pending tool does not run — which is the whole point
 * of asking.
 *
 * Imports nothing from `src/lib` (AD-6).
 */

import { readSkill, scanSkills } from "./skills.mjs";
import {
  effectiveShellCwd,
  executableKey,
  runShellCommand,
  shellApprovalReason,
  shellExternalSetGrew,
  shellExternalTargets,
  SHELL_DENIED_COPY,
  SHELL_PATH_CHANGED_COPY,
} from "./shell.mjs";

/** How many tool calls one turn may make before it must answer. */
export const MAX_TOOL_CALLS_PER_TURN = 6;

function focusGraph(body, focus) {
  if (!body || typeof body !== "object") return body;
  if (!focus) return body;
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  const slug = focus.replace(/^wiki\//, "").replace(/\.md$/, "");
  const around = nodes.filter((node) => {
    const id = String(node.id ?? node.slug ?? "");
    return id === focus || id === slug || `wiki/${id}.md` === focus;
  });
  if (around.length === 0) return { ...body, focus };
  const ids = new Set(around.map((node) => node.id ?? node.slug));
  const edges = (Array.isArray(body.edges) ? body.edges : []).filter(
    (edge) =>
      ids.has(edge.source) ||
      ids.has(edge.target) ||
      ids.has(edge.from) ||
      ids.has(edge.to),
  );
  return { nodes: around, edges, focus };
}

function mergeTurnCitations(citations, result) {
  const incoming = result.citations;
  const start = citations.length === 0 ? 1 : Math.max(...citations.map((row) => row.n)) + 1;
  const remapped = incoming.map((row, index) => ({
    n: start + index,
    path: String(row.path ?? "").trim(),
    title: typeof row.title === "string" ? row.title : String(row.path ?? ""),
    type: typeof row.type === "string" ? row.type : "page",
  }));
  if (typeof result.observation === "string") {
    for (let index = incoming.length - 1; index >= 0; index -= 1) {
      const from = Number.isInteger(incoming[index].n) ? incoming[index].n : index + 1;
      const to = remapped[index].n;
      if (from !== to) {
        result.observation = result.observation.replaceAll(`[${from}]`, `[${to}]`);
      }
    }
  }
  citations.push(...remapped.filter((row) => row.path));
}

/**
 * The shapes crossing this module's edges, spelled out for the typed suites.
 *
 * These are JSDoc rather than TypeScript because the sidecar is plain ESM by
 * design (AD-6) — but the tests that drive it are `.ts`, and without the
 * annotations `tsc` infers `never` for every destructured parameter and turns a
 * legitimate call into an error. The annotations describe the contract that was
 * already there; they do not add one.
 *
 * @typedef {{ role: string, content: string }} AgentMessage
 * @typedef {{ id: string, tool: string, detail: string }} AgentToolCall
 * @typedef {{ path: string, name: string, bytes: number }} AgentOutput
 * @typedef {{ n: number, path: string, title: string, type: string }} AgentCitation
 * @typedef {(event: string, payload: Record<string, unknown>) => void} AgentEmit
 * @typedef {{ name: string, label: string, kind: string, options?: string[], required?: boolean }} AgentFormField
 * @typedef {Record<string, string | string[]>} AgentFormAnswers
 * @typedef {(input: { system: string, messages: AgentMessage[] }) => Promise<string>} AgentGenerate
 * @typedef {{
 *   kernel: (path: string, init?: Record<string, unknown>) => Promise<unknown>,
 *   wikiId?: string,
 *   workspace?: import("./workspace.mjs").AgentWorkspace,
 *   approvedExecutables?: Set<string>,
 *   skillEnablement?: Record<string, boolean>,
 *   spawnImpl?: unknown,
 * }} AgentContext
 * @typedef {{
 *   kind: string,
 *   rowId: string,
 *   rowSeed: number,
 *   transcript: AgentMessage[],
 *   toolCalls: AgentToolCall[],
 *   outputs: AgentOutput[],
 *   title?: string,
 *   fields?: AgentFormField[],
 *   reason?: string,
 *   command?: string,
 *   args?: string[],
 *   cwd?: string,
 *   externalCwd?: boolean,
 *   externalPaths?: string[],
 * }} AgentPending
 * @typedef {{
 *   content: string,
 *   toolCalls: AgentToolCall[],
 *   outputs: AgentOutput[],
 *   citations: AgentCitation[],
 *   pending?: AgentPending,
 * }} AgentTurn
 */

/**
 * The tool vocabulary, as the model sees it.
 *
 * READ-HEAVY BY DESIGN. Six of the eight only look at things; the two that act
 * are `workspace_write` (which cannot leave `agent-workspace/`) and `shell`
 * (which is gated by the classifier). There is no page-write tool here at all:
 * wiki bytes go through the kernel write path so `dataVersion` bumps, and a tool
 * that wrote them from this side would be a second write path with no
 * invalidation.
 */
export const AGENT_TOOLS = [
  {
    name: "wiki_search",
    description: "Search the wiki's pages and sources. Returns numbered hits with paths.",
    input: { query: "string", topK: "number (optional)" },
  },
  {
    name: "wiki_read",
    description: "Read one wiki file by its display path, e.g. wiki/alpha.md.",
    input: { path: "string" },
  },
  {
    name: "source_search",
    description: "Full-text search across raw/sources/ (AnyTXT).",
    input: { query: "string" },
  },
  {
    name: "graph",
    description: "The wiki's link and signal graph around a page or the whole wiki.",
    input: { path: "string (optional)" },
  },
  {
    name: "web_search",
    description:
      "Search the web mid-turn for something the wiki does not cover. This is not Deep Research and writes nothing.",
    input: { query: "string" },
  },
  {
    name: "skill_read",
    description: "Read an enabled SKILL.md pack for instructions.",
    input: { id: "string" },
  },
  {
    name: "workspace_write",
    description:
      "Write a file under agent-workspace/. Use for drafts and outputs, never for wiki pages.",
    input: { path: "string", contents: "string" },
  },
  {
    name: "shell",
    description:
      "Run one command. Commands outside the workspace, or a program not used before, need the owner's approval.",
    input: { command: "string", args: "string[] (optional)", cwd: "string (optional)" },
  },
  // THE ONE TOOL THAT ASKS THE OWNER SOMETHING. A Skill that needs a choice
  // ("which client?", "which of these three sources?") would otherwise either
  // guess or interrogate the owner across several turns, and a guess in a Skill
  // that then writes files is the expensive kind of wrong.
  {
    name: "skill_form",
    description:
      "Ask the owner to fill in a short form before continuing. Use when a Skill declares inputs you do not have.",
    input: {
      title: "string",
      fields:
        '[{ name, label, kind: "single" | "multiple" | "text", options: string[] (single/multiple only) }]',
    },
  },
];

const WRITE_TOOL_NAMES = new Set(["workspace_write", "shell"]);

/** Stock MCP is read-only except rescan; Workbench Chat keeps write tools. */
export function toolsForTurn(allowWrites = true) {
  return allowWrites
    ? AGENT_TOOLS
    : AGENT_TOOLS.filter((tool) => !WRITE_TOOL_NAMES.has(tool.name));
}

export async function withSelectedSkill(system, skillId, enablement, roots) {
  if (typeof skillId !== "string" || !skillId) return system;
  const pack = await readSkill(skillId, {
    enablement: enablement ?? {},
    ...(roots ? { roots } : {}),
  });
  if (!pack) return system;
  return `${system}\n\nSELECTED SKILL (${pack.name})\n${pack.text}`;
}

/** Form field kinds. ONE renderer handles all three — see `normalizeFormFields`. */
export const FORM_FIELD_KINDS = ["single", "multiple", "text"];

/** Cancel / Esc. The pending tool did not run, and the turn says so. */
export const FORM_CANCELLED_COPY =
  "Cancelled the form, so I did not run that step. Tell me how you would like to proceed.";

/** Fields one form may declare. A Skill asking for more is asking wrong. */
export const MAX_FORM_FIELDS = 12;

/**
 * Coerce whatever the model declared into fields the surface can render.
 *
 * DEFENSIVE ON PURPOSE: these fields come from a model reading a `SKILL.md` an
 * owner installed, so both halves are untrusted input to the renderer. An
 * unknown `kind` becomes `text` rather than being dropped — a question the owner
 * can still answer in prose is better than a form with a missing row — and a
 * `single`/`multiple` with no options degrades to `text` for the same reason,
 * because a choice with nothing to choose from is unanswerable.
 */
export function normalizeFormFields(value) {
  if (!Array.isArray(value)) return [];
  const fields = [];
  for (const raw of value.slice(0, MAX_FORM_FIELDS)) {
    if (!raw || typeof raw !== "object") continue;
    const name = String(raw.name ?? raw.id ?? "").trim();
    if (!name) continue;
    const options = Array.isArray(raw.options)
      ? raw.options.map((option) => String(option)).filter(Boolean).slice(0, 24)
      : [];
    let kind = FORM_FIELD_KINDS.includes(raw.kind) ? raw.kind : "text";
    if ((kind === "single" || kind === "multiple") && options.length === 0) {
      kind = "text";
    }
    fields.push({
      name,
      label: String(raw.label ?? name),
      kind,
      ...(kind === "text" ? {} : { options }),
      ...(raw.required === true ? { required: true } : {}),
    });
  }
  return fields;
}

/** The owner's answers, as one observation the model can read. */
export function formAnswerObservation(fields, answers = {}) {
  const rows = fields.map((field) => {
    const value = answers[field.name];
    const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    return `${field.label}: ${text || "(no answer)"}`;
  });
  return `The owner answered the form:\n${rows.join("\n")}`;
}

/**
 * The system preamble that makes the loop legible to the model.
 *
 * IT NAMES THE HONEST-EMPTY RULE, because that is the one instruction the
 * product cannot enforce after the fact: `sanitizeCitedAnswer` can strip an
 * invented `[7]`, but nothing can un-write a confident paragraph about a page
 * that does not exist. Saying "if the search is empty, say so" is cheaper than
 * detecting the alternative.
 */
export function toolSystemPrompt(tools = AGENT_TOOLS) {
  return [
    "You can call tools. To call one, reply with ONLY a JSON object:",
    '{"tool":"<name>","input":{...}}',
    "To answer, reply with prose and no JSON object.",
    "",
    "Tools:",
    ...tools.map(
      (tool) => `- ${tool.name}: ${tool.description} input=${JSON.stringify(tool.input)}`,
    ),
    "",
    "Rules:",
    "- Search the wiki before answering questions about it.",
    "- Cite with [n] markers that match the numbered context you were given.",
    "- If a search returns nothing, say the wiki has no coverage. Never invent a page, a path or a citation.",
    "- Answer in English.",
  ].join("\n");
}

/**
 * Is this model reply a tool call?
 *
 * TOLERANT ABOUT WRAPPING, strict about shape. Models fence JSON in ```
 * blocks and prepend "Sure —" no matter what they are told, so the parse looks
 * for the object; but a reply whose `tool` is not a known name is treated as
 * PROSE rather than as an error, because the alternative is a turn that dies on
 * a model's stray brace instead of answering.
 */
export function parseToolCall(text, tools = AGENT_TOOLS) {
  if (typeof text !== "string") return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const name = parsed.tool ?? parsed.name;
  if (typeof name !== "string") return null;
  if (!tools.some((tool) => tool.name === name)) return null;
  return {
    tool: name,
    input: parsed.input && typeof parsed.input === "object" ? parsed.input : {},
  };
}

/**
 * One tool-call row, as it rides inside an `agent` payload.
 *
 * `id` is stable across the announce and the outcome so the surface updates the
 * row it already drew rather than appending a second one.
 */
export function toolRow(id, tool, state, detail = "") {
  return { id, tool, state, detail };
}

/**
 * Run one tool and describe the result for the model and for the row.
 *
 * `observation` is what goes back to the MODEL; `detail` is what the owner reads
 * on the row. They are deliberately different: the model needs the hits, the
 * owner needs "4 hits". Feeding the owner's summary to the model would make the
 * loop search twice.
 *
 * `pending` is a third answer, and it stops the loop rather than failing it — a
 * Skill form and a shell approval are questions, not errors.
 */
export async function runTool(call, context) {
  const { kernel, wikiId, workspace, enablement = {}, approvedExecutables } = context;
  switch (call.tool) {
    case "wiki_search": {
      const query = String(call.input.query ?? "").trim();
      if (!query) return { detail: "empty query", observation: "No query given." };
      const body = await kernel(`/api/v1/projects/${encodeURIComponent(wikiId)}/search`, {
        method: "POST",
        body: JSON.stringify({ query, topK: call.input.topK }),
      });
      const hits = Array.isArray(body?.results) ? body.results : [];
      return {
        detail: `${hits.length} hit${hits.length === 1 ? "" : "s"}`,
        observation:
          hits.length === 0
            ? "No hits. The wiki has no coverage for this."
            : hits
                .map(
                  (hit, index) =>
                    `[${index + 1}] ${hit.path} — ${hit.title}\n${hit.snippet ?? ""}`,
                )
                .join("\n\n"),
        citations: hits.map((hit, index) => ({
          n: index + 1,
          path: hit.path,
          title: hit.title ?? hit.path,
          type: "page",
        })),
      };
    }
    case "wiki_read": {
      const target = String(call.input.path ?? "").trim();
      if (!target) return { detail: "no path", observation: "No path given." };
      const body = await kernel(
        `/api/v1/projects/${encodeURIComponent(wikiId)}/files/content?path=${encodeURIComponent(target)}`,
      );
      if (typeof body?.content !== "string") {
        return { detail: `could not read ${target}`, observation: `Could not read ${target}.` };
      }
      return {
        detail: target,
        observation: body.content,
        citations: [{ n: 1, path: target, title: target, type: "page" }],
      };
    }
    case "source_search": {
      // ANYTXT IS `/api/sources/search`, the same full-text pass over
      // `raw/sources/` the product already uses — not a second index. Its rows
      // are `excerpt` + `citation` (they are source CHUNKS, with line spans),
      // which is why the mapping below is not the wiki-search one.
      const query = String(call.input.query ?? "").trim();
      if (!query) return { detail: "empty query", observation: "No query given." };
      const body = await kernel(
        `/api/sources/search?q=${encodeURIComponent(query)}`,
      );
      const hits = Array.isArray(body?.results) ? body.results.slice(0, 10) : [];
      return {
        detail: `${hits.length} source match${hits.length === 1 ? "" : "es"}`,
        observation:
          hits.length === 0
            ? "No source matches."
            : hits
                .map(
                  (hit, index) =>
                    `[${index + 1}] ${hit.citation ?? hit.pageSlug ?? hit.id} (lines ${hit.startLine}-${hit.endLine})\n${hit.excerpt ?? ""}`,
                )
                .join("\n\n"),
        citations: hits.map((hit, index) => ({
          n: index + 1,
          path: String(hit.citation ?? hit.pageSlug ?? hit.id ?? "raw/sources"),
          title: String(hit.citation ?? hit.pageSlug ?? hit.id ?? "Source"),
          type: "source",
        })),
      };
    }
    case "graph": {
      // The IN-APP graph tool may use the Epic 5 four-signal engine — that is
      // the point of it being in-app. The loopback `/graph` export is the
      // wikilink graph only, and conflating the two would either give an agent
      // on the outside signal data it cannot interpret or give the Agent here a
      // poorer graph than the Workbench already draws.
      const focus = String(call.input.path ?? "").trim();
      const body = await kernel("/api/graph/workbench");
      const focused = focusGraph(body, focus);
      const nodes = Array.isArray(focused?.nodes) ? focused.nodes.length : 0;
      const edges = Array.isArray(focused?.edges) ? focused.edges.length : 0;
      return {
        detail: `${nodes} nodes, ${edges} edges`,
        observation: JSON.stringify(focused ?? {}).slice(0, 20_000),
        citations: [
          {
            n: 1,
            path: focus || "graph",
            title: focus || "Wiki graph",
            type: "graph",
          },
        ],
      };
    }
    case "web_search": {
      // MID-TURN, and NOT unconfirmed Deep Research: it reads and writes
      // nothing, mints no Research record and skips no confirm. The Deep
      // Research panel stays the only thing that starts a run.
      const query = String(call.input.query ?? "").trim();
      if (!query) return { detail: "empty query", observation: "No query given." };
      const body = await kernel("/api/v1/web-search", {
        method: "POST",
        body: JSON.stringify({ query }),
      });
      const results = Array.isArray(body?.results) ? body.results : [];
      if (results.length === 0) {
        // THE REASON, not a shrug. An unconfigured provider and an empty web are
        // different facts, and the Agent's next move differs: one is worth
        // telling the owner about, the other is worth rephrasing.
        return {
          detail: body?.error ? String(body.error) : "no web results",
          observation:
            body?.error === "provider_unconfigured"
              ? "No web search provider is configured. Say so instead of guessing."
              : "No web results.",
        };
      }
      return {
        detail: `${results.length} web result${results.length === 1 ? "" : "s"}`,
        observation: results
          .map((row, index) => `[${index + 1}] ${row.title}\n${row.url}\n${row.snippet ?? ""}`)
          .join("\n\n")
          .slice(0, 20_000),
        citations: results.map((row, index) => ({
          n: index + 1,
          path: String(row.url ?? ""),
          title: String(row.title ?? row.url ?? "Web"),
          type: "web",
        })),
      };
    }
    case "skill_read": {
      // Only ENABLED Skills, and the check is inside `readSkill` rather than
      // here — see its note. A disabled Skill the Agent could still read would
      // make the switch cosmetic.
      const skill = await readSkill(String(call.input.id ?? ""), { enablement });
      if (!skill) {
        return { detail: "not available", observation: "That Skill is not enabled." };
      }
      return { detail: skill.name, observation: skill.text };
    }
    case "workspace_write": {
      const target = String(call.input.path ?? "").trim();
      const contents = String(call.input.contents ?? "");
      try {
        const output = await workspace.write(target, contents);
        return {
          detail: output.name,
          observation: `Wrote ${output.path}.`,
          output,
        };
      } catch (error) {
        return {
          detail: "refused",
          observation: `Could not write ${target}: ${error.message}.`,
        };
      }
    }
    case "shell": {
      const command = String(call.input.command ?? "");
      const args = Array.isArray(call.input.args) ? call.input.args.map(String) : [];
      const cwd = effectiveShellCwd(call.input.cwd, workspace);
      const reason = shellApprovalReason(
        { command, args, cwd },
        { workspace, approvedExecutables },
      );
      if (reason === "invalid") {
        return { detail: "invalid command", observation: "No command given." };
      }
      if (reason) {
        // A QUESTION, not a refusal. The turn suspends here and the surface
        // draws Approve / Deny for THIS command — there is no allow-all, and
        // Deny/Esc means the command never ran at all.
        const targets = shellExternalTargets(
          { command, args, cwd },
          { workspace },
        );
        return {
          pending: {
            kind: "shell_approval",
            reason,
            command,
            args,
            cwd,
            externalCwd: targets.externalCwd,
            externalPaths: targets.externalPaths,
          },
          detail: "waiting for approval",
          observation: "",
        };
      }
      const result = await runShellCommand({ command, args, cwd }, { workspace });
      return {
        detail: `exit ${result.code}`,
        observation:
          `exit ${result.code}\n` +
          (result.stdout ? `stdout:\n${result.stdout}\n` : "") +
          (result.stderr ? `stderr:\n${result.stderr}` : ""),
      };
    }
    case "skill_form": {
      const fields = normalizeFormFields(call.input.fields);
      if (fields.length === 0) {
        // A form with no answerable field would block the turn on a modal the
        // owner cannot fill in. Better to tell the model to ask in prose.
        return {
          detail: "no fields",
          observation: "That form had no usable fields. Ask in plain language instead.",
        };
      }
      return {
        pending: {
          kind: "skill_form",
          title: String(call.input.title ?? "").trim() || "Skill input",
          fields,
        },
        detail: `${fields.length} field${fields.length === 1 ? "" : "s"}`,
        observation: "",
      };
    }
    default:
      return { detail: "unknown tool", observation: "Unknown tool." };
  }
}

/**
 * Run one turn: call tools until the model answers, or the bound is reached.
 *
 * `generate` is INJECTED — the provider call lives in `server.mjs` and the suite
 * hands in a scripted one, which is what makes "a golden turn records a
 * wiki_search call" a test rather than a manual check.
 *
 * `emit` is called for every row and every delta, and it is the only way
 * anything reaches the wire. The loop does not know whether it is streaming.
 *
 * WHEN THE BOUND IS HIT the last observation is handed back with an instruction
 * to answer from it, rather than the turn erroring. A model that searched six
 * times has still gathered six searches' worth of evidence, and throwing that
 * away to show the owner a failure would be the worse of the two outcomes.
 *
 * @param {{
 *   generate: AgentGenerate,
 *   emit?: AgentEmit,
 *   messages: AgentMessage[],
 *   system: string,
 *   context: AgentContext,
 *   maxToolCalls?: number,
 *   tools?: typeof AGENT_TOOLS,
 *   priorToolCalls?: AgentToolCall[],
 *   priorOutputs?: AgentOutput[],
 *   rowSeed?: number,
 * }} input
 * @returns {Promise<AgentTurn>}
 */
export async function runAgentTurn({
  generate,
  emit = () => {},
  messages,
  system,
  context,
  maxToolCalls = MAX_TOOL_CALLS_PER_TURN,
  tools = AGENT_TOOLS,
  // A RESUMED turn hands back what the suspended half already gathered. Without
  // these, approving a shell command would drop the three searches that led the
  // Agent to ask for it — the rows would vanish from the transcript the owner is
  // reading, and the outputs would lose their chips.
  priorToolCalls = [],
  priorOutputs = [],
  rowSeed = 0,
}) {
  const transcript = [...messages];
  const toolCalls = [...priorToolCalls];
  const outputs = [...priorOutputs];
  const citations = [];
  let rowId = rowSeed;

  for (let step = 0; step <= maxToolCalls; step += 1) {
    const raw = await generate({
      system: `${system}\n\n${toolSystemPrompt(tools)}`,
      messages: transcript,
    });
    const call = step < maxToolCalls ? parseToolCall(raw, tools) : null;
    if (!call) {
      return { content: raw, toolCalls, outputs, citations };
    }
    rowId += 1;
    const id = `t${rowId}`;
    emit("agent", { toolRow: toolRow(id, call.tool, "running") });
    const result = await runTool(call, context);
    if (result.pending) {
      // The turn STOPS here and is resumable. Everything already gathered rides
      // out with it, so a Deny does not throw away the searches that preceded
      // the command.
      emit("agent", { toolRow: toolRow(id, call.tool, "pending", result.detail) });
      return {
        content: "",
        pending: {
          ...result.pending,
          rowId: id,
          rowSeed: rowId,
          transcript,
          toolCalls,
          outputs,
        },
        toolCalls,
        outputs,
        citations,
      };
    }
    emit("agent", { toolRow: toolRow(id, call.tool, "done", result.detail) });
    toolCalls.push({ id, tool: call.tool, detail: result.detail });
    if (result.output) outputs.push(result.output);
    if (Array.isArray(result.citations) && result.citations.length > 0) {
      mergeTurnCitations(citations, result);
    }
    transcript.push({ role: "assistant", content: JSON.stringify(call) });
    transcript.push({
      role: "user",
      content:
        step === maxToolCalls - 1
          ? `Tool ${call.tool} result:\n${result.observation}\n\nAnswer now from what you have.`
          : `Tool ${call.tool} result:\n${result.observation}`,
    });
  }
  return { content: "", toolCalls, outputs, citations };
}

/**
 * Resume a suspended turn with the owner's answer.
 *
 * DENY IS TERMINAL for the pending call and NOT for the conversation: the turn
 * finishes with the sentence saying the command did not run, and the transcript
 * keeps everything gathered before it. Losing the whole turn because the owner
 * declined one command would train them to approve.
 *
 * @param {{
 *   pending: AgentPending,
 *   approved: boolean,
 *   answers?: AgentFormAnswers,
 *   generate: AgentGenerate,
 *   emit?: AgentEmit,
 *   system: string,
 *   context: AgentContext,
 *   tools?: typeof AGENT_TOOLS,
 * }} input
 * @returns {Promise<AgentTurn>}
 */
export async function resumeAgentTurn({
  pending,
  approved,
  answers,
  generate,
  emit = () => {},
  system,
  context,
  tools = AGENT_TOOLS,
}) {
  if (!pending || typeof pending !== "object") {
    return {
      content: FORM_CANCELLED_COPY,
      toolCalls: [],
      outputs: [],
      citations: [],
    };
  }
  if (pending.kind === "skill_form") {
    // CANCEL IS TERMINAL FOR THE PENDING TOOL AND HARMLESS TO EVERYTHING ELSE:
    // the row is marked cancelled, the answer is one sentence, and the
    // Conversation — including every tool call and output already gathered —
    // persists exactly as it stood. Esc arrives here as `approved: false`.
    if (!approved) {
      emit("agent", {
        toolRow: toolRow(pending.rowId, "skill_form", "cancelled", "cancelled"),
      });
      return {
        content: FORM_CANCELLED_COPY,
        toolCalls: [
          ...(pending.toolCalls ?? []),
          { id: pending.rowId, tool: "skill_form", detail: "cancelled" },
        ],
        outputs: pending.outputs ?? [],
        citations: [],
      };
    }
    const fields = normalizeFormFields(pending.fields);
    emit("agent", {
      toolRow: toolRow(pending.rowId, "skill_form", "done", "submitted"),
    });
    return runAgentTurn({
      generate,
      emit,
      messages: [
        ...(pending.transcript ?? []),
        { role: "user", content: formAnswerObservation(fields, answers ?? {}) },
      ],
      system,
      context,
      tools,
      priorToolCalls: [
        ...(pending.toolCalls ?? []),
        { id: pending.rowId, tool: "skill_form", detail: "submitted" },
      ],
      priorOutputs: pending.outputs ?? [],
      rowSeed: pending.rowSeed ?? 0,
    });
  }
  if (!approved) {
    emit("agent", { toolRow: toolRow(pending.rowId, "shell", "denied", SHELL_DENIED_COPY) });
    return {
      content: SHELL_DENIED_COPY,
      toolCalls: [
        ...(pending.toolCalls ?? []),
        { id: pending.rowId, tool: "shell", detail: SHELL_DENIED_COPY },
      ],
      outputs: pending.outputs ?? [],
      citations: [],
    };
  }
  const cwd = effectiveShellCwd(pending.cwd, context.workspace);
  const reason = shellApprovalReason(
    { command: pending.command, args: pending.args ?? [], cwd },
    { workspace: context.workspace, approvedExecutables: context.approvedExecutables },
  );
  if (reason === "invalid") {
    return {
      content: "No command given.",
      toolCalls: pending.toolCalls ?? [],
      outputs: pending.outputs ?? [],
      citations: [],
    };
  }
  // A pause is not a blank cheque for every external target. Compare the
  // live set against what the modal showed. A new_executable resume whose
  // parent raced to a symlink, or an external_path resume whose SECOND
  // argument became external, must not spawn. Same stored set still runs.
  const live = shellExternalTargets(
    { command: pending.command, args: pending.args ?? [], cwd },
    { workspace: context.workspace },
  );
  const captured =
    Array.isArray(pending.externalPaths) ||
    typeof pending.externalCwd === "boolean";
  const grew = captured
    ? shellExternalSetGrew(
        {
          externalCwd: pending.externalCwd === true,
          externalPaths: Array.isArray(pending.externalPaths)
            ? pending.externalPaths
            : [],
        },
        live,
      )
    : (reason === "external_cwd" || reason === "external_path") &&
      pending.reason !== reason;
  if (grew) {
    emit("agent", {
      toolRow: toolRow(pending.rowId, "shell", "denied", SHELL_PATH_CHANGED_COPY),
    });
    return {
      content: SHELL_PATH_CHANGED_COPY,
      toolCalls: [
        ...(pending.toolCalls ?? []),
        { id: pending.rowId, tool: "shell", detail: SHELL_PATH_CHANGED_COPY },
      ],
      outputs: pending.outputs ?? [],
      citations: [],
    };
  }
  const result = await runShellCommand(
    { command: pending.command, args: pending.args, cwd },
    { workspace: context.workspace, spawnImpl: context.spawnImpl },
  );
  // Approval memory records a capability that actually started. ENOENT and a
  // synchronous spawn refusal did not exercise the executable, so the next
  // attempt must ask again rather than inheriting a permission that never ran.
  if (result.started) {
    context.approvedExecutables?.add(executableKey(pending.command));
  }
  emit("agent", {
    toolRow: toolRow(pending.rowId, "shell", "done", `exit ${result.code}`),
  });
  const transcript = [
    ...(pending.transcript ?? []),
    {
      role: "user",
      content: `Tool shell result:\nexit ${result.code}\n${result.stdout}\n${result.stderr}`,
    },
  ];
  return runAgentTurn({
    generate,
    emit,
    messages: transcript,
    system,
    context,
    tools,
    priorToolCalls: [
      ...(pending.toolCalls ?? []),
      { id: pending.rowId, tool: "shell", detail: `exit ${result.code}` },
    ],
    priorOutputs: pending.outputs ?? [],
    rowSeed: pending.rowSeed ?? 0,
  });
}

/** Every enabled Skill's name, for `/skill` completion. */
export async function enabledSkillNames(enablement = {}) {
  const skills = await scanSkills({ enablement });
  return skills.filter((skill) => skill.enabled).map((skill) => skill.name);
}
