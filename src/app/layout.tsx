import { getPrincipal } from "@/lib/auth";
import { isOwnerPrincipal } from "@/lib/owner";
import { unstable_rethrow } from "next/navigation";
import type { Metadata } from "next";
import { Inter, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { NavHeader } from "@/components/NavHeader";
import { Footer } from "@/components/Footer";
import { SiteChrome } from "@/components/SiteChrome";
import { ClientProviders } from "@/components/ClientProviders";
import { EnsureYoyo } from "@/components/EnsureYoyo";
import { E2eViewerIdentity } from "@/components/E2eViewerIdentity";
import { RegisterSW } from "@/components/RegisterSW";
import { APP_NAME, APP_ORIGIN, APP_TITLE } from "@/lib/brand";
import { isE2eIdentityArmed } from "@/lib/e2e-identity";
import "katex/dist/katex.min.css";
import "./globals.css";

// Self-hosted via next/font (no runtime Google CDN calls). Exposed as CSS
// variables consumed by the `--font-*` tokens in globals.css.
const fontSans = Inter({
  subsets: ["latin"],
  variable: "--font-sans-next",
  display: "swap",
});
const fontSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-serif-next",
  display: "swap",
});
const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono-next",
  display: "swap",
});

const SITE_DESCRIPTION =
  "A shared second brain for humans and agents. Not RAG — it accumulates: sources become cited pages, contradictions reconcile, and lineage stays visible.";

export const metadata: Metadata = {
  metadataBase: new URL(APP_ORIGIN),
  title: {
    default: APP_TITLE,
    template: `%s · ${APP_NAME}`,
  },
  description: SITE_DESCRIPTION,
  openGraph: {
    title: APP_TITLE,
    description: SITE_DESCRIPTION,
    siteName: APP_NAME,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: APP_TITLE,
    description: SITE_DESCRIPTION,
  },
};

const themeScript = `
(function() {
  try {
    // Light is the default; dark only when explicitly chosen. (We no longer
    // follow the OS prefers-color-scheme for unset visitors.)
    var t = localStorage.getItem('theme');
    if (t === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.add('light');
    }
  } catch(e) {}
})();
`;

/**
 * Clerk wraps every live request. The local Playwright harness is the one
 * exception: dummy keys make `<ClerkProvider>` throw before the Workbench
 * can paint, and `useUser()` in EnsureYoyo / NavHeader would throw without
 * it. The E2E cookie is the identity there — see `e2e-identity.ts`.
 *
 * That cookie is also what the client islands must gate on under the harness
 * (DW-534). With no `<ClerkProvider>` here, `useViewerHandle()` used to answer
 * SIGNED OUT for the very owner `middleware.ts` admits, so Delete, Re-ingest,
 * Graphify and Revert all failed closed for the only viewer the E2E lane has.
 * `<E2eViewerIdentity>` resolves the cookie and injects the handle in the
 * armed branch. AppProviders remains synchronous; RootLayout additionally
 * resolves the server owner flag on each render before passing it to NavHeader.
 * Ordinary auth failures hide owner controls; Next control-flow errors rethrow.
 */
function AppProviders({ children, isSiteOwner }: { children: React.ReactNode; isSiteOwner: boolean }) {
  const e2e = isE2eIdentityArmed();
  const shell = (
    <ClientProviders>
      {e2e ? null : <EnsureYoyo />}
      <RegisterSW />
      <SiteChrome nav={e2e ? null : <NavHeader isSiteOwner={isSiteOwner} />} footer={e2e ? null : <Footer />}>
        {children}
      </SiteChrome>
    </ClientProviders>
  );
  return e2e ? (
    <E2eViewerIdentity>{shell}</E2eViewerIdentity>
  ) : (
    <ClerkProvider
      signInFallbackRedirectUrl="/"
      signInForceRedirectUrl="/"
    >
      {shell}
    </ClerkProvider>
  );
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolve authority per server render; keep the actual identity private.
  let isSiteOwner = false;
  try {
    isSiteOwner = isOwnerPrincipal(await getPrincipal());
  } catch (error) {
    unstable_rethrow(error);
  }
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fontSans.variable} ${fontSerif.variable} ${fontMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen antialiased flex flex-col">
        {/* No `waitlistUrl`: /waitlist is retired. This deployment is
            owner-only — there is no self-serve sign-up to route anywhere, and
            no public read path behind it. */}
        <AppProviders isSiteOwner={isSiteOwner}>{children}</AppProviders>
      </body>
    </html>
  );
}
