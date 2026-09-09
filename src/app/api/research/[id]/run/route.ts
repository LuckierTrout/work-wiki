import { ownerTenantHandle } from "@/lib/owner";
import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage, isClientInputError } from "@/lib/errors";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { enqueueTask } from "@/lib/tasks";
import {
  cancelResearchProject,
  queueResearchProject,
  runResearchProject,
} from "@/lib/research-runtime";
import {
  availableResearchProviders,
  ResearchProviderOverrideError,
  ResearchProviderUnconfiguredError,
} from "@/lib/research-providers";
import {
  ResearchProjectBusyError,
  ResearchProjectConflictError,
  ResearchProjectNotFoundError,
} from "@/lib/research-projects";

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
      return NextResponse.json({ project: await cancelResearchProject(ownerTenantHandle(principal), id) });
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
    const project = await queueResearchProject(ownerTenantHandle(principal), id);
    const enqueued = await enqueueTask({
      kind: "run-research",
      projectId: id,
      owner: ownerTenantHandle(principal),
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
      void runResearchProject(ownerTenantHandle(principal), id).catch(() => {
        // `runResearchProject` has already written `status: "failed"` and the
        // message onto the project. There is no second place to report it.
      });
    }
    return NextResponse.json({ project, enqueued }, { status: 202 });
  } catch (error) {
    const message = getErrorMessage(error);
    // Read-only FIRST, ahead of the ladder (DW-657). The gate at the top of
    // this handler answers a deployment that was already read-only; this is
    // the flip that lands MID-request, refused by `queueResearchProject`'s or
    // `cancelResearchProject`'s CAS. Collapsed, that refusal used to arrive as
    // `ResearchProjectNotFoundError` and leave by the 404 below — the owner
    // told their project was gone about a row nothing had written to. The
    // caught message is echoed rather than the route's own literal, the
    // backstop shape every sibling door uses.
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    // Classification is by TYPE alone — the `POST /api/research` idiom.
    //
    // A missing credential for the SELECTED provider is the caller's
    // configuration, not a server fault, and it is reported with the list of
    // providers that ARE configured so the surface can say what to switch to —
    // without ever silently switching. Every class in this ladder extends
    // `Error` directly and none subclasses another, so the branches are
    // disjoint and the order is presentation, not precedence.
    //
    // The 404 and 409 used to be decided by `/not found/i` and
    // `/already running/i` over the message, which handed a storage fault whose
    // sentence happened to contain those words to the caller as their own
    // mistake — "R2 object not found for research-projects.json" is a 500. The
    // runtime throws the typed class for each of those faults instead.
    //
    // THREE CLASSES, THREE STATUSES since DW-651. "…is retired" is a
    // `ResearchProjectNotFoundError` (404), agreeing with the GET on this same
    // path for that same row. A completion still being delivered joins "already
    // running" as a `ResearchProjectConflictError` (409) — a state the caller
    // can read back and wait out. A lost or exhausted compare-and-swap is a
    // `ResearchProjectBusyError` (503): transient contention, which as a 500
    // read as a permanent server fault and gave the caller no retry signal.
    // Every OTHER fault, `ResearchLeaseError` included, keeps the 500 it had.
    const status =
      error instanceof ResearchProviderUnconfiguredError
        || error instanceof ResearchProviderOverrideError
        || isClientInputError(error)
        ? 400
        : error instanceof ResearchProjectNotFoundError
          ? 404
          : error instanceof ResearchProjectConflictError
            ? 409
            : error instanceof ResearchProjectBusyError
              ? 503
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
  // Wrapped because the read itself can REFUSE: `parseRegistry` throws on a
  // registry that is not a list, or that holds a row the shape guard rejects,
  // and an unreadable store is a server fault (500), never an empty one.
  //
  // Left uncaught that refusal escaped as a framework error page with no body.
  // The gain is SHAPE, not a fixed screen: this door now answers the same
  // `{ error }` JSON every sibling door returns, so any client that reads the
  // body gets the store's own sentence instead of nothing. The Studio's
  // 3-second Research poll happens to discard it (`catch {}` — the visible
  // status holds until the next refresh), which is exactly why the body was
  // free to be missing for so long.
  try {
    const { id } = await params;
    const { getResearchProject } = await import("@/lib/research-projects");
    const project = await getResearchProject(ownerTenantHandle(principal), id);
    return project && !project.deleteRequested
      ? NextResponse.json({ project, availableProviders: availableResearchProviders() })
      : NextResponse.json({ error: "Research project not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
