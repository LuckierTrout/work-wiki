"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/folio/icons";

const destinations = [
  { href: "/wiki", label: "Browse", icon: Icon.folder },
  { href: "/query", label: "Ask", icon: Icon.search },
  { href: "/chat", label: "Chat", icon: Icon.chat },
  { href: "/ingest", label: "Add", icon: Icon.plus },
  { href: "/tasks", label: "To-do", icon: Icon.check },
] as const;

function activeDestination(pathname: string): string | null {
  if (pathname === "/query" || pathname.startsWith("/query/")) return "/query";
  if (pathname === "/chat" || pathname.startsWith("/chat/")) return "/chat";
  if (
    pathname === "/ingest" ||
    pathname.startsWith("/ingest/") ||
    pathname === "/save" ||
    pathname.startsWith("/save/")
  ) return "/ingest";
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return "/tasks";
  if (
    pathname === "/wiki" ||
    pathname.startsWith("/wiki/") ||
    pathname.startsWith("/u/") ||
    pathname.startsWith("/vault")
  ) return "/wiki";
  return null;
}

export function MobileNavigationDock() {
  const pathname = usePathname();
  const activeHref = activeDestination(pathname);

  return (
    <nav className="mobile-navigation-dock" aria-label="Mobile navigation">
      {destinations.map(({ href, label, icon: DestinationIcon }) => (
        <Link
          key={href}
          href={href}
          className="mobile-navigation-link"
          aria-current={activeHref === href ? "page" : undefined}
        >
          <DestinationIcon aria-hidden />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
