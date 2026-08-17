import type { Metadata } from "next";
import { Inter, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { NavHeader } from "@/components/NavHeader";
import { Footer } from "@/components/Footer";
import { SiteChrome } from "@/components/SiteChrome";
import { ClientProviders } from "@/components/ClientProviders";
import { EnsureYoyo } from "@/components/EnsureYoyo";
import { RegisterSW } from "@/components/RegisterSW";
import { APP_NAME, APP_ORIGIN, APP_TITLE } from "@/lib/brand";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
        <ClerkProvider>
          <ClientProviders>
            <EnsureYoyo />
            <RegisterSW />
            <SiteChrome nav={<NavHeader />} footer={<Footer />}>
              {children}
            </SiteChrome>
          </ClientProviders>
        </ClerkProvider>
      </body>
    </html>
  );
}
