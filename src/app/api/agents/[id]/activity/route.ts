import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { listAgentActivity } from "@/lib/agent-runtime";
import { getAgent } from "@/lib/agents";
import { getErrorMessage } from "@/lib/errors";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { id } = await params;
    const agent = await getAgent(id);
    if (!agent || agent.owner?.toLowerCase() !== principal.handle.toLowerCase()) {
      return NextResponse.json({ error: "Agent not found." }, { status: 404 });
    }
    return NextResponse.json({
      activity: await listAgentActivity(principal.handle, id),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
