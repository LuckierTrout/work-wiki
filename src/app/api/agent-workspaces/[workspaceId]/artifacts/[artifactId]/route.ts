import { getPrincipal } from "@/lib/auth";
import { readAgentArtifact } from "@/lib/agent-workspaces";

interface RouteContext { params: Promise<{ workspaceId: string; artifactId: string }> }

export async function GET(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return Response.json({ error: "Sign in required." }, { status: 401 });
  const { workspaceId, artifactId } = await params;
  const result = await readAgentArtifact(principal.handle, workspaceId, artifactId);
  if (!result) return Response.json({ error: "Artifact not found." }, { status: 404 });
  const safeName = result.artifact.filename.replace(/["\r\n]/g, "-");
  return new Response(result.content, {
    headers: {
      "Content-Type": result.artifact.mediaType,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
