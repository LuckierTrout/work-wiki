import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
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
      proposals: await listMemoryChangeProposals(principal.handle, status),
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
    const proposal = await createMemoryChangeProposal(principal.handle, {
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
    return NextResponse.json(
      { error: message },
      { status: /required|invalid|owner|does not change|too large/i.test(message) ? 400 : 500 },
    );
  }
}
