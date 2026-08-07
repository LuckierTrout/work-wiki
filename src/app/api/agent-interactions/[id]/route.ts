import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { submitAgentInteraction } from "@/lib/agent-workspaces";
import { runSpecializedAgent } from "@/lib/agent-runtime";

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { id } = await params;
    const body = await request.json() as { values?: unknown };
    if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) {
      return NextResponse.json({ error: "values must be an object" }, { status: 400 });
    }
    const interaction = await submitAgentInteraction(
      principal.handle,
      id,
      body.values as Record<string, string | number | boolean>,
    );
    if (!interaction) return NextResponse.json({ error: "Pending interaction not found." }, { status: 404 });
    const activity = await runSpecializedAgent({
      agentId: interaction.agentId,
      owner: principal.handle,
      trigger: "manual",
      prompt: `Resume after owner input for request "${interaction.title}". The submitted values are:\n${JSON.stringify(interaction.values, null, 2)}\nUse these values only for the requested continuation.`,
    });
    return NextResponse.json({ interaction, activity });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
