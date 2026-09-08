import { NextRequest, NextResponse } from "next/server";
import { ingestXMention } from "@/lib/ingest";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";

/** Pattern matching x.com or twitter.com post URLs. */
const X_URL_PATTERN = /^https?:\/\/(www\.)?(x\.com|twitter\.com)\//i;

export async function POST(request: NextRequest) {
  try {
    // Clerk session (human) OR service token (scheduled agent jobs) — never
    // the request body.
    const principal = (await getPrincipal()) ?? getServicePrincipal(request);
    if (!principal) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    // Deployment read-only (DW-187). Answered HERE — after the 401, before any
    // work — and not left to the kernel writer, because this door meets BOTH
    // halves of the rule:
    //   - IRREVERSIBLE WORK ALREADY COMMITTED: `ingestXMention` writes the
    //     post's raw snapshot before the page write.
    //   - EXPENSIVE, FAILABLE WORK FIRST: the syndication fetch and two LLM
    //     calls run ahead of it, and a deleted/private post answers 400 or 500
    //     in place of the refusal.
    // Ordered after `getPrincipal()` so an unauthenticated caller still learns
    // it is unauthenticated, matching `DELETE /api/ingest/history`.
    if (isReadOnly()) {
      return NextResponse.json(
        { error: READ_ONLY_REFUSAL.ingest },
        { status: 403 },
      );
    }
    const body = await request.json();
    const { url, triggeredBy } = body;

    // --- Validate url ---
    if (!url || typeof url !== "string" || url.trim().length === 0) {
      return NextResponse.json(
        { error: "url is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    if (!X_URL_PATTERN.test(url.trim())) {
      return NextResponse.json(
        { error: "url must be an x.com or twitter.com URL" },
        { status: 400 },
      );
    }

    // --- Validate triggeredBy ---
    if (
      !triggeredBy ||
      typeof triggeredBy !== "string" ||
      triggeredBy.trim().length === 0
    ) {
      return NextResponse.json(
        { error: "triggeredBy is required and must be a non-empty string" },
        { status: 400 },
      );
    }

    // `triggeredBy` (the X handle) stays as source provenance; the page owner
    // and author are the authenticated principal (Phase 1: the caller is the
    // logged-in user; the @yoyoevolve service loop is a later phase).
    const result = await ingestXMention(url.trim(), triggeredBy.trim(), {
      author: principal.handle,
      owner: principal.handle,
    });
    return NextResponse.json(result);
  } catch (error) {
    // Mid-request flag flip: the gate above already answered for a deployment
    // that was read-only on arrival, so a `ReadOnlyError` here came from the
    // kernel page writer. It is a refusal, not a server fault.
    if (isReadOnlyError(error)) {
      return NextResponse.json(
        { error: getErrorMessage(error) },
        { status: 403 },
      );
    }
    logger.error("ingest-x-mention", "X mention ingest error", error);
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
