import type { ReactElement, SVGProps } from "react";
import type { WorkbenchModeId } from "@/lib/workbench-modes";

/**
 * Rail glyphs — 16×16 inline stroke SVGs traced from the UX mockups
 * (`mockups/todos.html`), authored in the same style as `folio/icons.tsx` so
 * the shell gains no icon dependency. Geometry is drawn on a 24-unit grid and
 * scaled by the rail's 16px box.
 */

type P = SVGProps<SVGSVGElement>;

function Glyph({ children, ...rest }: P) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const RAIL_ICONS: Record<WorkbenchModeId, (p: P) => ReactElement> = {
  wiki: (p) => (
    <Glyph {...p}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </Glyph>
  ),
  chat: (p) => (
    <Glyph {...p}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Glyph>
  ),
  sources: (p) => (
    <Glyph {...p}>
      <path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </Glyph>
  ),
  search: (p) => (
    <Glyph {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3-3" />
    </Glyph>
  ),
  graph: (p) => (
    <Glyph {...p}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M8 7h8M7 8l4 8M17 8l-4 8" />
    </Glyph>
  ),
  lint: (p) => (
    <Glyph {...p}>
      <rect x="6" y="3" width="12" height="18" rx="1" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </Glyph>
  ),
  todos: (p) => (
    <Glyph {...p}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m4 6 1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
    </Glyph>
  ),
  review: (p) => (
    <Glyph {...p}>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </Glyph>
  ),
  research: (p) => (
    <Glyph {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </Glyph>
  ),
  skills: (p) => (
    <Glyph {...p}>
      <path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z" />
    </Glyph>
  ),
};

export function SettingsIcon(p: P) {
  return (
    <Glyph {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
    </Glyph>
  );
}

export function ChevronLeftIcon(p: P) {
  return (
    <Glyph {...p}>
      <path d="M15 6 9 12l6 6" />
    </Glyph>
  );
}
