/**
 * Chat HTTP and SSE transport.
 *
 * Event names stay exactly `meta`, `agent`, `done`, `cancelled`, `error`.
 * The turn session is created only after every synchronous refusal, so an
 * unresolved `/current` tool turn or a forged resume never owns a socket
 * listener. Chat JSON is capped at the same 1 MiB as the rest of `/api/v1`.
 *
 * Imports nothing from `src/lib` (AD-6).
 */

import { randomBytes } from "node:crypto";

import {
  V1_MAX_BODY_BYTES,
  canonicalLoopbackWikiId,
  resolveLoopbackWikiId,
} from "./loopback.mjs";
import { createAgentWorkspace } from "./workspace.mjs";
import {
  resumeAgentTurn,
  runAgentTurn,
  toolsForTurn,
  withSelectedSkill,
} from "./agent.mjs";
import { publicPending } from "./capabilities.mjs";
import { generateChat } from "./chat-provider.mjs";

const COVERAGE_COPY =
  "Wiki has no coverage for this. Ingest a source or run Deep Research.";
const CITATION_MARKER_RE = /\[([1-9]\d*)\]/g;

function clientConversationId(body) {
  return typeof body?.conversationId === "string" && body.conversationId.trim()
    ? body.conversationId.trim()
    : "";
}

export function formatSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function sanitizeCitedAnswer(
  content,
  citations,
  coverageCopy = COVERAGE_COPY,
  extras = {},
) {
  const byN = new Map();
  for (const row of Array.isArray(citations) ? citations : []) {
    if (
      !row ||
      typeof row !== "object" ||
      !Number.isInteger(row.n) ||
      row.n < 1 ||
      typeof row.path !== "string" ||
      !row.path.trim()
    ) {
      continue;
    }
    if (!byN.has(row.n)) byN.set(row.n, row);
  }
  const used = new Set();
  const invented = new Set();
  const text = typeof content === "string" ? content : "";
  for (const match of text.matchAll(CITATION_MARKER_RE)) {
    const n = Number(match[1]);
    if (byN.has(n)) used.add(n);
    else invented.add(n);
  }
  let next = text;
  for (const n of invented) next = next.replaceAll(`[${n}]`, "");
  next = next.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (used.size === 0) {
    const rows = [...byN.values()];
    const typed = rows.some(
      (row) =>
        row.type === "source" ||
        row.type === "web" ||
        row.type === "graph" ||
        row.type === "workspace",
    );
    if (extras.allowUncited === true || typed) {
      return { content: next, citations: rows, coverage: rows.length > 0 };
    }
    return { content: coverageCopy, citations: [], coverage: false };
  }
  return {
    content: next,
    citations: [...used]
      .sort((a, b) => a - b)
      .map((n) => byN.get(n)),
    coverage: true,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createChatTurnSession(req, res, stream) {
  const controller = new AbortController();
  let settled = false;
  let closeListener = null;

  const removeTurnListeners = () => {
    if (typeof req.off === "function") req.off("aborted", emitCancelled);
    if (closeListener && req.socket && typeof req.socket.off === "function") {
      req.socket.off("close", closeListener);
    }
    closeListener = null;
  };

  const emitCancelled = () => {
    if (settled) return;
    settled = true;
    removeTurnListeners();
    controller.abort();
    if (!stream || res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
    }
    try {
      res.write(formatSse("cancelled", {}));
    } catch {
      // Client already gone.
    }
    res.end();
  };

  const settle = () => {
    if (settled) return;
    settled = true;
    removeTurnListeners();
  };

  if (typeof req.on === "function") {
    // Do not listen to req "close": it fires after the body is read, which
    // would abort every turn. aborted / socket close mean the client left.
    req.on("aborted", emitCancelled);
  }
  if (req.socket && typeof req.socket.on === "function") {
    closeListener = () => {
      if (!settled) emitCancelled();
    };
    req.socket.on("close", closeListener);
  }

  return { signal: controller.signal, emitCancelled, settle };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > V1_MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function extractThinking(text) {
  const match = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (!match) return { thinking: "", content: text };
  return {
    thinking: match[1].trim(),
    content: text.replace(match[0], "").trim(),
  };
}

export function chatPath(url) {
  // The alias means `current`: on the loopback door there is exactly one
  // workspace, and a client that omitted the project meant this one.
  if (url.pathname === "/api/v1/chat") return "current";
  const match = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/chat$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    (error instanceof Error && /aborted|abort/i.test(error.message))
  );
}

function rejectChat(res, status, error) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function resumeCapabilityId(resume) {
  if (typeof resume?.capabilityId === "string" && resume.capabilityId) {
    return resume.capabilityId;
  }
  if (
    isPlainObject(resume?.pending) &&
    typeof resume.pending.capabilityId === "string" &&
    resume.pending.capabilityId
  ) {
    return resume.pending.capabilityId;
  }
  return null;
}

function parseHistory(value) {
  if (value === undefined) return { messages: [] };
  if (!Array.isArray(value)) return { error: "messages must be an array" };
  const messages = [];
  for (const item of value) {
    if (!isPlainObject(item)) return { error: "invalid history row" };
    if (item.role !== "user" && item.role !== "assistant") {
      return { error: "invalid history role" };
    }
    if (typeof item.content !== "string") {
      return { error: "invalid history content" };
    }
    messages.push({ role: item.role, content: item.content });
  }
  return { messages };
}

function parseCitations(value) {
  if (value === undefined) return { citations: [] };
  if (!Array.isArray(value)) return { error: "citations must be an array" };
  const citations = [];
  for (const item of value) {
    if (!isPlainObject(item)) return { error: "invalid citation" };
    if (
      !Number.isInteger(item.n) ||
      item.n < 1 ||
      typeof item.path !== "string" ||
      !item.path.trim() ||
      typeof item.title !== "string" ||
      typeof item.type !== "string"
    ) {
      return { error: "invalid citation" };
    }
    citations.push({
      n: item.n,
      path: item.path.trim(),
      title: item.title,
      type: item.type,
    });
  }
  return { citations };
}

/**
 * One tool-using turn, streamed.
 *
 * TOOL ROWS STREAM AS THEY HAPPEN and the `done` frame is still the COMPLETE
 * aggregate — both, not either. A client that joined late, or one that only
 * reads `done` (the non-streaming JSON caller is exactly that), must end up with
 * the same turn as one that watched every row. So `runAgentTurn`'s `emit` writes
 * rows to the wire while they run, and the payload assembled at the end carries
 * every row again.
 *
 * `pending` rides on `done` rather than on a new event name: a shell approval or
 * a Skill form is the turn's OUTCOME for now — the surface draws a modal and
 * sends the answer back — and inventing a sixth SSE event for it would break
 * every client filtering on the locked five.
 */
async function runToolTurn({
  res,
  body,
  wikiId,
  session,
  stream,
  system,
  messages,
  citations,
  options,
  resumePending,
}) {
  let opened = false;
  const open = () => {
    if (opened || !stream) return;
    opened = true;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(formatSse("meta", { wikiId, tools: true }));
  };
  const emit = (event, payload) => {
    if (!stream) return;
    open();
    res.write(formatSse(event, payload));
  };

  const workspace = options.workspace ?? createAgentWorkspace();
  const enablement = options.settings?.skillEnablement ?? {};
  // Mint when the body omits one so a ticket is never stored under "". Resume
  // uses the client-supplied id only — a second omitted body gets a new mint
  // and cannot take the first ticket.
  const conversationId =
    clientConversationId(body) || `anon:${randomBytes(16).toString("hex")}`;
  const context = {
    wikiId,
    workspace,
    // FROM THE SETTINGS POLL, never from the request body. A caller-supplied
    // enablement map would let any local process re-enable a Skill the owner
    // switched off in Settings, which would make the switch decorative.
    enablement,
    approvedExecutables: options.approvals.setFor(conversationId),
    kernel: (pathname, init) => kernelFetch(options.kernel, pathname, init),
  };
  const tools = toolsForTurn(body.allowWrites !== false);
  system = await withSelectedSkill(system, body.skill, enablement);
  const generate = ({ system: sys, messages: msgs }) =>
    generateChat({
      model: typeof body.model?.model === "string" ? body.model.model : undefined,
      system: sys,
      messages: msgs,
      signal: session.signal,
    });

  // A RESUME rather than a fresh turn when the owner answered an approval. The
  // pending record carries the transcript, so nothing gathered before the
  // question is re-fetched.
  const result = resumePending
    ? await resumeAgentTurn({
        pending: resumePending,
        // EXPLICIT TRUE ONLY. A resume that arrived without the flag — a client
        // bug, a truncated body — must read as Deny/Cancel, because the failure
        // mode of the other default is running a command nobody approved.
        approved: body.resume.approved === true,
        answers: isPlainObject(body.resume.answers) ? body.resume.answers : {},
        generate,
        emit,
        system,
        context,
        tools,
      })
    : await runAgentTurn({ generate, emit, messages, system, context, tools });

  if (session.signal.aborted) {
    session.emitCancelled();
    return;
  }
  session.settle();
  const split = extractThinking(result.content);
  // Cited against what the TOOLS found, falling back to what the caller
  // assembled. The invented-marker strip is the same one the Epic 3 path uses:
  // the loop makes the model better informed, not more trustworthy about `[7]`.
  const evidence = result.citations.length > 0 ? result.citations : citations;
  const sanitized = sanitizeCitedAnswer(split.content, evidence, COVERAGE_COPY, {
    allowUncited:
      result.outputs.length > 0 ||
      result.toolCalls.length > 0,
  });
  let pending = null;
  if (result.pending) {
    const capabilityId = options.capabilities.issue(
      result.pending.kind,
      result.pending,
      {
        conversationId,
        wikiId,
      },
    );
    pending = publicPending(result.pending, capabilityId);
  }
  const payload = {
    content: sanitized.content,
    thinking: split.thinking,
    citations: sanitized.citations,
    coverage: sanitized.coverage,
    toolCalls: result.toolCalls,
    outputs: result.outputs,
    conversationId,
    ...(pending ? { pending } : {}),
  };
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
    return;
  }
  open();
  if (payload.thinking) {
    res.write(formatSse("agent", { thinking: payload.thinking, delta: "" }));
  }
  if (payload.content) {
    res.write(formatSse("agent", { delta: payload.content }));
  }
  res.write(formatSse("done", payload));
  res.end();
}

/** One kernel read for a tool, as parsed JSON or `null`. */
async function kernelFetch(kernel, pathname, init = {}) {
  if (!kernel?.base || !kernel?.token) return null;
  try {
    const response = await fetch(`${kernel.base}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${kernel.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function handleChat(req, res, wikiId, options = {}) {
  const resolvedWikiId = resolveLoopbackWikiId(wikiId, options.wikiRegistry);
  if (!resolvedWikiId) {
    rejectChat(res, 400, "invalid_wiki_id");
    return;
  }
  const canonicalWikiId = canonicalLoopbackWikiId(
    resolvedWikiId,
    options.wikiRegistry,
  );
  const currentIdentityUnavailable =
    resolvedWikiId === "current" && canonicalWikiId === null;
  // Non-tool Chat retains the kernel's existing `/current` behavior. A tool
  // turn can mint a resumable capability, so it must bind to an immutable UUID
  // and is refused below when the registry poller cannot supply one.
  wikiId = canonicalWikiId ?? resolvedWikiId;
  let body;
  try {
    body = await readBody(req);
  } catch {
    rejectChat(res, 400, "invalid JSON");
    return;
  }
  if (!isPlainObject(body)) {
    rejectChat(res, 400, "invalid JSON");
    return;
  }
  const historyParsed = parseHistory(body.messages);
  if (historyParsed.error) {
    rejectChat(res, 400, historyParsed.error);
    return;
  }
  const citationParsed = parseCitations(body.citations);
  if (citationParsed.error) {
    rejectChat(res, 400, citationParsed.error);
    return;
  }
  const context = typeof body.context === "string" ? body.context : "";
  const query =
    typeof body.query === "string" ? body.query.trim() : "";
  if (!query && context.trim() && body.coverage !== false) {
    rejectChat(res, 400, "query is required");
    return;
  }
  const stream =
    body.stream === true ||
    String(req.headers.accept || "").includes("text/event-stream");
  const toolsEnabled = body.tools === true || isPlainObject(body.resume);
  if (toolsEnabled && currentIdentityUnavailable) {
    rejectChat(res, 503, "current_wiki_unavailable");
    return;
  }
  let resumePending = null;
  if (isPlainObject(body.resume)) {
    const capabilityId = resumeCapabilityId(body.resume);
    const taken = options.capabilities?.take(capabilityId, {
      conversationId: clientConversationId(body),
      wikiId,
    });
    if (
      !taken ||
      (taken.kind !== "shell_approval" && taken.kind !== "skill_form")
    ) {
      rejectChat(res, 400, "invalid_resume");
      return;
    }
    resumePending = taken.payload;
  }
  // Attach abort/socket listeners only after every synchronous refusal. An
  // unresolved mutable-current door and an invalid resume never own a turn and
  // must not leave a close listener behind on a keep-alive socket.
  const session = (options.sessionFactory ?? createChatTurnSession)(
    req,
    res,
    stream,
  );
  const citations = citationParsed.citations;
  const history = historyParsed.messages;
  const system = [
    typeof body.system === "string" ? body.system : "",
    context ? `NUMBERED CONTEXT\n${context}` : "",
    typeof body.indexSlice === "string" && body.indexSlice
      ? `INDEX\n${body.indexSlice}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const done = async (payload) => {
    session.settle();
    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(formatSse("meta", { wikiId }));
    if (payload.thinking) {
      res.write(formatSse("agent", { thinking: payload.thinking, delta: "" }));
    }
    if (payload.content) {
      res.write(formatSse("agent", { delta: payload.content }));
    }
    res.write(formatSse("done", payload));
    res.end();
  };

  /**
   * Is this a TOOL-USING turn? (Story 8.5)
   *
   * OPT-IN from the request, and that is not timidity — it is what keeps the
   * Epic 3 contract intact. The retrieve-then-chat turn the Workbench has been
   * sending since Epic 3 hands over pre-assembled numbered context and expects
   * exactly one provider call; a loop that started searching on its own behalf
   * inside that shape would spend the owner's budget re-finding what the
   * Workbench had already found and would break the `coverage: false` pin.
   */
  // NO CONTEXT AND NO TOOLS is honest coverage-missing: nothing was retrieved
  // and nothing may go looking, so there is no answer to give. With tools on,
  // an empty context is the NORMAL start of a turn — the Agent's first act is to
  // search, which is the whole "without me picking the tool" criterion.
  //
  // `coverage: false` from the caller is the ASSEMBLE step's verdict, and with
  // tools on it is an opening position rather than an answer: the assemble ran
  // one retrieval, the Agent is about to run several. Honouring it here would
  // make the tool loop unreachable for exactly the questions it was built for —
  // the ones the wiki does not obviously cover.
  if (!toolsEnabled && (body.coverage === false || !context.trim())) {
    await done({
      content: COVERAGE_COPY,
      thinking: "",
      citations: [],
      coverage: false,
    });
    return;
  }

  const userText =
    query ||
    history.filter((item) => item.role === "user").at(-1)?.content ||
    "";
  const messages = [...history];
  if (!messages.some((item) => item.role === "user" && item.content === userText) && userText) {
    messages.push({ role: "user", content: userText });
  }

  try {
    if (toolsEnabled) {
      await runToolTurn({
        res,
        body,
        wikiId,
        session,
        stream,
        system,
        messages,
        citations,
        options,
        resumePending,
      });
      return;
    }
    const raw = await generateChat({
      model: typeof body.model?.model === "string" ? body.model.model : undefined,
      system,
      messages,
      signal: session.signal,
    });
    if (session.signal.aborted) {
      session.emitCancelled();
      return;
    }
    const split = extractThinking(raw);
    const sanitized = sanitizeCitedAnswer(split.content, citations);
    await done({
      content: sanitized.content,
      thinking: split.thinking,
      citations: sanitized.citations,
      coverage: sanitized.coverage,
    });
  } catch (error) {
    if (session.signal.aborted || isAbortError(error)) {
      session.emitCancelled();
      return;
    }
    session.settle();
    const message = error instanceof Error ? error.message : "Chat failed.";
    if (!stream) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    });
    res.write(formatSse("error", { message }));
    res.end();
  }
}
