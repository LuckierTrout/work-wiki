import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { editResearchProject, getResearchProject } from "@/lib/research-projects";
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
      principal.handle,
      id,
      (current) => EDITABLE.has(current.status) && !current.deleteRequested,
      {
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.question === "string" ? { question: body.question } : {}),
        ...(Array.isArray(body.queries) ? { queries: body.queries as string[] } : {}),
      },
    );
    if (project) return NextResponse.json({ project });
    const current = await getResearchProject(principal.handle, id);
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
    const status = error instanceof ClientInputError ? 400 : 500;
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
    return (await retireResearchProject(principal.handle, id))
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Research project not found." }, { status: 404 });
  } catch (error) {
    // Same classification as PATCH above: a store-side input refusal is the
    // caller's fault at every door, and a storage fault is still a 500.
    const status = error instanceof ClientInputError ? 400 : 500;
    return NextResponse.json({ error: getErrorMessage(error) }, { status });
  }
}
