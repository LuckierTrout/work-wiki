"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  CHAT_HISTORY_DEPTH_DEFAULT,
  CHAT_TOKEN_BUDGET_DEFAULT,
} from "@/lib/chat-contract";
import {
  conversationSettings,
  createConversation,
  deleteConversation,
  dropOptimisticMessages,
  listConversations,
  mergeConversationRow,
  patchConversation,
  persistConversationMessages,
  readConversation,
  renameConversation,
  type CanvasMessage,
  type ConversationRow,
  type PersistOptions,
} from "@/lib/chat-conversation-store";

/**
 * The conversation half of Chat: which conversations exist, which one is open,
 * what it holds, and what it is set to (DW-587).
 *
 * The doors and their rules are `@/lib/chat-conversation-store`; this hook is
 * the WHEN and the WHAT-IT-WRITES — the mount load, the in-flight guards, and
 * the state each answer lands in. It is deliberately thin: a hook can only be
 * tested by mounting, and the mounted Chat suites have to pass unedited, so
 * every decision worth asserting lives one file over in the `node` project.
 *
 * It owns NO composer, draft or per-turn state. `drafts` in particular stays a
 * ChatCanvas ref: it is composer text keyed by conversation, and putting the
 * composer's state behind the conversation's door is the coupling this split
 * exists to remove.
 *
 * The sibling-hook shape follows `useReviewBadge.ts`.
 */

/** What removing a conversation left the surface on. */
export interface RemoveConversationOutcome {
  /** The removal moved the surface, because the open conversation is the one that went. */
  switched: boolean;
  /** The conversation now open, or `null` when none is left. */
  fallbackId: string | null;
}

export interface UseChatConversationsOptions {
  readOnly: boolean;
  /** Where a load or a read failure is reported. */
  onError: (message: string) => void;
}

export interface ChatConversations {
  conversations: ConversationRow[];
  activeId: string | null;
  messages: CanvasMessage[];
  retrievalMode: "wiki" | "sources";
  tokenBudget: number;
  historyDepth: number;
  selectedSkill: string | undefined;
  setActiveId: Dispatch<SetStateAction<string | null>>;
  setMessages: Dispatch<SetStateAction<CanvasMessage[]>>;
  setRetrievalMode: Dispatch<SetStateAction<"wiki" | "sources">>;
  setTokenBudget: Dispatch<SetStateAction<number>>;
  setHistoryDepth: Dispatch<SetStateAction<number>>;
  setSelectedSkill: Dispatch<SetStateAction<string | undefined>>;
  loadConversation: (id: string) => Promise<void>;
  startConversation: () => Promise<ConversationRow | null>;
  removeConversation: (id: string) => Promise<RemoveConversationOutcome>;
  renameActive: (id: string, name: string) => Promise<void>;
  patchActive: (patch: Record<string, unknown>) => void;
  persistFrames: (
    id: string,
    frames: readonly CanvasMessage[],
    options?: PersistOptions,
  ) => Promise<void>;
  clearOptimistic: () => void;
}

export function useChatConversations({
  readOnly,
  onError,
}: UseChatConversationsOptions): ChatConversations {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CanvasMessage[]>([]);
  const [retrievalMode, setRetrievalMode] = useState<"wiki" | "sources">("wiki");
  const [tokenBudget, setTokenBudget] = useState(CHAT_TOKEN_BUDGET_DEFAULT);
  const [historyDepth, setHistoryDepth] = useState(CHAT_HISTORY_DEPTH_DEFAULT);
  const [selectedSkill, setSelectedSkill] = useState<string | undefined>(undefined);
  // LAST WRITER WINS on both legs: a second load or a second persist started
  // while the first was in flight must be the one whose answer is rendered, or
  // switching conversations quickly leaves the surface showing the slower one.
  const loadSeq = useRef(0);
  const persistSeq = useRef(0);
  // SERIALIZED, not concurrent: two setting patches racing would let the loser's
  // answer be merged last and put the toolbar back to the value the owner just
  // left. The rejection is swallowed so one failed patch cannot break the next.
  const patchChain = useRef(Promise.resolve());
  // Held in a ref so the mount effect below does not re-run — and re-load — every
  // time the surface re-renders with a fresh error handler.
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const loadList = useCallback(async () => {
    const rows = await listConversations();
    setConversations(rows);
    return rows;
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const seq = ++loadSeq.current;
    const conversation = await readConversation(id);
    if (seq !== loadSeq.current) return;
    if (!conversation) {
      setMessages([]);
      errorRef.current("Conversation not found.");
      return;
    }
    const settings = conversationSettings(conversation);
    setMessages(conversation.messages ?? []);
    setRetrievalMode(settings.retrievalMode);
    setTokenBudget(settings.tokenBudget);
    setHistoryDepth(settings.historyDepth);
    setSelectedSkill(settings.selectedSkill);
    setConversations((current) => mergeConversationRow(current, id, conversation));
  }, []);

  useEffect(() => {
    void loadList()
      .then((rows) => {
        const wanted =
          typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("conversation")
            : null;
        const next = rows.find((row) => row.id === wanted) ?? rows[0];
        if (next) {
          setActiveId(next.id);
          return loadConversation(next.id);
        }
      })
      .catch((cause) => {
        errorRef.current(cause instanceof Error ? cause.message : "Chat failed.");
      });
  }, [loadList, loadConversation]);

  /**
   * Open a new conversation and make it the active one.
   *
   * The surface decides what else that means — the New Chat button also clears
   * the transcript and the draft, while a Send with nothing open only needs an
   * id to send against.
   */
  const startConversation = useCallback(async (): Promise<ConversationRow | null> => {
    if (readOnly) return null;
    // The three fields the door accepts, and no fourth: `selectedSkill` is not
    // among them, so it is not read here and not in the deps either.
    const conversation = await createConversation({
      retrievalMode,
      tokenBudget,
      historyDepth,
    });
    if (!conversation) return null;
    setConversations((current) => [conversation, ...current]);
    setActiveId(conversation.id);
    return conversation;
  }, [readOnly, retrievalMode, tokenBudget, historyDepth]);

  const removeConversation = useCallback(
    async (id: string): Promise<RemoveConversationOutcome> => {
      if (readOnly) return { switched: false, fallbackId: null };
      await deleteConversation(id);
      const next = conversations.filter((item) => item.id !== id);
      setConversations(next);
      if (activeId !== id) return { switched: false, fallbackId: null };
      const fallback = next[0];
      setActiveId(fallback?.id ?? null);
      setMessages([]);
      if (fallback) void loadConversation(fallback.id);
      return { switched: true, fallbackId: fallback?.id ?? null };
    },
    [readOnly, conversations, activeId, loadConversation],
  );

  const renameActive = useCallback(
    async (id: string, name: string) => {
      if (readOnly) return;
      const conversation = await renameConversation(id, name);
      if (!conversation) return;
      setConversations((current) => mergeConversationRow(current, id, conversation));
    },
    [readOnly],
  );

  const patchActive = useCallback(
    (patch: Record<string, unknown>) => {
      if (!activeId || readOnly) return;
      const id = activeId;
      patchChain.current = patchChain.current
        .then(async () => {
          const conversation = await patchConversation(id, patch);
          if (conversation) {
            setConversations((current) =>
              mergeConversationRow(current, id, conversation),
            );
          }
        })
        .catch(() => undefined);
    },
    [activeId, readOnly],
  );

  const persistFrames = useCallback(
    async (
      id: string,
      frames: readonly CanvasMessage[],
      options?: PersistOptions,
    ) => {
      const seq = ++persistSeq.current;
      const conversation = await persistConversationMessages(id, frames, options);
      if (seq !== persistSeq.current) return;
      setMessages(conversation.messages ?? []);
      setConversations((current) => mergeConversationRow(current, id, conversation));
    },
    [],
  );

  const clearOptimistic = useCallback(() => {
    setMessages((current) => dropOptimisticMessages(current));
  }, []);

  return {
    conversations,
    activeId,
    messages,
    retrievalMode,
    tokenBudget,
    historyDepth,
    selectedSkill,
    setActiveId,
    setMessages,
    setRetrievalMode,
    setTokenBudget,
    setHistoryDepth,
    setSelectedSkill,
    loadConversation,
    startConversation,
    removeConversation,
    renameActive,
    patchActive,
    persistFrames,
    clearOptimistic,
  };
}
