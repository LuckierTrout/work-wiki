import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { cascadeDeleteSource } from "@/lib/source-cascade";
import { sourceRestFromPath } from "@/lib/source-delete";
import { INTAKE_SIGN_IN_COPY } from "@/lib/workbench-intake";

/**
 * DELETE /api/workbench/source — confirm-gated cascade delete for one Source.
 */

export async function DELETE(request: NextRequest) {
  try {
    const principal = await getPrincipal();
    if (!principal) {
      return NextResponse.json({ error: INTAKE_SIGN_IN_COPY }, { status: 401 });
    }
    if (isReadOnly()) {
      return NextResponse.json({ error: READ_ONLY_REFUSAL.ingest }, { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as { path?: unknown };
    const path = typeof body.path === "string" ? body.path.trim() : "";
    const rest = sourceRestFromPath(path);
    if (!rest) {
      return NextResponse.json({ error: "That source path is not allowed." }, { status: 400 });
    }
    const leafBase = rest.split("/").pop()?.replace(/\.[^.]+$/, "") ?? rest;
    const result = await cascadeDeleteSource({
      owner: principal.handle,
      path,
      sourceTitle: leafBase,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    logger.error("source", "workbench source delete error", error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
