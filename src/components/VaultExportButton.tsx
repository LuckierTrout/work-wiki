"use client";

import { useCallback, useState } from "react";
import { useToast } from "@/hooks/useToast";
import { logger } from "@/lib/logger";
import { APP_NAME } from "@/lib/brand";

/**
 * "Download my vault" — the only entry point to `GET /api/wiki/export`.
 *
 * The export used to hang off the wiki index toolbar, which was retired with
 * the commons (AD-21). The endpoint, its readability gating, and its Obsidian
 * conversion were never in scope for that cut, so the capability is re-homed
 * here on the owner's settings page rather than left reachable only by URL.
 */
export function VaultExportButton() {
  const [exporting, setExporting] = useState(false);
  const { addToast } = useToast();

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/wiki/export");
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Export failed" }));
        throw new Error(body.error ?? "Export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${APP_NAME}-vault.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      addToast("Wiki exported successfully", "success");
    } catch (err) {
      logger.error("wiki", "Export failed", err);
      addToast(err instanceof Error ? err.message : "Export failed", "error");
    } finally {
      setExporting(false);
    }
  }, [addToast]);

  return (
    <button
      type="button"
      onClick={handleExport}
      disabled={exporting}
      className="rounded-md border border-foreground/20 px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-foreground/5 disabled:opacity-50"
    >
      {exporting ? "Exporting…" : "Download vault (.zip)"}
    </button>
  );
}
