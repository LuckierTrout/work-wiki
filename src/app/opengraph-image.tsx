import { ImageResponse } from "next/og";
import { APP_NAME, APP_TITLE } from "@/lib/brand";

// Rendered at build time and served as a static asset (no Workers runtime
// dependency on next/og). Update copy here, not in a committed PNG.
export const dynamic = "force-static";

export const alt = `${APP_TITLE}. Not RAG — it accumulates.`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Inline so the social card remains self-contained.
const MARK = `<svg width="88" height="88" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <path d="M6.5 2.5h12l7 7v20h-19z" fill="#84aed6" stroke="#84aed6" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M18.5 2.5v7h7" fill="#17273a" stroke="#0f2235" stroke-width="1.25" stroke-linejoin="round"/>
  <path d="m10 13 2.2 10 3.8-7.1 3.8 7.1L22 13" fill="none" stroke="#0f2235" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const MARK_URI = `data:image/svg+xml,${encodeURIComponent(MARK)}`;

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#1b1a16",
          color: "#efebdf",
          padding: "72px 80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <img src={MARK_URI} width={88} height={88} alt="" />
          <div style={{ fontSize: 44, fontWeight: 600, letterSpacing: -1.3 }}>
            {APP_NAME}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 64,
              fontWeight: 600,
              letterSpacing: -1.7,
              lineHeight: 1.1,
            }}
          >
            <span>A shared second brain</span>
            <span>for humans and agents.</span>
          </div>
          <div
            style={{ fontSize: 30, color: "#a39c8c", lineHeight: 1.3, maxWidth: 900 }}
          >
            Not RAG — it accumulates. Sources become cited pages; provenance and
            lineage stay visible.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 14, height: 14, borderRadius: 7, background: "#84aed6" }} />
            <span style={{ color: "#c7c2b4" }}>humans</span>
          </div>
          <span style={{ color: "#635e51" }}>+</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                border: "2px solid #6b7280",
              }}
            />
            <span style={{ color: "#c7c2b4" }}>agents</span>
          </div>
          <span style={{ marginLeft: "auto", color: "#756f62" }}>
            a wiki for the agent age
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
