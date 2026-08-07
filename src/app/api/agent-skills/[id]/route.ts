import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { deleteAgentSkill, updateAgentSkill } from "@/lib/agent-skills";

interface RouteContext { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    for (const field of ["name", "description", "instructions"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        return NextResponse.json({ error: `${field} must be text` }, { status: 400 });
      }
    }
    if (body.agentIds !== undefined && (!Array.isArray(body.agentIds) || body.agentIds.some((value) => typeof value !== "string"))) {
      return NextResponse.json({ error: "agentIds must be a list of strings" }, { status: 400 });
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
    }
    const { id } = await params;
    const skill = await updateAgentSkill(principal.handle, id, {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
      ...(Array.isArray(body.agentIds) ? { agentIds: body.agentIds as string[] } : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    });
    return skill
      ? NextResponse.json({ skill })
      : NextResponse.json({ error: "Skill not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { id } = await params;
    return (await deleteAgentSkill(principal.handle, id))
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Skill not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
