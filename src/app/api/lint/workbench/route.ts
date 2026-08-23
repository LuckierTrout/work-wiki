import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { runWorkbenchLint } from "@/lib/workbench-lint";

export async function POST(request: Request) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as { semantic?: unknown };
    const issues = await runWorkbenchLint({ semantic: body.semantic === true });
    return NextResponse.json({ issues });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
