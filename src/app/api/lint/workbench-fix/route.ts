import { NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { FixNotFoundError, FixValidationError } from "@/lib/lint-fix";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { isReadOnlyError, READ_ONLY_REFUSAL } from "@/lib/read-only";
import { fixWorkbenchLintIssue } from "@/lib/workbench-lint-fix";

export async function POST(request: Request) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json({ error: READ_ONLY_REFUSAL.lintFix }, { status: 403 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      type?: unknown;
      slug?: unknown;
      target?: unknown;
      targetSlug?: unknown;
    };
    if (typeof body.type !== "string" || typeof body.slug !== "string") {
      return NextResponse.json({ error: "type and slug are required." }, { status: 400 });
    }
    const target =
      typeof body.targetSlug === "string"
        ? body.targetSlug
        : typeof body.target === "string"
          ? body.target
          : undefined;
    // The owner is the TRIGGER, not the author (DW-447): `author` stays
    // `"lint-fix"` (hence the `undefined`), and the resolved principal is
    // recorded on the fix's wiki-log detail line only — never in the revision
    // sidecar, the page's contributors or a trust score.
    const result = await fixWorkbenchLintIssue(
      body.type,
      body.slug,
      target,
      undefined,
      principal.handle,
    );
    return NextResponse.json(result);
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    if (error instanceof FixValidationError) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
    }
    if (error instanceof FixNotFoundError) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 404 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
