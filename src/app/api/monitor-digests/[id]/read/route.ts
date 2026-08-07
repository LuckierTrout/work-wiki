import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { markMonitorDigestRead } from "@/lib/monitor-digests";

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { id } = await params;
    if (!/^mdg_[a-f0-9]{16}$/.test(id)) {
      return NextResponse.json({ error: "Invalid monitor digest id." }, { status: 400 });
    }
    const digest = await markMonitorDigestRead(principal.handle, id);
    return digest
      ? NextResponse.json({ digest })
      : NextResponse.json({ error: "Monitor digest not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
