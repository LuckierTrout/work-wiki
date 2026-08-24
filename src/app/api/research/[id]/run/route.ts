import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { READ_ONLY_REFUSAL } from "@/lib/read-only";
import { enqueueTask } from "@/lib/tasks";
import {
  cancelResearchProject,
  queueResearchProject,
  runResearchProject,
} from "@/lib/research-runtime";
import {
  availableResearchProviders,
  ResearchProviderUnconfiguredError,
} from "@/lib/research-providers";

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  // Read-only, before the body is read. Run and cancel both mutate the project
  // record — cancel sets `cancelRequested` — so both are refused, and the
  // ordering matches `POST /api/research`: 401 first, then this, then anything
  // about the request's shape.
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.researchMutate },
      { status: 403 },
    );
  }
  try {
    const { id } = await params;
    const raw = await request.text();
    let body: Record<string, unknown> = {};
    if (raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
      }
    }
    if (body.action === "cancel") {
      return NextResponse.json({ project: await cancelResearchProject(principal.handle, id) });
    }
    if (body.action !== undefined && body.action !== "start") {
      return NextResponse.json({ error: "action must be cancel or omitted." }, { status: 400 });
    }
    if (body.provider !== undefined) {
      return NextResponse.json(
        { error: "The search provider is chosen in Settings, not on the run." },
        { status: 400 },
      );
    }
    const project = await queueResearchProject(principal.handle, id);
    const enqueued = await enqueueTask({
      kind: "run-research",
      projectId: id,
      owner: principal.handle,
    });
    // 202 EITHER WAY. The run is asynchronous by contract: the Workbench opens
    // the panel and polls, and a response that arrived only after the whole
    // search-fetch-synthesise-write cycle had finished would hold the request
    // open for minutes and time out behind any proxy.
    //
    // Off-Workers there is no queue to hand it to, so the work is started HERE
    // and deliberately not awaited — `void` with a catch, so a failure lands on
    // the project record (where the panel reads it) rather than as an unhandled
    // rejection. The run takes the same three-slot lease either way, so the dev
    // path cannot exceed a cap the queued path respects.
    if (!enqueued) {
      void runResearchProject(principal.handle, id).catch(() => {
        // `runResearchProject` has already written `status: "failed"` and the
        // message onto the project. There is no second place to report it.
      });
    }
    return NextResponse.json({ project, enqueued }, { status: 202 });
  } catch (error) {
    const message = getErrorMessage(error);
    // A missing credential for the SELECTED provider is the caller's
    // configuration, not a server fault, and it is reported with the list of
    // providers that ARE configured so the surface can say what to switch to —
    // without ever silently switching. 400 by TYPE rather than by matching the
    // sentence, the `ClientInputError` idiom from the create route.
    const status =
      error instanceof ResearchProviderUnconfiguredError
        ? 400
        : /not found/i.test(message)
          ? 404
          : /already running/i.test(message)
            ? 409
            : 500;
    return NextResponse.json(
      { error: message, availableProviders: availableResearchProviders() },
      { status },
    );
  }
}

export async function GET(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const { id } = await params;
  const { getResearchProject } = await import("@/lib/research-projects");
  const project = await getResearchProject(principal.handle, id);
  return project && !project.deleteRequested
    ? NextResponse.json({ project, availableProviders: availableResearchProviders() })
    : NextResponse.json({ error: "Research project not found." }, { status: 404 });
}
