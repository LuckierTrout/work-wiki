import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import {
  deleteResearchProject,
  updateResearchProject,
  type ResearchProjectStatus,
} from "@/lib/research-projects";

interface RouteContext { params: Promise<{ id: string }> }
const STATUSES = new Set<ResearchProjectStatus>([
  "draft", "queued", "collecting", "ready", "complete", "failed", "cancelled",
]);

export async function PATCH(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    for (const field of ["title", "question", "vaultId", "synthesis"] as const) {
      if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
        return NextResponse.json({ error: `${field} must be text or null` }, { status: 400 });
      }
    }
    for (const field of ["queries", "sourceUrls", "pageSlugs"] as const) {
      if (body[field] !== undefined && (!Array.isArray(body[field]) || body[field].some((value) => typeof value !== "string"))) {
        return NextResponse.json({ error: `${field} must be a list of strings` }, { status: 400 });
      }
    }
    if (body.status !== undefined && !STATUSES.has(body.status as ResearchProjectStatus)) {
      return NextResponse.json({ error: "Invalid research status" }, { status: 400 });
    }
    const project = await updateResearchProject(principal.handle, id, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.question === "string" ? { question: body.question } : {}),
      ...(Array.isArray(body.queries) ? { queries: body.queries as string[] } : {}),
      ...(Array.isArray(body.sourceUrls) ? { sourceUrls: body.sourceUrls as string[] } : {}),
      ...(Array.isArray(body.pageSlugs) ? { pageSlugs: body.pageSlugs as string[] } : {}),
      ...(body.vaultId === null || typeof body.vaultId === "string" ? { vaultId: body.vaultId } : {}),
      ...(STATUSES.has(body.status as ResearchProjectStatus) ? { status: body.status as ResearchProjectStatus } : {}),
      ...(body.synthesis === null || typeof body.synthesis === "string" ? { synthesis: body.synthesis } : {}),
    });
    return project
      ? NextResponse.json({ project })
      : NextResponse.json({ error: "Research project not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { id } = await params;
    return (await deleteResearchProject(principal.handle, id))
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Research project not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
