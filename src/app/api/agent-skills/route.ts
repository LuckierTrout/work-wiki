import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { createAgentSkill, listAgentSkills } from "@/lib/agent-skills";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    return NextResponse.json({ skills: await listAgentSkills(principal.handle) });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.name !== "string" || typeof body.instructions !== "string") {
      return NextResponse.json({ error: "name and instructions are required" }, { status: 400 });
    }
    if (body.agentIds !== undefined && (!Array.isArray(body.agentIds) || body.agentIds.some((value) => typeof value !== "string"))) {
      return NextResponse.json({ error: "agentIds must be a list of strings" }, { status: 400 });
    }
    const skill = await createAgentSkill(principal.handle, {
      name: body.name,
      instructions: body.instructions,
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      ...(Array.isArray(body.agentIds) ? { agentIds: body.agentIds as string[] } : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    });
    return NextResponse.json({ skill }, { status: 201 });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json({ error: message }, { status: /required/i.test(message) ? 400 : 500 });
  }
}
