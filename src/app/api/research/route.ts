import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL } from "@/lib/read-only";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import {
  createResearchProject,
  listResearchProjects,
} from "@/lib/research-projects";
import {
  availableResearchProviders,
  selectResearchProvider,
} from "@/lib/research-providers";
import { reconcileResearchProjects } from "@/lib/research-runtime";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const availableProviders = availableResearchProviders();
    // WHICH provider is selected, beside which ones are configured. Two facts,
    // because they disagree exactly when the panel most needs to say so: a
    // selection with no credential is the "fails visibly" case, and a panel
    // holding only the available list would show a green "SerpApi, Tavily" and
    // no hint about the run that is about to refuse.
    const activeProvider = selectResearchProvider();
    // The panel's poll is also where an interrupted run gets its answer: a
    // `queued` project whose wake-up was lost is re-dispatched, and a
    // `collecting` one whose worker died is failed visibly rather than left
    // saying "collecting" forever. See `reconcileResearchProjects`.
    //
    // SKIPPED on a read-only deployment: reconciling WRITES — a status change and
    // possibly a task enqueue — and a read-only deployment refuses those on every
    // other door. A GET that quietly wrote would be the one exception.
    const projects = isReadOnly()
      ? await listResearchProjects(principal.handle)
      : await reconcileResearchProjects(
          principal.handle,
          await listResearchProjects(principal.handle),
        );
    return NextResponse.json({
      projects,
      availableProviders,
      activeProvider,
      activeProviderConfigured: availableProviders.includes(activeProvider),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  // Deployment read-only (DW-294). Gated HERE rather than left to a kernel
  // writer, because `createResearchProject` reaches none: it writes the project
  // record straight to storage, so there is nothing behind this handler that
  // would refuse. Ordered after the 401 (an unauthenticated caller still learns
  // it is unauthenticated) and before the body parse, so the refusal cannot be
  // pre-empted by a 400 about a field the deployment was never going to store.
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.researchCreate },
      { status: 403 },
    );
  }
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
      // `wikiId` is the name the Workbench rail uses for the same thing, and
      // Graph/Review/mode-direct all read it from there. Accepting both spellings
      // beats making three call sites remember to rename it — and `vaultId`
      // wins when both ride, because it is the field's own name.
      ...(typeof body.vaultId === "string"
        ? { vaultId: body.vaultId }
        : typeof body.wikiId === "string"
          ? { vaultId: body.wikiId }
          : {}),
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    // A `ClientInputError` is the caller's fault by construction (the
    // MAX_PROJECTS refusal), so it is a 400 by TYPE rather than by matching its
    // message — the `src/app/api/wikis/route.ts` idiom. The message regex stays
    // for the validation throws in `cleanInput` that predate that class.
    const message = getErrorMessage(error);
    const status =
      error instanceof ClientInputError || /required|invalid/i.test(message)
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
