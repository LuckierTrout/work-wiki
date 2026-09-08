import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { isReadOnlyError } from "@/lib/read-only";
import {
  applyMemoryChangeProposal,
  getMemoryProposalReview,
  rejectMemoryChangeProposal,
  reviseMemoryChangeProposal,
} from "@/lib/memory-proposals";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { id } = await params;
    const review = await getMemoryProposalReview(principal.handle, id);
    return review
      ? NextResponse.json({ review })
      : NextResponse.json({ error: "Proposal not found." }, { status: 404 });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /invalid proposal id/i.test(message) ? 400 : 500 },
    );
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const action = body.action;
    const decisionNote = typeof body.decisionNote === "string"
      ? body.decisionNote
      : undefined;
    if (action === "accept") {
      const proposal = await applyMemoryChangeProposal(
        principal.handle,
        id,
        principal.handle,
        decisionNote,
      );
      return NextResponse.json({ proposal });
    }
    if (action === "reject") {
      const proposal = await rejectMemoryChangeProposal(
        principal.handle,
        id,
        principal.handle,
        decisionNote,
      );
      return proposal
        ? NextResponse.json({ proposal })
        : NextResponse.json({ error: "Proposal not found." }, { status: 404 });
    }
    if (action === "revise") {
      if (typeof body.proposedBody !== "string") {
        return NextResponse.json({ error: "proposedBody is required." }, { status: 400 });
      }
      const proposal = await reviseMemoryChangeProposal(
        principal.handle,
        id,
        principal.handle,
        body.proposedBody,
      );
      return NextResponse.json({ proposal });
    }
    return NextResponse.json(
      { error: "action must be accept, reject, or revise." },
      { status: 400 },
    );
  } catch (error) {
    // Deployment read-only (DW-188). NO route-level gate here on purpose: the
    // rule says a route adds its own check only where the kernel refusal lands
    // too late, and it does not. `applyMemoryChangeProposal` reaches
    // `writeWikiPageWithSideEffects` before it marks the proposal accepted,
    // before `recordOperationSafe` and before the knowledge enqueue — so the
    // refusal aborts with the proposal still pending and nothing committed.
    // All this catch has to do is not call it a 500.
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /not found/i.test(message) ? 404 : /stale|cannot be applied|cannot be revised/i.test(message) ? 409 : /required|does not change/i.test(message) ? 400 : 500 },
    );
  }
}
