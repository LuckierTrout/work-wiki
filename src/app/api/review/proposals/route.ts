import { ownerTenantHandle } from "@/lib/owner";
import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage, isClientInputError, isInfrastructureFault } from "@/lib/errors";
import {
  createMemoryChangeProposal,
  listMemoryChangeProposals,
  type MemoryProposalRisk,
  type MemoryProposalStatus,
} from "@/lib/memory-proposals";

const STATUSES = new Set<MemoryProposalStatus>([
  "pending",
  "accepted",
  "rejected",
  "superseded",
]);
const RISKS = new Set<MemoryProposalRisk>(["low", "medium", "high"]);

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const value = new URL(request.url).searchParams.get("status");
    const status = value && STATUSES.has(value as MemoryProposalStatus)
      ? (value as MemoryProposalStatus)
      : undefined;
    return NextResponse.json({
      proposals: await listMemoryChangeProposals(ownerTenantHandle(principal), status),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (
      typeof body.targetSlug !== "string" ||
      typeof body.title !== "string" ||
      typeof body.summary !== "string" ||
      typeof body.reason !== "string" ||
      typeof body.proposedContent !== "string"
    ) {
      return NextResponse.json(
        { error: "targetSlug, title, summary, reason, and proposedContent are required." },
        { status: 400 },
      );
    }
    if (body.risk !== undefined && !RISKS.has(body.risk as MemoryProposalRisk)) {
      return NextResponse.json({ error: "risk must be low, medium, or high." }, { status: 400 });
    }
    const proposal = await createMemoryChangeProposal(ownerTenantHandle(principal), {
      targetSlug: body.targetSlug,
      title: body.title,
      summary: body.summary,
      reason: body.reason,
      proposedContent: body.proposedContent,
      evidenceIds: Array.isArray(body.evidenceIds)
        ? body.evidenceIds.filter((value): value is string => typeof value === "string")
        : [],
      actor: principal.handle,
      ...(RISKS.has(body.risk as MemoryProposalRisk)
        ? { risk: body.risk as MemoryProposalRisk }
        : {}),
    });
    return NextResponse.json({ proposal }, { status: 201 });
  } catch (error) {
    const message = getErrorMessage(error);
    // Classify by TYPE first. An infrastructure fault
    // (`createMemoryChangeProposal` hitting an unreadable file, or the
    // filesystem answering `EINVAL: invalid argument, open '…'`) is OURS, not
    // the caller's — the message ladder below read that sentence's "invalid"
    // as a 400 and the caller retried a broken disk forever (DW-481). The
    // ladder survives as the residual branch only, covering `validateSlug` and
    // the proposal module's own still-untyped validation throws, which are
    // genuinely the caller's 400.
    if (isInfrastructureFault(error)) {
      return NextResponse.json({ error: message }, { status: 500 });
    }
    if (isClientInputError(error)) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json(
      { error: message },
      { status: /required|invalid|owner|does not change|too large/i.test(message) ? 400 : 500 },
    );
  }
}
