"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useUser, useClerk } from "@clerk/nextjs";
import { hostOf } from "@/lib/share-target";
import {
  INTAKE_SIGN_IN_COPY,
  INTAKE_URL_REQUIRED_COPY,
  isIntakeUrl,
} from "@/lib/workbench-intake";
import { submitIntakeUrl } from "@/lib/workbench-intake-client";

type Status = "loading" | "signin" | "confirm" | "saving" | "saved" | "error";

/**
 * The capture target for all three surfaces (bookmarklet popup, PWA share, iOS
 * Shortcut). It runs on work-wiki's own origin, so the user's session cookie
 * authenticates the save. When signed in it shows a CONFIRM step — the captured
 * URL and an optional clip — and nothing is stored until the user clicks Save.
 * Signed-out → a sign-in prompt, then the confirm step once the session lands.
 *
 * Files through Workbench Intake (`submitIntakeUrl`). A clip without a URL is
 * refused on this action; empty or blocked arrivals invent no Source.
 */
export function SaveCapture({
  url,
  clip,
}: {
  url: string;
  clip?: string;
}) {
  const { isSignedIn, isLoaded } = useUser();
  const { openSignIn } = useClerk();
  const [status, setStatus] = useState<Status>("loading");
  const missingUrl = !isIntakeUrl(url);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [error, setError] = useState<string | null>(
    missingUrl ? INTAKE_URL_REQUIRED_COPY : null,
  );

  async function save() {
    if (status === "saving") return; // guard against double-submit / Enter-mash
    if (missingUrl) {
      setError(INTAKE_URL_REQUIRED_COPY);
      setStatus("confirm");
      return;
    }
    setStatus("saving");
    setError(null);
    setUnconfirmed(false);
    try {
      const outcome = await submitIntakeUrl(url, clip);
      if (outcome.error === INTAKE_SIGN_IN_COPY) {
        setError("Your session expired — sign in to finish saving.");
        setStatus("signin");
        return;
      }
      if (outcome.unconfirmed) {
        // The attempt may already have landed. Do not offer Retry as if it
        // failed — that would store a second Source.
        setError(outcome.error);
        setUnconfirmed(true);
        setStatus("error");
        return;
      }
      if (outcome.error) {
        setError(outcome.error);
        setStatus("error");
        return;
      }
      setStatus("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setStatus("error");
    }
  }

  // Dismiss the capture view. A bookmarklet popup is script-opened so
  // window.close() works; the PWA-share / iOS-Shortcut surfaces open a normal
  // tab where close() is a no-op — fall back to navigating so the button isn't
  // dead.
  function dismiss(fallback: string) {
    window.close();
    setTimeout(() => {
      if (!window.closed) window.location.href = fallback;
    }, 120);
  }

  // Move to the confirm step once signed in (or the sign-in prompt if not) —
  // but never clobber an in-progress / finished save.
  useEffect(() => {
    if (!isLoaded) return;
    setStatus((s) => {
      if (s === "saving" || s === "saved" || s === "error") return s;
      return isSignedIn ? "confirm" : "signin";
    });
  }, [isLoaded, isSignedIn]);

  const host = hostOf(url);
  const clipText = (clip ?? "").trim();

  return (
    <div className="shell" style={{ maxWidth: 460, margin: "0 auto", padding: "8px 0" }}>
      <h1 className="display" style={{ fontSize: 22, margin: "0 0 4px" }}>
        Save to work-wiki
      </h1>
      <p
        className="receipt"
        style={{
          fontSize: 12.5,
          color: "var(--muted)",
          margin: "0 0 18px",
          wordBreak: "break-all",
        }}
        title={url || undefined}
      >
        {url || INTAKE_URL_REQUIRED_COPY}
      </p>

      {status === "loading" && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>Checking your session…</p>
      )}

      {status === "signin" && (
        <div>
          {error && (
            <p style={{ fontSize: 13, color: "var(--danger, #dc2626)", marginBottom: 10 }}>
              {error}
            </p>
          )}
          <p style={{ fontSize: 13.5, marginBottom: 12 }}>
            Sign in to save this page to work-wiki.
          </p>
          <button
            type="button"
            className="receipt"
            // Modal sign-in keeps us on this page; once the session lands,
            // isSignedIn flips and the effect advances to the confirm step.
            onClick={() => openSignIn()}
            style={btnPrimary}
          >
            Sign in
          </button>
        </div>
      )}

      {status === "confirm" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {error && (
            <p style={{ fontSize: 13.5, color: "var(--danger, #dc2626)", marginBottom: 12 }}>
              {error}
            </p>
          )}

          {clipText ? (
            <p
              className="receipt"
              style={{
                fontSize: 12.5,
                color: "var(--muted)",
                margin: "0 0 22px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {clipText}
            </p>
          ) : null}

          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="submit"
              className="receipt"
              style={btnPrimary}
              disabled={missingUrl}
            >
              Save
            </button>
            <button type="button" className="receipt" onClick={() => dismiss("/")} style={btnSecondary}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {status === "saving" && (
        <p style={{ fontSize: 13.5, color: "var(--muted)" }}>Saving {host || "this capture"}…</p>
      )}

      {status === "error" && (
        <div>
          <p style={{ fontSize: 13.5, color: "var(--danger, #dc2626)", marginBottom: 12 }}>
            {error}
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            {!unconfirmed && (
              <button type="button" className="receipt" onClick={() => save()} style={btnPrimary}>
                Retry
              </button>
            )}
            <button type="button" className="receipt" onClick={() => setStatus("confirm")} style={btnSecondary}>
              Edit
            </button>
          </div>
        </div>
      )}

      {status === "saved" && (
        <div>
          <p style={{ fontSize: 14, marginBottom: 16 }}>
            <span style={{ color: "var(--accent)" }}>✓ Saved.</span> work-wiki is reading{" "}
            <strong>{host || "this capture"}</strong> now — it’ll appear in your wiki shortly.
          </p>

          <div style={{ marginTop: 22, display: "flex", gap: 10 }}>
            {/* Post-save, the only action is to dismiss. (No in-popup "View
                activity" nav — re-mounting drops back to the confirm step, which
                is confusing right after a save; dismissing is the right action.) */}
            <button type="button" className="receipt" onClick={() => dismiss("/")} style={btnPrimary}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const btnPrimary: CSSProperties = {
  fontSize: 13,
  padding: "7px 16px",
  borderRadius: 8,
  border: "1px solid var(--rule)",
  background: "var(--accent-soft)",
  color: "var(--accent)",
  cursor: "pointer",
};

const btnSecondary: CSSProperties = {
  fontSize: 12.5,
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid var(--rule)",
  background: "transparent",
  color: "var(--muted)",
  cursor: "pointer",
};
