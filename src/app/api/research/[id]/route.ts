import { ownerTenantHandle } from "@/lib/owner";
import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage, isClientInputError } from "@/lib/errors";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import {
  editResearchProject,
  getResearchProject,
  ResearchProjectBusyError,
} from "@/lib/research-projects";
import { retireResearchProject } from "@/lib/research-runtime";

interface RouteContext { params: Promise<{ id: string }> }

const OWNER_PATCH = new Set(["title", "question", "queries"]);
const EDITABLE = new Set(["draft", "failed", "cancelled"]);

export async function PATCH(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.researchMutate },
      { status: 403 },
    );
  }
  try {
    const { id } = await params;
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;
    const keys = Object.keys(body);
    if (keys.some((key) => !OWNER_PATCH.has(key))) {
      return NextResponse.json(
        { error: "Only title, question, and queries can be edited." },
        { status: 400 },
      );
    }
    for (const field of ["title", "question"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        return NextResponse.json({ error: `${field} must be text` }, { status: 400 });
      }
      if (typeof body[field] === "string" && !body[field].trim()) {
        return NextResponse.json({ error: `${field} cannot be blank` }, { status: 400 });
      }
    }
    if (body.queries !== undefined) {
      if (!Array.isArray(body.queries) || body.queries.some((value) => typeof value !== "string")) {
        return NextResponse.json({ error: "queries must be a list of strings" }, { status: 400 });
      }
      if (!body.queries.some((value) => value.trim())) {
        return NextResponse.json({ error: "At least one research query is required." }, { status: 400 });
      }
    }
    // `editResearchProject`, not `updateResearchProjectIf` (DW-527): the
    // gated owner-editing entry point, so a DIRECT library caller is refused
    // by the same sentence this door serves, and a flag that flips after the
    // gate above arrives here as a `ReadOnlyError` rather than a `null` the
    // 409 below would mislabel as "cannot be edited".
    const project = await editResearchProject(
      ownerTenantHandle(principal),
      id,
      (current) => EDITABLE.has(current.status) && !current.deleteRequested,
      {
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.question === "string" ? { question: body.question } : {}),
        ...(Array.isArray(body.queries) ? { queries: body.queries as string[] } : {}),
      },
    );
    if (project) return NextResponse.json({ project });
    const current = await getResearchProject(ownerTenantHandle(principal), id);
    if (!current || current.deleteRequested) {
      return NextResponse.json({ error: "Research project not found." }, { status: 404 });
    }
    return NextResponse.json(
      { error: "A running or finished research project cannot be edited." },
      { status: 409 },
    );
  } catch (error) {
    // Read-only FIRST (DW-527). The early `isReadOnly()` gate above answers the
    // ordinary case; this branch is reached only when the deployment turns
    // read-only MID-request — writable on arrival, refused by the writer —
    // which used to leave by the 500 below. The caught message is echoed
    // rather than re-serving the route's own literal, the backstop shape
    // DW-316/DW-319/DW-526 established at nine sibling doors; this is the
    // tenth.
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    // Classification by TYPE alone, the `src/app/api/research/route.ts` idiom
    // (DW-478). The store throws `ClientInputError` for the caller's own faults
    // — `cleanInput`'s blank title/question refusal reaches this door too, via
    // a stored row the patch does not overwrite — and a 500 tells the client to
    // retry a request that will never succeed. Everything else stays a server
    // fault, message unchanged.
    //
    // DW-684. A `ResearchProjectBusyError` is the third rung: an exhausted
    // registry CAS, transient by construction and telling the caller to retry,
    // which as a 500 read as a permanent fault at this door while the run and
    // repair doors already answered 503 for the same class.
    const status = isClientInputError(error)
      ? 400
      : error instanceof ResearchProjectBusyError
        ? 503
        : 500;
    return NextResponse.json({ error: getErrorMessage(error) }, { status });
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.researchMutate },
      { status: 403 },
    );
  }
  try {
    const { id } = await params;
    return (await retireResearchProject(ownerTenantHandle(principal), id))
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Research project not found." }, { status: 404 });
  } catch (error) {
    // Read-only FIRST, mirroring the PATCH branch above (DW-639, DW-657). The
    // early `isReadOnly()` gate answers a deployment that was already read-only
    // when the request arrived; this is the flip that lands MID-request,
    // refused by `retireResearchProject`'s own `assertWritable` or by the CAS
    // underneath it. Without this branch that refusal would have left by the
    // 500 below — a server fault the owner would retry forever — and a
    // `false`-returning writer would have left by the 404 above, which says the
    // project is gone when nothing was touched at all.
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    // Same classification as PATCH above: a store-side input refusal is the
    // caller's fault at every door, contended registry writes are a retryable
    // 503 (DW-684), and a storage fault is still a 500.
    const status = isClientInputError(error)
      ? 400
      : error instanceof ResearchProjectBusyError
        ? 503
        : 500;
    return NextResponse.json({ error: getErrorMessage(error) }, { status });
  }
}
