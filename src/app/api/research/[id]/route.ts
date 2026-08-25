import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { READ_ONLY_REFUSAL } from "@/lib/read-only";
import { getResearchProject, updateResearchProjectIf } from "@/lib/research-projects";
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
    const project = await updateResearchProjectIf(
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
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
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
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
