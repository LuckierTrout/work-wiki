import { APP_NAME } from "@/lib/brand";

type MarkSize = "nav" | "footer" | "full";

interface AppMarkProps {
  className?: string;
  size?: MarkSize;
}

const MARK_DIMENSIONS: Record<MarkSize, { width: number; height: number }> = {
  nav: { width: 29, height: 31 },
  footer: { width: 20, height: 22 },
  full: { width: 58, height: 62 },
};

/**
 * work-wiki's document mark: a folded page and an open W. It keeps the original
 * living-page idea, but makes the product initial legible at every brand size.
 */
export function AppMark({ className, size = "nav" }: AppMarkProps) {
  const { width, height } = MARK_DIMENSIONS[size];

  return (
    <span
      className={className}
      aria-hidden
      style={{
        width,
        height,
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg
        width={width}
        height={height}
        viewBox="0 0 28 30"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M4.25 1.25h12.5l7 7v20.5H4.25z"
          fill="var(--accent)"
          stroke="var(--accent)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M16.75 1.25v7h7"
          fill="var(--accent-soft)"
          stroke="var(--on-accent)"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
        <path
          d="m7.75 12 2.45 10 3.8-7.15L17.8 22l2.45-10"
          stroke="var(--on-accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** Retained as the shared mark export for existing page and footer surfaces. */
export function LivingPageMark(props: AppMarkProps) {
  return <AppMark {...props} />;
}

interface LogoProps extends AppMarkProps {
  markOnly?: boolean;
}

export function Logo({ className, size = "nav", markOnly = false }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ""}`}>
      <AppMark size={size} />
      {!markOnly && (
        <span
          className="display text-ink"
          style={{ fontSize: 22, fontWeight: 650, letterSpacing: "-0.035em" }}
        >
          {APP_NAME}
        </span>
      )}
    </span>
  );
}
