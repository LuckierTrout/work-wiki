import { NextRequest, NextResponse } from "next/server";
import { getErrorMessage, isEnoent } from "@/lib/errors";
import { getExtractJob } from "@/lib/extract-jobs";
import { logger } from "@/lib/logger";
import { readRawSourceBytes } from "@/lib/raw";
import { extractOwnerFor, resolveExtractCaller } from "@/lib/extract-auth";

/**
 * `GET /api/extract/bytes?extractId=…` — the stored Source bytes, for the
 * sidecar that just claimed the matching record (Story 7.1).
 *
 * THE KEY COMES FROM THE RECORD, never from the query string. A caller names
 * an `extractId`; the storage key it resolves to is whatever Intake wrote when
 * it stored the bytes. A door that took a path would be a read-any-file
 * primitive wearing an extract label.
 *
 * Served as `application/octet-stream` with the record's own SHA-256 in a
 * header, so the sidecar can key its parse cache on the same digest the kernel
 * used rather than hashing the body a second time and hoping the two agree.
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const caller = await resolveExtractCaller(request, url.searchParams.get("owner"));
    if (!caller) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const extractId = url.searchParams.get("extractId")?.trim() ?? "";
    if (!extractId) {
      return NextResponse.json({ error: "extractId is required." }, { status: 400 });
    }
    const job = await getExtractJob(extractId);
    if (!job || !extractOwnerFor(caller, job.owner)) {
      return NextResponse.json({ error: "Extract job not found." }, { status: 404 });
    }

    // A record whose bytes are gone is a 404, NOT the 500 an unhandled ENOENT
    // produced. The distinction is the sidecar's: a 500 reads as "the kernel is
    // broken, keep polling", so a single vanished Source had every poll retry
    // it forever, while a 404 is a terminal answer the poller fails the record
    // on. Only the missing case is narrowed — a storage fault still throws.
    // `isEnoent` covers both providers: the filesystem throws a real ENOENT and
    // R2's `R2NotFoundError` carries `code = "ENOENT"` for exactly this reason.
    const bytes = await readRawSourceBytes(job.storageKey).catch((error) => {
      if (!isEnoent(error)) throw error;
      return null;
    });
    if (!bytes) {
      logger.warn(
        "extract",
        `extract ${extractId} names "${job.storageKey}", which is no longer stored`,
      );
      return NextResponse.json(
        { error: "The stored source for this extract is no longer available." },
        { status: 404 },
      );
    }

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "x-extract-sha256": job.bytesSha256,
        "x-extract-format": job.format,
        // The filename is what picks a parser in the crate, and a header value
        // must not carry a raw newline or quote from an uploaded name.
        "x-extract-filename": job.filename.replace(/[^\w.\-]/g, "_"),
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    logger.error("extract", "extract bytes door failed", error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
