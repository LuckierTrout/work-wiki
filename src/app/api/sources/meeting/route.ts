import { NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { isReadOnlyError, READ_ONLY_REFUSAL } from "@/lib/read-only";
import { isSourceMeeting, setSourceMeeting } from "@/lib/source-meeting";
import { workbenchSourcePath } from "@/lib/source-delete";

export async function GET(request: Request) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const path = new URL(request.url).searchParams.get("path") ?? "";
  const canonical = workbenchSourcePath(path);
  if (!canonical) {
    return NextResponse.json({ error: "Invalid source path." }, { status: 400 });
  }
  try {
    return NextResponse.json({
      path: canonical,
      meeting: await isSourceMeeting(principal.handle, canonical),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.sourceMeeting },
      { status: 403 },
    );
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      path?: unknown;
      meeting?: unknown;
    };
    if (typeof body.path !== "string" || !workbenchSourcePath(body.path)) {
      return NextResponse.json({ error: "Invalid source path." }, { status: 400 });
    }
    if (body.meeting !== undefined && typeof body.meeting !== "boolean") {
      return NextResponse.json(
        { error: "meeting must be boolean." },
        { status: 400 },
      );
    }
    const meeting = body.meeting === undefined ? true : body.meeting;
    const result = await setSourceMeeting(principal.handle, body.path, meeting);
    return NextResponse.json(result);
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /Invalid source path/i.test(message) ? 400 : 500 },
    );
  }
}
