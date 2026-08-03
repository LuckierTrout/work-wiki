import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { retryOutboxEvent } from "@/lib/integration-outbox";

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { id } = await params;
    const event = await retryOutboxEvent(principal.handle, id);
    return event
      ? NextResponse.json({ event })
      : NextResponse.json({ error: "Outbox event not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
