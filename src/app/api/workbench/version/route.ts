import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { readDataVersion } from "@/lib/data-version";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * GET /api/workbench/version — the Workbench's refresh signal.
 *
 * Answers `{ dataVersion: <integer> }`: the monotonic counter every successful
 * kernel page write and delete raises by one (`src/lib/data-version.ts`). The
 * shell polls it and re-runs the server render when it has moved forward, so a
 * page written by the CLI, by MCP, by an agent or by another tab reaches the
 * trees and the Preview without the owner reloading the window.
 *
 * It exists at all because the browser cannot read KV. It is GATED because the
 * answer is a fact about the owner's workspace, and it is `private, no-store`
 * because a shared cache holding one principal's answer would hand it to the
 * next reader — the same six rules `api/workbench/preview/route.ts` follows,
 * and the same `{ error }` shape, because the column parses it.
 */

/** Per-principal and gated, so no cache may keep it — not even the bfcache. */
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET() {
  try {
    return await handle();
  } catch (error) {
    // Without this a throw from `getPrincipal` escapes as a framework 500 whose
    // body is not `{ error }` — breaking the shape every other route in this
    // tree answers with, and the one the poll parses. A malformed answer is
    // never a reason to refresh, so the watcher degrades to silence either way;
    // the shape is what keeps that true rather than accidental.
    logger.error("workbench-version", "data version read failed", error);
    return json({ error: getErrorMessage(error) }, 500);
  }
}

async function handle() {
  const principal = await getPrincipal();
  if (!principal) {
    return json({ error: "Sign in required." }, 401);
  }
  // Global by design (AD-11): one integer for the whole store, not one per
  // tenant, per Wiki or per page. The gate is about who may ask, not about what
  // the number describes.
  return json({ dataVersion: await readDataVersion() });
}
