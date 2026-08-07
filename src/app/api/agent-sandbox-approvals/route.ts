import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { listAgentSandboxApprovals } from "@/lib/agent-workspaces";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const all = await listAgentSandboxApprovals(principal.handle);
  const ordered = [
    ...all.filter((approval) => approval.status === "pending" || approval.status === "executing"),
    ...all.filter((approval) => approval.status !== "pending" && approval.status !== "executing"),
  ].slice(0, 50).map((approval) => ({
    ...approval,
    ...(approval.result ? {
      result: {
        ...approval.result,
        stdout: approval.result.stdout.slice(0, 2_000),
        stderr: approval.result.stderr.slice(0, 2_000),
      },
    } : {}),
  }));
  return NextResponse.json({
    approvals: ordered,
  });
}
