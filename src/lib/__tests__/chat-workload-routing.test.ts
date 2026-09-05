/**
 * Chat's generation runs on the provider Chat's own setting names (DW-711).
 *
 * `chatProvider` / `chatModel` used to change what the UI REPORTED and never
 * which model a call USED. The visible consequence was two gates answering two
 * different questions on one send: `ChatCanvas` refuses on
 * `assembled.chatModel.configured` — the WORKLOAD answer, from
 * `getChatModelSettings` — while `chat.ts` refused on the PRIMARY answer, so a
 * store holding `chatProvider: "ollama"` and no `provider` passed the first and
 * was told "No LLM provider is configured." by the second.
 *
 * THE PIN IS THE ARGUMENT, not the client. `../llm` is module-mocked here, so
 * what this file can see is that `chat.ts` NAMES its workload at both doors —
 * the gate and the `callLLM` that gate guards. Which client that argument
 * actually builds is `settings-runtime-wiring.test.ts`'s question, against the
 * real config store and the mocked provider SDKs.
 *
 * THE DOOR IS `addChatTurn`, because `generateChatAnswer` is not exported. The
 * live Chat surface posts to the sidecar rather than calling it (see
 * `workbench-epic3.test.ts`), but `src/lib/config.ts` names `chat.ts` as Epic
 * 3's call site and the disagreement was real in its code, so the wiring is
 * pinned where a revert would otherwise be green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Mocked so nothing reaches a provider — the same shape `query-search.test.ts`
// and `ingest.test.ts` use.
vi.mock("../llm", () => ({
  hasLLMKey: vi.fn(async () => false),
  callLLM: vi.fn(async () => "An answer. [alpha](alpha.md)"),
}));

vi.mock("../embeddings", () => ({
  searchByVector: vi.fn(async () => []),
  upsertEmbedding: vi.fn(async () => {}),
  removeEmbedding: vi.fn(async () => {}),
  // Not exercised here; `config.ts` imports both from this module and the real
  // `config.ts` cannot evaluate against a stub that omits them.
  getEmbeddingResolution: vi.fn(() => null),
  hasEmbeddingSupport: vi.fn(() => false),
}));

import { callLLM, hasLLMKey } from "../llm";
import { addChatTurn, createChatConversation } from "../chat";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";
import { ensureDirectories, updateIndex, writeWikiPage } from "../wiki";
import type { Principal } from "../auth";

const mockedHasLLMKey = vi.mocked(hasLLMKey);
const mockedCallLLM = vi.mocked(callLLM);

const OWNER = "owner";
const PRINCIPAL: Principal = { id: "user_1", handle: OWNER } as Principal;

const ENV_KEYS = [
  "DATA_DIR",
  "WIKI_DIR",
  "RAW_DIR",
  "NEXT_PUBLIC_OWNER_HANDLE",
  // The Hermes branch is a DIFFERENT pair of doors in the same function. Both
  // are wired, but only one of them runs per send, so the environment that
  // chooses between them must not be whatever the developer exported.
  "HERMES_AGENT_URL",
  "HERMES_API_KEY",
];

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-workload-"));
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.DATA_DIR = tmpDir;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;

  _resetLocks();
  _resetStorage();

  /**
   * THE STORE THAT BROKE, as `chat.ts` sees it through the mock: a deployment
   * that named a provider ONLY through `chatProvider`, so the gate says yes to
   * `{workload: "chat"}` and no to every other question.
   *
   * The discrimination is what makes this suite non-vacuous. A gate that loses
   * its argument gets `false` and the send throws the refusal below instead of
   * answering — so dropping the argument fails the case on WHAT HAPPENED, not
   * only on how it was asked. It also keeps `selectPagesForQuery`'s own bare
   * gate (`src/lib/query-search.ts`, deliberately NOT a workload owner) off the
   * LLM rerank, so every `callLLM` recorded here came from `chat.ts`.
   */
  mockedHasLLMKey.mockImplementation(
    async (options) => options?.workload === "chat",
  );
  mockedCallLLM.mockClear();
  mockedCallLLM.mockResolvedValue("An answer. [alpha](alpha.md)");

  await ensureDirectories();
  await writeWikiPage(
    "alpha",
    "# Alpha\n\n## Summary\n\nAlpha is about workload routing in this wiki.\n",
  );
  await updateIndex([
    { slug: "alpha", title: "Alpha", summary: "Alpha is about workload routing" },
  ]);
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  mockedHasLLMKey.mockReset();
  mockedHasLLMKey.mockResolvedValue(false);
  mockedCallLLM.mockReset();
  _resetLocks();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("a chat send names its workload at the gate and at the call", () => {
  it("gates and generates on {workload: 'chat'}", async () => {
    const conversation = await createChatConversation(OWNER, {
      title: "Routing",
      retrievalMode: "wiki",
    });

    const { message } = await addChatTurn(
      OWNER,
      conversation.id,
      "What is alpha?",
      PRINCIPAL,
    );

    // It ANSWERED — which, with the gate above, it only does when `chat.ts`
    // asks the workload's question rather than the primary one.
    expect(message.content).toContain("An answer.");

    expect(mockedHasLLMKey).toHaveBeenCalledWith({ workload: "chat" });
    // EVERY generation call, not "some call": a gate and the call it guards
    // resolving to different providers is the defect this closes.
    expect(mockedCallLLM.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockedCallLLM.mock.calls) {
      expect(call[2]).toMatchObject({ workload: "chat" });
    }
  });

  it("still refuses with the unchanged sentence when the workload is unusable", async () => {
    // The refusal copy is frozen: a store whose chat workload cannot make a
    // call must fail with exactly the sentence it has always failed with, now
    // asked of the right route.
    mockedHasLLMKey.mockResolvedValue(false);
    const conversation = await createChatConversation(OWNER, {
      title: "Routing",
      retrievalMode: "wiki",
    });

    await expect(
      addChatTurn(OWNER, conversation.id, "What is alpha?", PRINCIPAL),
    ).rejects.toThrow("No LLM provider is configured.");
    expect(mockedHasLLMKey).toHaveBeenCalledWith({ workload: "chat" });
    expect(mockedCallLLM).not.toHaveBeenCalled();
  });

  it("names the same workload on the Hermes fallback pair", async () => {
    // The other branch of the same function, and the other refusal sentence.
    // `callHermes` fails against an unroutable host, so the send falls back to
    // the native LLM — which must ask and call the same workload the native
    // branch does.
    process.env.HERMES_AGENT_URL = "http://127.0.0.1:1/hermes";
    process.env.HERMES_API_KEY = "k";
    const conversation = await createChatConversation(OWNER, {
      title: "Routing",
      retrievalMode: "wiki",
    });

    const { message } = await addChatTurn(
      OWNER,
      conversation.id,
      "What is alpha?",
      PRINCIPAL,
    );

    expect(message.content).toContain("An answer.");
    expect(mockedHasLLMKey).toHaveBeenCalledWith({ workload: "chat" });
    // Pinned before the loop, which would otherwise pass vacuously on zero
    // calls — exactly what a fallback that stopped falling back would produce.
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    for (const call of mockedCallLLM.mock.calls) {
      expect(call[2]).toMatchObject({ workload: "chat" });
    }
  });
});
