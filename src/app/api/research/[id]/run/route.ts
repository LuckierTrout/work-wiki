import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { enqueueTask } from "@/lib/tasks";
import {
  cancelResearchProject,
  queueResearchProject,
  runResearchProject,
} from "@/lib/research-runtime";
import { availableResearchProviders } from "@/lib/research-providers";

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (body.action === "cancel") {
      return NextResponse.json({ project: await cancelResearchProject(principal.handle, id) });
    }
    if (body.provider !== undefined && typeof body.provider !== "string") {
      return NextResponse.json({ error: "provider must be text" }, { status: 400 });
    }
    const project = await queueResearchProject(
      principal.handle,
      id,
      typeof body.provider === "string" ? body.provider : undefined,
    );
    const enqueued = await enqueueTask({
      kind: "run-research",
      projectId: id,
      owner: principal.handle,
    });
    if (enqueued) return NextResponse.json({ project, enqueued: true });
    // Local/test fallback: complete inline when Cloudflare Queues is absent.
    return NextResponse.json({
      project: await runResearchProject(principal.handle, id),
      enqueued: false,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message, availableProviders: availableResearchProviders() },
      { status: /not found/i.test(message) ? 404 : /configured|already running/i.test(message) ? 409 : 500 },
    );
  }
}

export async function GET(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await params;
  const { getResearchProject } = await import("@/lib/research-projects");
  const project = await getResearchProject(principal.handle, id);
  return project
    ? NextResponse.json({ project, availableProviders: availableResearchProviders() })
    : NextResponse.json({ error: "Research project not found." }, { status: 404 });
}
