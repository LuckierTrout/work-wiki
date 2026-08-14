"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { Show, SignInButton, UserButton, useUser } from "@clerk/nextjs";
import { GlobalSearch } from "./GlobalSearch";
import { ThemeToggle } from "./folio/ThemeToggle";
import { Avatar } from "./folio/primitives";
import { AppMark } from "./Logo";
import { APP_NAME } from "@/lib/brand";
import { isOwnerHandle } from "@/lib/owner";
import { LocaleSwitcher } from "./LocaleSwitcher";

// Primary actions — the only links in the bar. Secondary/exploration links
// (Graph, Log) live in the footer per the Folio design; owner admin (Lint,
// Settings) lives in the user menu.
const primaryLinks = [
  { href: "/query", label: "Ask" },
  { href: "/chat", label: "Chat" },
  { href: "/ingest", label: "Ingest" },
  { href: "/save", label: "Save" },
  { href: "/tasks", label: "To-do" },
];

const workspaceLinks = [
  { href: "/studio", label: "Studio" },
  { href: "/vault", label: "Vaults" },
  { href: "/agents", label: "Agents" },
  { href: "/review", label: "Review" },
  { href: "/monitors", label: "Sources" },
  { href: "/knowledge", label: "Knowledge" },
  { href: "/integrations", label: "Integrations" },
  { href: "/system", label: "System" },
] as const;

/** Which primary link should read as "active" for the current path. */
function getActiveHref(pathname: string): string | null {
  if (pathname === "/query" || pathname.startsWith("/query/")) return "/query";
  if (pathname === "/chat" || pathname.startsWith("/chat/")) return "/chat";
  if (pathname === "/ingest" || pathname.startsWith("/ingest/")) return "/ingest";
  if (pathname === "/save" || pathname.startsWith("/save/")) return "/save";
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return "/tasks";
  return null;
}

export function NavHeader() {
  const pathname = usePathname();
  const activeHref = getActiveHref(pathname);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { user } = useUser();
  const handle = user?.username ?? null;
  const isOwner = isOwnerHandle(handle);

  // Close the mobile menu on navigation.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Translucent + ruled once the page scrolls (Folio nav behavior).
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className="sticky top-0 z-50"
      style={{
        background: scrolled
          ? "color-mix(in srgb, var(--paper) 90%, transparent)"
          : "var(--paper)",
        backdropFilter: scrolled ? "saturate(1.8) blur(12px)" : undefined,
        WebkitBackdropFilter: scrolled ? "saturate(1.8) blur(12px)" : undefined,
        borderBottom: "1px solid var(--rule)",
        transition: "background .2s, border-color .2s",
      }}
    >
      <nav
        aria-label="Main navigation"
        className="flex h-14 w-full items-center justify-between gap-4 md:h-16"
        style={{ paddingInline: "clamp(18px, 3.75vw, 54px)" }}
      >
        {/* Brand + primary links */}
        <div className="flex items-center" style={{ gap: 36 }}>
          <Link
            href="/"
            className="flex items-center gap-2.5 text-ink hover:opacity-90 transition-opacity"
          >
            <AppMark />
            <span
              className="display"
              style={{ fontSize: 21, letterSpacing: "-0.026em", fontWeight: 650 }}
            >
              {APP_NAME}
            </span>
          </Link>

          <ul className="hidden items-center gap-1 xl:flex">
            {primaryLinks.map(({ href, label }) => {
              const isActive = href === activeHref;
              return (
                <li key={href}>
                  <Link
                    href={href}
                    className="transition-colors"
                    style={{
                      display: "inline-block",
                      padding: "8px 12px",
                      borderRadius: 999,
                      fontSize: 14,
                      letterSpacing: "-0.01em",
                      fontWeight: isActive ? 600 : 400,
                      color: isActive ? "var(--ink)" : "var(--muted)",
                      background: isActive ? "var(--paper-3)" : "transparent",
                    }}
                  >
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Search + theme + auth */}
        <div className="flex items-center" style={{ gap: 12 }}>
          <div className="hidden xl:block">
            <GlobalSearch />
          </div>
          <ThemeToggle />
          <LocaleSwitcher />

          <Show when="signed-out">
            {/* Owner-only deployment: signing in is the only entry point (the
                waitlist is retired). Hidden below xl — the hamburger menu
                carries auth on narrow widths. */}
            <span className="hidden xl:inline-flex">
              <SignInButton mode="modal">
                <button className="btn ghost" style={{ marginLeft: 2 }}>
                  Sign in
                </button>
              </SignInButton>
            </span>
          </Show>
          <Show when="signed-in">
            <span
              className="hidden items-center xl:inline-flex"
              style={{ marginLeft: 2 }}
            >
              <UserButton>
                {
                  <UserButton.MenuItems>
                    <UserButton.Link
                      label="Knowledge Studio"
                      labelIcon={<span aria-hidden>◈</span>}
                      href="/studio"
                    />
                    <UserButton.Link
                      label="Vaults"
                      labelIcon={<span aria-hidden>🗄️</span>}
                      href="/vault"
                    />
                    <UserButton.Link
                      label="Agents"
                      labelIcon={<span aria-hidden>🤖</span>}
                      href="/agents"
                    />
                    <UserButton.Link
                      label="Review"
                      labelIcon={<span aria-hidden>◫</span>}
                      href="/review"
                    />
                    <UserButton.Link
                      label="Sources"
                      labelIcon={<span aria-hidden>◎</span>}
                      href="/monitors"
                    />
                    <UserButton.Link
                      label="Knowledge"
                      labelIcon={<span aria-hidden>◇</span>}
                      href="/knowledge"
                    />
                    <UserButton.Link
                      label="Integrations"
                      labelIcon={<span aria-hidden>↗</span>}
                      href="/integrations"
                    />
                    <UserButton.Link
                      label="System"
                      labelIcon={<span aria-hidden>◉</span>}
                      href="/system"
                    />
                    {isOwner && (
                      <UserButton.Link
                        label="Settings"
                        labelIcon={<span aria-hidden>⚙️</span>}
                        href="/settings"
                      />
                    )}
                    {isOwner && (
                      <UserButton.Link
                        label="Wiki Health"
                        labelIcon={<span aria-hidden>✓</span>}
                        href="/lint"
                      />
                    )}
                  </UserButton.MenuItems>
                }
              </UserButton>
            </span>
          </Show>

          {/* Hamburger (mobile only). Keep the responsive display class on a
              wrapper: `.btn` sets display after Tailwind's utilities and would
              otherwise override `md:hidden` at desktop widths. */}
          <span className="xl:hidden">
            <button
              type="button"
              className="btn ghost"
              style={{ padding: 8, borderRadius: 10, width: 38, height: 38 }}
              onClick={() => setMobileOpen((prev) => !prev)}
              aria-label="Toggle navigation menu"
              aria-expanded={mobileOpen}
            >
              <svg
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                viewBox="0 0 24 24"
              >
                {mobileOpen ? (
                  <path d="M6 18 18 6M6 6l12 12" />
                ) : (
                  <path d="M4 7h16M4 12h16M4 17h16" />
                )}
              </svg>
            </button>
          </span>
        </div>
      </nav>

      {/* Mobile dropdown menu */}
      {mobileOpen && (
        <div
          className="xl:hidden"
          style={{
            background: "var(--paper)",
            borderTop: "1px solid var(--rule)",
            borderBottom: "1px solid var(--rule)",
            paddingBlock: 10,
          }}
        >
          <div style={{ paddingInline: 22, paddingBottom: 8 }}>
            <GlobalSearch />
          </div>
          {primaryLinks.map(({ href, label }) => {
            const isActive = href === activeHref;
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileOpen(false)}
                className="block transition-colors"
                style={{
                  paddingInline: 24,
                  paddingBlock: 9,
                  fontSize: 15,
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? "var(--ink)" : "var(--muted)",
                  background: isActive ? "var(--paper-2)" : "transparent",
                }}
              >
                {label}
              </Link>
            );
          })}
          <Show when="signed-in">
            <p
              className="receipt"
              style={{ margin: "8px 24px 4px", color: "var(--faint)", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase" }}
            >
              Workspace
            </p>
            {workspaceLinks.map(({ href, label }) => {
              const isActive = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMobileOpen(false)}
                  className="block transition-colors"
                  style={{
                    paddingInline: 24,
                    paddingBlock: 9,
                    fontSize: 15,
                    color: isActive ? "var(--ink)" : "var(--muted)",
                    background: isActive ? "var(--paper-2)" : "transparent",
                  }}
                >
                  {label}
                </Link>
              );
            })}
            {isOwner && (
              <Link
                href="/settings"
                onClick={() => setMobileOpen(false)}
                className="block transition-colors"
                style={{
                  paddingInline: 24,
                  paddingBlock: 9,
                  fontSize: 15,
                  color: pathname.startsWith("/settings") ? "var(--ink)" : "var(--muted)",
                  background: pathname.startsWith("/settings") ? "var(--paper-2)" : "transparent",
                }}
              >
                Settings
              </Link>
            )}
            {isOwner && (
              <Link
                href="/lint"
                onClick={() => setMobileOpen(false)}
                className="block transition-colors"
                style={{
                  paddingInline: 24,
                  paddingBlock: 9,
                  fontSize: 15,
                  color: pathname.startsWith("/lint") ? "var(--ink)" : "var(--muted)",
                  background: pathname.startsWith("/lint") ? "var(--paper-2)" : "transparent",
                }}
              >
                Wiki Health
              </Link>
            )}
          </Show>
          <div
            style={{
              margin: "8px 24px",
              borderTop: "1px solid var(--rule)",
            }}
          />
          <div
            className="flex items-center justify-between"
            style={{ paddingInline: 24, paddingBlock: 6 }}
          >
            <Show when="signed-out">
              <span className="inline-flex items-center gap-2">
                <SignInButton mode="modal">
                  <button className="btn ghost">Sign in</button>
                </SignInButton>
              </span>
            </Show>
            <Show when="signed-in">
              <span className="inline-flex items-center gap-2">
                {handle && <Avatar id={handle} size={28} />}
                <UserButton />
              </span>
            </Show>
          </div>
        </div>
      )}
    </header>
  );
}
