import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import {
  createResearchProject,
  filterResearchProjects,
  listResearchProjects,
} from "@/lib/research-projects";
import { listWikis } from "@/lib/wikis";
import {
  availableResearchProviders,
  selectResearchProvider,
} from "@/lib/research-providers";
import { reconcileResearchProjects } from "@/lib/research-runtime";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const wikiId = new URL(request.url).searchParams.get("wikiId")?.trim() || null;
    const availableProviders = availableResearchProviders();
    // WHICH provider is selected, beside which ones are configured. Two facts,
    // because they disagree exactly when the panel most needs to say so: a
    // selection with no credential is the "fails visibly" case, and a panel
    // holding only the available list would show a green "SerpApi, Tavily" and
    // no hint about the run that is about to refuse.
    let activeProvider: ReturnType<typeof selectResearchProvider> | null = null;
    let providerConfigurationError: string | null = null;
    try {
      activeProvider = selectResearchProvider();
    } catch (error) {
      providerConfigurationError = getErrorMessage(error);
    }
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
      projects: filterResearchProjects(projects, wikiId),
      // The Studio's ONLY read of this door, and so its source of truth for the
      // flag (DW-386). `/studio` is `"use client"` from the page down, so the
      // fact cannot arrive as a prop; it rides on the GET the Research desk
      // already makes rather than on a second fetch that could disagree.
      readOnly: isReadOnly(),
      availableProviders,
      activeProvider,
      activeProviderConfigured: activeProvider !== null && availableProviders.includes(activeProvider),
      providerConfigurationError,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  // Deployment read-only (DW-294). `createResearchProject` now gates in the
  // kernel too (DW-385, same sentence), so this is no longer the only refusal
  // behind the door — but it stays for the reason it was added: ordered after
  // the 401 (an unauthenticated caller still learns it is unauthenticated) and
  // BEFORE the body parse, so the refusal cannot be pre-empted by a 400 about a
  // field the deployment was never going to store.
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.researchCreate },
      { status: 403 },
    );
  }
  try {
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
    if (
      typeof body.title !== "string" || !body.title.trim() ||
      typeof body.question !== "string" || !body.question.trim()
    ) {
      return NextResponse.json({ error: "title and question are required" }, { status: 400 });
    }
    // DW-442. Creation no longer takes seed URLs: the first automated run
    // overwrites `project.sourceUrls` with the provider's own results, so a
    // supplied list was stored and then discarded. Refused rather than ignored
    // — a 400 is the one answer that cannot be mistaken for the old behaviour,
    // where the caller got a 201 and a project that dropped their seeds. The
    // field's PRESENCE is what is refused, `[]` included, because an empty list
    // is still a caller who believes the field does something.
    if (body.sourceUrls !== undefined) {
      return NextResponse.json(
        { error: "sourceUrls is no longer accepted — an automated run collects its own sources." },
        { status: 400 },
      );
    }
    for (const field of ["queries", "pageSlugs"] as const) {
      if (body[field] !== undefined && (!Array.isArray(body[field]) || body[field].some((value) => typeof value !== "string"))) {
        return NextResponse.json({ error: `${field} must be a list of strings` }, { status: 400 });
      }
    }
    if (
      !Array.isArray(body.queries) ||
      !body.queries.some((value) => typeof value === "string" && value.trim())
    ) {
      return NextResponse.json({ error: "At least one research query is required." }, { status: 400 });
    }
    for (const field of ["vaultId", "wikiId"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        return NextResponse.json({ error: `${field} must be text` }, { status: 400 });
      }
    }
    const project = await createResearchProject(principal.handle, {
      title: body.title,
      question: body.question,
      queries: body.queries as string[] | undefined,
      pageSlugs: body.pageSlugs as string[] | undefined,
      // `wikiId` is the name the Workbench rail uses for the same thing, and
      // Graph/Review/mode-direct all read it from there. Accepting both spellings
      // beats making three call sites remember to rename it — and `vaultId`
      // wins when both ride, because it is the field's own name.
      ...(await researchWikiField(principal.handle, body)),
    });
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    // Backstop for a flag that flipped mid-request: the gate above already
    // answered for a deployment that was read-only when the request arrived, so
    // reaching here means the kernel writer refused. A refusal is neither a
    // server fault nor the caller's bad input.
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    // Classification is by TYPE alone — the `src/app/api/wikis/route.ts` idiom.
    // A `ClientInputError` is the caller's fault by construction (the
    // MAX_PROJECTS refusal, and `cleanInput`'s blank title/question checks);
    // everything else is a server fault. This used to also 400 any message
    // matching /required|invalid/i, which mislabelled storage faults like
    // "EINVAL: invalid argument, open …" as the caller's bad input — inviting a
    // client to fix and resubmit a body that was never the problem.
    const message = getErrorMessage(error);
    const status = error instanceof ClientInputError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

async function researchWikiField(
  owner: string,
  body: Record<string, unknown>,
): Promise<{ vaultId: string } | Record<string, never>> {
  const raw = typeof body.vaultId === "string"
    ? body.vaultId
    : typeof body.wikiId === "string"
      ? body.wikiId
      : "";
  const wikiId = raw.trim();
  if (!wikiId) return {};
  const known = (await listWikis(owner)).some((wiki) => wiki.id === wikiId);
  if (!known) {
    throw new ClientInputError("That Wiki is not in this workspace.");
  }
  return { vaultId: wikiId };
}
