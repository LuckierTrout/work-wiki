import { NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { dismissInsight, listInsightDismissals } from "@/lib/graph-insight-dismissals";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { isReadOnlyError, READ_ONLY_REFUSAL } from "@/lib/read-only";

export async function GET() {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    return NextResponse.json({ items: await listInsightDismissals(principal.handle) });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json({ error: READ_ONLY_REFUSAL.graphInsightDismiss }, { status: 403 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      id?: unknown;
      fingerprint?: unknown;
    };
    if (typeof body.id !== "string" || !body.id.trim()) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }
    if (typeof body.fingerprint !== "string" || !body.fingerprint.trim()) {
      return NextResponse.json({ error: "fingerprint is required." }, { status: 400 });
    }
    const item = await dismissInsight(principal.handle, body.id.trim(), body.fingerprint.trim());
    return NextResponse.json({ item });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
