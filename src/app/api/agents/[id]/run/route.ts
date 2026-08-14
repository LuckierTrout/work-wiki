import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { runSpecializedAgent } from "@/lib/agent-runtime";
import { getErrorMessage } from "@/lib/errors";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      prompt?: unknown;
      dryRun?: unknown;
    };
    if (body.prompt !== undefined && typeof body.prompt !== "string") {
      return NextResponse.json({ error: "prompt must be a string" }, { status: 400 });
    }
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
      return NextResponse.json({ error: "dryRun must be a boolean" }, { status: 400 });
    }
    const activity = await runSpecializedAgent({
      agentId: id,
      owner: principal.handle,
      trigger: "manual",
      dryRun: body.dryRun === true,
      ...(typeof body.prompt === "string" && body.prompt.trim()
        ? { prompt: body.prompt.slice(0, 4_000) }
        : {}),
    });
    return NextResponse.json({ activity });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /not found|not owned/i.test(message) ? 404 : 500 },
    );
  }
}
