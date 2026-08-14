import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { deleteAgentRunWorkspace, listAgentRunWorkspaces } from "@/lib/agent-workspaces";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const agentId = new URL(request.url).searchParams.get("agentId") || undefined;
  return NextResponse.json({ workspaces: await listAgentRunWorkspaces(principal.handle, agentId) });
}

export async function DELETE(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    return (await deleteAgentRunWorkspace(principal.handle, id))
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
