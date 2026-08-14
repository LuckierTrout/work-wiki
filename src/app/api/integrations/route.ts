import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import {
  getIntegrationSettings,
  listOutboxEvents,
  saveIntegrationSettings,
} from "@/lib/integration-outbox";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const [settings, events] = await Promise.all([
      getIntegrationSettings(principal.handle),
      listOutboxEvents(principal.handle),
    ]);
    return NextResponse.json({
      settings,
      events,
      webhookSigningConfigured: Boolean(process.env.YOPEDIA_WEBHOOK_SIGNING_SECRET),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (body.webhookEnabled !== undefined && typeof body.webhookEnabled !== "boolean") {
      return NextResponse.json({ error: "webhookEnabled must be a boolean." }, { status: 400 });
    }
    if (body.calendarEnabled !== undefined && typeof body.calendarEnabled !== "boolean") {
      return NextResponse.json({ error: "calendarEnabled must be a boolean." }, { status: 400 });
    }
    if (body.webhookUrl !== undefined && body.webhookUrl !== null && typeof body.webhookUrl !== "string") {
      return NextResponse.json({ error: "webhookUrl must be a string or null." }, { status: 400 });
    }
    const settings = await saveIntegrationSettings(principal.handle, {
      ...(typeof body.webhookEnabled === "boolean" ? { webhookEnabled: body.webhookEnabled } : {}),
      ...(typeof body.calendarEnabled === "boolean" ? { calendarEnabled: body.calendarEnabled } : {}),
      ...(typeof body.webhookUrl === "string" || body.webhookUrl === null
        ? { webhookUrl: body.webhookUrl }
        : {}),
    });
    return NextResponse.json({ settings });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /required|blocked|invalid/i.test(message) ? 400 : 500 },
    );
  }
}
