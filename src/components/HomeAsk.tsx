"use client";

import { useRouter } from "next/navigation";
import { useUser, useClerk, SignInButton } from "@clerk/nextjs";
import { useStreamingQuery } from "@/hooks/useStreamingQuery";
import { Icon } from "./folio/icons";

const DEFAULT_EXAMPLES = [
  "What is harness engineering?",
  "How is work-wiki different from RAG?",
  "What are the agentic harness patterns?",
];

interface HomeAskProps {
  examples?: readonly string[];
  placeholder?: string;
  helperText?: string;
}

/**
 * The homepage hero / launcher. Submitting (or clicking a sample) navigates to
 * /query?q=… which auto-runs the answer there.
 *
 * The signed-out "taste" demo is gone with the commons: `/api/query/demo` was
 * the app's only unauthenticated route and now 404s, and middleware redirects
 * an anonymous visitor to /sign-in before this component ever renders. A
 * signed-out render is therefore only a transient pre-hydration state, and it
 * offers sign-in rather than a preview answer.
 */
export function HomeAsk({
  examples = DEFAULT_EXAMPLES,
  placeholder = "Ask your wiki — get an answer cited to the pages it stands on…",
  helperText = "Answers query the wiki live and cite their sources. ⌘↵ to ask.",
}: HomeAskProps = {}) {
  const router = useRouter();
  const { isSignedIn } = useUser();
  const { openSignIn } = useClerk();
  // Only the question input is used here; asks run on /query, not inline.
  const { question, setQuestion } = useStreamingQuery();

  /** Hand the question off to /query, which reads ?q= and auto-runs it. */
  function goToQuery(q: string) {
    const trimmed = q.trim();
    if (trimmed) router.push(`/query?q=${encodeURIComponent(trimmed)}`);
  }

  function onChip(q: string) {
    if (isSignedIn) {
      goToQuery(q);
      return;
    }
    openSignIn();
  }

  return (
    <div>
      <form
        onSubmit={
          isSignedIn
            ? (e) => {
                e.preventDefault();
                goToQuery(question);
              }
            : (e) => {
                e.preventDefault();
                openSignIn();
              }
        }
      >
        <div
          style={{
            border: "1px solid var(--rule-strong)",
            borderRadius: 18,
            background: "var(--paper-2)",
            boxShadow: "var(--shadow)",
            overflow: "hidden",
          }}
        >
          <div
            className="row"
            style={{ gap: 14, padding: "20px 22px 6px", alignItems: "flex-start" }}
          >
            <span style={{ color: "var(--accent)", paddingTop: 3 }}>
              <Icon.spark width="22" height="22" />
            </span>
            <textarea
              value={isSignedIn ? question : ""}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={placeholder}
              rows={2}
              disabled={!isSignedIn}
              aria-label="Ask your wiki a question"
              style={{
                flex: 1,
                border: 0,
                outline: 0,
                resize: "none",
                background: "transparent",
                fontFamily: "var(--font-read)",
                fontSize: 20,
                lineHeight: 1.4,
                color: "var(--ink)",
                paddingTop: 2,
              }}
              className="placeholder:text-faint disabled:opacity-70"
            />
          </div>
          <div
            className="spread"
            style={{
              padding: "12px 16px 14px 22px",
              borderTop: "1px solid var(--rule)",
              gap: 12,
              flexWrap: "wrap",
              justifyContent: examples.length === 0 ? "flex-end" : undefined,
            }}
          >
            {examples.length > 0 ? (
              <div
                className="row"
                style={{ gap: 8, flexWrap: "wrap", flex: "1 1 320px", minWidth: 0 }}
              >
                {examples.map((q) => (
                  <button
                    type="button"
                    key={q}
                    onClick={() => onChip(q)}
                    className="receipt folio-chip"
                    style={{
                      fontSize: 11.5,
                      color: "var(--muted)",
                      background: "transparent",
                      whiteSpace: "nowrap",
                      border: "1px solid var(--rule)",
                      borderRadius: 999,
                      padding: "5px 11px",
                    }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            ) : null}
            {isSignedIn ? (
              <button
                type="submit"
                disabled={!question.trim()}
                className="btn primary shrink-0 disabled:opacity-50"
              >
                Ask <Icon.arrow width="16" height="16" />
              </button>
            ) : (
              <SignInButton mode="modal">
                <button className="btn primary shrink-0">
                  Ask <Icon.arrow width="16" height="16" />
                </button>
              </SignInButton>
            )}
          </div>
        </div>
        <p
          className="receipt"
          style={{ fontSize: 11.5, color: "var(--faint)", margin: "10px 2px 0" }}
        >
          {helperText}
        </p>
      </form>
    </div>
  );
}
