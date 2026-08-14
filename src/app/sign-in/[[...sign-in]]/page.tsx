import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Owner sign in",
  robots: { index: false, follow: false, noarchive: true },
};

/** The only public application route; it renders authentication, not content. */
export default function SignInPage() {
  return (
    <section
      className="min-h-screen px-6 py-16"
      style={{
        display: "grid",
        placeItems: "center",
        background: "var(--paper)",
      }}
    >
      <div className="stack" style={{ gap: 22, alignItems: "center" }}>
        <div style={{ textAlign: "center" }}>
          <p className="fmark" style={{ marginBottom: 10 }}>
            private workspace
          </p>
          <h1 className="display" style={{ margin: 0, fontSize: 38 }}>
            Sign in to WorkWiki
          </h1>
          <p style={{ margin: "10px 0 0", color: "var(--muted)" }}>
            Owner access only.
          </p>
        </div>
        <SignIn />
      </div>
    </section>
  );
}
