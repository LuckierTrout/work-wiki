import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { runSourceMonitor } from "@/lib/source-monitors";

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { id } = await params;
    const result = await runSourceMonitor(principal.handle, id);
    return NextResponse.json({ result }, { status: result.outcome === "failed" ? 502 : 200 });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /not found/i.test(message) ? 404 : /paused|invalid/i.test(message) ? 409 : 500 },
    );
  }
}
