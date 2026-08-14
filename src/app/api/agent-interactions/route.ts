import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { listAgentInteractions } from "@/lib/agent-workspaces";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const rawStatus = new URL(request.url).searchParams.get("status");
  const status = rawStatus === "pending" || rawStatus === "submitted" || rawStatus === "cancelled"
    ? rawStatus
    : undefined;
  return NextResponse.json({ interactions: await listAgentInteractions(principal.handle, status) });
}
