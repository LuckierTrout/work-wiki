import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import {
  createResearchProject,
  listResearchProjects,
} from "@/lib/research-projects";
import { availableResearchProviders } from "@/lib/research-providers";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    return NextResponse.json({
      projects: await listResearchProjects(principal.handle),
      availableProviders: availableResearchProviders(),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.title !== "string" || typeof body.question !== "string") {
      return NextResponse.json({ error: "title and question are required" }, { status: 400 });
    }
    for (const field of ["queries", "sourceUrls", "pageSlugs"] as const) {
      if (body[field] !== undefined && (!Array.isArray(body[field]) || body[field].some((value) => typeof value !== "string"))) {
        return NextResponse.json({ error: `${field} must be a list of strings` }, { status: 400 });
      }
    }
    const project = await createResearchProject(principal.handle, {
      title: body.title,
      question: body.question,
      queries: body.queries as string[] | undefined,
      sourceUrls: body.sourceUrls as string[] | undefined,
      pageSlugs: body.pageSlugs as string[] | undefined,
      ...(typeof body.vaultId === "string" ? { vaultId: body.vaultId } : {}),
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json({ error: message }, { status: /required|invalid/i.test(message) ? 400 : 500 });
  }
}
