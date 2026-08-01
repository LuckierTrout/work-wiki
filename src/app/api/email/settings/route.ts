import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isOwnerHandle } from "@/lib/owner";
import {
  MAX_EMAIL_SENDERS,
  isEmailAddress,
  loadEmailIngestConfig,
  normalizeAllowedSenders,
  saveEmailIngestConfig,
} from "@/lib/email-ingest";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

async function requireOwner() {
  const principal = await getPrincipal();
  return principal && isOwnerHandle(principal.handle) ? principal : null;
}

export async function GET() {
  if (!(await requireOwner())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const config = await loadEmailIngestConfig();
  const routingReady =
    config.inboundAddress.length > 0 &&
    process.env.YOPEDIA_EMAIL_ROUTING_READY === "1";
  return NextResponse.json({
    ...config,
    addressConfigured: config.inboundAddress.length > 0,
    routingReady,
    bodyIngestEnabled: true,
    attachmentIngestEnabled: false,
  });
}

export async function PUT(request: Request) {
  if (!(await requireOwner())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be true or false" },
        { status: 400 },
      );
    }
    if (typeof body.inboundAddress !== "string") {
      return NextResponse.json(
        { error: "inboundAddress must be a string" },
        { status: 400 },
      );
    }
    if (body.inboundAddress.trim() && !isEmailAddress(body.inboundAddress)) {
      return NextResponse.json(
        { error: "Enter a valid inbound email address" },
        { status: 400 },
      );
    }
    if (
      !Array.isArray(body.allowedSenders) ||
      !body.allowedSenders.every((value) => typeof value === "string")
    ) {
      return NextResponse.json(
        { error: "allowedSenders must be an array of email addresses" },
        { status: 400 },
      );
    }
    const allowedSenders = normalizeAllowedSenders(body.allowedSenders as string[]);
    if (allowedSenders.length > MAX_EMAIL_SENDERS) {
      return NextResponse.json(
        { error: `Add no more than ${MAX_EMAIL_SENDERS} approved senders` },
        { status: 400 },
      );
    }
    const invalid = allowedSenders.find((sender) => !isEmailAddress(sender));
    if (invalid) {
      return NextResponse.json(
        { error: `Invalid approved sender: ${invalid}` },
        { status: 400 },
      );
    }
    if (body.enabled && allowedSenders.length === 0) {
      return NextResponse.json(
        { error: "Add at least one approved sender before enabling email ingestion" },
        { status: 400 },
      );
    }
    if (body.enabled && !body.inboundAddress.trim()) {
      return NextResponse.json(
        { error: "Add the inbound email address before enabling email ingestion" },
        { status: 400 },
      );
    }

    const config = await saveEmailIngestConfig({
      enabled: body.enabled,
      inboundAddress: body.inboundAddress,
      allowedSenders,
    });
    return NextResponse.json({
      saved: true,
      ...config,
      addressConfigured: config.inboundAddress.length > 0,
      routingReady:
        config.inboundAddress.length > 0 &&
        process.env.YOPEDIA_EMAIL_ROUTING_READY === "1",
      bodyIngestEnabled: true,
      attachmentIngestEnabled: false,
    });
  } catch (error) {
    logger.error("email-ingest", "settings update failed", error);
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
