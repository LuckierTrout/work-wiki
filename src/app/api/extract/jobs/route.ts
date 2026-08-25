import { NextRequest, NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { extractOwnerFor, resolveExtractCaller } from "@/lib/extract-auth";
import {
  getExtractJob,
  listClaimableExtractJobs,
  listExtractJobs,
} from "@/lib/extract-jobs";
import { claimExtract, completeExtract, failExtract } from "@/lib/extract-dispatch";
import { getIntakeSettings } from "@/lib/extract-settings";
import { EXTRACT_POLL_ANY, recordExtractPoll } from "@/lib/extract-heartbeat";
import { logger } from "@/lib/logger";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";

/**
 * The sidecar's half of the extract path (Story 7.1).
 *
 * `GET` answers the poll ("is there anything to parse?"), `POST` carries the
 * three verbs a poller needs: `claim`, `complete`, `fail`. One route rather
 * than four because they share an authorization rule, a read-only rule and an
 * owner resolution that would otherwise be copied four times.
 *
 * AUTH IS OWNER-AUTOMATION. The sidecar has no Clerk session — it is a Node
 * process on the owner's laptop — so it presents the service bearer token and
 * `getServicePrincipal` resolves it. That token is the SAME owner-automation
 * credential operators already configure (the docs spell it `WORKWIKI_URL` +
 * `WORKWIKI_API_TOKEN`; the env names the kernel reads are `YOPEDIA_SERVICE_*`).
 * No third token family was invented for extract.
 *
 * A Clerk session is also honoured, scoped to that principal's own records —
 * it is what makes the doors testable from a browser and reviewable by the
 * owner without handing a laptop process a second credential.
 *
 * THE POLL IS ALSO THE HEARTBEAT. Nothing on the Worker can dial `127.0.0.1`,
 * so this request arriving is the only honest evidence the kernel has that
 * extract is possible at all; `extract-heartbeat` is what the arrival door
 * reads before it decides whether to queue or to fail closed.
 */

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const caller = await resolveExtractCaller(request, url.searchParams.get("owner"));
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Stamped before the listing so a first poll that finds nothing to do still
  // counts as a sidecar that is up.
  //
  // SERVICE CALLERS ONLY. This stamp is what the arrival door reads to decide
  // between queueing a document and failing it closed, and only the sidecar's
  // bearer-token poll is evidence that a process able to parse anything exists.
  // A Clerk browser GET — the owner opening a debug view, a test hitting the
  // route from a session — proved only that a tab was open, and stamping it
  // made every arrival for the next few minutes queue against a sidecar that
  // was not running, with nothing on screen saying so.
  if (caller.service) {
    await recordExtractPoll(caller.owner ?? EXTRACT_POLL_ANY);
  }
  const all = url.searchParams.get("all") === "1";
  const jobs = all
    ? await listExtractJobs({ owner: caller.owner, limit: 100 })
    : await listClaimableExtractJobs(caller.owner);
  return NextResponse.json({
    owner: caller.owner,
    jobs: jobs.map((job) => ({
      extractId: job.extractId,
      owner: job.owner,
      status: job.status,
      filename: job.filename,
      format: job.format,
      bytesSha256: job.bytesSha256,
      size: job.size,
      sourceRel: job.sourceRel,
      title: job.title,
      attempts: job.attempts,
      ...(job.error ? { error: job.error } : {}),
    })),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) ?? {};
    const payload = body as {
      action?: unknown;
      extractId?: unknown;
      owner?: unknown;
      text?: unknown;
      error?: unknown;
      cacheHit?: unknown;
    };
    const requestedOwner =
      typeof payload.owner === "string" ? payload.owner : null;
    const caller = await resolveExtractCaller(request, requestedOwner);
    if (!caller) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Every verb below commits something — a claim included, since it stamps
    // the record — so the refusal is answered once, ahead of all three.
    if (isReadOnly()) {
      return NextResponse.json({ error: READ_ONLY_REFUSAL.ingest }, { status: 403 });
    }

    const extractId =
      typeof payload.extractId === "string" ? payload.extractId.trim() : "";
    if (!extractId) {
      return NextResponse.json({ error: "extractId is required." }, { status: 400 });
    }

    // The record names its own owner, and every verb below acts AS that owner.
    // A caller that may not touch this record is answered 404 rather than 403:
    // whether an id exists is itself an answer about someone else's vault.
    const record = await getExtractJob(extractId);
    const owner = record ? extractOwnerFor(caller, record.owner) : null;
    if (!record || !owner) {
      return NextResponse.json({ error: "Extract job not found." }, { status: 404 });
    }

    if (payload.action === "claim") {
      const job = await claimExtract(extractId, owner);
      if (!job) {
        // Not an error: losing a claim race is the expected outcome of two
        // pollers, and a 409 lets the sidecar move to the next record without
        // treating its own health as suspect.
        return NextResponse.json({ claimed: false }, { status: 409 });
      }
      return NextResponse.json({
        claimed: true,
        extractId: job.extractId,
        owner: job.owner,
        filename: job.filename,
        format: job.format,
        bytesSha256: job.bytesSha256,
        size: job.size,
        attempts: job.attempts,
      });
    }

    if (payload.action === "complete") {
      const text = typeof payload.text === "string" ? payload.text : "";
      const settings = await getIntakeSettings();
      const result = await completeExtract({
        extractId,
        owner,
        text,
        cacheHit: payload.cacheHit === true,
        keepParsed: settings.keepParsed,
      });
      if (!result.ok) {
        if (result.reason === "not-found") {
          return NextResponse.json({ error: "Extract job not found." }, { status: 404 });
        }
        if (result.reason === "empty") {
          return NextResponse.json(
            { error: "Extracted text was empty." },
            { status: 400 },
          );
        }
        return NextResponse.json(
          { error: "Extract job is already complete." },
          { status: 409 },
        );
      }
      return NextResponse.json({
        ok: true,
        textRel: result.textRel,
        queued: result.queued,
      });
    }

    if (payload.action === "fail") {
      const message =
        typeof payload.error === "string" && payload.error.trim()
          ? payload.error.trim().slice(0, 500)
          : "Extract failed.";
      const job = await failExtract({ extractId, owner, error: message });
      if (!job) {
        return NextResponse.json({ error: "Extract job not found." }, { status: 404 });
      }
      return NextResponse.json({ ok: true, failed: true });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    logger.error("extract", "extract job door failed", error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
