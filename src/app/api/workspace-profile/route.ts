import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import {
  getWorkspaceProfile,
  saveWorkspaceProfile,
} from "@/lib/workspace-profile";
import { parseWorkspaceProfileInput } from "@/lib/workspace-profile-schema";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    return NextResponse.json({
      profile: await getWorkspaceProfile(principal.handle),
      readOnly: isReadOnly(),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json(
      { error: "Settings are read-only in this deployment." },
      { status: 403 },
    );
  }
  try {
    const profile = await saveWorkspaceProfile(
      principal.handle,
      parseWorkspaceProfileInput(await request.json()),
    );
    return NextResponse.json({ profile });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }
}
