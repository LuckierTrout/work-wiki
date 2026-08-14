import { SignInButton } from "@clerk/nextjs";

/**
 * The signed-out state for every owner-only surface.
 *
 * In practice middleware redirects an anonymous request to `/sign-in` before a
 * page renders (`src/middleware.ts`), so this is a fail-closed backstop rather
 * than a landing page — which is exactly why it must not grow marketing copy or
 * a waitlist CTA again. It carries a real `<h1>` so an owner-only route never
 * renders a headingless document (WCAG 2.2 AA heading structure), and it lives
 * in one file so all nine surfaces stay identical.
 */
export function PrivateWorkspaceNotice({
  /** Page-specific label for the sign-in button, e.g. "Sign in to chat". */
  action,
  /** Accessible page heading, e.g. "Chat". */
  heading,
}: {
  action: string;
  heading: string;
}) {
  return (
    <main
      className="shell fade"
      style={{ paddingTop: 120, paddingBottom: 120, textAlign: "center" }}
    >
      <h1 className="display" style={{ fontSize: "clamp(28px,4vw,40px)", margin: "0 0 12px" }}>
        {heading}
      </h1>
      <p
        style={{
          color: "var(--ink-2)",
          fontSize: 18,
          maxWidth: "40ch",
          margin: "0 auto 28px",
        }}
      >
        This workspace is private. Sign in to continue.
      </p>
      <SignInButton mode="modal">
        <button className="btn primary">{action}</button>
      </SignInButton>
    </main>
  );
}
