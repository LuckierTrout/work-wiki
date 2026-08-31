import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { getCurrentWiki } from "@/lib/wikis";
import {
  emptyWorkspaceProfile,
  getWorkspaceProfile,
} from "@/lib/workspace-profile";
import { objectVersion } from "@/lib/write-precondition";

/**
 * Migration-safe compatibility read for the retired structured profile.
 * New product surfaces read and edit canonical purpose.md instead; this GET
 * remains only so an older client can display preserved legacy evidence while
 * a Wiki is still unmarked.
 */
export async function GET() {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const wiki = await getCurrentWiki(principal.handle);
    const profile = wiki
      ? await getWorkspaceProfile(principal.handle, wiki.id)
      : emptyWorkspaceProfile();
    return NextResponse.json({
      profile,
      readOnly: isReadOnly(),
      wiki: wiki ? { id: wiki.id, name: wiki.name } : null,
      version: objectVersion(profile),
      retired: true,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

/** Structured profile writes are retired; Purpose has one Markdown writer. */
export async function PUT() {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  return NextResponse.json(
    {
      error:
        "Workspace Purpose is edited from purpose.md in the Workbench Preview.",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
