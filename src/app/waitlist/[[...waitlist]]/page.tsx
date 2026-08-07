import type { Metadata } from "next";
import { Waitlist } from "@clerk/nextjs";

export const metadata: Metadata = {
  // The layout title template appends " · yopedia".
  title: "Join the waitlist",
};

/**
 * `/waitlist` — the public landing for new visitors while yopedia is invite-only.
 *
 * Registration is gated in Clerk (waitlist sign-up mode, set in the Clerk
 * dashboard), so a brand-new visitor can't create an account directly: they
 * leave an email here, then get approved out-of-band in Clerk (the dashboard's
 * waitlist, which emails an invite to finish sign-up). Reading the commons stays
 * fully public — this only gates *joining*.
 *
 * The optional catch-all segment (`[[...waitlist]]`) lets Clerk's `<Waitlist />`
 * own any sub-routes of its flow without a 404 (per Clerk's Next.js setup).
 */
export default function WaitlistPage() {
  return (
    <div className="fade">
      <section
        className="shell paper-route"
        style={{ paddingTop: 72, paddingBottom: 96 }}
      >
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
          <div style={{ paddingTop: 18 }}>
            <p className="fmark">request access</p>
            <h1
              className="display"
              style={{ fontSize: "clamp(40px,5.2vw,68px)", margin: "18px 0 14px", maxWidth: "12ch" }}
            >
              Bring your working memory together.
            </h1>
            <p style={{ color: "var(--ink-2)", fontSize: 18, maxWidth: "50ch", margin: 0, lineHeight: 1.6 }}>
              Join the WorkWiki waitlist to turn scattered sources into cited, searchable, accountable knowledge.
            </p>
            <div className="grid gap-3 sm:grid-cols-3" style={{ marginTop: 34 }}>
              {["Private by default", "Owner controlled", "Portable sources"].map((label) => (
                <div key={label} style={{ borderTop: "1px solid var(--rule)", paddingTop: 12, color: "var(--muted)", fontSize: 13 }}>
                  {label}
                </div>
              ))}
            </div>
          </div>
          <aside style={{ border: "1px solid var(--rule)", borderRadius: 14, background: "var(--paper-2)", padding: "28px 24px" }}>
            <p className="fmark" style={{ marginBottom: 10 }}>join the waitlist</p>
            <h2 className="display" style={{ fontSize: 28, margin: "0 0 20px" }}>Tell us where to reach you</h2>
            <div className="flex justify-center">
              <Waitlist />
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}
