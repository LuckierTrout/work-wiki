import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import {
  ResearchProjectBusyError,
  repairResearchRegistry,
} from "@/lib/research-projects";

/**
 * `POST /api/research/repair` — the owner's way out of a wedged registry
 * (DW-477).
 *
 * A `tenants/<t>/research-projects.json` that `parseRegistry` refuses 500s
 * every research door for its owner, the DELETEs that could have shrunk the
 * file included. Those 500 bodies now end by naming this route, and this is
 * what it does: quarantine the unreadable bytes to a timestamped
 * `.corrupt-<ms>` sibling and start a fresh empty registry.
 *
 * A STATIC SEGMENT beside `[id]`, so Next matches it ahead of
 * `/api/research/<id>` and the repair is never read as a project id.
 *
 * OWNER-ONLY AND UNPARAMETERIZED. The tenant comes from `principal.handle`
 * alone — no request field names a registry, so no caller can aim this at
 * someone else's file, and the body is never even read.
 *
 * FOUR ANSWERS, classified by TYPE and by the store's own union (DW-296
 * deleted message matching from these doors): 200 when bytes were quarantined,
 * 409 when the file reads fine and there was nothing to do, 503 when the
 * compare-and-swap lost to a concurrent writer — the
 * `POST /api/research/[id]/run` precedent for {@link ResearchProjectBusyError}
 * — and 500 for a storage fault, carrying the store's own message.
 */
export async function POST(_request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  // Read-only, ordered exactly as `POST /api/research/[id]/run`: after the 401,
  // and before the store is reached at all. Repairing is "change my research",
  // so it serves that door's existing sentence rather than a fourth wording,
  // and no exception is carved for it.
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.researchMutate },
      { status: 403 },
    );
  }
  try {
    const repair = await repairResearchRegistry(principal.handle);
    if (!repair.quarantined) {
      // A REFUSAL, not a fault: the registry reads, so a repair would have
      // thrown away a working file. 409 rather than 200 so a caller that
      // reached for this by mistake is told nothing happened.
      return NextResponse.json(
        { error: "The research projects file reads fine; there is nothing to repair." },
        { status: 409 },
      );
    }
    // The quarantine key is returned because it is the ONLY handle on the
    // bytes that were moved aside — nothing reaps them and no door reads them
    // back.
    return NextResponse.json({ repaired: true, quarantinedPath: repair.path });
  } catch (error) {
    // Backstop for a flag that flipped between the gate above and the kernel's
    // own `assertWritable`. A refusal is neither a server fault nor contention.
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    const status = error instanceof ResearchProjectBusyError ? 503 : 500;
    return NextResponse.json({ error: getErrorMessage(error) }, { status });
  }
}
